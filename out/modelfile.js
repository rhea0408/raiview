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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReviewerModelName = getReviewerModelName;
exports.listReviewerModels = listReviewerModels;
exports.reviewerModelExists = reviewerModelExists;
exports.createReviewerModel = createReviewerModel;
exports.unloadOllamaModel = unloadOllamaModel;
exports.deleteReviewerModel = deleteReviewerModel;
const http = __importStar(require("http"));
// ---------------------------------------------------------------------------
// Ollama model management for enhanced code reviews
// ---------------------------------------------------------------------------
const CODE_REVIEWER_SYSTEM_PROMPT = "You are an expert Code Reviewer. Your job is to find problems in the code — NOT to describe what it does. " +
    "Do NOT summarise or explain the code. Only report actual issues you find. " +
    "Only reference files and functions that were explicitly provided. Do NOT invent or assume the existence of other files. " +
    "Review only the code that was given across these categories in order: " +
    "Correctness, Security, Performance, Design & Architecture (SOLID), " +
    "Readability, Error Handling, Complexity, and Test Coverage. " +
    "IMPORTANT: Distribute findings evenly — aim for 1–2 findings per category. " +
    "Do NOT over-report Error Handling; treat it with the same weight as every other category. " +
    "Be concise and actionable.";
// ---------------------------------------------------------------------------
// Ollama REST helpers (for model management — not for generation)
// ---------------------------------------------------------------------------
function ollamaRequest(method, path, baseUrl, body, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const bodyStr = body ? JSON.stringify(body) : undefined;
        const options = {
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
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 400) {
                    try {
                        const parsed = JSON.parse(responseBody);
                        reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${responseBody}`));
                    }
                    catch {
                        reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
                    }
                }
                else {
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
function ollamaStreamRequest(method, path, baseUrl, body, onProgress, timeoutMs = 600000 // 10 minutes for model creation
) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const options = {
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
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const respBody = Buffer.concat(chunks).toString();
                    try {
                        const parsed = JSON.parse(respBody);
                        reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${respBody}`));
                    }
                    catch {
                        reject(new Error(`HTTP ${res.statusCode}: ${respBody}`));
                    }
                });
                return;
            }
            let buffer = "";
            function processLine(line) {
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
                }
                catch {
                    // ignore non-JSON lines
                }
            }
            res.on("data", (chunk) => {
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
function getReviewerModelName(baseModel) {
    const colonIdx = baseModel.lastIndexOf(":");
    let basePart;
    if (colonIdx === -1) {
        basePart = baseModel;
    }
    else {
        const tag = baseModel.slice(colonIdx + 1);
        const name = baseModel.slice(0, colonIdx);
        basePart = tag === "latest" ? name : `${name}-${tag}`;
    }
    const sanitized = basePart.replace(/[^a-zA-Z0-9._-]/g, "-");
    return `code-reviewer-${sanitized}:latest`;
}
/** List all derived code-reviewer-* models currently in Ollama. */
async function listReviewerModels(ollamaUrl = "http://localhost:11434") {
    try {
        const raw = await ollamaRequest("GET", "/api/tags", ollamaUrl, undefined, 5000);
        const data = JSON.parse(raw);
        const models = data.models ?? [];
        return models.map((m) => m.name).filter((n) => n.startsWith("code-reviewer"));
    }
    catch {
        return [];
    }
}
/** Check whether the code-reviewer model for a given base model exists in Ollama. */
async function reviewerModelExists(ollamaUrl = "http://localhost:11434", baseModel) {
    try {
        const raw = await ollamaRequest("GET", "/api/tags", ollamaUrl, undefined, 5000);
        const data = JSON.parse(raw);
        const models = data.models ?? [];
        if (baseModel) {
            const target = getReviewerModelName(baseModel);
            return models.some((m) => m.name === target);
        }
        return models.some((m) => m.name.startsWith("code-reviewer"));
    }
    catch {
        return false;
    }
}
/**
 * Create the code-reviewer model using Ollama's /api/create endpoint.
 * Uses the new API format (v0.5.5+): `from` + `system` instead of `modelfile`.
 * @param baseModel - The Ollama model to build on (e.g. "gemma3:27b")
 */
async function createReviewerModel(baseModel, ollamaUrl = "http://localhost:11434", onProgress, numCtx = 8192, numPredict = 2000) {
    await ollamaStreamRequest("POST", "/api/create", ollamaUrl, {
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
    }, onProgress);
}
/**
 * Unload a model from Ollama's memory by sending keep_alive=0.
 * Frees VRAM/RAM immediately without deleting the model from disk.
 */
async function unloadOllamaModel(modelName, ollamaUrl = "http://localhost:11434", log) {
    log?.(`[unloadOllamaModel] POST ${ollamaUrl}/api/generate keep_alive:0 model:"${modelName}"`);
    await ollamaRequest("POST", "/api/generate", ollamaUrl, {
        model: modelName,
        keep_alive: 0,
    }, 5000);
    log?.(`[unloadOllamaModel] request resolved`);
}
/** Delete the reviewer model from Ollama. Pass either baseModel (name is derived) or modelName (used directly). */
async function deleteReviewerModel(ollamaUrl = "http://localhost:11434", baseModel, modelName) {
    const name = modelName ?? (baseModel ? getReviewerModelName(baseModel) : "code-reviewer:latest");
    // Ollama older versions use "name", newer versions use "model" — send both
    await ollamaRequest("DELETE", "/api/delete", ollamaUrl, { model: name, name });
}
//# sourceMappingURL=modelfile.js.map