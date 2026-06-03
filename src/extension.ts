import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { GitExtension } from "./git.d";
import {
  getProvider,
  getAllProviders,
  getOllamaProvider,
  type LLMProvider,
  type ChatMessage,
} from "./provider";
import {
  reviewerModelExists,
  createReviewerModel,
  deleteReviewerModel,
  getReviewerModelName,
  listReviewerModels,
  unloadOllamaModel,
} from "./modelfile";
import { marked } from "marked";

const outputChannel = vscode.window.createOutputChannel("Raiview");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXCHANGES = 20;
const WARN_EXCHANGES = 16;
const SUMMARY_THRESHOLD = 5;
// Default max content chars — overridden at runtime by raiview.maxContentChars setting
// ~10000 chars ≈ 3300 tokens, fits within 4096 context leaving room for system prompt + response
const DEFAULT_MAX_CONTENT_CHARS = 10000;

const GUARDRAILS = `You are operating as a code reviewer within a focused review session.

IMPORTANT CONTEXT: The code to be reviewed is provided in this conversation — either in the current message or in an earlier message. Do NOT ask the user to paste or provide it again. If the user asks you to re-review or revisit, refer back to the code already shared.

CRITICAL RULES — follow these in every response:
1. FILE MODIFICATIONS: If the user asks you to make changes to files, modify files, apply changes, or edit code on their behalf: politely explain that you cannot modify files directly as a reviewer. Instead, provide a concise code snippet showing exactly what the change would look like, and describe where in the file it should be applied.
2. MULTI-FILE CHANGES: If the user asks for changes across multiple files simultaneously: First analyze which files depend on each other (type definitions, utility functions, interfaces). Produce a dependency-ordered plan — list changes starting from files with no dependencies first, then files that depend on those. Tell the user to ask for each step one at a time. Do NOT provide all code changes at once.
3. SCOPE: Every follow-up question must relate to the code being reviewed or the review feedback provided. If the user asks something unrelated to the code or the review (general knowledge, creative tasks, unrelated topics), respond with exactly: "Please keep questions related to the current code review. Ask me anything about the code or feedback provided." Do not elaborate further on off-topic requests.`;

const SUMMARY_SYSTEM_PROMPT =
  "You are a helpful assistant that summarizes technical code review conversations concisely.";

const SUMMARY_USER_PROMPT = `Summarize this code review conversation concisely. Preserve:
- File names, functions, and line numbers discussed
- Issues found with their severity (critical/warning/suggestion)
- Code snippets discussed (keep verbatim in fenced blocks)
- What the user has already fixed vs. still outstanding
- Any decisions or action items agreed upon
Output only the summary, no preamble.

Conversation:
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  model?: string;
  provider?: string;
}

interface ChatSession {
  id: string;
  startedAt: number;
  title: string;
  provider: string;
  model: string;
  messages: StoredMessage[];
  exchangeCount: number;
}

interface ReviewChunk {
  prompt: string;
  label: string;
}

interface ReviewFinding {
  severity: "Critical" | "Warning" | "Suggestion";
  category: "Correctness" | "Security" | "Performance" | "Design" | "Readability" | "Error Handling";
  title: string;
  description: string;
}

interface ReviewResponse {
  findings: ReviewFinding[];
  rating: "Looks Good" | "Needs Minor Changes" | "Needs Major Revision";
}

const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["Critical", "Warning", "Suggestion"] },
          category: { type: "string", enum: ["Correctness", "Security", "Performance", "Design", "Readability", "Error Handling"] },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "category", "title", "description"],
      },
    },
    rating: { type: "string", enum: ["Looks Good", "Needs Minor Changes", "Needs Major Revision"] },
  },
  required: ["findings", "rating"],
} as const;

// ---------------------------------------------------------------------------
// Git review command entry point (registered as VS Code command)
// ---------------------------------------------------------------------------

export function reviewChanges() {
  vscode.window.showInformationMessage(
    "Please use the 'Review Git Changes' button in the extension side panel."
  );
}

// ---------------------------------------------------------------------------
// File / folder reader (supports Windows, WSL UNC, and Linux paths)
// ---------------------------------------------------------------------------

function tryWslPath(linuxPath: string): string | null {
  try {
    const winPath = execSync(`wsl wslpath -w "${linuxPath}"`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (winPath && fs.existsSync(winPath)) {
      return winPath;
    }
  } catch {
    // wsl not available or path doesn't exist
  }
  return null;
}

function wslReadFile(linuxPath: string): string | null {
  try {
    return execSync(`wsl cat "${linuxPath}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    return null;
  }
}

function wslExists(linuxPath: string): "file" | "dir" | false {
  try {
    const result = execSync(
      `wsl bash -c "if [ -d '${linuxPath}' ]; then echo dir; elif [ -f '${linuxPath}' ]; then echo file; else echo none; fi"`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    if (result === "dir") { return "dir"; }
    if (result === "file") { return "file"; }
  } catch { /* ignore */ }
  return false;
}

function wslReadDir(linuxPath: string): string {
  try {
    const listing = execSync(
      `wsl bash -c "for f in '${linuxPath}'/*; do if [ -f \\"\\$f\\" ]; then echo \\"\\$f\\"; fi; done"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!listing) {
      return `Directory: ${linuxPath}\n(empty or no readable files)`;
    }
    const files = listing.split("\n").filter(Boolean);
    const parts: string[] = [`Directory: ${linuxPath}\n`];
    for (const f of files) {
      const name = f.split("/").pop() ?? f;
      const content = wslReadFile(f);
      if (content !== null) {
        parts.push(`--- ${name} ---\n${content}\n`);
      } else {
        parts.push(`--- ${name} --- (could not read)\n`);
      }
    }
    return parts.join("\n");
  } catch {
    return `⚠ Could not read WSL directory: ${linuxPath}`;
  }
}

function isFilePath(input: string): boolean {
  if (/^[a-zA-Z]:[/\\]/.test(input)) { return true; }
  if (input.startsWith("\\\\")) { return true; }
  if (input.startsWith("/")) { return true; }
  if (input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\")) { return true; }
  try { return fs.existsSync(path.resolve(input)); } catch { return false; }
}

function uncToLinuxPath(uncPath: string): string | null {
  const match = uncPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$/i);
  if (match) {
    return "/" + match[2].replace(/\\/g, "/");
  }
  return null;
}

interface ReadResult {
  ok: boolean;
  content: string;
}

function readWindowsDir(dirPath: string): string {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const parts: string[] = [`Directory: ${dirPath}\n`];
  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = path.join(dirPath, entry.name);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        parts.push(`--- ${entry.name} ---\n${content}\n`);
      } catch {
        parts.push(`--- ${entry.name} --- (could not read)\n`);
      }
    }
  }
  return parts.join("\n");
}

function readFileOrFolder(inputPath: string): ReadResult {
  if (inputPath.startsWith("\\\\")) {
    try {
      if (fs.existsSync(inputPath)) {
        const stat = fs.statSync(inputPath);
        if (stat.isFile()) {
          return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(inputPath, "utf-8")}` };
        }
        if (stat.isDirectory()) {
          return { ok: true, content: readWindowsDir(inputPath) };
        }
      }
    } catch { /* UNC access failed, try WSL fallback */ }

    const linuxPath = uncToLinuxPath(inputPath);
    if (linuxPath) {
      const type = wslExists(linuxPath);
      if (type === "file") {
        const content = wslReadFile(linuxPath);
        if (content !== null) {
          return { ok: true, content: `File: ${inputPath}\n\n${content}` };
        }
      } else if (type === "dir") {
        return { ok: true, content: wslReadDir(linuxPath) };
      }
    }
    return { ok: false, content: `Path not accessible: ${inputPath}\nEnsure WSL is running and the path exists.` };
  }

  if (inputPath.startsWith("/")) {
    const winPath = tryWslPath(inputPath);
    if (winPath) {
      try {
        if (fs.existsSync(winPath)) {
          const stat = fs.statSync(winPath);
          if (stat.isFile()) {
            return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(winPath, "utf-8")}` };
          }
          if (stat.isDirectory()) {
            return { ok: true, content: readWindowsDir(winPath) };
          }
        }
      } catch { /* fall through */ }
    }
    const type = wslExists(inputPath);
    if (type === "file") {
      const content = wslReadFile(inputPath);
      if (content !== null) {
        return { ok: true, content: `File: ${inputPath}\n\n${content}` };
      }
    } else if (type === "dir") {
      return { ok: true, content: wslReadDir(inputPath) };
    }
    return { ok: false, content: `Path not found: ${inputPath}\nIf this is a WSL path, ensure WSL is running.` };
  }

  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, content: `Path not found: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return { ok: true, content: `File: ${resolved}\n\n${fs.readFileSync(resolved, "utf-8")}` };
  }
  if (stat.isDirectory()) {
    return { ok: true, content: readWindowsDir(resolved) };
  }
  return { ok: false, content: `Unsupported path type: ${resolved}` };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let modelFetchSeq = 0;

async function fetchModelsForWebview(
  providerName: string,
  apiKey: string | undefined,
  webviewView: vscode.WebviewView
) {
  const seq = ++modelFetchSeq;
  if (providerName === "ollama") {
    const pinned = vscode.workspace.getConfiguration("raiview").get<string[]>("ollamaModels") ?? [];
    const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
    const isLocal = (() => { try { const h = new URL(ollamaUrl).hostname; return h === "localhost" || h === "127.0.0.1" || h === "::1"; } catch { return true; } })();
    if (pinned.length > 0 && !isLocal) {
      if (seq !== modelFetchSeq) { return; }
      webviewView.webview.postMessage({ type: "models", available: pinned });
      await sendReviewerModelsForWebview(webviewView);
      return;
    }
  }
  const provider = getProvider(providerName);
  if (!provider) {
    webviewView.webview.postMessage({ type: "error", message: `Unknown provider: ${providerName}` });
    return;
  }
  try {
    const models = await provider.listModels(apiKey);
    if (seq !== modelFetchSeq) { return; }
    webviewView.webview.postMessage({ type: "models", available: models });
  } catch (err: any) {
    if (seq !== modelFetchSeq) { return; }
    webviewView.webview.postMessage({
      type: "error",
      message: `Could not fetch models for ${provider.displayName}: ${err.message ?? err}`,
    });
  }
  if (providerName === "ollama") {
    await sendReviewerModelsForWebview(webviewView);
  }
}

async function sendReviewerModelsForWebview(webviewView: vscode.WebviewView) {
  const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
  const models = await listReviewerModels(ollamaUrl);
  webviewView.webview.postMessage({ type: "derivedModelsList", models });
}

const DEFAULT_REVIEW_SYSTEM_PROMPT =
  "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
  "Do NOT summarise, explain, or paraphrase the code. Only report actual issues you find. " +
  "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
  "Review only the code provided across these categories: Correctness, Design, Security, Performance, Readability, and Error Handling. " +
  "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. Do NOT focus disproportionately on any single category. " +
  "Do not repeat any finding already stated.";

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

class SidePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "raiview.sidePanel";

  // Provider / UI settings
  private activeProvider = "ollama";
  private systemPrompt = "";
  private streamingMode: "chunked" | "complete" = "chunked";
  private enhancedReviewer = false;

  // Chat state
  private chatHistory: StoredMessage[] = [];
  private exchangeCount = 0;
  private currentModel = "";
  private activeSessionTrigger: "git" | "file" | null = null;
  private activeAbortController: AbortController | null = null;
  private reviewCancelled = false;

  // Rolling summary state
  private latestSummary: string | null = null;
  private summaryGenerationId = 0;

  // Webview reference (set when the panel is first opened)
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("raiview");
    this.activeProvider = config.get<string>("defaultProvider") ?? "ollama";
    this.systemPrompt = config.get<string>("defaultSystemPrompt") ?? "";
    this.streamingMode =
      (config.get<string>("streamingMode") as "chunked" | "complete") ?? "chunked";
    this.enhancedReviewer = config.get<boolean>("enhancedReviewer") ?? false;
    getOllamaProvider().setBaseUrl(config.get<string>("ollamaUrl") ?? "http://localhost:11434");

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("raiview.ollamaUrl")) {
        getOllamaProvider().setBaseUrl(
          vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434"
        );
      }
    }, undefined, context.subscriptions);
  }

  // -------------------------------------------------------------------------
  // API key helpers
  // -------------------------------------------------------------------------

  private async getApiKey(providerName: string): Promise<string | undefined> {
    return this.context.secrets.get(`raiview.apiKey.${providerName}`);
  }

  private async setApiKey(providerName: string, key: string): Promise<void> {
    await this.context.secrets.store(`raiview.apiKey.${providerName}`, key);
  }

  // -------------------------------------------------------------------------
  // Context building
  // -------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    const base = this.systemPrompt.trim() || DEFAULT_REVIEW_SYSTEM_PROMPT;
    const summarySection = this.latestSummary
      ? `\n\nPrior conversation summary:\n${this.latestSummary}`
      : "";

    const priorModels = [...new Set(
      this.chatHistory
        .filter(m => m.role === "assistant" && m.model && m.model !== this.currentModel)
        .map(m => m.model!)
    )];
    const attributionSection = priorModels.length > 0
      ? `\n\nNote: This conversation includes messages previously generated by: ${priorModels.join(", ")}. You are now the active model. Continue the review with full awareness of the prior context — those previous responses were from a different model.`
      : "";

    return `${GUARDRAILS}\n\n${base}${summarySection}${attributionSection}`;
  }

  private buildHistoryForProvider(): ChatMessage[] {
    const all = this.chatHistory.map((m) => ({ role: m.role, content: m.content }));
    if (this.exchangeCount <= SUMMARY_THRESHOLD || !this.latestSummary) {
      return all;
    }
    // Summary injected into systemPrompt; only send last 2 exchanges raw
    return all.slice(-4);
  }

  // -------------------------------------------------------------------------
  // Background summary (fire-and-forget, never blocks user)
  // -------------------------------------------------------------------------

  private triggerBackgroundSummary(provider: LLMProvider, apiKey: string | undefined): void {
    if (this.exchangeCount < SUMMARY_THRESHOLD) { return; }
    const genId = ++this.summaryGenerationId;

    const historyText = this.chatHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    provider
      .generate({
        model: this.currentModel,
        prompt: SUMMARY_USER_PROMPT + historyText,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        apiKey,
        stream: false,
      })
      .then((summary) => {
        if (genId === this.summaryGenerationId) {
          this.latestSummary = summary;
        }
      })
      .catch(() => { /* fail silently */ });
  }

  // -------------------------------------------------------------------------
  // Session persistence
  // -------------------------------------------------------------------------

  private async saveCurrentSession(): Promise<void> {
    if (this.exchangeCount === 0) { return; }
    const sessions = this.context.globalState.get<ChatSession[]>("raiview.chatSessions", []);
    const first = this.chatHistory[0];
    const rawTitle = first?.content ?? "Review session";
    // Strip the large diff/file content from the title — use first line only
    const firstLine = rawTitle.split("\n")[0].trim();
    sessions.unshift({
      id: Date.now().toString(),
      startedAt: first?.timestamp ?? Date.now(),
      title: firstLine.slice(0, 60),
      provider: this.activeProvider,
      model: this.currentModel,
      messages: [...this.chatHistory],
      exchangeCount: this.exchangeCount,
    });
    await this.context.globalState.update("raiview.chatSessions", sessions.slice(0, 5));
  }

  private async startNewSession(webviewView: vscode.WebviewView): Promise<void> {
    this.reviewCancelled = true;  // halt any running chunked review loop
    await this.saveCurrentSession();
    const config = vscode.workspace.getConfiguration("raiview");
    if (this.activeProvider === "ollama" && this.currentModel && config.get<boolean>("autoUnloadModel")) {
      const ollamaUrl = config.get<string>("ollamaUrl") ?? "http://localhost:11434";
      await unloadOllamaModel(this.currentModel, ollamaUrl);
    }
    this.chatHistory = [];
    this.exchangeCount = 0;
    this.activeSessionTrigger = null;
    this.latestSummary = null;
    this.summaryGenerationId++;
    this.currentModel = "";
    webviewView.webview.postMessage({ type: "newSessionStarted" });
    const sessions = this.context.globalState.get<ChatSession[]>("raiview.chatSessions", []);
    webviewView.webview.postMessage({ type: "historyLoaded", sessions });
  }

  // -------------------------------------------------------------------------
  // Core send method — all AI calls funnel through here
  // -------------------------------------------------------------------------

  private tryParseReview(text: string): ReviewResponse | undefined {
    // Full parse
    try { return JSON.parse(text) as ReviewResponse; } catch { /* try recovery */ }
    // Recovery: truncated JSON — find the last complete finding object and close the structure
    const lastClose = text.lastIndexOf('"}');
    if (lastClose === -1) { return undefined; }
    const truncated = text.slice(0, lastClose + 2);
    // Find the findings array start
    const findingsStart = truncated.indexOf('"findings"');
    if (findingsStart === -1) { return undefined; }
    const arrayStart = truncated.indexOf('[', findingsStart);
    if (arrayStart === -1) { return undefined; }
    try {
      const partial = JSON.parse(truncated.slice(arrayStart) + ']') as ReviewFinding[];
      return { findings: partial, rating: "Needs Minor Changes" };
    } catch { return undefined; }
  }

  private async sendChat(opts: {
    prompt: string;
    displayText: string;
    model: string;
    webviewView: vscode.WebviewView;
    isSystemMessage?: boolean;
    skipExchangeCount?: boolean;
    historyOverride?: ChatMessage[];
    jsonSchema?: object;
    displayModel?: string;
  }): Promise<{ text: string; structured?: ReviewResponse }> {
    const { prompt, displayText, model, webviewView, isSystemMessage, skipExchangeCount } = opts;
    const attributionModel = opts.displayModel ?? model;
    const provider = getProvider(this.activeProvider);
    if (!provider) {
      webviewView.webview.postMessage({
        type: "chatError",
        message: `Unknown provider: ${this.activeProvider}`,
      });
      return { text: "" };
    }

    const apiKey = await this.getApiKey(this.activeProvider);
    const history = opts.historyOverride !== undefined
      ? opts.historyOverride
      : this.buildHistoryForProvider();
    const systemPrompt = this.buildSystemPrompt();
    const isStreaming = this.streamingMode === "chunked";

    // Show the output channel on the first call of a new session so token stats are visible
    if (this.exchangeCount === 0 && !skipExchangeCount) {
      outputChannel.show(true); // preserveFocus=true — don't steal keyboard from editor
    }
    const userTimestamp = Date.now();
    const numCtx = this.activeProvider === "ollama"
      ? (vscode.workspace.getConfiguration("raiview").get<number>("ollamaContextWindow") ?? 8192)
      : undefined;
    const numPredict = this.activeProvider === "ollama"
      ? (vscode.workspace.getConfiguration("raiview").get<number>("ollamaNumPredict") ?? 2000)
      : undefined;

    this.currentModel = model;

    // Show the message in the chat (system triggers use a neutral label, not a user bubble)
    webviewView.webview.postMessage({
      type: isSystemMessage ? "systemMessage" : "userMessage",
      text: displayText,
      timestamp: userTimestamp,
    });

    // Add to history (prompt may differ from displayText for review triggers)
    this.chatHistory.push({ role: "user", content: prompt, timestamp: userTimestamp });

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    webviewView.webview.postMessage({ type: "generationStarted" });

    try {
      webviewView.webview.postMessage({ type: "aiThinking" });

      let fullResponse = "";

      if (isStreaming) {
        webviewView.webview.postMessage({ type: "streamStart" });
        let accumulated = "";
        let parseTimer: ReturnType<typeof setTimeout> | null = null;

        const sendParsedUpdate = async () => {
          try {
            const html = await marked(accumulated);
            webviewView.webview.postMessage({ type: "streamUpdate", html });
          } catch { /* ignore during streaming */ }
        };

        fullResponse = await provider.generate({
          model,
          prompt,
          systemPrompt,
          apiKey,
          stream: true,
          history,
          signal: abortController.signal,
          numCtx,
          numPredict,
          jsonSchema: opts.jsonSchema,
          onToken: (token: string) => {
            accumulated += token;
            if (!parseTimer) {
              parseTimer = setTimeout(() => {
                parseTimer = null;
                sendParsedUpdate();
              }, 300);
            }
          },
          onUsage: (inputTokens: number, outputTokens: number) => {
            outputChannel.appendLine(
              `[${new Date().toLocaleTimeString()}] ${this.activeProvider} / ${model}` +
              ` | input: ${inputTokens.toLocaleString()} tokens` +
              ` | output: ${outputTokens.toLocaleString()} tokens` +
              ` | total: ${(inputTokens + outputTokens).toLocaleString()} tokens`
            );
          },
        });

        if (parseTimer) { clearTimeout(parseTimer); }
        let structured: ReviewResponse | undefined;
        if (opts.jsonSchema) {
          structured = this.tryParseReview(fullResponse);
        }
        const html = structured ? undefined : await marked(fullResponse);
        webviewView.webview.postMessage({ type: "streamEnd", html, structured, model: attributionModel, timestamp: Date.now() });
      } else {
        fullResponse = await provider.generate({
          model,
          prompt,
          systemPrompt,
          apiKey,
          stream: false,
          history,
          signal: abortController.signal,
          numCtx,
          numPredict,
          jsonSchema: opts.jsonSchema,
          onUsage: (inputTokens: number, outputTokens: number) => {
            outputChannel.appendLine(
              `[${new Date().toLocaleTimeString()}] ${this.activeProvider} / ${model}` +
              ` | input: ${inputTokens.toLocaleString()} tokens` +
              ` | output: ${outputTokens.toLocaleString()} tokens` +
              ` | total: ${(inputTokens + outputTokens).toLocaleString()} tokens`
            );
          },
        });
        let structured: ReviewResponse | undefined;
        if (opts.jsonSchema) {
          structured = this.tryParseReview(fullResponse);
        }
        const html = structured ? undefined : await marked(fullResponse);
        webviewView.webview.postMessage({ type: "chatMessage", html, structured, model: attributionModel, timestamp: Date.now() });
      }

      // Record AI response in history
      this.chatHistory.push({
        role: "assistant",
        content: fullResponse,
        timestamp: Date.now(),
        model,
        provider: this.activeProvider,
      });
      if (!skipExchangeCount) {
        this.exchangeCount++;
      }

      // Reveal follow-up input and update exchange counter
      webviewView.webview.postMessage({ type: "showFollowup" });
      webviewView.webview.postMessage({
        type: "exchangeUpdate",
        count: this.exchangeCount,
        limit: MAX_EXCHANGES,
        warn: WARN_EXCHANGES,
      });

      // Fire-and-forget background summary after threshold
      this.triggerBackgroundSummary(provider, apiKey);

      let structured: ReviewResponse | undefined;
      if (opts.jsonSchema) {
        try { structured = JSON.parse(fullResponse) as ReviewResponse; } catch { /* fallback */ }
      }
      return { text: fullResponse, structured };

    } catch (err: any) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        // User stopped generation — show partial response if any, don't show error
        webviewView.webview.postMessage({ type: "generationStopped" });
      } else {
        // Roll back the optimistic history entry
        this.chatHistory.pop();
        webviewView.webview.postMessage({
          type: "chatError",
          message: `${provider.displayName} error: ${err.message ?? err}`,
        });
      }
      return { text: "" };
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      webviewView.webview.postMessage({ type: "generationEnded" });
    }
  }

  // -------------------------------------------------------------------------
  // Prompt builders
  // -------------------------------------------------------------------------

  private get maxContentChars(): number {
    return vscode.workspace.getConfiguration("raiview").get<number>("maxContentChars") ?? DEFAULT_MAX_CONTENT_CHARS;
  }

  private splitDiffByFile(diffText: string): string[] {
    return diffText.split(/(?=^diff --git )/m).filter(s => s.trim());
  }

  private splitByLineChunks(content: string): string[] {
    const limit = this.maxContentChars;
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

  private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    return symbols.flatMap(s => [s, ...this.flattenSymbols(s.children)]);
  }

  private async splitByMethods(document: vscode.TextDocument): Promise<string[]> {
    const limit = this.maxContentChars;
    let symbols: vscode.DocumentSymbol[] = [];
    try {
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider", document.uri
      );
      symbols = result ?? [];
    } catch { /* fall through to line-based split */ }

    const flat = this.flattenSymbols(symbols)
      .filter(s => [
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Constructor,
        vscode.SymbolKind.Class,
      ].includes(s.kind))
      .sort((a, b) => a.range.start.line - b.range.start.line);

    if (flat.length === 0) {
      return this.splitByLineChunks(document.getText());
    }

    const chunks: string[] = [];
    let current = "";
    let currentLabels: string[] = [];
    const allLabels: string[][] = [];

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
    if (current) {
      chunks.push(current);
      allLabels.push(currentLabels);
    }

    // Attach labels to chunks via a parallel array — callers use buildFileChunks which wraps them
    (chunks as any).__labels = allLabels;
    return chunks;
  }

  private async buildGitChunks(
    webviewView: vscode.WebviewView
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
    const pathspecExclusions = excludeExts.map(ext => `:(exclude)*${ext.startsWith(".") ? ext : "." + ext}`);
    const excludeArg = pathspecExclusions.length > 0 ? ` -- . ${pathspecExclusions.map(p => `"${p}"`).join(" ")}` : "";
    const extFilter = (f: string) => excludeExts.length === 0 || !excludeExts.some(ext => f.endsWith(ext.startsWith(".") ? ext : "." + ext));

    try {
      untrackedFiles = execSync(`git ls-files --others --exclude-standard`, {
        cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000,
      }).trim().split("\n").filter(Boolean).filter(extFilter);
    } catch (e) {
      outputChannel.appendLine(`[git] ls-files failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      diffFiles = execSync(`git diff --name-only HEAD${excludeArg}`, {
        cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000,
      }).trim().split("\n").filter(Boolean);
      diffText = execSync(`git diff HEAD${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
    } catch (e) {
      outputChannel.appendLine(`[git] diff HEAD failed, trying staged+unstaged fallback: ${e instanceof Error ? e.message : String(e)}`);
      try {
        const staged = execSync(`git diff --name-only --cached${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim().split("\n").filter(Boolean);
        const unstaged = execSync(`git diff --name-only${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim().split("\n").filter(Boolean);
        diffFiles = [...new Set([...staged, ...unstaged])];
        const d1 = execSync(`git diff --cached${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
        const d2 = execSync(`git diff${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
        diffText = d1 + "\n" + d2;
      } catch (e2) {
        outputChannel.appendLine(`[git] staged+unstaged fallback also failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        webviewView.webview.postMessage({ type: "chatError", message: "Could not read git diff. Check the Output panel for details." });
        return null;
      }
    }

    const allFiles = [...new Set([...diffFiles, ...untrackedFiles])];
    if (allFiles.length === 0) {
      webviewView.webview.postMessage({
        type: "chatError",
        message: "No changes in git control that can be reviewed.",
      });
      return null;
    }

    // Build per-unit blocks: each tracked file's diff + each untracked file's content
    interface DiffUnit { content: string; fileName: string; }
    const units: DiffUnit[] = [];

    if (diffText) {
      for (const block of this.splitDiffByFile(diffText)) {
        // Extract filename from the diff --git header
        const match = block.match(/^diff --git a\/(.+?) b\//m);
        const fileName = match ? match[1] : "changed file";
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
            units.push({
              content: `New Untracked File: ${file}\n\`\`\`\n${content}\n\`\`\``,
              fileName: file,
            });
          } catch { /* ignore */ }
        }
      }
    }

    const limit = this.maxContentChars;

    const buildGitInstruction = (files: string[]): string => {
      const fileList = files.map(f => `• ${f}`).join("\n");
      return `\n\nReview ALL of the following files/sections present above:\n${fileList}\n\nReturn a JSON object with exactly these two fields:\n- "findings": array of at most 5 findings (prioritise the most impactful), where each item has severity ("Critical", "Warning", or "Suggestion"), category ("Correctness", "Security", "Performance", "Design", "Readability", or "Error Handling"), title (short string), description (one sentence string)\n- "rating": exactly one of these three strings: "Looks Good", "Needs Minor Changes", "Needs Major Revision"\nCover every file listed. Do NOT echo the diff.`;
    };

    // Greedily bin-pack units into chunks
    const chunks: ReviewChunk[] = [];
    let currentContent = "";
    let currentFiles: string[] = [];

    const flushChunk = () => {
      if (currentContent) {
        chunks.push({
          prompt: currentContent + buildGitInstruction(currentFiles),
          label: currentFiles.join(", "),
        });
      }
      currentContent = "";
      currentFiles = [];
    };

    for (const unit of units) {
      // If a single unit is already over the limit, split it at line boundaries
      if (unit.content.length > limit) {
        flushChunk();
        const subChunks = this.splitByLineChunks(unit.content);
        for (let i = 0; i < subChunks.length; i++) {
          const subLabel = subChunks.length > 1
            ? `${unit.fileName} (part ${i + 1}/${subChunks.length})`
            : unit.fileName;
          chunks.push({
            prompt: subChunks[i] + buildGitInstruction([unit.fileName]),
            label: subLabel,
          });
        }
        continue;
      }

      const separator = currentContent ? "\n\n" : "";
      if (currentContent.length + separator.length + unit.content.length > limit && currentContent.length > 0) {
        flushChunk();
      }
      currentContent += (currentContent ? "\n\n" : "") + unit.content;
      currentFiles.push(unit.fileName);
    }
    flushChunk();

    return chunks;
  }

  private async buildFileChunks(
    customInput: string,
    webviewView: vscode.WebviewView
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
        const rawChunks = this.splitByLineChunks(result.content);
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
      // Plain text / follow-up prompt — send as-is (single chunk, no review instruction appended)
      return [{ prompt: input, label: "custom input" }];
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const fileName = vscode.workspace.asRelativePath(editor.document.fileName);
      const rawChunks = await this.splitByMethods(editor.document);
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
        return {
          prompt: `${chunk}${buildFileInstruction(fileName, scope)}`,
          label,
        };
      });
    }

    webviewView.webview.postMessage({
      type: "chatError",
      message: "No active file open and no input provided. Enter a prompt, file path, or open a file.",
    });
    return null;
  }

  // -------------------------------------------------------------------------
  // Chunked review orchestrator
  // -------------------------------------------------------------------------

  private async runChunkedReview(
    chunks: ReviewChunk[],
    model: string,
    webviewView: vscode.WebviewView,
    singleDisplayText: string,
    displayModel?: string
  ): Promise<void> {
    this.reviewCancelled = false;  // reset for this review run

    if (chunks.length > 1) {
      webviewView.webview.postMessage({
        type: "systemMessage",
        text: `📋 Content split into ${chunks.length} parts (limit: ${this.maxContentChars.toLocaleString()} chars). Reviewing each part in sequence...`,
      });
    }

    const responses: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (this.reviewCancelled) { break; }

      if (chunks.length > 1) {
        webviewView.webview.postMessage({
          type: "systemMessage",
          text: `— Part ${i + 1} of ${chunks.length}: ${chunks[i].label} —`,
        });
      }

      const result = await this.sendChat({
        prompt: chunks[i].prompt,
        displayText: chunks.length > 1
          ? `[Part ${i + 1}/${chunks.length}] ${chunks[i].label}`
          : singleDisplayText,
        model,
        webviewView,
        isSystemMessage: true,
        historyOverride: [],  // each chunk reviewed in isolation — no cross-chunk contamination
        jsonSchema: REVIEW_JSON_SCHEMA,
        displayModel,
      });
      responses.push(result.text);
    }

    // Combined summary across all chunks — not counted as an exchange
    if (chunks.length > 1 && responses.length === chunks.length && !this.reviewCancelled) {
      webviewView.webview.postMessage({
        type: "systemMessage",
        text: "— Generating combined summary across all parts —",
      });

      // Collect all structured findings; fall back to text injection if parsing failed
      const allFindings: ReviewFinding[] = responses.flatMap(r => {
        try { return (JSON.parse(r) as ReviewResponse).findings ?? []; } catch { return []; }
      });

      // De-duplicate by title before sending to the model — prevents repeated findings
      // for functions that appear across multiple files (e.g. encode_scaled)
      const seenTitles = new Set<string>();
      const uniqueFindings = allFindings.filter(f => {
        const key = f.title.toLowerCase().trim();
        if (seenTitles.has(key)) { return false; }
        seenTitles.add(key);
        return true;
      });

      const ratingInstruction = `Return a JSON object with exactly:\n- "findings": array of at most 8 findings (severity/category/title/description per item). Include findings across all severity levels present in the input — do not omit Critical or Warning items.\n- "rating": exactly one of "Looks Good", "Needs Minor Changes", "Needs Major Revision"`;
      // Use a compact bullet list instead of full JSON to avoid consuming the model's output budget
      const findingsSummary = uniqueFindings.length > 0
        ? uniqueFindings.map(f => `• [${f.severity}/${f.category}] ${f.title}`).join('\n')
        : responses.map((r, i) => `Part ${i + 1} (${chunks[i].label}):\n${r.slice(0, 500)}`).join('\n\n');
      const summaryPrompt = `Here are findings from ${chunks.length} parts of the code review:\n${findingsSummary}\n\n${ratingInstruction}`;

      await this.sendChat({
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

  // -------------------------------------------------------------------------
  // Webview view resolver
  // -------------------------------------------------------------------------

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
    );
    webviewView.webview.html = this.getHtml(scriptUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready": {
          const hasKey = !!(await this.getApiKey(this.activeProvider));
          const providerKeyStatus: Record<string, boolean> = {};
          for (const p of getAllProviders()) {
            providerKeyStatus[p.name] = !!(await this.getApiKey(p.name));
          }
          webviewView.webview.postMessage({
            type: "init",
            providers: getAllProviders().map((p) => ({
              name: p.name,
              displayName: p.displayName,
              requiresApiKey: p.requiresApiKey,
            })),
            activeProvider: this.activeProvider,
            hasApiKey: hasKey,
            providerKeyStatus,
            streamingMode: this.streamingMode,
            enhancedReviewer: this.enhancedReviewer,
            systemPrompt: this.systemPrompt,
            autoUnloadModel: vscode.workspace.getConfiguration("raiview").get<boolean>("autoUnloadModel") ?? false,
            ollamaUrl: vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434",
            ollamaModels: vscode.workspace.getConfiguration("raiview").get<string[]>("ollamaModels") ?? [],
          });
          fetchModelsForWebview(
            this.activeProvider,
            await this.getApiKey(this.activeProvider),
            webviewView
          );
          const sessions = this.context.globalState.get<ChatSession[]>("raiview.chatSessions", []);
          webviewView.webview.postMessage({ type: "historyLoaded", sessions });
          break;
        }

        case "refreshModels": {
          fetchModelsForWebview(
            this.activeProvider,
            await this.getApiKey(this.activeProvider),
            webviewView
          );
          break;
        }

        case "saveOllamaUrl": {
          const newUrl = ((message.url as string) ?? "").trim() || "http://localhost:11434";
          await vscode.workspace.getConfiguration("raiview").update("ollamaUrl", newUrl, vscode.ConfigurationTarget.Global);
          getOllamaProvider().setBaseUrl(newUrl);
          if (this.activeSessionTrigger !== null) {
            webviewView.webview.postMessage({
              type: "systemMessage",
              text: `Ollama URL changed to ${newUrl} mid-session. The full conversation history will be sent to this endpoint.`,
            });
          }
          fetchModelsForWebview("ollama", await this.getApiKey("ollama"), webviewView);
          break;
        }

        case "savePinnedModels": {
          const models = (message.models as string[]).filter(Boolean);
          await vscode.workspace.getConfiguration("raiview").update("ollamaModels", models, vscode.ConfigurationTarget.Global);
          fetchModelsForWebview("ollama", await this.getApiKey("ollama"), webviewView);
          break;
        }

        case "setProvider": {
          const newProvider = message.provider;
          if (
            this.activeSessionTrigger !== null &&
            newProvider !== this.activeProvider &&
            (getProvider(newProvider)?.requiresApiKey ?? false)
          ) {
            const displayName = getProvider(newProvider)?.displayName ?? newProvider;
            webviewView.webview.postMessage({
              type: "systemMessage",
              text: `Switched to ${displayName} mid-session. The full conversation history will be shared with this model and may consume tokens.`,
            });
          }
          this.activeProvider = newProvider;
          const apiKey = await this.getApiKey(this.activeProvider);
          webviewView.webview.postMessage({
            type: "providerChanged",
            provider: this.activeProvider,
            hasApiKey: !!apiKey,
            requiresApiKey: getProvider(this.activeProvider)?.requiresApiKey ?? false,
          });
          fetchModelsForWebview(this.activeProvider, apiKey, webviewView);
          break;
        }

        case "setApiKey": {
          const target = message.provider ?? this.activeProvider;
          const input = await vscode.window.showInputBox({
            prompt: `Enter your ${getProvider(target)?.displayName ?? target} API key`,
            password: true,
            ignoreFocusOut: true,
          });
          if (input && input.trim().length > 5) {
            await this.setApiKey(target, input.trim());
            const isActive = target === this.activeProvider;
            webviewView.webview.postMessage({ type: "apiKeySet", provider: target, hasApiKey: true, isActiveProvider: isActive });
            if (isActive) { fetchModelsForWebview(this.activeProvider, input, webviewView); }
            vscode.window.showInformationMessage(
              `${getProvider(target)?.displayName} API key saved securely.`
            );
          }
          break;
        }

        case "clearApiKey": {
          const target = message.provider ?? this.activeProvider;
          await this.context.secrets.delete(`raiview.apiKey.${target}`);
          const isActive = target === this.activeProvider;
          webviewView.webview.postMessage({ type: "apiKeyCleared", provider: target, isActiveProvider: isActive });
          if (isActive) { fetchModelsForWebview(this.activeProvider, undefined, webviewView); }
          break;
        }

        case "reviewChanges": {
          if (this.activeAbortController) { break; }
          const userSelectedGitModel = message.model;
          let model = message.model;
          if (this.enhancedReviewer && this.activeProvider === "ollama") {
            const reviewerName = getReviewerModelName(model);
            if (model !== reviewerName) {
              const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
              if (await reviewerModelExists(ollamaUrl, model)) { model = reviewerName; }
            }
          }

          const gitChunks = await this.buildGitChunks(webviewView);
          if (!gitChunks) { return; }

          if (this.activeSessionTrigger === null) {
            this.activeSessionTrigger = "git";
            webviewView.webview.postMessage({ type: "sessionTriggered", trigger: "git" });
          }

          await this.runChunkedReview(
            gitChunks,
            model,
            webviewView,
            this.exchangeCount === 0 ? "Reviewing git changes..." : "Re-reviewing git changes...",
            userSelectedGitModel
          );
          break;
        }

        case "sendToProvider": {
          if (this.activeAbortController) { break; }
          const userSelectedFileModel = message.model;
          let model = message.model;
          if (this.enhancedReviewer && this.activeProvider === "ollama") {
            const reviewerName = getReviewerModelName(model);
            if (model !== reviewerName) {
              const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
              if (await reviewerModelExists(ollamaUrl, model)) { model = reviewerName; }
            }
          }

          const fileChunks = await this.buildFileChunks(message.customInput ?? "", webviewView);
          if (!fileChunks) { return; }

          if (this.activeSessionTrigger === null) {
            this.activeSessionTrigger = "file";
            webviewView.webview.postMessage({ type: "sessionTriggered", trigger: "file" });
          }

          await this.runChunkedReview(
            fileChunks,
            model,
            webviewView,
            this.exchangeCount === 0 ? "Reviewing active file..." : "Re-reviewing active file...",
            userSelectedFileModel
          );
          break;
        }

        case "stopGeneration": {
          this.reviewCancelled = true;
          if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
          }
          break;
        }

        case "followUp": {
          if (this.exchangeCount >= MAX_EXCHANGES) { return; }
          const model = message.model || this.currentModel;
          await this.sendChat({
            prompt: message.content,
            displayText: message.content,
            model,
            webviewView,
          });
          break;
        }

        case "newSession": {
          await this.startNewSession(webviewView);
          break;
        }

        case "loadSession": {
          const sessions = this.context.globalState.get<ChatSession[]>("raiview.chatSessions", []);
          const session = sessions.find((s) => s.id === message.sessionId);
          if (session) {
            const renderedMessages = await Promise.all(
              session.messages.map(async (m) => {
                if (m.role === "assistant") {
                  const structured = this.tryParseReview(m.content);
                  if (structured) { return { ...m, structured }; }
                  return { ...m, html: await marked(m.content) };
                }
                return { ...m };
              })
            );
            webviewView.webview.postMessage({
              type: "sessionView",
              session: { ...session, messages: renderedMessages },
            });
          }
          break;
        }

        case "clearHistory": {
          await this.context.globalState.update("raiview.chatSessions", []);
          webviewView.webview.postMessage({ type: "historyLoaded", sessions: [] });
          break;
        }

        case "freeMemory": {
          if (this.activeProvider === "ollama" && this.currentModel) {
            const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
            await unloadOllamaModel(this.currentModel, ollamaUrl);
            webviewView.webview.postMessage({ type: "systemMessage", text: `Model ${this.currentModel} unloaded from memory.` });
          }
          break;
        }

        case "setSystemPrompt":
          this.systemPrompt = message.prompt;
          break;

        case "toggleStreaming":
          this.streamingMode = message.mode;
          break;

        case "toggleEnhancedReviewer":
          this.enhancedReviewer = message.enabled;
          break;

        case "createReviewerModel": {
          const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
          try {
            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "creating" });
            const numCtx = vscode.workspace.getConfiguration("raiview").get<number>("ollamaContextWindow") ?? 4096;
            const numPredict = vscode.workspace.getConfiguration("raiview").get<number>("ollamaNumPredict") ?? 2000;
            await createReviewerModel(message.baseModel, ollamaUrl, (progressStatus: string) => {
              webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "progress", message: progressStatus });
            }, numCtx, numPredict);
            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "created" });
            vscode.window.showInformationMessage(`code-reviewer model created from ${message.baseModel}.`);
            await fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
          } catch (err: any) {
            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "error", message: err.message ?? String(err) });
          }
          break;
        }

        case "deleteReviewerModelByName": {
          const ollamaUrl = vscode.workspace.getConfiguration("raiview").get<string>("ollamaUrl") ?? "http://localhost:11434";
          try {
            await deleteReviewerModel(ollamaUrl, undefined, message.modelName);
            vscode.window.showInformationMessage(`${message.modelName} deleted.`);
            await fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
          } catch (err: any) {
            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "error", message: err.message ?? String(err) });
          }
          break;
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Webview HTML
  // -------------------------------------------------------------------------

  private getHtml(scriptUri: vscode.Uri): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      padding: 12px;
      gap: 10px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    /* Toolbar */
    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 2px 0; }
    .icon-btn {
      background: none; border: none; color: var(--vscode-foreground);
      cursor: pointer; font-size: 15px; padding: 4px 6px; border-radius: 4px;
      opacity: 0.7; transition: opacity 0.2s; width: auto; line-height: 1;
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

    /* Provider collapsible */
    .provider-body { display: flex; flex-direction: column; gap: 8px; }

    /* Controls */
    label { font-weight: 600; margin-bottom: 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); }
    select, button, textarea, input[type="text"] {
      width: 100%; padding: 6px 8px; border-radius: 4px;
      font-size: 13px; font-family: var(--vscode-font-family);
    }
    select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; cursor: pointer; transition: background 0.15s;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.45; cursor: default; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .followup-send.stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f48771); border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); }
    .followup-send.stop:hover { opacity: 0.85; }

    .row { display: flex; flex-direction: column; gap: 4px; }
    .row-inline { display: flex; gap: 6px; align-items: center; }

    /* Settings panel */
    .settings-panel { display: none; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); }
    .settings-panel.open { display: flex; }
    .settings-panel h4 { font-size: 12px; margin-bottom: 2px; color: var(--vscode-foreground); }

    .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
    .toggle-row label { text-transform: none; font-weight: normal; font-size: 12px; color: var(--vscode-foreground); }

    .switch { position: relative; display: inline-block; width: 34px; height: 18px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 18px; transition: 0.2s; }
    .slider:before { content: ""; position: absolute; height: 12px; width: 12px; left: 2px; bottom: 2px; background: var(--vscode-foreground); border-radius: 50%; transition: 0.2s; }
    input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    input:checked + .slider:before { transform: translateX(16px); background: var(--vscode-button-foreground); }

    /* System prompt */
    .system-prompt-section { display: flex; flex-direction: column; gap: 4px; }
    .collapsible-header { cursor: pointer; display: flex; align-items: center; gap: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); font-weight: 600; user-select: none; }
    .collapsible-header .arrow { transition: transform 0.2s; font-size: 10px; }
    .collapsible-header.open .arrow { transform: rotate(90deg); }
    textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: vertical; min-height: 60px; max-height: 200px; line-height: 1.4; }
    textarea:focus, input[type="text"]:focus { outline: none; border-color: var(--vscode-focusBorder); }

    /* Review buttons row */
    .review-buttons { display: flex; gap: 6px; }
    .review-buttons button { flex: 1; }

    /* Chat messages */
    .chat-messages {
      display: flex; flex-direction: column; gap: 8px;
      min-height: 80px; max-height: 50vh;
      overflow-y: auto;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .chat-empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      padding: 20px 0;
    }

    /* Chat bubbles */
    .bubble { display: flex; flex-direction: column; gap: 3px; }
    .bubble-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .bubble.user .bubble-meta { text-align: right; }
    .bubble-body {
      padding: 7px 10px; border-radius: 6px;
      font-size: 12px; line-height: 1.6; word-wrap: break-word;
    }
    .bubble.user .bubble-body {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      margin-left: 24px;
    }
    .bubble.ai .bubble-body {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      margin-right: 0;
    }
    .bubble.system { align-items: center; }
    .bubble.system .bubble-body {
      background: none; border: none; padding: 2px 0;
      font-size: 11px; color: var(--vscode-descriptionForeground);
      font-style: italic; text-align: center;
    }
    .bubble.error .bubble-body {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
    }

    /* Markdown inside AI bubbles */
    .bubble-body h1, .bubble-body h2, .bubble-body h3 { margin: 10px 0 5px; color: var(--vscode-foreground); }
    .bubble-body h1 { font-size: 15px; } .bubble-body h2 { font-size: 13px; } .bubble-body h3 { font-size: 12px; }
    .bubble-body p { margin: 5px 0; }
    .bubble-body ul, .bubble-body ol { margin: 5px 0; padding-left: 18px; }
    .bubble-body li { margin: 2px 0; }
    .bubble-body strong { color: var(--vscode-foreground); }
    .bubble-body code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family), monospace; font-size: 11px; }
    .bubble-body pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; margin: 6px 0; }
    .bubble-body pre code { background: none; padding: 0; }

    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 5px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    hr { width: 100%; border: none; border-top: 1px solid var(--vscode-panel-border); margin: 2px 0; }

    /* Exchange limit bar */
    .limit-bar {
      display: none; font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .limit-bar.hidden { display: none !important; }
    .limit-track { flex: 1; height: 3px; background: var(--vscode-panel-border); border-radius: 2px; }
    .limit-fill { height: 100%; border-radius: 2px; background: var(--vscode-button-background); transition: width 0.3s; }
    .limit-fill.warn { background: #e8a020; }
    .limit-fill.danger { background: #be1100; }

    .limit-warning {
      display: none; padding: 6px 8px; border-radius: 4px; font-size: 11px;
      background: var(--vscode-inputValidation-warningBackground, #352a05);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
      color: var(--vscode-inputValidation-warningForeground, #cca700);
    }
    .limit-warning.visible { display: block; }

    /* Follow-up area */
    .followup-area {
      display: none; flex-direction: column; gap: 6px;
    }
    .followup-area.visible { display: flex; }
    .followup-row { display: flex; gap: 6px; align-items: flex-end; }
    .followup-row textarea {
      flex: 1; min-height: 38px; max-height: 120px;
      resize: none; font-size: 12px;
    }
    .followup-send {
      width: auto; flex-shrink: 0; padding: 6px 12px;
      align-self: flex-end;
    }
    .new-session-link {
      display: none; background: none; border: none; width: auto;
      color: var(--vscode-textLink-foreground); cursor: pointer;
      font-size: 11px; padding: 0; text-decoration: underline;
      text-align: right;
    }
    .new-session-link.visible { display: block; }
    .new-session-link:hover { color: var(--vscode-textLink-activeForeground); background: none; }

    /* History panel */
    .history-section { display: flex; flex-direction: column; gap: 6px; }
    .history-panel { display: none; flex-direction: column; gap: 6px; }
    .history-panel.open { display: flex; }
    .history-card {
      padding: 7px 9px; border-radius: 5px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      transition: border-color 0.15s;
      font-size: 11px;
    }
    .history-card:hover { border-color: var(--vscode-focusBorder); }
    .history-card .hc-title { font-weight: 600; color: var(--vscode-foreground); margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-card .hc-meta { color: var(--vscode-descriptionForeground); }
    .history-actions { display: flex; justify-content: flex-end; }
    .history-empty { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }

    /* Session view overlay */
    .session-overlay {
      display: none; flex-direction: column;
      padding: 8px; border: 1px solid var(--vscode-panel-border);
      border-radius: 6px; background: var(--vscode-editor-background);
      max-height: 50vh;
    }
    .session-overlay.visible { display: flex; }
    .session-overlay-header { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; padding-bottom: 6px; }
    .session-overlay-header button { width: auto; padding: 3px 8px; font-size: 11px; }
    #overlayMessages { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; }
    .prompt-truncated { color: var(--vscode-descriptionForeground); font-style: italic; }

    /* Enhanced reviewer section */
    .reviewer-section { display: none; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
    .reviewer-section.visible { display: flex; }
    .reviewer-section .info { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .derived-models-list { display: flex; flex-direction: column; gap: 4px; }
    .derived-model-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 7px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); font-size: 11px; }
    .derived-model-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .derived-model-delete { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 0 2px; font-size: 13px; line-height: 1; flex-shrink: 0; width: auto; }
    .derived-model-delete:hover { color: var(--vscode-errorForeground); }
    .finding { padding: 8px 10px; margin-bottom: 6px; border-radius: 5px; border-left: 3px solid transparent; background: var(--vscode-editor-inactiveSelectionBackground); }
    .finding-critical { border-left-color: #e05252; }
    .finding-warning  { border-left-color: #d4a800; }
    .finding-suggestion { border-left-color: #5a9ee6; }
    .finding-header { display: flex; align-items: center; gap: 6px; }
    .finding-badge { font-size: 11px; font-weight: 600; white-space: nowrap; }
    .finding-category { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
    .finding-title { display: block; margin-top: 4px; font-size: 12px; }
    .finding-desc { margin: 3px 0 0; font-size: 12px; color: var(--vscode-foreground); opacity: 0.9; }
    .review-rating { margin-top: 10px; font-weight: 600; font-size: 12px; }
  </style>
</head>
<body>
  <!-- Toolbar: refresh (left) + settings (right) -->
  <div class="toolbar">
    <button class="icon-btn" id="refreshBtn" title="Refresh Models">↻</button>
    <button class="icon-btn" id="freeMemoryBtn" style="display:none;" title="Unload model from Ollama memory">🗑</button>
    <button class="icon-btn" id="settingsBtn" title="Settings">⚙</button>
  </div>

  <!-- Settings panel -->
  <div class="settings-panel" id="settingsPanel">
    <h4>⚙ Settings</h4>
    <div class="toggle-row">
      <label for="streamToggle">Streaming (chunked output)</label>
      <label class="switch"><input type="checkbox" id="streamToggle" checked><span class="slider"></span></label>
    </div>
    <div class="toggle-row" id="enhancedRow" style="display:none;">
      <label for="enhancedToggle">Enhanced Reviewer (Ollama)</label>
      <label class="switch"><input type="checkbox" id="enhancedToggle"><span class="slider"></span></label>
    </div>
    <div class="reviewer-section" id="reviewerSection">
      <div class="info">Creates a <strong>code-reviewer</strong> model in Ollama with optimized parameters and a structured code review system prompt.</div>
      <div class="row">
        <label for="baseModelSelect">Base Model</label>
        <select id="baseModelSelect"><option value="">Select base model...</option></select>
      </div>
      <button id="createReviewerBtn" class="secondary">Create code-reviewer Model</button>
      <div id="reviewerStatus" style="font-size:11px; color:var(--vscode-descriptionForeground);"></div>
    </div>
    <div id="derivedModelsList" class="derived-models-list" style="display:none;"></div>
    <div id="ollamaSettingsRow" style="display:none;">
      <hr style="margin:10px 0; border-color:var(--vscode-widget-border);">
      <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--vscode-descriptionForeground); margin-bottom:6px;">Ollama</div>
      <div class="row">
        <label for="ollamaUrlInput">URL</label>
        <input type="text" id="ollamaUrlInput" placeholder="http://localhost:11434" />
      </div>
      <button id="saveOllamaUrlBtn" class="secondary">Save URL</button>
      <div class="row" style="margin-top:6px;">
        <label for="ollamaPinnedModels">Pinned Models <span style="font-weight:400; font-size:10px;">(one per line — leave empty to fetch from server)</span></label>
        <textarea id="ollamaPinnedModels" rows="3" placeholder="qwen3.5:397b-cloud&#10;llama3.3:70b"></textarea>
      </div>
      <button id="savePinnedModelsBtn" class="secondary">Save Models</button>
    </div>
    <hr style="margin:10px 0; border-color:var(--vscode-widget-border);">
    <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--vscode-descriptionForeground); margin-bottom:6px;">API Keys</div>
    <div class="row">
      <label for="keyProviderSelect">Provider</label>
      <select id="keyProviderSelect"></select>
    </div>
    <div id="apiKeyHint" style="font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:2px;"></div>
    <div id="apiKeyStatus" style="font-size:11px; margin-bottom:6px;"></div>
    <div style="display:flex; gap:6px;">
      <button id="saveKeyBtn" class="secondary" style="flex:1;">Save Key</button>
      <button id="clearKeyBtn" class="secondary" style="flex:1;">Clear Key</button>
    </div>
  </div>

  <!-- Review buttons -->
  <div class="review-buttons">
    <button id="reviewBtn">Review Git Changes</button>
    <button id="sendBtn" disabled>Send for Review</button>
  </div>

  <hr>

  <!-- Provider selection (collapsible) -->
  <div class="system-prompt-section" id="providerSection">
    <div class="collapsible-header" id="providerHeader">
      <span class="arrow">▶</span><span>Provider</span>
    </div>
    <div class="provider-body" id="providerBody">
      <select id="providerSelect"><option value="">Loading...</option></select>
      <div class="row">
        <label for="availableModels">Model</label>
        <select id="availableModels"><option value="">Detecting...</option></select>
      </div>
    </div>
  </div>

  <hr>

  <!-- System prompt -->
  <div class="system-prompt-section" id="sysPromptSection">
    <div class="collapsible-header" id="sysPromptHeader">
      <span class="arrow">▶</span><span>System Prompt</span>
    </div>
    <textarea id="systemPrompt" style="display:none;" rows="4" placeholder="Enter a system prompt to guide the review..."></textarea>
  </div>

  <!-- Chat messages -->
  <div id="chatMessages" class="chat-messages">
    <div class="chat-empty" id="chatEmpty">No review started yet. Click a review button above.</div>
  </div>

  <!-- Exchange limit bar (shown after first exchange) -->
  <div class="limit-bar hidden" id="limitBar">
    <span id="limitText">0 / 20</span>
    <div class="limit-track"><div class="limit-fill" id="limitFill" style="width:0%"></div></div>
  </div>

  <!-- Limit warning -->
  <div class="limit-warning" id="limitWarning"></div>

  <!-- Follow-up area (revealed after first AI response) -->
  <div class="followup-area" id="followupArea">
    <div class="followup-row">
      <textarea id="followupInput" placeholder="Ask a follow-up question about the review..." rows="2"></textarea>
      <button class="followup-send" id="followupSend">Send</button>
    </div>
    <button class="new-session-link" id="newSessionBtn">Start new session</button>
  </div>

  <!-- Session history -->
  <hr>
  <div class="history-section">
    <div class="collapsible-header" id="historyHeader">
      <span class="arrow">▶</span><span>Recent Sessions</span>
    </div>
    <div class="history-panel" id="historyPanel">
      <div class="history-empty" id="historyEmpty">No past sessions.</div>
      <div class="history-actions" id="historyActions" style="display:none;">
        <button class="secondary" id="clearHistoryBtn" style="width:auto; font-size:11px; padding:3px 8px;">Clear All</button>
      </div>
    </div>
  </div>

  <!-- Past session view overlay -->
  <div class="session-overlay" id="sessionOverlay">
    <div class="session-overlay-header">
      <span id="overlayTitle">Past Session</span>
      <button class="secondary" id="overlayCloseBtn">✕ Close</button>
    </div>
    <div id="overlayMessages"></div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const provider = new SidePanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("raiview.reviewChanges", reviewChanges),
    outputChannel
  );
}

export function deactivate() {}
