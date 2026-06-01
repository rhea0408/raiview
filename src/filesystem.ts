import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface ReadResult {
  ok: boolean;
  content: string;
}

// ---------------------------------------------------------------------------
// WSL helpers
// ---------------------------------------------------------------------------

function tryWslPath(linuxPath: string): string | null {
  try {
    const winPath = execSync(`wsl wslpath -w "${linuxPath}"`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (winPath && fs.existsSync(winPath)) { return winPath; }
  } catch { /* wsl not available or path doesn't exist */ }
  return null;
}

function wslReadFile(linuxPath: string): string | null {
  try {
    return execSync(`wsl cat "${linuxPath}"`, { encoding: "utf-8", timeout: 10000 });
  } catch {
    return null;
  }
}

function wslExists(linuxPath: string): "file" | "dir" | false {
  try {
    const result = execSync(
      `wsl bash -c "if [ -d '${linuxPath}' ]; then echo dir; elif [ -f '${linuxPath}' ]; then echo file; else echo none; fi"`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    if (result === "dir") { return "dir"; }
    if (result === "file") { return "file"; }
  } catch { /* ignore */ }
  return false;
}

function wslReadDir(linuxPath: string): string {
  try {
    const listing = execSync(
      `wsl bash -c "for f in '${linuxPath}'/*; do if [ -f \\"\\$f\\" ]; then echo \\"\\$f\\"; fi; done"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!listing) { return `Directory: ${linuxPath}\n(empty or no readable files)`; }
    const files = listing.split("\n").filter(Boolean);
    const parts: string[] = [`Directory: ${linuxPath}\n`];
    for (const f of files) {
      const name = f.split("/").pop() ?? f;
      const content = wslReadFile(f);
      parts.push(content !== null ? `--- ${name} ---\n${content}\n` : `--- ${name} --- (could not read)\n`);
    }
    return parts.join("\n");
  } catch {
    return `⚠ Could not read WSL directory: ${linuxPath}`;
  }
}

function uncToLinuxPath(uncPath: string): string | null {
  const match = uncPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$/i);
  return match ? "/" + match[2].replace(/\\/g, "/") : null;
}

// ---------------------------------------------------------------------------
// Windows directory reader
// ---------------------------------------------------------------------------

function readWindowsDir(dirPath: string): string {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const parts: string[] = [`Directory: ${dirPath}\n`];
  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = path.join(dirPath, entry.name);
      try {
        parts.push(`--- ${entry.name} ---\n${fs.readFileSync(filePath, "utf-8")}\n`);
      } catch {
        parts.push(`--- ${entry.name} --- (could not read)\n`);
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isFilePath(input: string): boolean {
  if (/^[a-zA-Z]:[/\\]/.test(input)) { return true; }
  if (input.startsWith("\\\\") || input.startsWith("/")) { return true; }
  if (input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\")) { return true; }
  try { return fs.existsSync(path.resolve(input)); } catch { return false; }
}

export function readFileOrFolder(inputPath: string): ReadResult {
  // --- UNC / WSL path ---
  if (inputPath.startsWith("\\\\")) {
    try {
      if (fs.existsSync(inputPath)) {
        const stat = fs.statSync(inputPath);
        if (stat.isFile()) { return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(inputPath, "utf-8")}` }; }
        if (stat.isDirectory()) { return { ok: true, content: readWindowsDir(inputPath) }; }
      }
    } catch { /* fall through to WSL */ }
    const linuxPath = uncToLinuxPath(inputPath);
    if (linuxPath) {
      const type = wslExists(linuxPath);
      if (type === "file") {
        const content = wslReadFile(linuxPath);
        if (content !== null) { return { ok: true, content: `File: ${inputPath}\n\n${content}` }; }
      }
      if (type === "dir") { return { ok: true, content: wslReadDir(linuxPath) }; }
    }
    return { ok: false, content: `Path not accessible: ${inputPath}\nEnsure WSL is running and the path exists.` };
  }

  // --- Linux / WSL path ---
  if (inputPath.startsWith("/")) {
    const winPath = tryWslPath(inputPath);
    if (winPath) {
      try {
        if (fs.existsSync(winPath)) {
          const stat = fs.statSync(winPath);
          if (stat.isFile()) { return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(winPath, "utf-8")}` }; }
          if (stat.isDirectory()) { return { ok: true, content: readWindowsDir(winPath) }; }
        }
      } catch { /* fall through */ }
    }
    const type = wslExists(inputPath);
    if (type === "file") {
      const content = wslReadFile(inputPath);
      if (content !== null) { return { ok: true, content: `File: ${inputPath}\n\n${content}` }; }
    }
    if (type === "dir") { return { ok: true, content: wslReadDir(inputPath) }; }
    return { ok: false, content: `Path not found: ${inputPath}\nIf this is a WSL path, ensure WSL is running.` };
  }

  // --- Windows native path ---
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) { return { ok: false, content: `Path not found: ${resolved}` }; }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) { return { ok: true, content: `File: ${resolved}\n\n${fs.readFileSync(resolved, "utf-8")}` }; }
  if (stat.isDirectory()) { return { ok: true, content: readWindowsDir(resolved) }; }
  return { ok: false, content: `Unsupported path type: ${resolved}` };
}
