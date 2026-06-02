import * as http from "http";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Common interface
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  systemPrompt: string;
  apiKey?: string;
  stream: boolean;
  onToken?: (token: string) => void;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  history?: ChatMessage[];
  signal?: AbortSignal;
  numCtx?: number; // Ollama-specific: context window size
  numPredict?: number; // Ollama-specific: max tokens to generate
  jsonSchema?: object; // When set, provider switches to structured JSON output mode
}

export interface LLMProvider {
  readonly name: string;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  listModels(apiKey?: string): Promise<string[]>;
  generate(opts: GenerateOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Ollama provider  (uses the OpenAI SDK with a custom baseURL)
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly displayName = "Ollama";
  readonly requiresApiKey = false;

  constructor(private baseUrl: string = DEFAULT_OLLAMA_URL) {}

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  private client(): OpenAI {
    return new OpenAI({
      baseURL: `${this.baseUrl}/v1/`,
      apiKey: "ollama", // required by SDK but ignored by Ollama
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const client = this.client();
      const list = await client.models.list();
      const models: string[] = [];
      for await (const model of list) {
        models.push(model.id);
      }
      return models;
    } catch {
      return [];
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const messages = [];
    if (opts.systemPrompt) { messages.push({ role: "system", content: opts.systemPrompt }); }
    for (const m of opts.history ?? []) { messages.push({ role: m.role, content: m.content }); }
    messages.push({ role: "user", content: opts.prompt });

    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: !!(opts.stream && opts.onToken && !opts.jsonSchema), // no streaming in JSON mode
    };
    body.options = {
      num_predict: opts.numPredict ?? (opts.jsonSchema ? 3000 : 1500),
      ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
    };
    if (opts.jsonSchema) { body.format = "json"; }

    const bodyStr = JSON.stringify(body);
    const url = new URL("/api/chat", this.baseUrl);

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const reqOptions: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? "443" : "80"),
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
      };

      const req = http.request(reqOptions, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const err: Buffer[] = [];
          res.on("data", (c) => err.push(c));
          res.on("end", () => {
            try { done(() => reject(new Error(JSON.parse(Buffer.concat(err).toString()).error ?? `HTTP ${res.statusCode}`))); }
            catch { done(() => reject(new Error(`HTTP ${res.statusCode}`))); }
          });
          return;
        }

        const chunks: string[] = [];
        let buf = "";

        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t) { continue; }
            try {
              const parsed = JSON.parse(t);
              const token: string = parsed.message?.content ?? "";
              if (token) { chunks.push(token); opts.onToken?.(token); }
              if (parsed.done) {
                const inputTok: number = parsed.prompt_eval_count ?? 0;
                const outputTok: number = parsed.eval_count ?? 0;
                if (inputTok || outputTok) { opts.onUsage?.(inputTok, outputTok); }
                done(() => resolve(chunks.join("")));
              }
            } catch { /* ignore non-JSON */ }
          }
        });
        res.on("end", () => {
          // Process any remaining buffered content (non-streaming responses have no trailing newline)
          if (buf.trim()) {
            try {
              const parsed = JSON.parse(buf.trim());
              const token: string = parsed.message?.content ?? "";
              if (token) { chunks.push(token); opts.onToken?.(token); }
              if (parsed.done) {
                const inputTok: number = parsed.prompt_eval_count ?? 0;
                const outputTok: number = parsed.eval_count ?? 0;
                if (inputTok || outputTok) { opts.onUsage?.(inputTok, outputTok); }
              }
            } catch { /* ignore non-JSON */ }
          }
          done(() => resolve(chunks.join("")));
        });
        res.on("error", (e) => done(() => reject(e)));
      });

      if (opts.signal) {
        if (opts.signal.aborted) { req.destroy(); done(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))); return; }
        opts.signal.addEventListener("abort", () => { req.destroy(); done(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))); });
      }

      req.on("error", (e) => done(() => reject(e)));
      req.write(bodyStr);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

const OPENAI_FALLBACK_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";
  readonly requiresApiKey = true;

  private client(apiKey: string): OpenAI {
    return new OpenAI({ apiKey });
  }

  async listModels(apiKey?: string): Promise<string[]> {
    if (!apiKey) {
      return OPENAI_FALLBACK_MODELS;
    }
    try {
      const client = this.client(apiKey);
      const list = await client.models.list();
      const models: string[] = [];
      for await (const model of list) {
        // Only include chat-capable models
        if (
          model.id.startsWith("gpt-") ||
          model.id.startsWith("o1") ||
          model.id.startsWith("o3") ||
          model.id.startsWith("o4")
        ) {
          models.push(model.id);
        }
      }
      return models.length > 0 ? models.sort() : OPENAI_FALLBACK_MODELS;
    } catch {
      return OPENAI_FALLBACK_MODELS;
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    if (!opts.apiKey) {
      throw new Error("OpenAI API key is required.");
    }
    const client = this.client(opts.apiKey);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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
      const chunks: string[] = [];
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
    } else {
      const createOpts: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: opts.model,
        messages,
        stream: false,
      };
      if (opts.jsonSchema) {
        createOpts.response_format = {
          type: "json_schema",
          json_schema: { name: "review", schema: opts.jsonSchema as Record<string, unknown>, strict: true },
        } as OpenAI.ResponseFormatJSONSchema;
      }
      const response = await client.chat.completions.create(createOpts, { signal: opts.signal });
      if (response.usage) {
        opts.onUsage?.(response.usage.prompt_tokens, response.usage.completion_tokens);
      }
      return response.choices[0]?.message?.content ?? "";
    }
  }
}

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

const CLAUDE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
];

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  readonly displayName = "Claude";
  readonly requiresApiKey = true;

  private client(apiKey: string): Anthropic {
    return new Anthropic({ apiKey });
  }

  async listModels(_apiKey?: string): Promise<string[]> {
    return CLAUDE_MODELS;
  }

  async generate(opts: GenerateOptions): Promise<string> {
    if (!opts.apiKey) {
      throw new Error("Claude API key is required.");
    }
    const client = this.client(opts.apiKey);

    const effectivePrompt = opts.jsonSchema
      ? `Respond only with valid JSON matching this schema: ${JSON.stringify(opts.jsonSchema)}\n\n${opts.prompt}`
      : opts.prompt;

    const claudeHistory: Anthropic.MessageParam[] = [
      ...(opts.history ?? []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: effectivePrompt },
    ];

    if (opts.stream && opts.onToken && !opts.jsonSchema) {
      const stream = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        system: opts.systemPrompt || undefined,
        messages: claudeHistory,
        stream: true,
      }, { signal: opts.signal });
      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const event of stream) {
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const token = event.delta.text;
          chunks.push(token);
          opts.onToken(token);
        }
      }
      if (inputTokens || outputTokens) { opts.onUsage?.(inputTokens, outputTokens); }
      return chunks.join("");
    } else {
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

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const ollamaProvider = new OllamaProvider();
const openaiProvider = new OpenAIProvider();
const claudeProvider = new ClaudeProvider();

const providers: Record<string, LLMProvider> = {
  ollama: ollamaProvider,
  openai: openaiProvider,
  claude: claudeProvider,
};

export function getProvider(name: string): LLMProvider | undefined {
  return providers[name];
}

export function getAllProviders(): LLMProvider[] {
  return Object.values(providers);
}

export function getOllamaProvider(): OllamaProvider {
  return ollamaProvider;
}
