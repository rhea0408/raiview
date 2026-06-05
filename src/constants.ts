// ---------------------------------------------------------------------------
// Numeric limits
// ---------------------------------------------------------------------------

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export const MAX_EXCHANGES = 20;
export const WARN_EXCHANGES = 16;
export const SUMMARY_THRESHOLD = 5;
export const DEFAULT_MAX_CONTENT_CHARS = 10000;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const GUARDRAILS = `You are operating as a code reviewer within a focused review session.

IMPORTANT CONTEXT: The code to be reviewed is provided in this conversation — either in the current message or in an earlier message. Do NOT ask the user to paste or provide it again. If the user asks you to re-review or revisit, refer back to the code already shared.

CRITICAL RULES — follow these in every response:
1. FILE MODIFICATIONS: If the user asks you to make changes to files, modify files, apply changes, or edit code on their behalf: politely explain that you cannot modify files directly as a reviewer. Instead, provide a concise code snippet showing exactly what the change would look like, and describe where in the file it should be applied.
2. MULTI-FILE CHANGES: If the user asks for changes across multiple files simultaneously: First analyze which files depend on each other (type definitions, utility functions, interfaces). Produce a dependency-ordered plan — list changes starting from files with no dependencies first, then files that depend on those. Tell the user to ask for each step one at a time. Do NOT provide all code changes at once.
3. SCOPE: Every follow-up question must relate to the code being reviewed or the review feedback provided. If the user asks something unrelated to the code or the review (general knowledge, creative tasks, unrelated topics), respond with exactly: "Please keep questions related to the current code review. Ask me anything about the code or feedback provided." Do not elaborate further on off-topic requests.`;

export const DEFAULT_REVIEW_SYSTEM_PROMPT =
  "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
  "Do NOT summarise, explain, or paraphrase the code. Only report actual issues you find. " +
  "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
  "Review only the code provided across these categories: Correctness, Design, Security, Performance, Readability, and Error Handling. " +
  "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. Do NOT focus disproportionately on any single category. " +
  "Do not repeat any finding already stated.";

export const SUMMARY_SYSTEM_PROMPT =
  "You are a helpful assistant that summarizes technical code review conversations concisely.";

export const SUMMARY_USER_PROMPT =
  `Summarize this code review conversation concisely. Preserve:
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

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  model?: string;
  provider?: string;
}

export interface ChatSession {
  id: string;
  startedAt: number;
  title: string;
  provider: string;
  model: string;
  messages: StoredMessage[];
  exchangeCount: number;
}

export interface ReviewChunk {
  prompt: string;
  label: string;
}

export interface ReviewFinding {
  severity: "Critical" | "Warning" | "Suggestion";
  category: "Correctness" | "Security" | "Performance" | "Design" | "Readability" | "Error Handling";
  title: string;
  description: string;
}

export interface ReviewResponse {
  findings: ReviewFinding[];
  rating: "Looks Good" | "Needs Minor Changes" | "Needs Major Revision";
}

export interface SendChatOpts {
  prompt: string;
  displayText: string;
  model: string;
  webviewView: import("vscode").WebviewView;
  isSystemMessage?: boolean;
  skipExchangeCount?: boolean;
  historyOverride?: import("./providers/types").ChatMessage[];
  jsonSchema?: object;
  displayModel?: string;
}

export interface SendChatResult {
  text: string;
  structured?: ReviewResponse;
}

export const REVIEW_JSON_SCHEMA = {
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
