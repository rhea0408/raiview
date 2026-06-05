import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, GenerateOptions } from "./types";

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
    if (!opts.apiKey) { throw new Error("Claude API key is required."); }
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
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const token = event.delta.text;
          chunks.push(token);
          opts.onToken(token);
        }
      }
      if (inputTokens || outputTokens) { opts.onUsage?.(inputTokens, outputTokens); }
      return chunks.join("");
    }

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
