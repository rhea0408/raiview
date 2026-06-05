import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { GitExtension } from "../git.d";
import { isFilePath, readFileOrFolder } from "../filesystem";
import {
  type ReviewChunk,
  type ReviewFinding,
  type ReviewResponse,
  type SendChatOpts,
  type SendChatResult,
  REVIEW_JSON_SCHEMA,
} from "../constants";

// ---------------------------------------------------------------------------
// Content splitting helpers
// ---------------------------------------------------------------------------

export function splitDiffByFile(diffText: string): string[] {
  return diffText.split(/(?=^diff --git )/m).filter(s => s.trim());
}

export function splitByLineChunks(content: string, limit: number): string[] {
  if (content.length <= limit) { return [content]; }
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const addition = (current ? "\n" : "") + line;
    if (current.length + addition.length > limit && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += addition;
    }
  }
  if (current) { chunks.push(current); }
  return chunks;
}

export function flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return symbols.flatMap(s => [s, ...flattenSymbols(s.children)]);
}

export async function splitByMethods(document: vscode.TextDocument, limit: number): Promise<string[]> {
  let symbols: vscode.DocumentSymbol[] = [];
  try {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider", document.uri
    );
    symbols = result ?? [];
  } catch { /* fall through to line-based split */ }

  const flat = flattenSymbols(symbols)
    .filter(s => [
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Class,
    ].includes(s.kind))
    .sort((a, b) => a.range.start.line - b.range.start.line);

  if (flat.length === 0) { return splitByLineChunks(document.getText(), limit); }

  const chunks: string[] = [];
  const allLabels: string[][] = [];
  let current = "";
  let currentLabels: string[] = [];

  for (const sym of flat) {
    const text = document.getText(sym.range);
    const addition = (current ? "\n\n" : "") + text;
    if (current.length + addition.length > limit && current.length > 0) {
      chunks.push(current);
      allLabels.push(currentLabels);
      current = text;
      currentLabels = [sym.name];
    } else {
      current += addition;
      currentLabels.push(sym.name);
    }
  }
  if (current) { chunks.push(current); allLabels.push(currentLabels); }

  // Attach method labels as a hidden property for callers that need them
  (chunks as any).__labels = allLabels;
  return chunks;
}

// ---------------------------------------------------------------------------
// Git diff chunk builder
// ---------------------------------------------------------------------------

export async function buildGitChunks(
  webviewView: vscode.WebviewView,
  maxContentChars: number,
  outputChannel: vscode.OutputChannel
): Promise<ReviewChunk[] | null> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    webviewView.webview.postMessage({ type: "chatError", message: "Built-in Git extension is not available." });
    return null;
  }

  const git = gitExtension.isActive
    ? gitExtension.exports.getAPI(1)
    : (await gitExtension.activate()).getAPI(1);

  const repo = git.repositories[0];
  if (!repo) {
    webviewView.webview.postMessage({ type: "chatError", message: "No git repository detected." });
    return null;
  }

  const repoPath = repo.rootUri.fsPath;
  let diffText = "";
  let diffFiles: string[] = [];
  let untrackedFiles: string[] = [];

  const excludeExts = vscode.workspace.getConfiguration("raiview").get<string[]>("excludeExtensions") ?? [];
  const extFilter = (f: string) => excludeExts.length === 0 || !excludeExts.some(ext => {
    if (ext.includes("*")) {
      const re = new RegExp("^" + ext
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\x00")
        .replace(/\*/g, "[^/]*")
        .replace(/\x00/g, ".*") + "$");
      return re.test(f);
    }
    const normalised = ext.startsWith(".") ? ext : "." + ext;
    return f === ext || f.endsWith("/" + ext) || f.endsWith(normalised);
  });

  const gitOpts = { cwd: repoPath, encoding: "utf8" as const, stdio: "pipe" as const, timeout: 10000 };

  try {
    untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], gitOpts)
      .trim().split("\n").filter(Boolean).filter(extFilter);
  } catch (e) {
    outputChannel.appendLine(`[git] ls-files failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    diffFiles = execFileSync("git", ["diff", "--name-only", "HEAD"], gitOpts)
      .trim().split("\n").filter(Boolean).filter(extFilter);
    diffText = execFileSync("git", ["diff", "HEAD"], gitOpts);
  } catch (e) {
    outputChannel.appendLine(`[git] diff HEAD failed, trying staged+unstaged fallback: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const staged = execFileSync("git", ["diff", "--name-only", "--cached"], gitOpts).trim().split("\n").filter(Boolean);
      const unstaged = execFileSync("git", ["diff", "--name-only"], gitOpts).trim().split("\n").filter(Boolean);
      diffFiles = [...new Set([...staged, ...unstaged])].filter(extFilter);
      diffText = execFileSync("git", ["diff", "--cached"], gitOpts) + "\n" + execFileSync("git", ["diff"], gitOpts);
    } catch (e2) {
      outputChannel.appendLine(`[git] staged+unstaged fallback also failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      webviewView.webview.postMessage({ type: "chatError", message: "Could not read git diff. Check the Output panel for details." });
      return null;
    }
  }

  const allFiles = [...new Set([...diffFiles, ...untrackedFiles])];
  if (allFiles.length === 0) {
    webviewView.webview.postMessage({ type: "chatError", message: "No changes in git control that can be reviewed." });
    return null;
  }

  interface DiffUnit { content: string; fileName: string; }
  const units: DiffUnit[] = [];

  if (diffText) {
    for (const block of splitDiffByFile(diffText)) {
      const match = block.match(/^diff --git a\/(.+?) b\//m);
      const fileName = match ? match[1] : "changed file";
      if (!extFilter(fileName)) { continue; }
      units.push({ content: "```diff\n" + block + "\n```", fileName });
    }
  }

  for (const file of untrackedFiles) {
    const fullPath = path.join(repoPath, file);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          units.push({ content: `New Untracked File: ${file}\n\`\`\`\n${content}\n\`\`\``, fileName: file });
        } catch { /* ignore */ }
      }
    }
  }

  const buildGitInstruction = (files: string[]): string => {
    const fileList = files.map(f => `• ${f}`).join("\n");
    return `\n\nReview ALL of the following files/sections present above:\n${fileList}\n\nReturn a JSON object with exactly these two fields:\n- "findings": array of at most 5 findings (prioritise the most impactful), where each item has severity ("Critical", "Warning", or "Suggestion"), category ("Correctness", "Security", "Performance", "Design", "Readability", or "Error Handling"), title (short string), description (one sentence string)\n- "rating": exactly one of these three strings: "Looks Good", "Needs Minor Changes", "Needs Major Revision"\nCover every file listed. Do NOT echo the diff.`;
  };

  const chunks: ReviewChunk[] = [];
  let currentContent = "";
  let currentFiles: string[] = [];

  const flushChunk = () => {
    if (currentContent) {
      chunks.push({ prompt: currentContent + buildGitInstruction(currentFiles), label: currentFiles.join(", ") });
      currentContent = "";
      currentFiles = [];
    }
  };

  for (const unit of units) {
    if (unit.content.length > maxContentChars) {
      flushChunk();
      const subChunks = splitByLineChunks(unit.content, maxContentChars);
      for (let i = 0; i < subChunks.length; i++) {
        const subLabel = subChunks.length > 1 ? `${unit.fileName} (part ${i + 1}/${subChunks.length})` : unit.fileName;
        chunks.push({ prompt: subChunks[i] + buildGitInstruction([unit.fileName]), label: subLabel });
      }
      continue;
    }
    if (currentContent.length + (currentContent ? 2 : 0) + unit.content.length > maxContentChars && currentContent.length > 0) {
      flushChunk();
    }
    currentContent += (currentContent ? "\n\n" : "") + unit.content;
    currentFiles.push(unit.fileName);
  }
  flushChunk();

  return chunks;
}

// ---------------------------------------------------------------------------
// File/custom input chunk builder
// ---------------------------------------------------------------------------

export async function buildFileChunks(
  customInput: string,
  webviewView: vscode.WebviewView,
  maxContentChars: number
): Promise<ReviewChunk[] | null> {
  const buildFileInstruction = (fileName: string, scope?: string): string => {
    const header = `\n\nReview the code above${scope ? ` (${scope})` : ""} from file: ${fileName}`;
    return `${header}\n\nReturn a JSON object with exactly these two fields:\n- "findings": array of at most 5 findings (prioritise the most impactful), where each item has severity ("Critical", "Warning", or "Suggestion"), category ("Correctness", "Security", "Performance", "Design", "Readability", or "Error Handling"), title (short string), description (one sentence string)\n- "rating": exactly one of these three strings: "Looks Good", "Needs Minor Changes", "Needs Major Revision"\nCover all categories. Do NOT echo the code.`;
  };

  if (customInput && customInput.trim()) {
    const input = customInput.trim();
    if (isFilePath(input)) {
      const result = readFileOrFolder(input);
      if (!result.ok) {
        webviewView.webview.postMessage({ type: "chatError", message: result.content });
        return null;
      }
      const rawChunks = splitByLineChunks(result.content, maxContentChars);
      let lineOffset = 1;
      return rawChunks.map((chunk) => {
        const startLine = lineOffset;
        const endLine = startLine + chunk.split("\n").length - 1;
        lineOffset = endLine + 1;
        const label = rawChunks.length > 1 ? `lines ${startLine}–${endLine}` : path.basename(input);
        const scope = rawChunks.length > 1 ? `lines ${startLine}–${endLine}` : undefined;
        return { prompt: `${chunk}${buildFileInstruction(path.basename(input), scope)}`, label };
      });
    }
    return [{ prompt: input, label: "custom input" }];
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const fileName = vscode.workspace.asRelativePath(editor.document.fileName);
    const rawChunks = await splitByMethods(editor.document, maxContentChars);
    const methodLabels: string[][] | undefined = (rawChunks as any).__labels;

    return rawChunks.map((chunk, i) => {
      let label: string;
      let scope: string | undefined;
      if (methodLabels && methodLabels[i] && methodLabels[i].length > 0) {
        const names = methodLabels[i].slice(0, 3).join(", ") + (methodLabels[i].length > 3 ? ", …" : "");
        label = names;
        scope = names;
      } else {
        const lines = chunk.split("\n");
        label = `${fileName}: ${lines.length} lines`;
      }
      return { prompt: `${chunk}${buildFileInstruction(fileName, scope)}`, label };
    });
  }

  webviewView.webview.postMessage({
    type: "chatError",
    message: "No active file open and no input provided. Enter a prompt, file path, or open a file.",
  });
  return null;
}

// ---------------------------------------------------------------------------
// Chunked review orchestrator
// ---------------------------------------------------------------------------

export async function runChunkedReview(
  chunks: ReviewChunk[],
  model: string,
  webviewView: vscode.WebviewView,
  singleDisplayText: string,
  sendChat: (opts: SendChatOpts) => Promise<SendChatResult>,
  getCancelled: () => boolean,
  setCancelled: (v: boolean) => void,
  maxContentChars: number,
  displayModel?: string
): Promise<void> {
  setCancelled(false);

  if (chunks.length > 1) {
    webviewView.webview.postMessage({
      type: "systemMessage",
      text: `📋 Content split into ${chunks.length} parts (limit: ${maxContentChars.toLocaleString()} chars). Reviewing each part in sequence...`,
    });
  }

  const responses: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (getCancelled()) { break; }

    if (chunks.length > 1) {
      webviewView.webview.postMessage({
        type: "systemMessage",
        text: `— Part ${i + 1} of ${chunks.length}: ${chunks[i].label} —`,
      });
    }

    const result = await sendChat({
      prompt: chunks[i].prompt,
      displayText: chunks.length > 1 ? `[Part ${i + 1}/${chunks.length}] ${chunks[i].label}` : singleDisplayText,
      model,
      webviewView,
      isSystemMessage: true,
      historyOverride: [],
      jsonSchema: REVIEW_JSON_SCHEMA,
      displayModel,
    });
    responses.push(result.text);
  }

  if (chunks.length > 1 && responses.length === chunks.length && !getCancelled()) {
    webviewView.webview.postMessage({ type: "systemMessage", text: "— Generating combined summary across all parts —" });

    const allFindings: ReviewFinding[] = responses.flatMap(r => {
      try { return (JSON.parse(r) as ReviewResponse).findings ?? []; } catch { return []; }
    });

    const seenTitles = new Set<string>();
    const uniqueFindings = allFindings.filter(f => {
      const key = f.title.toLowerCase().trim();
      if (seenTitles.has(key)) { return false; }
      seenTitles.add(key);
      return true;
    });

    const ratingInstruction = `Return a JSON object with exactly:\n- "findings": array of at most 8 findings (severity/category/title/description per item). Include findings across all severity levels present in the input — do not omit Critical or Warning items.\n- "rating": exactly one of "Looks Good", "Needs Minor Changes", "Needs Major Revision"`;
    const findingsSummary = uniqueFindings.length > 0
      ? uniqueFindings.map(f => `• [${f.severity}/${f.category}] ${f.title}`).join('\n')
      : responses.map((r, i) => `Part ${i + 1} (${chunks[i].label}):\n${r.slice(0, 500)}`).join('\n\n');
    const summaryPrompt = `Here are findings from ${chunks.length} parts of the code review:\n${findingsSummary}\n\n${ratingInstruction}`;

    await sendChat({
      prompt: summaryPrompt,
      displayText: "Combined summary across all parts",
      model,
      webviewView,
      isSystemMessage: true,
      skipExchangeCount: true,
      jsonSchema: REVIEW_JSON_SCHEMA,
      displayModel,
    });
  }
}
