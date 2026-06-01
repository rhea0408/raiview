# Test Findings

## Session: Claude - Review Git Changes

### 1. ✅ "Reviewing git changes..." shown as user message
The trigger message ("Reviewing git changes...") is displayed as a user bubble, which is misleading since it's a system-generated display label, not something the user typed.

### 2. ✅ Session not listed under Recent Sessions until new session is started
Sessions are only saved to history when "Start new session" is clicked. A session in progress does not appear in Recent Sessions. — Intentional: sessions should only be persisted once complete.

### 3. ✅ Slow responses for out-of-scope requests
When the user asked to make file changes or asked unrelated questions (e.g. color of a flower), the model still responded but took noticeably longer. — By design for local models: the delay is context prefill overhead (model must process the full code diff + history before any output), not a guardrail issue. Cloud providers handle this faster due to parallelised inference.

### 4. ✅ No stop/interrupt button
There is no way to cancel an in-progress AI response. Once a request is sent the user must wait for it to complete.

### 5. ✅ System prompt section visible after session has started
The system prompt collapsible section remains accessible during an active chat session, even though changing it mid-session has no effect on already-sent messages and can be confusing.

## Session: Mid-session model switch (Claude → Ollama)

### 6. ✅ Switching model mid-session causes history confusion
When the provider/model is switched mid-session, the full chat history is sent to the new model. The new model has no awareness that prior messages were from a different model and treats them as its own context, leading to incorrect attribution.

### 7. ✅ "Relist review comments" returns wrong content after model switch
When asked to relist the review comments originally given by Claude, the local Ollama model returned only the first comment it had generated itself, ignoring Claude's earlier output. The history is passed as flat messages with no model attribution, so the new model cannot distinguish whose comments are whose.

### 8. Interpretation issues when Ollama responds to Claude's review comments
When the local model was asked to act on review feedback that Claude had produced, it misinterpreted or partially addressed the comments. Likely caused by the local model not having the same context depth or instruction-following capability, compounded by receiving a mixed-model conversation history with no labelling of which model produced which response.

## General Quality & UX

### 9. ✅ Local models over-emphasise error handling in reviews
Local Ollama models disproportionately focus on error handling in review feedback. Claude produces more balanced reviews across the configured categories (Correctness, Design, Security, Performance, Readability, Error Handling). May be a limitation of the base model's instruction-following or the system prompt not being enforced strongly enough for smaller models.

### 10. Hallucination prevalent in local models
Local models frequently fabricate file names, function signatures, or code details not present in the reviewed code. Expected behaviour for smaller models but worth noting as a known quality gap compared to Claude.

### 11. ✅ Chat window sticks to bottom during streaming — cannot scroll up
While a response is being generated the chat area auto-scrolls to the bottom on every token, making it impossible to scroll up and read earlier parts of the conversation until the stream finishes.

### 12. ✅ Recent sessions overlay shows raw unrendered data
The past session view displays the full raw content — including the entire code/diff that was passed as the initial prompt and all AI responses in raw Markdown. The session title also reflects raw prompt content. Both the title and message display need truncation and Markdown rendering.

## Enhanced Reviewer (Ollama)

### 13. ✅ Enhanced reviewer always creates a single `code-reviewer:latest` model, overwriting the previous one
Regardless of which base model is selected, the created Modelfile is always named `code-reviewer:latest`. This means creating a reviewer from a second base model silently overwrites the first. Each base model should produce its own named variant (e.g. `code-reviewer-llama3:latest`, `code-reviewer-mistral:latest`) so multiple enhanced reviewers can coexist and be selected independently.

## Active File Review

### 14. ✅ Concurrent review requests bleed into each other
If a review is in progress (response streaming) and the user clicks "Send for Review" again for a different file, a second "Reviewing Active File..." bubble appears but its content is a continuation of the first request's stream rather than a fresh response — both bubbles end up showing identical text. No guard against concurrent sends exists. (Screenshot confirmed: two "Reviewing active file..." bubbles at 11:28 PM and 11:30 PM with duplicate response content.)

### 15. ✅ "Reviewing Active File..." bubble appears on the user side
Same issue as finding 1 — the trigger label is displayed as a user message bubble instead of a neutral system indicator.

### 16. ✅ Expanded past session overlay cannot be dismissed or minimised
Once a past session is opened via the Recent Sessions panel, the overlay stays visible with no way to close or collapse it. The close button (`✕ Close`) exists in the code but is not visible/reachable in the UI when the overlay is scrollable — it appears to be hidden behind or above the scrollable content. (Screenshots confirmed: overlay fills the panel with no visible close control, and the Recent Sessions header itself shows the raw session content with unrendered Markdown including code fences, headers, and bullet points.)

### 17. ✅ Stop button does not work during "Thinking..." phase
The ⏹ Stop button appears when a review is triggered, but clicking it while the AI is in the "Thinking..." state (before any tokens have streamed) has no effect — the generation continues regardless. Root cause: concurrent review requests (finding #18) overwrite `activeAbortController`, so the first request's abort signal can never be triggered.

### 18. ✅ Clicking review button multiple times starts concurrent reviews
If the review button is clicked more than once before the first response arrives, multiple simultaneous review requests are dispatched. The UI shows two "Reviewing git changes..." system messages and both streams run in parallel, resulting in overlapping or duplicate responses. No guard exists to disable the button after the first click until the session is fully started.

### 19. ✅ Claude model goes into "Thinking..." and never generates a response
When Claude is selected as the provider and a review is triggered, the UI shows the "Thinking..." bubble indefinitely with no response arriving. Root cause is finding #18 — a double-click fires two concurrent requests; the second overwrites the abort controller, leaving the first request permanently unabortable and hanging.
