import OpenAI from "openai";
import type { LLMProvider, GenerateOptions } from "./types";

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
    if (!apiKey) { return OPENAI_FALLBACK_MODELS; }
    try {
      const client = this.client(apiKey);
      const list = await client.models.list();
      const models: string[] = [];
      for await (const model of list) {
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
    if (!opts.apiKey) { throw new Error("OpenAI API key is required."); }
    const client = this.client(opts.apiKey);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (opts.systemPrompt) { messages.push({ role: "system", content: opts.systemPrompt }); }
    for (const m of opts.history ?? []) { messages.push({ role: m.role, content: m.content }); }
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
        if (token) { chunks.push(token); opts.onToken(token); }
        if (chunk.usage) { opts.onUsage?.(chunk.usage.prompt_tokens, chunk.usage.completion_tokens); }
      }
      return chunks.join("");
    }

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
    if (response.usage) { opts.onUsage?.(response.usage.prompt_tokens, response.usage.completion_tokens); }
    return response.choices[0]?.message?.content ?? "";
  }
}
