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
exports.listModels = listModels;
exports.listRunningModels = listRunningModels;
exports.generate = generate;
const http = __importStar(require("http"));
// For WSL: set OLLAMA_URL=http://172.31.48.1:11434 (Windows host IP)
// For native: defaults to http://localhost:11434
const OLLAMA_BASE = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 5000;
function request(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, OLLAMA_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { "Content-Type": "application/json" },
            timeout: timeoutMs,
        };
        const req = http.request(options, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Ollama request timed out. Is Ollama running?"));
        });
        req.on("error", (err) => reject(err));
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}
/** List models currently available in Ollama (downloaded). */
async function listModels() {
    const raw = await request("GET", "/api/tags");
    const data = JSON.parse(raw);
    return data.models ?? [];
}
/** List models currently loaded in memory (running). */
async function listRunningModels() {
    const raw = await request("GET", "/api/ps");
    const data = JSON.parse(raw);
    return data.models ?? [];
}
/** Send a prompt to a model and return the full response text. */
async function generate(model, prompt) {
    const raw = await request("POST", "/api/generate", {
        model,
        prompt,
        stream: false,
    }, 120000);
    const data = JSON.parse(raw);
    return data.response ?? "";
}
//# sourceMappingURL=ollama.js.map