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
  numCtx?: number;
  numPredict?: number;
  jsonSchema?: object;
}

export interface LLMProvider {
  readonly name: string;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  listModels(apiKey?: string): Promise<string[]>;
  generate(opts: GenerateOptions): Promise<string>;
}
