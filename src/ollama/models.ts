import { ollamaRequest, ollamaStreamRequest } from "./http";
import { DEFAULT_OLLAMA_URL } from "../constants";

const CODE_REVIEWER_SYSTEM_PROMPT =
  "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
  "Do NOT summarise or explain the code. Only report actual issues you find. " +
  "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
  "Review only the code that was given across these categories in order: " +
  "Correctness, Security, Performance, Design & Architecture (SOLID), " +
  "Readability, Error Handling, Complexity, and Test Coverage. " +
  "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. " +
  "Do NOT over-report Error Handling; treat it with the same weight as every other category. " +
  "Be concise and actionable.";

/**
 * Derive the reviewer model name from a base model.
 * e.g. "gemma3:27b" → "code-reviewer-gemma3-27b:latest"
 */
export function getReviewerModelName(baseModel: string): string {
  const colonIdx = baseModel.lastIndexOf(":");
  let basePart: string;
  if (colonIdx === -1) {
    basePart = baseModel;
  } else {
    const tag = baseModel.slice(colonIdx + 1);
    const name = baseModel.slice(0, colonIdx);
    basePart = tag === "latest" ? name : `${name}-${tag}`;
  }
  const sanitized = basePart.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `code-reviewer-${sanitized}:latest`;
}

export async function listReviewerModels(ollamaUrl: string = DEFAULT_OLLAMA_URL): Promise<string[]> {
  try {
    const raw = await ollamaRequest("GET", "/api/tags", ollamaUrl, undefined, 5000);
    const data = JSON.parse(raw);
    const models: { name: string }[] = data.models ?? [];
    return models.map((m) => m.name).filter((n) => n.startsWith("code-reviewer"));
  } catch {
    return [];
  }
}

export async function reviewerModelExists(
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
  baseModel?: string
): Promise<boolean> {
  try {
    const raw = await ollamaRequest("GET", "/api/tags", ollamaUrl, undefined, 5000);
    const data = JSON.parse(raw);
    const models: { name: string }[] = data.models ?? [];
    if (baseModel) {
      const target = getReviewerModelName(baseModel);
      return models.some((m) => m.name === target);
    }
    return models.some((m) => m.name.startsWith("code-reviewer"));
  } catch {
    return false;
  }
}

export async function createReviewerModel(
  baseModel: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
  onProgress?: (status: string) => void,
  numCtx: number = 8192,
  numPredict: number = 2000
): Promise<void> {
  await ollamaStreamRequest(
    "POST",
    "/api/create",
    ollamaUrl,
    {
      model: getReviewerModelName(baseModel),
      from: baseModel,
      system: CODE_REVIEWER_SYSTEM_PROMPT,
      parameters: {
        temperature: 0.2,
        repeat_penalty: 1.3,
        num_ctx: numCtx,
        num_predict: numPredict,
        top_p: 0.9,
      },
      stream: true,
    },
    onProgress
  );
}

/** Unload a model from Ollama's memory by sending keep_alive=0. Frees VRAM without deleting from disk. */
export async function unloadOllamaModel(
  modelName: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
  log?: (msg: string) => void
): Promise<void> {
  log?.(`[unloadOllamaModel] POST ${ollamaUrl}/api/generate keep_alive:0 model:"${modelName}"`);
  await ollamaRequest("POST", "/api/generate", ollamaUrl, { model: modelName, keep_alive: 0 }, 5000);
  log?.(`[unloadOllamaModel] request resolved`);
}

/** Delete the reviewer model from Ollama. Pass either baseModel (name is derived) or modelName (used directly). */
export async function deleteReviewerModel(
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
  baseModel?: string,
  modelName?: string
): Promise<void> {
  const name = modelName ?? (baseModel ? getReviewerModelName(baseModel) : "code-reviewer:latest");
  // Ollama older versions use "name", newer versions use "model" — send both
  await ollamaRequest("DELETE", "/api/delete", ollamaUrl, { model: name, name });
}
