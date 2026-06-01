"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewChanges = reviewChanges;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const provider_1 = require("./provider");
const modelfile_1 = require("./modelfile");
const marked_1 = require("marked");
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
const SUMMARY_SYSTEM_PROMPT = "You are a helpful assistant that summarizes technical code review conversations concisely.";
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
// Git review command entry point (registered as VS Code command)
// ---------------------------------------------------------------------------
function reviewChanges() {
    vscode.window.showInformationMessage("Please use the 'Review Git Changes' button in the extension side panel.");
}
// ---------------------------------------------------------------------------
// File / folder reader (supports Windows, WSL UNC, and Linux paths)
// ---------------------------------------------------------------------------
function tryWslPath(linuxPath) {
    try {
        const winPath = (0, child_process_1.execSync)(`wsl wslpath -w "${linuxPath}"`, {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
        if (winPath && fs.existsSync(winPath)) {
            return winPath;
        }
    }
    catch {
        // wsl not available or path doesn't exist
    }
    return null;
}
function wslReadFile(linuxPath) {
    try {
        return (0, child_process_1.execSync)(`wsl cat "${linuxPath}"`, {
            encoding: "utf-8",
            timeout: 10000,
        });
    }
    catch {
        return null;
    }
}
function wslExists(linuxPath) {
    try {
        const result = (0, child_process_1.execSync)(`wsl bash -c "if [ -d '${linuxPath}' ]; then echo dir; elif [ -f '${linuxPath}' ]; then echo file; else echo none; fi"`, { encoding: "utf-8", timeout: 3000 }).trim();
        if (result === "dir") {
            return "dir";
        }
        if (result === "file") {
            return "file";
        }
    }
    catch { /* ignore */ }
    return false;
}
function wslReadDir(linuxPath) {
    try {
        const listing = (0, child_process_1.execSync)(`wsl bash -c "for f in '${linuxPath}'/*; do if [ -f \\"\\$f\\" ]; then echo \\"\\$f\\"; fi; done"`, { encoding: "utf-8", timeout: 5000 }).trim();
        if (!listing) {
            return `Directory: ${linuxPath}\n(empty or no readable files)`;
        }
        const files = listing.split("\n").filter(Boolean);
        const parts = [`Directory: ${linuxPath}\n`];
        for (const f of files) {
            const name = f.split("/").pop() ?? f;
            const content = wslReadFile(f);
            if (content !== null) {
                parts.push(`--- ${name} ---\n${content}\n`);
            }
            else {
                parts.push(`--- ${name} --- (could not read)\n`);
            }
        }
        return parts.join("\n");
    }
    catch {
        return `⚠ Could not read WSL directory: ${linuxPath}`;
    }
}
function isFilePath(input) {
    if (/^[a-zA-Z]:[/\\]/.test(input)) {
        return true;
    }
    if (input.startsWith("\\\\")) {
        return true;
    }
    if (input.startsWith("/")) {
        return true;
    }
    if (input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\")) {
        return true;
    }
    try {
        return fs.existsSync(path.resolve(input));
    }
    catch {
        return false;
    }
}
function uncToLinuxPath(uncPath) {
    const match = uncPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$/i);
    if (match) {
        return "/" + match[2].replace(/\\/g, "/");
    }
    return null;
}
function readWindowsDir(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const parts = [`Directory: ${dirPath}\n`];
    for (const entry of entries) {
        if (entry.isFile()) {
            const filePath = path.join(dirPath, entry.name);
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                parts.push(`--- ${entry.name} ---\n${content}\n`);
            }
            catch {
                parts.push(`--- ${entry.name} --- (could not read)\n`);
            }
        }
    }
    return parts.join("\n");
}
function readFileOrFolder(inputPath) {
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
        }
        catch { /* UNC access failed, try WSL fallback */ }
        const linuxPath = uncToLinuxPath(inputPath);
        if (linuxPath) {
            const type = wslExists(linuxPath);
            if (type === "file") {
                const content = wslReadFile(linuxPath);
                if (content !== null) {
                    return { ok: true, content: `File: ${inputPath}\n\n${content}` };
                }
            }
            else if (type === "dir") {
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
            }
            catch { /* fall through */ }
        }
        const type = wslExists(inputPath);
        if (type === "file") {
            const content = wslReadFile(inputPath);
            if (content !== null) {
                return { ok: true, content: `File: ${inputPath}\n\n${content}` };
            }
        }
        else if (type === "dir") {
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
async function fetchModelsForWebview(providerName, apiKey, webviewView) {
    const provider = (0, provider_1.getProvider)(providerName);
    if (!provider) {
        webviewView.webview.postMessage({ type: "error", message: `Unknown provider: ${providerName}` });
        return;
    }
    try {
        const models = await provider.listModels(apiKey);
        webviewView.webview.postMessage({ type: "models", available: models });
    }
    catch (err) {
        webviewView.webview.postMessage({
            type: "error",
            message: `Could not fetch models for ${provider.displayName}: ${err.message ?? err}`,
        });
    }
    if (providerName === "ollama") {
        await sendReviewerModelsForWebview(webviewView);
    }
}
async function sendReviewerModelsForWebview(webviewView) {
    const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
    const models = await (0, modelfile_1.listReviewerModels)(ollamaUrl);
    webviewView.webview.postMessage({ type: "derivedModelsList", models });
}
const DEFAULT_REVIEW_SYSTEM_PROMPT = "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
    "Do NOT summarise, explain, or paraphrase the code. Only report actual issues you find. " +
    "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
    "Review only the code provided across these categories: Correctness, Design, Security, Performance, Readability, and Error Handling. " +
    "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. Do NOT focus disproportionately on any single category. " +
    "Use severity labels: 🔴 Critical, 🟡 Warning, 🔵 Suggestion. " +
    "End with a summary rating: ✅ Looks Good, ⚠️ Needs Minor Changes, or 🛑 Needs Major Revision. " +
    "After writing the summary rating, stop immediately. Do not repeat any finding already stated.";
// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
class SidePanelProvider {
    constructor(context) {
        this.context = context;
        // Provider / UI settings
        this.activeProvider = "ollama";
        this.systemPrompt = "";
        this.streamingMode = "chunked";
        this.enhancedReviewer = false;
        // Chat state
        this.chatHistory = [];
        this.exchangeCount = 0;
        this.currentModel = "";
        this.activeSessionTrigger = null;
        this.activeAbortController = null;
        // Rolling summary state
        this.latestSummary = null;
        this.summaryGenerationId = 0;
        const config = vscode.workspace.getConfiguration("raiview");
        this.activeProvider = config.get("defaultProvider") ?? "ollama";
        this.systemPrompt = config.get("defaultSystemPrompt") ?? "";
        this.streamingMode =
            config.get("streamingMode") ?? "chunked";
        this.enhancedReviewer = config.get("enhancedReviewer") ?? false;
    }
    // -------------------------------------------------------------------------
    // API key helpers
    // -------------------------------------------------------------------------
    async getApiKey(providerName) {
        return this.context.secrets.get(`raiview.apiKey.${providerName}`);
    }
    async setApiKey(providerName, key) {
        await this.context.secrets.store(`raiview.apiKey.${providerName}`, key);
    }
    // -------------------------------------------------------------------------
    // Context building
    // -------------------------------------------------------------------------
    buildSystemPrompt() {
        const base = this.systemPrompt.trim() || DEFAULT_REVIEW_SYSTEM_PROMPT;
        const summarySection = this.latestSummary
            ? `\n\nPrior conversation summary:\n${this.latestSummary}`
            : "";
        const priorModels = [...new Set(this.chatHistory
                .filter(m => m.role === "assistant" && m.model && m.model !== this.currentModel)
                .map(m => m.model))];
        const attributionSection = priorModels.length > 0
            ? `\n\nNote: This conversation includes messages previously generated by: ${priorModels.join(", ")}. You are now the active model. Continue the review with full awareness of the prior context — those previous responses were from a different model.`
            : "";
        return `${GUARDRAILS}\n\n${base}${summarySection}${attributionSection}`;
    }
    buildHistoryForProvider() {
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
    triggerBackgroundSummary(provider, apiKey) {
        if (this.exchangeCount < SUMMARY_THRESHOLD) {
            return;
        }
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
            .catch(() => { });
    }
    // -------------------------------------------------------------------------
    // Session persistence
    // -------------------------------------------------------------------------
    async saveCurrentSession() {
        if (this.exchangeCount === 0) {
            return;
        }
        const sessions = this.context.globalState.get("raiview.chatSessions", []);
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
    async startNewSession(webviewView) {
        await this.saveCurrentSession();
        const config = vscode.workspace.getConfiguration("raiview");
        if (this.activeProvider === "ollama" && this.currentModel && config.get("autoUnloadModel")) {
            const ollamaUrl = config.get("ollamaUrl") ?? "http://localhost:11434";
            await (0, modelfile_1.unloadOllamaModel)(this.currentModel, ollamaUrl);
        }
        this.chatHistory = [];
        this.exchangeCount = 0;
        this.activeSessionTrigger = null;
        this.latestSummary = null;
        this.summaryGenerationId++;
        this.currentModel = "";
        webviewView.webview.postMessage({ type: "newSessionStarted" });
        const sessions = this.context.globalState.get("raiview.chatSessions", []);
        webviewView.webview.postMessage({ type: "historyLoaded", sessions });
    }
    // -------------------------------------------------------------------------
    // Core send method — all AI calls funnel through here
    // -------------------------------------------------------------------------
    async sendChat(opts) {
        const { prompt, displayText, model, webviewView, isSystemMessage, skipExchangeCount } = opts;
        const provider = (0, provider_1.getProvider)(this.activeProvider);
        if (!provider) {
            webviewView.webview.postMessage({
                type: "chatError",
                message: `Unknown provider: ${this.activeProvider}`,
            });
            return "";
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
            ? (vscode.workspace.getConfiguration("raiview").get("ollamaContextWindow") ?? 8192)
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
                let parseTimer = null;
                const sendParsedUpdate = async () => {
                    try {
                        const html = await (0, marked_1.marked)(accumulated);
                        webviewView.webview.postMessage({ type: "streamUpdate", html });
                    }
                    catch { /* ignore during streaming */ }
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
                    onToken: (token) => {
                        accumulated += token;
                        if (!parseTimer) {
                            parseTimer = setTimeout(() => {
                                parseTimer = null;
                                sendParsedUpdate();
                            }, 300);
                        }
                    },
                    onUsage: (inputTokens, outputTokens) => {
                        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${this.activeProvider} / ${model}` +
                            ` | input: ${inputTokens.toLocaleString()} tokens` +
                            ` | output: ${outputTokens.toLocaleString()} tokens` +
                            ` | total: ${(inputTokens + outputTokens).toLocaleString()} tokens`);
                    },
                });
                if (parseTimer) {
                    clearTimeout(parseTimer);
                }
                const html = await (0, marked_1.marked)(fullResponse);
                webviewView.webview.postMessage({
                    type: "streamEnd",
                    html,
                    model,
                    timestamp: Date.now(),
                });
            }
            else {
                fullResponse = await provider.generate({
                    model,
                    prompt,
                    systemPrompt,
                    apiKey,
                    stream: false,
                    history,
                    signal: abortController.signal,
                    numCtx,
                    onUsage: (inputTokens, outputTokens) => {
                        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${this.activeProvider} / ${model}` +
                            ` | input: ${inputTokens.toLocaleString()} tokens` +
                            ` | output: ${outputTokens.toLocaleString()} tokens` +
                            ` | total: ${(inputTokens + outputTokens).toLocaleString()} tokens`);
                    },
                });
                const html = await (0, marked_1.marked)(fullResponse);
                webviewView.webview.postMessage({
                    type: "chatMessage",
                    html,
                    model,
                    timestamp: Date.now(),
                });
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
            return fullResponse;
        }
        catch (err) {
            if (err?.name === "AbortError" || abortController.signal.aborted) {
                // User stopped generation — show partial response if any, don't show error
                webviewView.webview.postMessage({ type: "generationStopped" });
            }
            else {
                // Roll back the optimistic history entry
                this.chatHistory.pop();
                webviewView.webview.postMessage({
                    type: "chatError",
                    message: `${provider.displayName} error: ${err.message ?? err}`,
                });
            }
            return "";
        }
        finally {
            if (this.activeAbortController === abortController) {
                this.activeAbortController = null;
            }
            webviewView.webview.postMessage({ type: "generationEnded" });
        }
    }
    // -------------------------------------------------------------------------
    // Prompt builders
    // -------------------------------------------------------------------------
    get maxContentChars() {
        return vscode.workspace.getConfiguration("raiview").get("maxContentChars") ?? DEFAULT_MAX_CONTENT_CHARS;
    }
    splitDiffByFile(diffText) {
        return diffText.split(/(?=^diff --git )/m).filter(s => s.trim());
    }
    splitByLineChunks(content) {
        const limit = this.maxContentChars;
        if (content.length <= limit) {
            return [content];
        }
        const lines = content.split("\n");
        const chunks = [];
        let current = "";
        for (const line of lines) {
            const addition = (current ? "\n" : "") + line;
            if (current.length + addition.length > limit && current.length > 0) {
                chunks.push(current);
                current = line;
            }
            else {
                current += addition;
            }
        }
        if (current) {
            chunks.push(current);
        }
        return chunks;
    }
    flattenSymbols(symbols) {
        return symbols.flatMap(s => [s, ...this.flattenSymbols(s.children)]);
    }
    async splitByMethods(document) {
        const limit = this.maxContentChars;
        let symbols = [];
        try {
            const result = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
            symbols = result ?? [];
        }
        catch { /* fall through to line-based split */ }
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
        const chunks = [];
        let current = "";
        let currentLabels = [];
        const allLabels = [];
        for (const sym of flat) {
            const text = document.getText(sym.range);
            const addition = (current ? "\n\n" : "") + text;
            if (current.length + addition.length > limit && current.length > 0) {
                chunks.push(current);
                allLabels.push(currentLabels);
                current = text;
                currentLabels = [sym.name];
            }
            else {
                current += addition;
                currentLabels.push(sym.name);
            }
        }
        if (current) {
            chunks.push(current);
            allLabels.push(currentLabels);
        }
        // Attach labels to chunks via a parallel array — callers use buildFileChunks which wraps them
        chunks.__labels = allLabels;
        return chunks;
    }
    async buildGitChunks(webviewView) {
        const gitExtension = vscode.extensions.getExtension("vscode.git");
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
        let diffFiles = [];
        let untrackedFiles = [];
        try {
            untrackedFiles = (0, child_process_1.execSync)(`git ls-files --others --exclude-standard`, {
                cwd: repoPath, encoding: "utf8", stdio: "pipe",
            }).trim().split("\n").filter(Boolean);
        }
        catch { /* ignore */ }
        try {
            diffFiles = (0, child_process_1.execSync)(`git diff --name-only HEAD`, {
                cwd: repoPath, encoding: "utf8", stdio: "pipe",
            }).trim().split("\n").filter(Boolean);
            diffText = (0, child_process_1.execSync)(`git diff HEAD`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
        }
        catch {
            try {
                const staged = (0, child_process_1.execSync)(`git diff --name-only --cached`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" }).trim().split("\n").filter(Boolean);
                const unstaged = (0, child_process_1.execSync)(`git diff --name-only`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" }).trim().split("\n").filter(Boolean);
                diffFiles = [...new Set([...staged, ...unstaged])];
                const d1 = (0, child_process_1.execSync)(`git diff --cached`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
                const d2 = (0, child_process_1.execSync)(`git diff`, { cwd: repoPath, encoding: "utf8", stdio: "pipe" });
                diffText = d1 + "\n" + d2;
            }
            catch { /* ignore */ }
        }
        const allFiles = [...new Set([...diffFiles, ...untrackedFiles])];
        if (allFiles.length === 0) {
            webviewView.webview.postMessage({
                type: "chatError",
                message: "No changes in git control that can be reviewed.",
            });
            return null;
        }
        const units = [];
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
                    }
                    catch { /* ignore */ }
                }
            }
        }
        const limit = this.maxContentChars;
        const buildGitInstruction = (files) => {
            const fileList = files.map(f => `• ${f}`).join("\n");
            if (this.enhancedReviewer) {
                return `\n\nReview ALL of the following files/sections:\n${fileList}\n\nCover all categories: Correctness, Security, Performance, Design, Readability, Error Handling. Do NOT echo the diff. Cover every file listed above.`;
            }
            return `\n\nReview ALL of the following files/sections present above:\n${fileList}\n\nFor each issue found, use this exact format:\n🔴 Critical / 🟡 Warning / 🔵 Suggestion — **[Short title]**\n[One sentence describing the issue.]\n\nRules: Do NOT describe what the code does. Do NOT echo the diff. Cover every file listed above. End with one of: ✅ Looks Good, ⚠️ Needs Minor Changes, or 🛑 Needs Major Revision.`;
        };
        // Greedily bin-pack units into chunks
        const chunks = [];
        let currentContent = "";
        let currentFiles = [];
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
    async buildFileChunks(customInput, webviewView) {
        const buildFileInstruction = (fileName, scope) => {
            const header = `\n\nReview the code above${scope ? ` (${scope})` : ""} from file: ${fileName}`;
            if (this.enhancedReviewer) {
                return `${header}\n\nCover all categories: Correctness, Security, Performance, Design, Readability, Error Handling. Do NOT echo the code.`;
            }
            return `${header}\n\nFor each issue found, use this exact format:\n🔴 Critical / 🟡 Warning / 🔵 Suggestion — **[Short title]**\n[One sentence describing the issue.]\n\nRules: Do NOT describe what the code does. Do NOT echo the code. End with one of: ✅ Looks Good, ⚠️ Needs Minor Changes, or 🛑 Needs Major Revision.`;
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
                return rawChunks.map((chunk, i) => {
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
            const methodLabels = rawChunks.__labels;
            return rawChunks.map((chunk, i) => {
                let label;
                let scope;
                if (methodLabels && methodLabels[i] && methodLabels[i].length > 0) {
                    const names = methodLabels[i].slice(0, 3).join(", ") + (methodLabels[i].length > 3 ? ", …" : "");
                    label = names;
                    scope = names;
                }
                else {
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
    async runChunkedReview(chunks, model, webviewView, singleDisplayText) {
        if (chunks.length > 1) {
            webviewView.webview.postMessage({
                type: "systemMessage",
                text: `📋 Content split into ${chunks.length} parts (limit: ${this.maxContentChars.toLocaleString()} chars). Reviewing each part in sequence...`,
            });
        }
        const responses = [];
        for (let i = 0; i < chunks.length; i++) {
            if (this.activeAbortController?.signal.aborted) {
                break;
            }
            if (chunks.length > 1) {
                webviewView.webview.postMessage({
                    type: "systemMessage",
                    text: `— Part ${i + 1} of ${chunks.length}: ${chunks[i].label} —`,
                });
            }
            const response = await this.sendChat({
                prompt: chunks[i].prompt,
                displayText: chunks.length > 1
                    ? `[Part ${i + 1}/${chunks.length}] ${chunks[i].label}`
                    : singleDisplayText,
                model,
                webviewView,
                isSystemMessage: true,
                historyOverride: [], // each chunk reviewed in isolation — no cross-chunk contamination
            });
            responses.push(response);
        }
        // Combined summary across all chunks — not counted as an exchange
        if (chunks.length > 1 && responses.length === chunks.length && !this.activeAbortController?.signal.aborted) {
            webviewView.webview.postMessage({
                type: "systemMessage",
                text: "— Generating combined summary across all parts —",
            });
            const perChunkBudget = Math.floor(this.maxContentChars / chunks.length);
            const partsText = responses
                .map((r, i) => {
                const capped = r.length > perChunkBudget ? r.slice(0, perChunkBudget) + "…" : r;
                return `**Part ${i + 1} (${chunks[i].label}):**\n${capped}`;
            })
                .join("\n\n");
            await this.sendChat({
                prompt: `Here are the findings from ${chunks.length} parts of the review:\n\n${partsText}\n\nProvide a concise combined summary. Group findings by category (Correctness, Security, Performance, Design, Readability, Error Handling). Within each category list issues from most to least severe (🔴 Critical first, then 🟡 Warning, then 🔵 Suggestion). Do not repeat individual findings verbatim — summarize and prioritize. End with an overall rating: ✅ Looks Good, ⚠️ Needs Minor Changes, or 🛑 Needs Major Revision.`,
                displayText: "Combined summary across all parts",
                model,
                webviewView,
                isSystemMessage: true,
                skipExchangeCount: true,
            });
        }
    }
    // -------------------------------------------------------------------------
    // Webview view resolver
    // -------------------------------------------------------------------------
    resolveWebviewView(webviewView) {
        const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
        webviewView.webview.html = this.getHtml(scriptUri);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "ready": {
                    const hasKey = !!(await this.getApiKey(this.activeProvider));
                    webviewView.webview.postMessage({
                        type: "init",
                        providers: (0, provider_1.getAllProviders)().map((p) => ({
                            name: p.name,
                            displayName: p.displayName,
                            requiresApiKey: p.requiresApiKey,
                        })),
                        activeProvider: this.activeProvider,
                        hasApiKey: hasKey,
                        streamingMode: this.streamingMode,
                        enhancedReviewer: this.enhancedReviewer,
                        systemPrompt: this.systemPrompt,
                        autoUnloadModel: vscode.workspace.getConfiguration("raiview").get("autoUnloadModel") ?? false,
                    });
                    fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
                    const sessions = this.context.globalState.get("raiview.chatSessions", []);
                    webviewView.webview.postMessage({ type: "historyLoaded", sessions });
                    break;
                }
                case "refreshModels": {
                    fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
                    break;
                }
                case "setProvider": {
                    const newProvider = message.provider;
                    if (this.activeSessionTrigger !== null &&
                        newProvider !== this.activeProvider &&
                        ((0, provider_1.getProvider)(newProvider)?.requiresApiKey ?? false)) {
                        const displayName = (0, provider_1.getProvider)(newProvider)?.displayName ?? newProvider;
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
                        requiresApiKey: (0, provider_1.getProvider)(this.activeProvider)?.requiresApiKey ?? false,
                    });
                    fetchModelsForWebview(this.activeProvider, apiKey, webviewView);
                    break;
                }
                case "setApiKey": {
                    const input = await vscode.window.showInputBox({
                        prompt: `Enter your ${(0, provider_1.getProvider)(this.activeProvider)?.displayName ?? this.activeProvider} API key`,
                        password: true,
                        ignoreFocusOut: true,
                    });
                    if (input) {
                        await this.setApiKey(this.activeProvider, input);
                        webviewView.webview.postMessage({ type: "apiKeySet", hasApiKey: true });
                        fetchModelsForWebview(this.activeProvider, input, webviewView);
                        vscode.window.showInformationMessage(`${(0, provider_1.getProvider)(this.activeProvider)?.displayName} API key saved securely.`);
                    }
                    break;
                }
                case "reviewChanges": {
                    if (this.activeAbortController) {
                        break;
                    }
                    let model = message.model;
                    if (this.enhancedReviewer && this.activeProvider === "ollama") {
                        const reviewerName = (0, modelfile_1.getReviewerModelName)(model);
                        if (model !== reviewerName) {
                            const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
                            if (await (0, modelfile_1.reviewerModelExists)(ollamaUrl, model)) {
                                model = reviewerName;
                            }
                        }
                    }
                    const gitChunks = await this.buildGitChunks(webviewView);
                    if (!gitChunks) {
                        return;
                    }
                    if (this.activeSessionTrigger === null) {
                        this.activeSessionTrigger = "git";
                        webviewView.webview.postMessage({ type: "sessionTriggered", trigger: "git" });
                    }
                    await this.runChunkedReview(gitChunks, model, webviewView, this.exchangeCount === 0 ? "Reviewing git changes..." : "Re-reviewing git changes...");
                    break;
                }
                case "sendToProvider": {
                    if (this.activeAbortController) {
                        break;
                    }
                    let model = message.model;
                    if (this.enhancedReviewer && this.activeProvider === "ollama") {
                        const reviewerName = (0, modelfile_1.getReviewerModelName)(model);
                        if (model !== reviewerName) {
                            const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
                            if (await (0, modelfile_1.reviewerModelExists)(ollamaUrl, model)) {
                                model = reviewerName;
                            }
                        }
                    }
                    const fileChunks = await this.buildFileChunks(message.customInput ?? "", webviewView);
                    if (!fileChunks) {
                        return;
                    }
                    if (this.activeSessionTrigger === null) {
                        this.activeSessionTrigger = "file";
                        webviewView.webview.postMessage({ type: "sessionTriggered", trigger: "file" });
                    }
                    await this.runChunkedReview(fileChunks, model, webviewView, this.exchangeCount === 0 ? "Reviewing active file..." : "Re-reviewing active file...");
                    break;
                }
                case "stopGeneration": {
                    if (this.activeAbortController) {
                        this.activeAbortController.abort();
                        this.activeAbortController = null;
                    }
                    break;
                }
                case "followUp": {
                    if (this.exchangeCount >= MAX_EXCHANGES) {
                        return;
                    }
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
                    const sessions = this.context.globalState.get("raiview.chatSessions", []);
                    const session = sessions.find((s) => s.id === message.sessionId);
                    if (session) {
                        const renderedMessages = await Promise.all(session.messages.map(async (m) => ({
                            ...m,
                            html: m.role === "assistant" ? await (0, marked_1.marked)(m.content) : undefined,
                        })));
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
                        const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
                        await (0, modelfile_1.unloadOllamaModel)(this.currentModel, ollamaUrl);
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
                    const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
                    try {
                        webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "creating" });
                        const numCtx = vscode.workspace.getConfiguration("raiview").get("ollamaContextWindow") ?? 4096;
                        await (0, modelfile_1.createReviewerModel)(message.baseModel, ollamaUrl, (progressStatus) => {
                            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "progress", message: progressStatus });
                        }, numCtx);
                        webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "created" });
                        vscode.window.showInformationMessage(`code-reviewer model created from ${message.baseModel}.`);
                        await fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
                    }
                    catch (err) {
                        webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "error", message: err.message ?? String(err) });
                    }
                    break;
                }
                case "deleteReviewerModelByName": {
                    const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
                    try {
                        await (0, modelfile_1.deleteReviewerModel)(ollamaUrl, undefined, message.modelName);
                        vscode.window.showInformationMessage(`${message.modelName} deleted.`);
                        await fetchModelsForWebview(this.activeProvider, await this.getApiKey(this.activeProvider), webviewView);
                    }
                    catch (err) {
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
    getHtml(scriptUri) {
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
      <button id="apiKeyBtn" style="display:none;" class="secondary">🔑 Set API Key</button>
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
SidePanelProvider.viewType = "raiview.sidePanel";
// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
function activate(context) {
    const provider = new SidePanelProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand("raiview.reviewChanges", reviewChanges), outputChannel);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map