import * as http from "http";

// ---------------------------------------------------------------------------
// Ollama model management for enhanced code reviews
// ---------------------------------------------------------------------------

const CODE_REVIEWER_SYSTEM_PROMPT =
  "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
  "Do NOT summarise or explain the code. Only report actual issues you find. " +
  "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
  "Review only the code that was given across these categories in order: " +
  "Correctness, Security, Performance, Design & Architecture (SOLID), " +
  "Readability, Error Handling, Complexity, and Test Coverage. " +
  "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. " +
  "Do NOT over-report Error Handling; treat it with the same weight as every other category. " +
  "Use severity labels: 🔴 Critical, 🟡 Warning, 🔵 Suggestion. " +
  "End with a summary rating: ✅ Looks Good, ⚠️ Needs Minor Changes, or 🛑 Needs Major Revision. " +
  "Be concise and actionable.";

// ---------------------------------------------------------------------------
// Ollama REST helpers (for model management — not for generation)
// ---------------------------------------------------------------------------

function ollamaRequest(
  method: string,
  path: string,
  baseUrl: string,
  body?: object,
  timeoutMs: number = 120_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString();
        if (res.statusCode && res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(responseBody);
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${responseBody}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
          }
        } else {
          resolve(responseBody);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama request timed out."));
    });
    req.on("error", (err) => reject(err));
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Stream an Ollama request, invoking onProgress with each JSON line's status.
 * Used for model creation which streams progress updates.
 */
function ollamaStreamRequest(
  method: string,
  path: string,
  baseUrl: string,
  body: object,
  onProgress?: (status: string) => void,
  timeoutMs: number = 600_000 // 10 minutes for model creation
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: timeoutMs,
    };
    let rejected = false;
    const req = http.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const respBody = Buffer.concat(chunks).toString();
          try {
            const parsed = JSON.parse(respBody);
            reject(
              new Error(parsed.error || `HTTP ${res.statusCode}: ${respBody}`)
            );
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${respBody}`));
          }
        });
        return;
      }

      let buffer = "";

      function processLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error) {
            rejected = true;
            reject(new Error(parsed.error));
            req.destroy();
            return;
          }
          if (onProgress && parsed.status) {
            onProgress(parsed.status);
          }
        } catch {
          // ignore non-JSON lines
        }
      }

      res.on("data", (chunk: Buffer) => {
        if (rejected) {
          return;
        }
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
          if (rejected) {
            return;
          }
        }
      });
      res.on("end", () => {
        if (buffer.trim()) {
          processLine(buffer);
        }
        if (!rejected) {
          resolve();
        }
      });
      res.on("error", (err) => {
        if (!rejected) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama model creation timed out. Try again."));
    });
    req.on("error", (err) => {
      if (!rejected) {
        reject(err);
      }
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the reviewer model name from a base model.
 * e.g. "gemma3:27b" → "code-reviewer-gemma3-27b:latest"
 *      "llama3:latest" → "code-reviewer-llama3:latest"
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
  return `code-reviewer${sanitized}:latest`;
}

/** List all derived code-reviewer-* models currently in Ollama. */
export async function listReviewerModels(
  ollamaUrl: string = "http://localhost:11434"
): Promise<string[]> {
  try {
    const raw = await ollamaRequest("GET", "/api/tags", ollamaUrl, undefined, 5000);
    const data = JSON.parse(raw);
    const models: { name: string }[] = data.models ?? [];
    return models.map((m) => m.name).filter((n) => n.startsWith("code-reviewer"));
  } catch {
    return [];
  }
}

/** Check whether the code-reviewer model for a given base model exists in Ollama. */
export async function reviewerModelExists(
  ollamaUrl: string = "http://localhost:11434",
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

/**
 * Create the code-reviewer model using Ollama's /api/create endpoint.
 * Uses the new API format (v0.5.5+): `from` + `system` instead of `modelfile`.
 * @param baseModel - The Ollama model to build on (e.g. "gemma3:27b")
 */
export async function createReviewerModel(
  baseModel: string,
  ollamaUrl: string = "http://localhost:11434",
  onProgress?: (status: string) => void,
  numCtx: number = 8192
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
        num_predict: 1500,
        top_p: 0.9,
      },
      stream: true,
    },
    onProgress
  );
}

/**
 * Unload a model from Ollama's memory by sending keep_alive=0.
 * Frees VRAM/RAM immediately without deleting the model from disk.
 */
export async function unloadOllamaModel(
  modelName: string,
  ollamaUrl: string = "http://localhost:11434"
): Promise<void> {
  try {
    await ollamaRequest("POST", "/api/generate", ollamaUrl, {
      model: modelName,
      keep_alive: 0,
    }, 5000);
  } catch {
    // Unload is best-effort — don't surface errors to the user
  }
}

/** Delete the reviewer model from Ollama. Pass either baseModel (name is derived) or modelName (used directly). */
export async function deleteReviewerModel(
  ollamaUrl: string = "http://localhost:11434",
  baseModel?: string,
  modelName?: string
): Promise<void> {
  const name = modelName ?? (baseModel ? getReviewerModelName(baseModel) : "code-reviewer:latest");
  // Ollama older versions use "name", newer versions use "model" — send both
  await ollamaRequest("DELETE", "/api/delete", ollamaUrl, { model: name, name });
}
