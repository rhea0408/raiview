import * as http from "http";

export function ollamaRequest(
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
    req.on("timeout", () => { req.destroy(); reject(new Error("Ollama request timed out.")); });
    req.on("error", (err) => reject(err));
    if (bodyStr) { req.write(bodyStr); }
    req.end();
  });
}

export function ollamaStreamRequest(
  method: string,
  path: string,
  baseUrl: string,
  body: object,
  onProgress?: (status: string) => void,
  timeoutMs: number = 600_000
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
            reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${respBody}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${respBody}`));
          }
        });
        return;
      }

      let buffer = "";

      function processLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error) { rejected = true; reject(new Error(parsed.error)); req.destroy(); return; }
          if (onProgress && parsed.status) { onProgress(parsed.status); }
        } catch { /* ignore non-JSON lines */ }
      }

      res.on("data", (chunk: Buffer) => {
        if (rejected) { return; }
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) { processLine(line); if (rejected) { return; } }
      });
      res.on("end", () => {
        if (buffer.trim()) { processLine(buffer); }
        if (!rejected) { resolve(); }
      });
      res.on("error", (err) => { if (!rejected) { reject(err); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Ollama model creation timed out. Try again.")); });
    req.on("error", (err) => { if (!rejected) { reject(err); } });
    req.write(JSON.stringify(body));
    req.end();
  });
}
