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
exports.isFilePath = isFilePath;
exports.readFileOrFolder = readFileOrFolder;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
// ---------------------------------------------------------------------------
// WSL helpers
// ---------------------------------------------------------------------------
function tryWslPath(linuxPath) {
    try {
        const winPath = (0, child_process_1.execSync)(`wsl wslpath -w "${linuxPath}"`, {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
        if (winPath && fs.existsSync(winPath)) {
            return winPath;
        }
    }
    catch { /* wsl not available or path doesn't exist */ }
    return null;
}
function wslReadFile(linuxPath) {
    try {
        return (0, child_process_1.execSync)(`wsl cat "${linuxPath}"`, { encoding: "utf-8", timeout: 10000 });
    }
    catch {
        return null;
    }
}
function wslExists(linuxPath) {
    try {
        const result = (0, child_process_1.execSync)(`wsl bash -c "if [ -d '${linuxPath}' ]; then echo dir; elif [ -f '${linuxPath}' ]; then echo file; else echo none; fi"`, { encoding: "utf-8", timeout: 3000 }).trim();
        if (result === "dir") {
            return "dir";
        }
        if (result === "file") {
            return "file";
        }
    }
    catch { /* ignore */ }
    return false;
}
function wslReadDir(linuxPath) {
    try {
        const listing = (0, child_process_1.execSync)(`wsl bash -c "for f in '${linuxPath}'/*; do if [ -f \\"\\$f\\" ]; then echo \\"\\$f\\"; fi; done"`, { encoding: "utf-8", timeout: 5000 }).trim();
        if (!listing) {
            return `Directory: ${linuxPath}\n(empty or no readable files)`;
        }
        const files = listing.split("\n").filter(Boolean);
        const parts = [`Directory: ${linuxPath}\n`];
        for (const f of files) {
            const name = f.split("/").pop() ?? f;
            const content = wslReadFile(f);
            parts.push(content !== null ? `--- ${name} ---\n${content}\n` : `--- ${name} --- (could not read)\n`);
        }
        return parts.join("\n");
    }
    catch {
        return `⚠ Could not read WSL directory: ${linuxPath}`;
    }
}
function uncToLinuxPath(uncPath) {
    const match = uncPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$/i);
    return match ? "/" + match[2].replace(/\\/g, "/") : null;
}
// ---------------------------------------------------------------------------
// Windows directory reader
// ---------------------------------------------------------------------------
function readWindowsDir(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const parts = [`Directory: ${dirPath}\n`];
    for (const entry of entries) {
        if (entry.isFile()) {
            const filePath = path.join(dirPath, entry.name);
            try {
                parts.push(`--- ${entry.name} ---\n${fs.readFileSync(filePath, "utf-8")}\n`);
            }
            catch {
                parts.push(`--- ${entry.name} --- (could not read)\n`);
            }
        }
    }
    return parts.join("\n");
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function isFilePath(input) {
    if (/^[a-zA-Z]:[/\\]/.test(input)) {
        return true;
    }
    if (input.startsWith("\\\\") || input.startsWith("/")) {
        return true;
    }
    if (input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\")) {
        return true;
    }
    try {
        return fs.existsSync(path.resolve(input));
    }
    catch {
        return false;
    }
}
function readFileOrFolder(inputPath) {
    // --- UNC / WSL path ---
    if (inputPath.startsWith("\\\\")) {
        try {
            if (fs.existsSync(inputPath)) {
                const stat = fs.statSync(inputPath);
                if (stat.isFile()) {
                    return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(inputPath, "utf-8")}` };
                }
                if (stat.isDirectory()) {
                    return { ok: true, content: readWindowsDir(inputPath) };
                }
            }
        }
        catch { /* fall through to WSL */ }
        const linuxPath = uncToLinuxPath(inputPath);
        if (linuxPath) {
            const type = wslExists(linuxPath);
            if (type === "file") {
                const content = wslReadFile(linuxPath);
                if (content !== null) {
                    return { ok: true, content: `File: ${inputPath}\n\n${content}` };
                }
            }
            if (type === "dir") {
                return { ok: true, content: wslReadDir(linuxPath) };
            }
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
                    if (stat.isFile()) {
                        return { ok: true, content: `File: ${inputPath}\n\n${fs.readFileSync(winPath, "utf-8")}` };
                    }
                    if (stat.isDirectory()) {
                        return { ok: true, content: readWindowsDir(winPath) };
                    }
                }
            }
            catch { /* fall through */ }
        }
        const type = wslExists(inputPath);
        if (type === "file") {
            const content = wslReadFile(inputPath);
            if (content !== null) {
                return { ok: true, content: `File: ${inputPath}\n\n${content}` };
            }
        }
        if (type === "dir") {
            return { ok: true, content: wslReadDir(inputPath) };
        }
        return { ok: false, content: `Path not found: ${inputPath}\nIf this is a WSL path, ensure WSL is running.` };
    }
    // --- Windows native path ---
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
        return { ok: false, content: `Path not found: ${resolved}` };
    }
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
        return { ok: true, content: `File: ${resolved}\n\n${fs.readFileSync(resolved, "utf-8")}` };
    }
    if (stat.isDirectory()) {
        return { ok: true, content: readWindowsDir(resolved) };
    }
    return { ok: false, content: `Unsupported path type: ${resolved}` };
}
//# sourceMappingURL=filesystem.js.map