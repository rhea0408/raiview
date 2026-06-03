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
};
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
let modelFetchSeq = 0;
async function fetchModelsForWebview(providerName, apiKey, webviewView) {
    const seq = ++modelFetchSeq;
    if (providerName === "ollama") {
        const pinned = vscode.workspace.getConfiguration("raiview").get("ollamaModels") ?? [];
        const ollamaUrl = vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434";
        const isLocal = (() => { try {
            const h = new URL(ollamaUrl).hostname;
            return h === "localhost" || h === "127.0.0.1" || h === "::1";
        }
        catch {
            return true;
        } })();
        if (pinned.length > 0 && !isLocal) {
            if (seq !== modelFetchSeq) {
                return;
            }
            webviewView.webview.postMessage({ type: "models", available: pinned });
            await sendReviewerModelsForWebview(webviewView);
            return;
        }
    }
    const provider = (0, provider_1.getProvider)(providerName);
    if (!provider) {
        webviewView.webview.postMessage({ type: "error", message: `Unknown provider: ${providerName}` });
        return;
    }
    try {
        const models = await provider.listModels(apiKey);
        if (seq !== modelFetchSeq) {
            return;
        }
        webviewView.webview.postMessage({ type: "models", available: models });
    }
    catch (err) {
        if (seq !== modelFetchSeq) {
            return;
        }
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
    "Do not repeat any finding already stated.";
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
        this.reviewCancelled = false;
        // Rolling summary state
        this.latestSummary = null;
        this.summaryGenerationId = 0;
        const config = vscode.workspace.getConfiguration("raiview");
        this.activeProvider = config.get("defaultProvider") ?? "ollama";
        this.systemPrompt = config.get("defaultSystemPrompt") ?? "";
        this.streamingMode =
            config.get("streamingMode") ?? "chunked";
        this.enhancedReviewer = config.get("enhancedReviewer") ?? false;
        (0, provider_1.getOllamaProvider)().setBaseUrl(config.get("ollamaUrl") ?? "http://localhost:11434");
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("raiview.ollamaUrl")) {
                (0, provider_1.getOllamaProvider)().setBaseUrl(vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434");
            }
        }, undefined, context.subscriptions);
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
        this.reviewCancelled = true; // halt any running chunked review loop
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
    tryParseReview(text) {
        // Full parse
        try {
            return JSON.parse(text);
        }
        catch { /* try recovery */ }
        // Recovery: truncated JSON — find the last complete finding object and close the structure
        const lastClose = text.lastIndexOf('"}');
        if (lastClose === -1) {
            return undefined;
        }
        const truncated = text.slice(0, lastClose + 2);
        // Find the findings array start
        const findingsStart = truncated.indexOf('"findings"');
        if (findingsStart === -1) {
            return undefined;
        }
        const arrayStart = truncated.indexOf('[', findingsStart);
        if (arrayStart === -1) {
            return undefined;
        }
        try {
            const partial = JSON.parse(truncated.slice(arrayStart) + ']');
            return { findings: partial, rating: "Needs Minor Changes" };
        }
        catch {
            return undefined;
        }
    }
    async sendChat(opts) {
        const { prompt, displayText, model, webviewView, isSystemMessage, skipExchangeCount } = opts;
        const attributionModel = opts.displayModel ?? model;
        const provider = (0, provider_1.getProvider)(this.activeProvider);
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
            ? (vscode.workspace.getConfiguration("raiview").get("ollamaContextWindow") ?? 8192)
            : undefined;
        const numPredict = this.activeProvider === "ollama"
            ? (vscode.workspace.getConfiguration("raiview").get("ollamaNumPredict") ?? 2000)
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
                    numPredict,
                    jsonSchema: opts.jsonSchema,
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
                let structured;
                if (opts.jsonSchema) {
                    structured = this.tryParseReview(fullResponse);
                }
                const html = structured ? undefined : await (0, marked_1.marked)(fullResponse);
                webviewView.webview.postMessage({ type: "streamEnd", html, structured, model: attributionModel, timestamp: Date.now() });
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
                    numPredict,
                    jsonSchema: opts.jsonSchema,
                    onUsage: (inputTokens, outputTokens) => {
                        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${this.activeProvider} / ${model}` +
                            ` | input: ${inputTokens.toLocaleString()} tokens` +
                            ` | output: ${outputTokens.toLocaleString()} tokens` +
                            ` | total: ${(inputTokens + outputTokens).toLocaleString()} tokens`);
                    },
                });
                let structured;
                if (opts.jsonSchema) {
                    structured = this.tryParseReview(fullResponse);
                }
                const html = structured ? undefined : await (0, marked_1.marked)(fullResponse);
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
            let structured;
            if (opts.jsonSchema) {
                try {
                    structured = JSON.parse(fullResponse);
                }
                catch { /* fallback */ }
            }
            return { text: fullResponse, structured };
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
            return { text: "" };
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
        const excludeExts = vscode.workspace.getConfiguration("raiview").get("excludeExtensions") ?? [];
        const pathspecExclusions = excludeExts.map(ext => `:(exclude)*${ext.startsWith(".") ? ext : "." + ext}`);
        const excludeArg = pathspecExclusions.length > 0 ? ` -- . ${pathspecExclusions.map(p => `"${p}"`).join(" ")}` : "";
        const extFilter = (f) => excludeExts.length === 0 || !excludeExts.some(ext => f.endsWith(ext.startsWith(".") ? ext : "." + ext));
        try {
            untrackedFiles = (0, child_process_1.execSync)(`git ls-files --others --exclude-standard`, {
                cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000,
            }).trim().split("\n").filter(Boolean).filter(extFilter);
        }
        catch (e) {
            outputChannel.appendLine(`[git] ls-files failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            diffFiles = (0, child_process_1.execSync)(`git diff --name-only HEAD${excludeArg}`, {
                cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000,
            }).trim().split("\n").filter(Boolean);
            diffText = (0, child_process_1.execSync)(`git diff HEAD${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
        }
        catch (e) {
            outputChannel.appendLine(`[git] diff HEAD failed, trying staged+unstaged fallback: ${e instanceof Error ? e.message : String(e)}`);
            try {
                const staged = (0, child_process_1.execSync)(`git diff --name-only --cached${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim().split("\n").filter(Boolean);
                const unstaged = (0, child_process_1.execSync)(`git diff --name-only${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim().split("\n").filter(Boolean);
                diffFiles = [...new Set([...staged, ...unstaged])];
                const d1 = (0, child_process_1.execSync)(`git diff --cached${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
                const d2 = (0, child_process_1.execSync)(`git diff${excludeArg}`, { cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 10000 });
                diffText = d1 + "\n" + d2;
            }
            catch (e2) {
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
            return `\n\nReview ALL of the following files/sections present above:\n${fileList}\n\nReturn a JSON object with exactly these two fields:\n- "findings": array of at most 5 findings (prioritise the most impactful), where each item has severity ("Critical", "Warning", or "Suggestion"), category ("Correctness", "Security", "Performance", "Design", "Readability", or "Error Handling"), title (short string), description (one sentence string)\n- "rating": exactly one of these three strings: "Looks Good", "Needs Minor Changes", "Needs Major Revision"\nCover every file listed. Do NOT echo the diff.`;
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
    async runChunkedReview(chunks, model, webviewView, singleDisplayText, displayModel) {
        this.reviewCancelled = false; // reset for this review run
        if (chunks.length > 1) {
            webviewView.webview.postMessage({
                type: "systemMessage",
                text: `📋 Content split into ${chunks.length} parts (limit: ${this.maxContentChars.toLocaleString()} chars). Reviewing each part in sequence...`,
            });
        }
        const responses = [];
        for (let i = 0; i < chunks.length; i++) {
            if (this.reviewCancelled) {
                break;
            }
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
                historyOverride: [], // each chunk reviewed in isolation — no cross-chunk contamination
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
            const allFindings = responses.flatMap(r => {
                try {
                    return JSON.parse(r).findings ?? [];
                }
                catch {
                    return [];
                }
            });
            // De-duplicate by title before sending to the model — prevents repeated findings
            // for functions that appear across multiple files (e.g. encode_scaled)
            const seenTitles = new Set();
            const uniqueFindings = allFindings.filter(f => {
                const key = f.title.toLowerCase().trim();
                if (seenTitles.has(key)) {
                    return false;
                }
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
    resolveWebviewView(webviewView) {
        this.webviewView = webviewView;
        const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
        const version = this.context.extension.packageJSON.version ?? '';
        webviewView.webview.html = this.getHtml(scriptUri, version);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "ready": {
                    const hasKey = !!(await this.getApiKey(this.activeProvider));
                    const providerKeyStatus = {};
                    for (const p of (0, provider_1.getAllProviders)()) {
                        providerKeyStatus[p.name] = !!(await this.getApiKey(p.name));
                    }
                    webviewView.webview.postMessage({
                        type: "init",
                        providers: (0, provider_1.getAllProviders)().map((p) => ({
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
                        autoUnloadModel: vscode.workspace.getConfiguration("raiview").get("autoUnloadModel") ?? false,
                        ollamaUrl: vscode.workspace.getConfiguration("raiview").get("ollamaUrl") ?? "http://localhost:11434",
                        ollamaModels: vscode.workspace.getConfiguration("raiview").get("ollamaModels") ?? [],
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
                case "saveOllamaUrl": {
                    const newUrl = (message.url ?? "").trim() || "http://localhost:11434";
                    await vscode.workspace.getConfiguration("raiview").update("ollamaUrl", newUrl, vscode.ConfigurationTarget.Global);
                    (0, provider_1.getOllamaProvider)().setBaseUrl(newUrl);
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
                    const models = message.models.filter(Boolean);
                    await vscode.workspace.getConfiguration("raiview").update("ollamaModels", models, vscode.ConfigurationTarget.Global);
                    fetchModelsForWebview("ollama", await this.getApiKey("ollama"), webviewView);
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
                    const target = message.provider ?? this.activeProvider;
                    const inlineKey = message.key?.trim() ?? "";
                    let keyValue;
                    if (inlineKey.length > 5) {
                        keyValue = inlineKey;
                    }
                    else {
                        const input = await vscode.window.showInputBox({
                            prompt: `Enter your ${(0, provider_1.getProvider)(target)?.displayName ?? target} API key`,
                            password: true,
                            ignoreFocusOut: true,
                        });
                        if (!input || input.trim().length <= 5) {
                            break;
                        }
                        keyValue = input.trim();
                    }
                    await this.setApiKey(target, keyValue);
                    const isActive = target === this.activeProvider;
                    webviewView.webview.postMessage({ type: "apiKeySet", provider: target, hasApiKey: true, isActiveProvider: isActive });
                    if (isActive) {
                        fetchModelsForWebview(this.activeProvider, keyValue, webviewView);
                    }
                    vscode.window.showInformationMessage(`${(0, provider_1.getProvider)(target)?.displayName} API key saved securely.`);
                    break;
                }
                case "clearApiKey": {
                    const target = message.provider ?? this.activeProvider;
                    await this.context.secrets.delete(`raiview.apiKey.${target}`);
                    const isActive = target === this.activeProvider;
                    webviewView.webview.postMessage({ type: "apiKeyCleared", provider: target, isActiveProvider: isActive });
                    if (isActive) {
                        fetchModelsForWebview(this.activeProvider, undefined, webviewView);
                    }
                    break;
                }
                case "reviewChanges": {
                    if (this.activeAbortController) {
                        break;
                    }
                    const userSelectedGitModel = message.model;
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
                    await this.runChunkedReview(gitChunks, model, webviewView, this.exchangeCount === 0 ? "Reviewing git changes..." : "Re-reviewing git changes...", userSelectedGitModel);
                    break;
                }
                case "sendToProvider": {
                    if (this.activeAbortController) {
                        break;
                    }
                    const userSelectedFileModel = message.model;
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
                    await this.runChunkedReview(fileChunks, model, webviewView, this.exchangeCount === 0 ? "Reviewing active file..." : "Re-reviewing active file...", userSelectedFileModel);
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
                        const renderedMessages = await Promise.all(session.messages.map(async (m) => {
                            if (m.role === "assistant") {
                                const structured = this.tryParseReview(m.content);
                                if (structured) {
                                    return { ...m, structured };
                                }
                                return { ...m, html: await (0, marked_1.marked)(m.content) };
                            }
                            return { ...m };
                        }));
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
                        const numPredict = vscode.workspace.getConfiguration("raiview").get("ollamaNumPredict") ?? 2000;
                        await (0, modelfile_1.createReviewerModel)(message.baseModel, ollamaUrl, (progressStatus) => {
                            webviewView.webview.postMessage({ type: "reviewerModelStatus", status: "progress", message: progressStatus });
                        }, numCtx, numPredict);
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
    getHtml(scriptUri, version) {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    /* ============ RAIVIEW — design tokens ============ */
    body.vscode-dark, body.vscode-high-contrast {
      --accent: #5cb9ff;
      --accent-ink: #04101a;
      --accent-dim: rgba(92,185,255,.13);
      --accent-line: rgba(92,185,255,.30);
      --sev-crit: #ff5d6c;
      --sev-warn: #ffc14d;
      --sev-info: #5cb9ff;
      --sev-ok: #39ff8a;
      --panel-bg: #0c0e11;
      --surface: #14181d;
      --surface-2: #191e25;
      --surface-hover: #1c222a;
      --border: rgba(255,255,255,.07);
      --border-strong: rgba(255,255,255,.13);
      --text: #e7eaef;
      --text-dim: #8b94a1;
      --text-faint: #59616d;
      --code-bg: rgba(255,255,255,.06);
      --shadow: 0 8px 30px rgba(0,0,0,.5);
      --font-sans: var(--vscode-font-family), system-ui, sans-serif;
      --font-mono: var(--vscode-editor-font-family), 'Courier New', monospace;
    }
    body.vscode-light {
      --accent: #1d74d6;
      --accent-ink: #ffffff;
      --accent-dim: rgba(29,116,214,.10);
      --accent-line: rgba(29,116,214,.34);
      --sev-crit: #e0344a;
      --sev-warn: #c98300;
      --sev-info: #2b86d9;
      --sev-ok: #0fa968;
      --panel-bg: #ffffff;
      --surface: #f4f6f8;
      --surface-2: #eceff2;
      --surface-hover: #e6eaee;
      --border: rgba(15,20,30,.10);
      --border-strong: rgba(15,20,30,.18);
      --text: #1a1f26;
      --text-dim: #5c6672;
      --text-faint: #97a0ab;
      --code-bg: rgba(15,20,30,.06);
      --shadow: 0 8px 28px rgba(20,30,50,.14);
      --font-sans: var(--vscode-font-family), system-ui, sans-serif;
      --font-mono: var(--vscode-editor-font-family), 'Courier New', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: var(--font-sans); font-size: 13px; background: var(--panel-bg); color: var(--text); -webkit-font-smoothing: antialiased; }
    ::selection { background: var(--accent-dim); }

    /* panel scroll */
    .panel-scroll { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 40px; }
    .panel-scroll::-webkit-scrollbar { width: 10px; }
    .panel-scroll::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; border: 3px solid transparent; background-clip: padding-box; }

    /* brand */
    .brand { display: flex; align-items: center; gap: 9px; }
    .brand .mark { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: var(--accent-dim); border: 1px solid var(--accent-line); flex: none; }
    .brand .mark svg { width: 13px; height: 13px; color: var(--accent); }
    .brand .name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; letter-spacing: 3px; color: var(--text); }
    .brand .name b { color: var(--accent); font-weight: 600; }
    .brand .ver { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); letter-spacing: .5px; }

    /* topbar */
    .topbar { display: flex; align-items: center; gap: 4px; padding: 2px 0 12px; border-bottom: 1px solid var(--border); }
    .topbar .lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; color: var(--text-faint); text-transform: uppercase; margin-right: auto; padding-left: 2px; }
    .iconbtn { width: 32px; height: 32px; border-radius: 8px; flex: none; display: grid; place-items: center; cursor: pointer; color: var(--text-dim); background: transparent; border: 1px solid transparent; transition: color .15s, border-color .15s; }
    .iconbtn:hover { color: var(--text); background: var(--surface); border-color: var(--border); }
    .iconbtn.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-dim); }
    .iconbtn svg { width: 16px; height: 16px; }
    .iconbtn.spin svg { animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* collapsible sections */
    .section-head { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; padding: 2px 0; }
    .section-head .chev { width: 12px; height: 12px; color: var(--text-faint); transition: transform .2s ease; flex: none; }
    .section-head.open .chev { transform: rotate(90deg); color: var(--accent); }
    .section-head h3 { margin: 0; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--text-dim); }
    .section-head .tag { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px; }
    .collapsible { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .25s ease; }
    .collapsible.open { grid-template-rows: 1fr; }
    .collapsible > .inner { overflow: hidden; }
    .collapsible.open > .inner { overflow: visible; }
    .coll-pad { padding-top: 10px; display: flex; flex-direction: column; gap: 0; }

    /* form controls */
    label.field-lbl { display: block; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); margin: 0 0 6px; }
    .select { position: relative; width: 100%; }
    .select select { width: 100%; appearance: none; -webkit-appearance: none; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 34px 10px 12px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .select select:hover { border-color: var(--border-strong); }
    .select select:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }
    .select .car { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--text-dim); width: 14px; height: 14px; }
    .input, .textarea { width: 100%; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; transition: border-color .15s, box-shadow .15s; }
    .textarea { resize: vertical; min-height: 78px; line-height: 1.55; }
    .input::placeholder, .textarea::placeholder { color: var(--text-faint); }
    .input:focus, .textarea:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }

    /* toggles */
    .toggle-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; }
    .toggle-row .tx { flex: 1; }
    .toggle-row .tx .t1 { font-size: 12.5px; color: var(--text); }
    .toggle-row .tx .t1 span { color: var(--text-dim); }
    .switch { width: 38px; height: 22px; border-radius: 999px; flex: none; cursor: pointer; background: var(--surface-2); border: 1px solid var(--border-strong); position: relative; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-faint); transition: transform .2s ease; }
    .switch.on { background: var(--accent); border-color: var(--accent); }
    .switch.on::after { transform: translateX(16px); background: var(--accent-ink); }

    /* action buttons */
    .actions { display: flex; gap: 8px; align-items: stretch; }
    .act-btn { flex: 1 1 50%; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; font-family: var(--font-sans); font-size: 13px; font-weight: 600; padding: 11px 12px; border-radius: 10px; cursor: pointer; border: 1px solid var(--accent-line); color: var(--accent); background: var(--accent-dim); transition: flex .2s, padding .2s, opacity .2s, transform .1s; white-space: nowrap; overflow: hidden; }
    .act-btn svg { width: 15px; height: 15px; flex: none; }
    .act-btn:hover { filter: brightness(1.1); }
    .act-btn:active { transform: translateY(1px); }
    .act-btn.primary { background: var(--accent); color: var(--accent-ink); }
    .act-btn.primary:hover { filter: brightness(1.06); }
    .act-btn.busy { color: var(--text-dim); background: var(--surface); border-color: var(--border); cursor: default; filter: none; }
    .act-btn.hidden-btn { flex: 0 0 0 !important; padding-left: 0 !important; padding-right: 0 !important; margin: 0 !important; opacity: 0 !important; border-width: 0 !important; pointer-events: none; }
    .act-btn .spin-ic { width: 14px; height: 14px; animation: spin .8s linear infinite; }
    .act-btn:disabled { opacity: .5; cursor: default; }

    /* settings card */
    .settings { border: 1px solid var(--accent-line); border-radius: 12px; background: linear-gradient(180deg, var(--surface), var(--panel-bg)); padding: 14px; box-shadow: var(--shadow); position: relative; overflow: hidden; display: none; }
    .settings.open { display: block; }
    .settings::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: .6; }
    .settings .s-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .settings .s-head svg { width: 14px; height: 14px; color: var(--accent); }
    .settings .s-head h4 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .3px; color: var(--text); }
    .settings .hint { font-size: 11.5px; color: var(--text-dim); line-height: 1.5; margin: 4px 0 12px; }
    .settings .hint b { color: var(--text); }
    .divider { height: 1px; background: var(--border); margin: 12px 0; }
    .create-btn { width: 100%; text-align: center; font-family: var(--font-mono); font-size: 12px; letter-spacing: .5px; color: var(--accent); background: transparent; border: 1px dashed var(--accent-line); border-radius: 9px; padding: 9px; cursor: pointer; margin: 10px 0; transition: background .15s; }
    .create-btn:hover { background: var(--accent-dim); }
    .create-btn:disabled { opacity: .5; cursor: default; }
    .settings-sub-btn { display: block; margin: 8px auto 0; font-family: var(--font-sans); font-size: 12.5px; font-weight: 600; padding: 7px 18px; border-radius: 9px; cursor: pointer; background: var(--surface); border: 1px solid var(--accent-line); color: var(--accent); transition: background .15s; }
    .settings-sub-btn:hover { background: var(--surface-2); }
    .settings-sub-btn.danger { border-color: var(--sev-crit); color: var(--sev-crit); }
    .settings-sub-btn.danger:hover { background: color-mix(in srgb, var(--sev-crit) 12%, var(--surface)); }
    .settings-sub-btns { display: flex; gap: 8px; margin-top: 8px; }
    .settings-sub-btns .settings-sub-btn { flex: 1; margin: 0; }
    .key-status { font-size: 11.5px; color: var(--text-faint); margin: 6px 0; }
    .key-status.set { color: var(--sev-ok); }
    .reviewer-status { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; }
    .derived-model-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); font-size: 11.5px; font-family: var(--font-mono); margin-bottom: 4px; color: var(--text-dim); }
    .derived-model-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .derived-model-delete { background: none; border: none; color: var(--text-faint); cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0; width: auto; }
    .derived-model-delete:hover { color: var(--sev-crit); }
    .s-section-lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); margin: 14px 0 8px; }
    .reviewer-section { display: none; flex-direction: column; gap: 8px; padding-top: 8px; }
    .reviewer-section.visible { display: flex; }

    /* chat shell */
    .chat-shell { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); overflow: hidden; display: flex; flex-direction: column; }
    .chat-empty { padding: 38px 22px; text-align: center; min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
    .chat-empty .ring { width: 46px; height: 46px; border-radius: 50%; border: 1px solid var(--border-strong); display: grid; place-items: center; color: var(--text-faint); }
    .chat-empty .ring svg { width: 20px; height: 20px; }
    .chat-empty p { margin: 0; font-size: 12.5px; color: var(--text-dim); font-style: italic; }
    .chat-empty .kbd { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
    .chat-body { padding: 14px; display: flex; flex-direction: column; gap: 14px; }

    /* streaming */
    .stream-meta { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-dim); line-height: 1.6; text-align: center; padding: 4px 6px; }
    .stream-meta .file { color: var(--accent); }
    .parts { display: flex; gap: 5px; justify-content: center; padding: 4px 0; }
    .parts i { height: 4px; flex: 1; max-width: 54px; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--border); display: block; }
    .parts i.done { background: var(--accent); border-color: var(--accent); }
    .parts i.cur { background: var(--accent-dim); border-color: var(--accent-line); animation: pulseb 1.1s ease-in-out infinite; }
    @keyframes pulseb { 50% { background: var(--accent-line); } }
    .thinking { display: flex; align-items: center; gap: 11px; border: 1px solid var(--accent-line); border-radius: 10px; background: var(--accent-dim); padding: 12px 14px; }
    .thinking .cur { width: 9px; height: 16px; background: var(--accent); flex: none; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .thinking .lab { font-family: var(--font-mono); font-size: 12.5px; color: var(--accent); letter-spacing: .5px; }
    .thinking .dots::after { content: ""; animation: dots 1.4s steps(4) infinite; }
    @keyframes dots { 0%{content:"";} 25%{content:".";} 50%{content:"..";} 75%{content:"...";} }

    /* review output */
    .review { font-size: 13px; line-height: 1.62; color: var(--text); }
    .review h4 { margin: 16px 0 8px; font-size: 12.5px; font-weight: 700; letter-spacing: .3px; display: flex; align-items: center; gap: 8px; }
    .review h4:first-child { margin-top: 0; }
    .review h4 .num { font-family: var(--font-mono); font-size: 10px; color: var(--accent); border: 1px solid var(--accent-line); border-radius: 5px; padding: 1px 5px; background: var(--accent-dim); }
    .findings { display: flex; flex-direction: column; gap: 7px; margin: 0 0 4px; }
    .finding { display: flex; gap: 9px; align-items: flex-start; border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 8px 10px; background: var(--panel-bg); }
    .finding .chip { font-family: var(--font-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; flex: none; display: inline-flex; align-items: center; gap: 5px; line-height: 1; white-space: nowrap; }
    .finding .chip .d { width: 6px; height: 6px; border-radius: 50%; }
    .finding .tx { flex: 1; font-size: 12.5px; line-height: 1.55; color: var(--text); }
    .finding .tx code { font-family: var(--font-mono); font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; color: var(--text); }
    .finding.crit { border-left-color: var(--sev-crit); }
    .finding.crit .chip { color: var(--sev-crit); background: color-mix(in srgb, var(--sev-crit) 14%, transparent); }
    .finding.crit .chip .d { background: var(--sev-crit); }
    .finding.warn { border-left-color: var(--sev-warn); }
    .finding.warn .chip { color: var(--sev-warn); background: color-mix(in srgb, var(--sev-warn) 14%, transparent); }
    .finding.warn .chip .d { background: var(--sev-warn); }
    .finding.info { border-left-color: var(--sev-info); }
    .finding.info .chip { color: var(--sev-info); background: color-mix(in srgb, var(--sev-info) 14%, transparent); }
    .finding.info .chip .d { background: var(--sev-info); }
    .finding.ok { border-left-color: var(--sev-ok); }
    .finding.ok .chip { color: var(--sev-ok); background: color-mix(in srgb, var(--sev-ok) 14%, transparent); }
    .finding.ok .chip .d { background: var(--sev-ok); }
    .summary { display: flex; align-items: center; gap: 11px; margin-top: 14px; border: 1px solid var(--sev-warn); border-radius: 10px; padding: 11px 13px; background: color-mix(in srgb, var(--sev-warn) 9%, transparent); }
    .summary .ic-w { width: 26px; height: 26px; border-radius: 7px; flex: none; display: grid; place-items: center; background: color-mix(in srgb, var(--sev-warn) 18%, transparent); color: var(--sev-warn); }
    .summary .ic-w svg { width: 15px; height: 15px; }
    .summary .st .l1 { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); }
    .summary .st .l2 { font-size: 13.5px; font-weight: 700; color: var(--text); }
    .summary.ok { border-color: var(--sev-ok); background: color-mix(in srgb, var(--sev-ok) 9%, transparent); }
    .summary.ok .ic-w { background: color-mix(in srgb, var(--sev-ok) 18%, transparent); color: var(--sev-ok); }
    .summary.crit { border-color: var(--sev-crit); background: color-mix(in srgb, var(--sev-crit) 9%, transparent); }
    .summary.crit .ic-w { background: color-mix(in srgb, var(--sev-crit) 18%, transparent); color: var(--sev-crit); }
    .msg-foot { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); padding-top: 8px; border-top: 1px solid var(--border); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
    .msg-foot .m { color: var(--accent); }

    /* chat messages */
    .user-msg { align-self: flex-end; max-width: 88%; background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 10px 10px 3px 10px; padding: 8px 11px; font-size: 12.5px; color: var(--text); }
    .assistant-msg { font-size: 12.5px; line-height: 1.62; color: var(--text); }
    .assistant-msg p { margin: 5px 0; }
    .assistant-msg ul, .assistant-msg ol { margin: 5px 0; padding-left: 18px; }
    .assistant-msg li { margin: 2px 0; }
    .assistant-msg code { font-family: var(--font-mono); font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
    .assistant-msg pre { font-family: var(--font-mono); font-size: 11.5px; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 9px; padding: 11px 12px; overflow-x: auto; margin: 8px 0; }
    .assistant-msg pre code { background: none; border: none; padding: 0; }
    .system-note { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); text-align: center; padding: 2px 4px; font-style: italic; }
    .error-msg { font-size: 12.5px; color: var(--sev-crit); border: 1px solid var(--sev-crit); border-radius: 8px; padding: 8px 10px; background: color-mix(in srgb, var(--sev-crit) 10%, transparent); }

    /* chat footer */
    .chat-foot { border-top: 1px solid var(--border); padding: 11px 12px; background: var(--panel-bg); display: none; }
    .chat-foot.visible { display: block; }
    .progress-row { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
    .progress-row .pn { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); flex: none; }
    .bar { flex: 1; height: 4px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--accent); transition: width .4s ease; }
    .bar > i.warn { background: var(--sev-warn); }
    .bar > i.danger { background: var(--sev-crit); }
    .limit-warning { font-size: 11.5px; color: var(--sev-warn); margin-bottom: 8px; font-family: var(--font-mono); display: none; }
    .limit-warning.visible { display: block; }
    .followup { display: flex; gap: 8px; align-items: flex-end; }
    .followup .ta-wrap { flex: 1; }
    .followup textarea { width: 100%; resize: none; height: 40px; font-family: var(--font-sans); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 11px; line-height: 1.4; }
    .followup textarea:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }
    .followup textarea:disabled { opacity: .5; }
    .send-btn { flex: none; font-family: var(--font-sans); font-size: 12.5px; font-weight: 600; padding: 0 16px; height: 40px; border-radius: 9px; cursor: pointer; background: var(--accent); color: var(--accent-ink); border: none; transition: filter .15s, transform .1s; }
    .send-btn:hover { filter: brightness(1.07); }
    .send-btn:active { transform: translateY(1px); }
    .send-btn:disabled { opacity: .5; cursor: default; }
    .send-btn.stop { background: color-mix(in srgb, var(--sev-crit) 18%, transparent); color: var(--sev-crit); border: 1px solid var(--sev-crit); }
    .foot-link { display: none; text-align: right; margin-top: 9px; font-size: 11.5px; color: var(--accent); cursor: pointer; }
    .foot-link.visible { display: block; }
    .foot-link:hover { text-decoration: underline; }

    /* sessions */
    .sessions { display: flex; flex-direction: column; gap: 8px; }
    .sess { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); cursor: pointer; transition: border-color .15s, background .15s, transform .1s; display: flex; align-items: center; gap: 11px; }
    .sess:hover { border-color: var(--accent-line); background: var(--surface-hover); transform: translateX(2px); }
    .sess .tag-diff { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .5px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 6px; padding: 3px 7px; flex: none; }
    .sess .meta { flex: 1; min-width: 0; }
    .sess .meta .l1 { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sess .meta .l2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
    .sess .rate { flex: none; width: 9px; height: 9px; border-radius: 50%; }
    .sess .arrow { flex: none; color: var(--text-faint); width: 14px; height: 14px; }
    .sess:hover .arrow { color: var(--accent); }
    .sess-foot { display: flex; justify-content: flex-end; padding-top: 4px; }
    .clear-all { font-size: 11.5px; color: var(--text-faint); cursor: pointer; }
    .clear-all:hover { color: var(--sev-crit); }
    .history-empty { font-size: 12px; color: var(--text-faint); font-style: italic; }

    /* session viewer */
    .viewer { border: 1px solid var(--accent-line); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow); margin-top: 10px; display: none; }
    .viewer.visible { display: block; }
    .viewer .v-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel-bg); }
    .viewer .v-head .tag-diff { font-family: var(--font-mono); font-size: 10px; font-weight: 600; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 6px; padding: 3px 7px; }
    .viewer .v-head .vt { flex: 1; font-size: 11.5px; color: var(--text-dim); font-family: var(--font-mono); }
    .viewer .v-head .ro { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 5px; padding: 2px 6px; }
    .viewer .v-close { display: flex; align-items: center; gap: 5px; cursor: pointer; color: var(--text-faint); font-size: 11.5px; background: none; border: none; padding: 0; }
    .viewer .v-close:hover { color: var(--sev-crit); }
    .viewer .v-close svg { width: 13px; height: 13px; }
    .viewer .v-body { padding: 14px; max-height: 420px; overflow-y: auto; }
    .viewer .v-body::-webkit-scrollbar { width: 9px; }
    .viewer .v-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; border: 3px solid transparent; background-clip: padding-box; }

    .fade { animation: fade .3s ease both; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  </style>
</head>
<body>
<div class="panel-scroll">

  <!-- Brand -->
  <div class="brand">
    <span class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12C5 7.5 8.4 5.5 12 5.5S19 7.5 21.5 12C19 16.5 15.6 18.5 12 18.5S5 16.5 2.5 12Z"/><path d="M12 9.1l.86 1.93 1.93.86-1.93.86L12 15.5l-.86-1.95-1.93-.86 1.93-.86z" fill="currentColor" stroke="none"/></svg>
    </span>
    <span class="name">RAI<b>VIEW</b></span>
    <span class="ver">v${version}</span>
  </div>

  <!-- Topbar -->
  <div class="topbar">
    <span class="lbl" id="agentStatus">Local Agent · Ready</span>
    <button class="iconbtn" id="refreshBtn" title="Refresh models">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    </button>
    <button class="iconbtn" id="freeMemoryBtn" style="display:none" title="Unload model from Ollama memory">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>
    </button>
    <button class="iconbtn" id="settingsBtn" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>

  <!-- Settings panel -->
  <div class="settings" id="settingsPanel">
    <div class="s-head">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <h4>Settings</h4>
    </div>
    <div class="toggle-row">
      <div class="tx"><div class="t1">Streaming <span>(chunked output)</span></div></div>
      <div class="switch on" id="streamSwitch"></div>
    </div>
    <div class="toggle-row" id="enhancedRow" style="display:none">
      <div class="tx"><div class="t1">Enhanced Reviewer <span>(Ollama)</span></div></div>
      <div class="switch" id="enhancedSwitch"></div>
    </div>
    <div class="reviewer-section" id="reviewerSection">
      <p class="hint">Creates a <b>code-reviewer</b> model in Ollama with optimized parameters and a structured code-review system prompt.</p>
      <label class="field-lbl" style="margin-top:4px">Base Model</label>
      <div class="select">
        <select id="baseModelSelect"><option value="">Select base model...</option></select>
        <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <button class="create-btn" id="createReviewerBtn">✦ Create code-reviewer Model</button>
      <div class="reviewer-status" id="reviewerStatus"></div>
      <div id="derivedModelsList" style="display:none; margin-top:6px;"></div>
    </div>
    <div id="ollamaSettingsRow" style="display:none">
      <div class="divider"></div>
      <div class="s-section-lbl" style="margin-top:0">Ollama</div>
      <label class="field-lbl">URL</label>
      <input class="input" type="text" id="ollamaUrlInput" placeholder="http://localhost:11434" />
      <button class="settings-sub-btn" id="saveOllamaUrlBtn">Save URL</button>
      <label class="field-lbl" style="margin-top:12px">Pinned Models <span style="font-weight:400;font-size:10px;">(one per line — leave empty to fetch from server)</span></label>
      <textarea class="textarea" id="ollamaPinnedModels" rows="3" placeholder="qwen3.5:397b-cloud&#10;llama3.3:70b"></textarea>
      <button class="settings-sub-btn" id="savePinnedModelsBtn">Save Models</button>
    </div>
    <div class="divider"></div>
    <div class="s-section-lbl" style="margin-top:0">API Keys</div>
    <label class="field-lbl">Provider</label>
    <div class="select">
      <select id="keyProviderSelect"></select>
      <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <input class="input" type="password" id="apiKeyInput" placeholder="Enter API key..." style="margin-top:8px" />
    <div id="apiKeyHint" style="font-size:11.5px; color:var(--text-dim); margin-top:6px;"></div>
    <div class="key-status" id="apiKeyStatus">No key saved.</div>
    <div class="settings-sub-btns">
      <button class="settings-sub-btn" id="saveKeyBtn">Save Key</button>
      <button class="settings-sub-btn danger" id="clearKeyBtn">Clear Key</button>
    </div>
  </div>

  <!-- Action buttons -->
  <div class="actions">
    <button class="act-btn primary" id="reviewBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><circle cx="18" cy="8" r="3"/><path d="M18 11a6 6 0 0 1-6 6"/></svg>
      Review Git Changes
    </button>
    <button class="act-btn" id="sendBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12L21 4l-5 8 5 8z"/></svg>
      Send for Review
    </button>
  </div>

  <!-- Provider section -->
  <div class="sect">
    <div class="section-head open" id="providerHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>Provider</h3>
    </div>
    <div class="collapsible open" id="providerCollapsible">
      <div class="inner">
        <div class="coll-pad" id="providerBody">
          <div class="select">
            <select id="providerSelect"><option value="">Loading...</option></select>
            <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <label class="field-lbl" style="margin-top:12px">Model</label>
          <div class="select">
            <select id="availableModels"><option value="">Detecting...</option></select>
            <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- System prompt section -->
  <div class="sect" id="sysPromptSection">
    <div class="section-head" id="sysPromptHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>System Prompt</h3>
      <span class="tag" id="sysPromptTag" style="display:none">set</span>
    </div>
    <div class="collapsible" id="sysPromptCollapsible">
      <div class="inner">
        <div class="coll-pad">
          <textarea class="textarea" id="systemPrompt" rows="4" placeholder="Enter a system prompt to guide the review..."></textarea>
        </div>
      </div>
    </div>
  </div>

  <!-- Chat shell -->
  <div class="chat-shell">
    <div id="chatMessages">
      <div class="chat-empty" id="chatEmpty">
        <div class="ring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M3 12h18"/></svg>
        </div>
        <p>No review started yet.</p>
        <div class="kbd">▸ Click a review button above</div>
      </div>
    </div>
    <div class="chat-foot" id="followupArea">
      <div class="progress-row" id="limitBar" style="display:none">
        <span class="pn" id="limitText">0 / 20</span>
        <div class="bar"><i id="limitFill" style="width:0%"></i></div>
      </div>
      <div class="limit-warning" id="limitWarning"></div>
      <div class="followup">
        <div class="ta-wrap">
          <textarea id="followupInput" placeholder="Ask a follow-up question about the review..."></textarea>
        </div>
        <button class="send-btn" id="followupSend">Send</button>
      </div>
      <a class="foot-link" id="newSessionBtn">↺ Start new session</a>
    </div>
  </div>

  <!-- Recent Sessions -->
  <div class="sect">
    <div class="section-head open" id="historyHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>Recent Sessions</h3>
      <span class="tag" id="historyCount" style="display:none"></span>
    </div>
    <div class="collapsible open" id="historyCollapsible">
      <div class="inner">
        <div class="coll-pad">
          <div class="sessions" id="historyPanel">
            <div class="history-empty" id="historyEmpty">No past sessions.</div>
          </div>
          <div class="sess-foot" id="historyActions" style="display:none">
            <span class="clear-all" id="clearHistoryBtn">Clear All</span>
          </div>
          <div class="viewer" id="sessionOverlay">
            <div class="v-head">
              <span class="tag-diff">\`\`\`diff</span>
              <span class="vt" id="overlayTitle">Session transcript</span>
              <span class="ro">READ-ONLY</span>
              <button class="v-close" id="overlayCloseBtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                Close
              </button>
            </div>
            <div class="v-body" id="overlayMessages"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

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