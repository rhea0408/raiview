# Extension Workflow Diagrams

Reference for all user interaction paths, state transitions, and message exchanges.
Use this when fixing a bug to understand which conditions are affected and predict other areas at risk.

---

## Diagram 1 — Session Lifecycle (State Machine)

```mermaid
stateDiagram-v2
    [*] --> Idle : extension loads
    Idle --> Reviewing : Review Git Changes / Send for Review clicked
    Reviewing --> Thinking : sessionTriggered + generationStarted
    Thinking --> Streaming : streamStart (chunked mode)
    Thinking --> Stopped : stopGeneration (abort)
    Streaming --> Stopped : stopGeneration (abort)
    Thinking --> ResponseReady : chatMessage (complete mode)
    Streaming --> ResponseReady : streamEnd
    ResponseReady --> FollowUp : showFollowup
    Stopped --> FollowUp : generationStopped (follow-up area shown)
    FollowUp --> Thinking : followUp sent
    FollowUp --> Reviewing : Review Git Changes re-clicked (re-review)
    Stopped --> Reviewing : Review Git Changes re-clicked (re-review)
    FollowUp --> NewSession : newSession clicked
    ResponseReady --> NewSession : newSession clicked (limit not reached)
    FollowUp --> SessionLimit : exchangeCount >= 20
    SessionLimit --> NewSession : newSession clicked
    NewSession --> Idle : newSessionStarted
    Reviewing --> Idle : chatError (pre-session failure) + buttons re-enabled
```

---

## Diagram 2 — Review Git Changes (Happy Path + All Error Paths)

```mermaid
flowchart TD
    A([User clicks Review Git Changes]) --> B{model selected?}
    B -- No --> B1[addErrorBubble: No model selected]
    B -- Yes --> C[disable both review buttons]
    C --> D{activeAbortController set?}
    D -- Yes --> C1([ignored — generation in progress])
    D -- No --> E[postMessage: reviewChanges]
    E --> F{buildGitPrompt}
    F -- git ext missing --> F1[chatError + re-enable buttons]
    F -- no repo --> F2[chatError + re-enable buttons]
    F -- no changes --> F3[chatError + re-enable buttons]
    F -- ok --> G[set activeSessionTrigger = git]
    G --> H[postMessage: sessionTriggered trigger=git]
    H --> I["hide sendBtn, hide sysPromptSection, show newSessionBtn"]
    I --> J[sendChat]
    J --> K[postMessage: systemMessage — Reviewing git changes...]
    K --> L[push user prompt to chatHistory]
    L --> M[new AbortController → activeAbortController]
    M --> N["postMessage: generationStarted → enterStopMode, disable both review buttons"]
    N --> O[postMessage: aiThinking → streamingBubble created]
    O --> P{streaming mode?}
    P -- chunked --> Q[provider.generate stream=true]
    Q --> R[postMessage: streamStart]
    R --> S[streamUpdate × N tokens]
    S --> T[postMessage: streamEnd html+model+ts]
    P -- complete --> U[provider.generate stream=false]
    U --> V[postMessage: chatMessage html+model+ts]
    T & V --> W["push assistant msg to chatHistory, exchangeCount++"]
    W --> X[postMessage: showFollowup]
    X --> Y[postMessage: exchangeUpdate count/20]
    Y --> Z[triggerBackgroundSummary if count > 5]
    Z --> AA["postMessage: generationEnded → exitStopMode, enableVisibleReviewBtn"]

    Q -- AbortError --> E1["postMessage: generationStopped, enableVisibleReviewBtn"]
    U -- AbortError --> E1
    Q -- API error --> E2["chatHistory.pop — roll back, postMessage: chatError"]
    U -- API error --> E2
    E1 --> E3[postMessage: generationEnded]
```

> **Send for Review (Active File)** follows the identical path — only the trigger command (`sendToProvider`), display text ("Reviewing active file..."), and session trigger value (`"file"`) differ.

---

## Diagram 3 — Follow-up Message Flow

```mermaid
flowchart TD
    A([User types follow-up + sends]) --> B{input empty?}
    B -- Yes --> B1([ignored])
    B -- No --> C{followupSend has stop class?}
    C -- Yes --> D[postMessage: stopGeneration → abort]
    C -- No --> E{exchangeCount >= 20?}
    E -- Yes --> E1([ignored — limit reached])
    E -- No --> F["disable followupInput, clear followupInput value"]
    F --> G[postMessage: followUp content+model]
    G --> H[sendChat with user text as prompt + displayText]
    H --> I[same path as Diagram 2 from sendChat onwards]
```

---

## Diagram 4 — Stop Button Flow + Race Condition Guard

```mermaid
flowchart TD
    A([User clicks Stop]) --> B{followupSend has stop class?}
    B -- No → stale message guard --> B1([ignored — not in generation])
    B -- Yes --> C[postMessage: stopGeneration]
    C --> D{activeAbortController set?}
    D -- No --> D1([no-op])
    D -- Yes --> E["abort signal fired, activeAbortController = null"]
    E --> F[provider.generate throws AbortError]
    F --> G[catch: postMessage: generationStopped]
    G --> H{webview: followupSend has stop class?}
    H -- No → stale from old session --> H1([ignored safely])
    H -- Yes --> I["generationWasStopped=true, exitStopMode, clear bubble body, set meta=Stopped, followupArea visible+focused, enableVisibleReviewBtn"]
    I --> J["finally: if activeAbortController===abortController → null, postMessage: generationEnded"]
    J --> K{followupSend has stop class?}
    K -- No → already exited --> K1([ignored])
    K -- Yes --> L[exitStopMode — idempotent]
```

---

## Diagram 5 — Provider Switch Mid-Session

```mermaid
flowchart TD
    A([User changes provider dropdown]) --> B[postMessage: setProvider provider=X]
    B --> C{"activeSessionTrigger set AND new != current AND new requiresApiKey?"}
    C -- All true --> D[postMessage: systemMessage — token cost warning]
    C -- Otherwise --> E
    D --> E[activeProvider = new provider]
    E --> F[postMessage: providerChanged]
    F --> G[fetchModelsForWebview → postMessage: models]
    G --> H[model dropdown repopulated]
    H --> I{next generation triggered}
    I --> J{chatHistory has assistant messages from a different model?}
    J -- Yes --> K["buildSystemPrompt injects attribution note: prior messages were from old-model"]
    J -- No --> L[normal system prompt]
    K & L --> M[sendChat with new provider]
```

---

## Diagram 6 — New Session Flow + Stale Message Race Condition

```mermaid
flowchart TD
    A([User clicks Start new session]) --> B[postMessage: newSession]
    B --> C[saveCurrentSession — persists if exchangeCount > 0]
    C --> D["Reset: chatHistory=[], exchangeCount=0, activeSessionTrigger=null, latestSummary=null, currentModel=''"]
    D --> E[postMessage: newSessionStarted]
    E --> F["Webview: clear chat, hide followupArea, hide newSessionBtn, limitBar hidden, show+enable review buttons, clear systemPrompt"]
    F --> G["postMessage: setSystemPrompt prompt=''"]
    G --> H[postMessage: historyLoaded sessions]
    H --> I([Idle — ready for new review])

    subgraph Race Condition Window
    J[old sendChat still awaiting provider.generate from aborted session]
    J --> K[abort fires eventually — catch block runs]
    K --> L[postMessage: generationStopped arrives AFTER newSessionStarted]
    L --> M{webview: followupSend has stop class?}
    M -- No — guard blocks --> N([ignored safely])
    M -- Yes — stale processed — BUG --> O[new session streamingBubble cleared and follow-up shows prematurely]
    end
```

---

## Diagram 7 — Message Protocol Sequence Reference

```mermaid
sequenceDiagram
    participant W as Webview
    participant E as Extension Host

    Note over W,E: Startup
    W->>E: ready
    E->>W: init {providers, activeProvider, hasApiKey, streamingMode, systemPrompt}
    E->>W: historyLoaded {sessions}
    E->>W: models {available}

    Note over W,E: Review Triggered (chunked streaming)
    W->>E: reviewChanges {model}
    E->>W: sessionTriggered {trigger: git|file}
    E->>W: systemMessage {text}
    E->>W: generationStarted
    E->>W: aiThinking
    E->>W: streamStart
    E-->>W: streamUpdate {html} × N tokens
    E->>W: streamEnd {html, model, timestamp}
    E->>W: showFollowup
    E->>W: exchangeUpdate {count, limit, warn}
    E->>W: generationEnded

    Note over W,E: Stop During Generation
    W->>E: stopGeneration
    E->>W: generationStopped
    E->>W: generationEnded

    Note over W,E: Follow-up
    W->>E: followUp {content, model}
    E->>W: userMessage {text, timestamp}
    E->>W: generationStarted
    E->>W: aiThinking
    E-->>W: [same stream sequence]

    Note over W,E: New Session
    W->>E: newSession
    E->>W: newSessionStarted
    E->>W: historyLoaded {sessions}

    Note over W,E: Provider Change
    W->>E: setProvider {provider}
    E->>W: systemMessage {text} (only if mid-session + cloud provider)
    E->>W: providerChanged {provider, hasApiKey, requiresApiKey}
    E->>W: models {available}
```

---

## Key State Variables — Danger Zones

| Variable | File | Danger Zone |
|---|---|---|
| `activeAbortController` | extension.ts | Old session's `finally` block must not clobber a new session's controller — guarded by identity check `=== abortController` |
| `sessionActive` | webview.js | Gates button re-enable on `chatError`; must be `false` before first `sessionTriggered` fires |
| `generationWasStopped` | webview.js | Keeps follow-up area visible after stop; reset in `enterStopMode` when next generation starts |
| `streamingBubble` | webview.js | Set to `null` on `newSession`; stale `generationStopped` from old session would clear the **new** session's bubble — guarded by stop-class check |
| `activeSessionTrigger` | extension.ts | `null` = pre-session; gates provider-switch token warning and `sessionTriggered` message |
| `exchangeCount` | extension.ts | NOT rolled back on abort; only rolled back on API error (non-abort); reset on `newSession` |
| `chatHistory` | extension.ts | User message pushed optimistically before generation; only popped on non-abort errors |
| `followupWasVisible` | webview.js | Captured at `enterStopMode`; determines whether follow-up area is hidden on `generationEnded` |
| `generationWasStopped` | webview.js | Also checked in `exitStopMode` to prevent hiding follow-up after a stop event |
