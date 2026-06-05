import * as http from "http";
import * as https from "https";
import OpenAI from "openai";
import type { LLMProvider, GenerateOptions } from "./types";
import { DEFAULT_OLLAMA_URL } from "../constants";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly displayName = "Ollama";
  readonly requiresApiKey = false;

  constructor(private baseUrl: string = DEFAULT_OLLAMA_URL) {}

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  private client(): OpenAI {
    // The OpenAI SDK requires a non-empty apiKey string even for servers that
    // don't use it. "ollama" is the conventional placeholder for auth-free
    // Ollama instances. Auth for proxied Ollama setups is handled via explicit
    // Authorization headers in generate(), which uses raw HTTP directly.
    return new OpenAI({ baseURL: `${this.baseUrl}/v1/`, apiKey: "ollama" });
  }

  async listModels(_apiKey?: string): Promise<string[]> {
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
      stream: !!(opts.stream && opts.onToken && !opts.jsonSchema),
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

      const headers: Record<string, string | number> = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      };
      if (opts.apiKey) { headers["Authorization"] = `Bearer ${opts.apiKey}`; }

      const reqOptions: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? "443" : "80"),
        path: url.pathname,
        method: "POST",
        headers,
      };

      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(reqOptions, (res) => {
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
