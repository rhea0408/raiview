# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Raiview is a VS Code extension that provides AI-powered code reviews via a side panel. It supports three LLM providers: Ollama (local), OpenAI, and Claude (Anthropic). Users can review git diffs, active files, or custom code snippets and hold multi-turn conversations with follow-up questions.

## Commands

```bash
npm run compile   # TypeScript → CommonJS in ./out/
npm run watch     # Continuous compilation
npm run package   # Build .vsix package for distribution (requires vsce)
```

There are no lint or test scripts. TypeScript strict mode is the primary correctness check — `npm run compile` catches type errors.

To debug: open the project in VS Code and press F5 (uses `.vscode/launch.json` to launch a new Extension Development Host window).

## Architecture

### Process Boundary

VS Code extensions split across two processes that communicate only via `postMessage`:

- **Extension host** (`src/extension.ts`) — Node.js process with full API access. Handles all LLM calls, git operations, file I/O, and secret storage.
- **Webview** (`media/webview.js`) — sandboxed browser process. Renders the chat UI and dispatches user actions back to the host.

The inline HTML template at the bottom of `extension.ts` (around line 1016) bootstraps the webview and embeds CSS using VSCode theme variables for dark/light mode support.

### Key Source Files

| File | Role |
|---|---|
| `src/extension.ts` | `SidePanelProvider` class — all session logic, message routing, API calls via `sendChat()`, git diff extraction, system prompt building, background summarization |
| `src/provider.ts` | `LLMProvider` interface + `OllamaProvider`, `OpenAIProvider`, `ClaudeProvider` implementations; streaming via `onToken` callback |
| `src/modelfile.ts` | Ollama-only: creates/deletes optimized `code-reviewer-<base>:latest` model variants, streams progress during creation |
| `src/filesystem.ts` | Cross-platform file reading: handles Windows native paths, UNC (`\\wsl.localhost\...`), and Linux/WSL paths |
| `media/webview.js` | Full chat UI: bubbles, provider/model dropdowns, settings panel, history panel, session overlay, streaming stop button |

### Message Protocol

**Extension → Webview**: `init`, `models`, `chatMessage`, `streamStart`/`streamUpdate`/`streamEnd`, `systemMessage`, `userMessage`, `error`, `sessionTriggered`, `generationStarted`/`generationEnded`, `exchangeUpdate`, `historyLoaded`, `sessionView`

**Webview → Extension**: `reviewChanges`, `sendToProvider`, `followUp`, `stopGeneration`, `newSession`, `setProvider`, `setApiKey`, `refreshModels`, `createReviewerModel`, `deleteReviewerModelByName`, `loadSession`, `clearHistory`

### Session & State

- Chat history (array of `{role, content}`) lives in `SidePanelProvider` memory and is persisted to VS Code's `globalState`.
- Background summarization fires after 5+ exchanges, every 2 turns — fire-and-forget, never blocks the user.
- Exchange limit: warn at 16, hard stop at 20.
- API keys stored in VS Code's secret store under `raiview.apiKey.{provider}`.

### Configuration (`raiview.*` in settings)

`defaultProvider`, `ollamaUrl`, `defaultSystemPrompt`, `streamingMode` (chunked/complete), `enhancedReviewer` (Ollama only), `autoUnloadModel`, `maxContentChars` (default 10000), `ollamaContextWindow`

## Known Issues

See `test-findings.md` for 19 tracked bugs. The most impactful:

- Concurrent review requests race on `activeAbortController` — last request wins, stop button may target wrong generation.
- Stop button has no effect during the "Thinking..." phase before streaming begins.
- Double-clicking review triggers duplicate requests.
- Auto-scroll during streaming overrides the user's manual scroll position.
- Session overlay close button is unreachable (obscured).

## Documentation

`docs/workflows.md` contains detailed state machine and message flow diagrams (7 Mermaid diagrams) covering the full session lifecycle.
