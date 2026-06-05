export type { ChatMessage, GenerateOptions, LLMProvider } from "./types";
export { OllamaProvider } from "./ollama";
export { OpenAIProvider } from "./openai";
export { ClaudeProvider } from "./claude";

import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import { ClaudeProvider } from "./claude";
import type { LLMProvider } from "./types";

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
