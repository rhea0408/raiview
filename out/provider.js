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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeProvider = exports.OpenAIProvider = exports.OllamaProvider = void 0;
exports.getProvider = getProvider;
exports.getAllProviders = getAllProviders;
exports.getOllamaProvider = getOllamaProvider;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const openai_1 = __importDefault(require("openai"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
// ---------------------------------------------------------------------------
// Ollama provider  (uses the OpenAI SDK with a custom baseURL)
// ---------------------------------------------------------------------------
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
class OllamaProvider {
    constructor(baseUrl = DEFAULT_OLLAMA_URL) {
        this.baseUrl = baseUrl;
        this.name = "ollama";
        this.displayName = "Ollama";
        this.requiresApiKey = false;
    }
    setBaseUrl(url) {
        this.baseUrl = url;
    }
    client() {
        // The OpenAI SDK requires a non-empty apiKey string even for servers that
        // don't use it. "ollama" is the conventional placeholder for auth-free
        // Ollama instances. Auth for proxied Ollama setups is handled via explicit
        // Authorization headers in generate(), which uses raw HTTP directly.
        return new openai_1.default({
            baseURL: `${this.baseUrl}/v1/`,
            apiKey: "ollama",
        });
    }
    async listModels(_apiKey) {
        try {
            const client = this.client();
            const list = await client.models.list();
            const models = [];
            for await (const model of list) {
                models.push(model.id);
            }
            return models;
        }
        catch {
            return [];
        }
    }
    async generate(opts) {
        const messages = [];
        if (opts.systemPrompt) {
            messages.push({ role: "system", content: opts.systemPrompt });
        }
        for (const m of opts.history ?? []) {
            messages.push({ role: m.role, content: m.content });
        }
        messages.push({ role: "user", content: opts.prompt });
        const body = {
            model: opts.model,
            messages,
            stream: !!(opts.stream && opts.onToken && !opts.jsonSchema), // no streaming in JSON mode
        };
        body.options = {
            num_predict: opts.numPredict ?? (opts.jsonSchema ? 3000 : 1500),
            ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        };
        if (opts.jsonSchema) {
            body.format = "json";
        }
        const bodyStr = JSON.stringify(body);
        const url = new URL("/api/chat", this.baseUrl);
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn) => { if (!settled) {
                settled = true;
                fn();
            } };
            const headers = {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr),
            };
            if (opts.apiKey) {
                headers["Authorization"] = `Bearer ${opts.apiKey}`;
            }
            const reqOptions = {
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? "443" : "80"),
                path: url.pathname,
                method: "POST",
                headers,
            };
            const transport = url.protocol === "https:" ? https : http;
            const req = transport.request(reqOptions, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    const err = [];
                    res.on("data", (c) => err.push(c));
                    res.on("end", () => {
                        try {
                            done(() => reject(new Error(JSON.parse(Buffer.concat(err).toString()).error ?? `HTTP ${res.statusCode}`)));
                        }
                        catch {
                            done(() => reject(new Error(`HTTP ${res.statusCode}`)));
                        }
                    });
                    return;
                }
                const chunks = [];
                let buf = "";
                res.on("data", (chunk) => {
                    buf += chunk.toString();
                    const lines = buf.split("\n");
                    buf = lines.pop() ?? "";
                    for (const line of lines) {
                        const t = line.trim();
                        if (!t) {
                            continue;
                        }
                        try {
                            const parsed = JSON.parse(t);
                            const token = parsed.message?.content ?? "";
                            if (token) {
                                chunks.push(token);
                                opts.onToken?.(token);
                            }
                            if (parsed.done) {
                                const inputTok = parsed.prompt_eval_count ?? 0;
                                const outputTok = parsed.eval_count ?? 0;
                                if (inputTok || outputTok) {
                                    opts.onUsage?.(inputTok, outputTok);
                                }
                                done(() => resolve(chunks.join("")));
                            }
                        }
                        catch { /* ignore non-JSON */ }
                    }
                });
                res.on("end", () => {
                    // Process any remaining buffered content (non-streaming responses have no trailing newline)
                    if (buf.trim()) {
                        try {
                            const parsed = JSON.parse(buf.trim());
                            const token = parsed.message?.content ?? "";
                            if (token) {
                                chunks.push(token);
                                opts.onToken?.(token);
                            }
                            if (parsed.done) {
                                const inputTok = parsed.prompt_eval_count ?? 0;
                                const outputTok = parsed.eval_count ?? 0;
                                if (inputTok || outputTok) {
                                    opts.onUsage?.(inputTok, outputTok);
                                }
                            }
                        }
                        catch { /* ignore non-JSON */ }
                    }
                    done(() => resolve(chunks.join("")));
                });
                res.on("error", (e) => done(() => reject(e)));
            });
            if (opts.signal) {
                if (opts.signal.aborted) {
                    req.destroy();
                    done(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
                    return;
                }
                opts.signal.addEventListener("abort", () => { req.destroy(); done(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))); });
            }
            req.on("error", (e) => done(() => reject(e)));
            req.write(bodyStr);
            req.end();
        });
    }
}
exports.OllamaProvider = OllamaProvider;
// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------
const OPENAI_FALLBACK_MODELS = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
];
class OpenAIProvider {
    constructor() {
        this.name = "openai";
        this.displayName = "OpenAI";
        this.requiresApiKey = true;
    }
    client(apiKey) {
        return new openai_1.default({ apiKey });
    }
    async listModels(apiKey) {
        if (!apiKey) {
            return OPENAI_FALLBACK_MODELS;
        }
        try {
            const client = this.client(apiKey);
            const list = await client.models.list();
            const models = [];
            for await (const model of list) {
                // Only include chat-capable models
                if (model.id.startsWith("gpt-") ||
                    model.id.startsWith("o1") ||
                    model.id.startsWith("o3") ||
                    model.id.startsWith("o4")) {
                    models.push(model.id);
                }
            }
            return models.length > 0 ? models.sort() : OPENAI_FALLBACK_MODELS;
        }
        catch {
            return OPENAI_FALLBACK_MODELS;
        }
    }
    async generate(opts) {
        if (!opts.apiKey) {
            throw new Error("OpenAI API key is required.");
        }
        const client = this.client(opts.apiKey);
        const messages = [];
        if (opts.systemPrompt) {
            messages.push({ role: "system", content: opts.systemPrompt });
        }
        for (const m of opts.history ?? []) {
            messages.push({ role: m.role, content: m.content });
        }
        messages.push({ role: "user", content: opts.prompt });
        if (opts.stream && opts.onToken && !opts.jsonSchema) {
            const stream = await client.chat.completions.create({
                model: opts.model,
                messages,
                stream: true,
                stream_options: { include_usage: true },
            }, { signal: opts.signal });
            const chunks = [];
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content ?? "";
                if (token) {
                    chunks.push(token);
                    opts.onToken(token);
                }
                if (chunk.usage) {
                    opts.onUsage?.(chunk.usage.prompt_tokens, chunk.usage.completion_tokens);
                }
            }
            return chunks.join("");
        }
        else {
            const createOpts = {
                model: opts.model,
                messages,
                stream: false,
            };
            if (opts.jsonSchema) {
                createOpts.response_format = {
                    type: "json_schema",
                    json_schema: { name: "review", schema: opts.jsonSchema, strict: true },
                };
            }
            const response = await client.chat.completions.create(createOpts, { signal: opts.signal });
            if (response.usage) {
                opts.onUsage?.(response.usage.prompt_tokens, response.usage.completion_tokens);
            }
            return response.choices[0]?.message?.content ?? "";
        }
    }
}
exports.OpenAIProvider = OpenAIProvider;
// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------
const CLAUDE_MODELS = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5",
];
class ClaudeProvider {
    constructor() {
        this.name = "claude";
        this.displayName = "Claude";
        this.requiresApiKey = true;
    }
    client(apiKey) {
        return new sdk_1.default({ apiKey });
    }
    async listModels(_apiKey) {
        return CLAUDE_MODELS;
    }
    async generate(opts) {
        if (!opts.apiKey) {
            throw new Error("Claude API key is required.");
        }
        const client = this.client(opts.apiKey);
        const effectivePrompt = opts.jsonSchema
            ? `Respond only with valid JSON matching this schema: ${JSON.stringify(opts.jsonSchema)}\n\n${opts.prompt}`
            : opts.prompt;
        const claudeHistory = [
            ...(opts.history ?? []).map((m) => ({
                role: m.role,
                content: m.content,
            })),
            { role: "user", content: effectivePrompt },
        ];
        if (opts.stream && opts.onToken && !opts.jsonSchema) {
            const stream = await client.messages.create({
                model: opts.model,
                max_tokens: 4096,
                system: opts.systemPrompt || undefined,
                messages: claudeHistory,
                stream: true,
            }, { signal: opts.signal });
            const chunks = [];
            let inputTokens = 0;
            let outputTokens = 0;
            for await (const event of stream) {
                if (event.type === "message_start") {
                    inputTokens = event.message.usage.input_tokens;
                }
                else if (event.type === "message_delta") {
                    outputTokens = event.usage.output_tokens;
                }
                else if (event.type === "content_block_delta" &&
                    event.delta.type === "text_delta") {
                    const token = event.delta.text;
                    chunks.push(token);
                    opts.onToken(token);
                }
            }
            if (inputTokens || outputTokens) {
                opts.onUsage?.(inputTokens, outputTokens);
            }
            return chunks.join("");
        }
        else {
            const response = await client.messages.create({
                model: opts.model,
                max_tokens: 4096,
                system: opts.systemPrompt || undefined,
                messages: claudeHistory,
            }, { signal: opts.signal });
            opts.onUsage?.(response.usage.input_tokens, response.usage.output_tokens);
            const textBlock = response.content.find((b) => b.type === "text");
            return textBlock && textBlock.type === "text" ? textBlock.text : "";
        }
    }
}
exports.ClaudeProvider = ClaudeProvider;
// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------
const ollamaProvider = new OllamaProvider();
const openaiProvider = new OpenAIProvider();
const claudeProvider = new ClaudeProvider();
const providers = {
    ollama: ollamaProvider,
    openai: openaiProvider,
    claude: claudeProvider,
};
function getProvider(name) {
    return providers[name];
}
function getAllProviders() {
    return Object.values(providers);
}
function getOllamaProvider() {
    return ollamaProvider;
}
//# sourceMappingURL=provider.js.map