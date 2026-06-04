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
    B -- No --> B1[addErrorMessage: No model selected]
    B -- Yes --> C[disable both review buttons]
    C --> D{activeAbortController set?}
    D -- Yes --> C1([ignored — generation in progress])
    D -- No --> E[postMessage: reviewChanges]
    E --> F{buildGitPrompt}
    F -- git ext missing --> F1[chatError + re-enable buttons]
    F -- no repo --> F2[chatError + re-enable buttons]
    F -- no changes --> F3[chatError + re-enable buttons]
    F -- content fits one chunk --> G1[single part path]
    F -- content too large --> G2[multi-part path]

    G1 --> G[set activeSessionTrigger = git]
    G --> H[postMessage: sessionTriggered trigger=git]
    H --> I["collapse provider section, hide inactive review btn, show newSessionBtn"]
    I --> J[sendChat]
    J --> K[postMessage: systemMessage — Reviewing git changes...]
    K --> L[push user prompt to chatHistory]
    L --> M[new AbortController → activeAbortController]
    M --> N["postMessage: generationStarted → enterStopMode"]
    N --> O[postMessage: aiThinking → streaming container created]
    O --> P{streaming mode?}
    P -- chunked --> Q[provider.generate stream=true]
    Q --> R[postMessage: streamStart]
    R --> S[streamUpdate × N tokens]
    S --> T[postMessage: streamEnd structured+model+ts]
    P -- complete --> U[provider.generate stream=false]
    U --> V[postMessage: chatMessage structured+model+ts]
    T & V --> W["push assistant msg to chatHistory, exchangeCount++"]
    W --> X[postMessage: showFollowup]
    X --> Y[postMessage: exchangeUpdate count/20]
    Y --> Z[triggerBackgroundSummary if count > 5]
    Z --> AA["postMessage: generationEnded → exitStopMode, enableVisibleReviewBtn"]

    G2 --> MP1[postMessage: systemMessage — Content split into N parts]
    MP1 --> MP2["loop: for each chunk i of N"]
    MP2 --> MP3["postMessage: systemMessage — Part i of N: filename"]
    MP3 --> MP4[sendChat for chunk i — up to 5 findings per chunk]
    MP4 --> MP5["postMessage: streamStart/streamUpdate/streamEnd"]
    MP5 --> MP6{more chunks?}
    MP6 -- Yes --> MP2
    MP6 -- No --> MP7[postMessage: systemMessage — Generating combined summary]
    MP7 --> MP8[sendChat combined summary → final streamEnd with merged findings]
    MP8 --> W

    Q -- AbortError --> E1["postMessage: generationStopped, enableVisibleReviewBtn"]
    U -- AbortError --> E1
    Q -- API error --> E2["chatHistory.pop — roll back, postMessage: chatError"]
    U -- API error --> E2
    E1 --> E3[postMessage: generationEnded]
```

> **Send for Review (Active File)** follows the identical path — only the trigger command (`sendToProvider`), display text ("Reviewing active file..."), and session trigger value (`"file"`) differ. Large files are split by method/function boundary (via VS Code symbol provider) or by line chunks as fallback.

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
    H -- Yes --> I["generationWasStopped=true, exitStopMode, replace streaming container with stopped note, followupArea visible+focused, enableVisibleReviewBtn"]
    I --> J["finally: if activeAbortController===abortController → null, postMessage: generationEnded"]
    J --> K{followupSend has stop class?}
    K -- No → already exited --> K1([ignored])
    K -- Yes --> L[exitStopMode — idempotent]
```

---

## Diagram 5 — Mid-Session Provider/Model Switch

Switching provider or model mid-session does **not** reset the conversation. History and exchange count are preserved. The next generation simply uses the newly selected provider and model.

```mermaid
flowchart TD
    A([User changes provider dropdown]) --> B[postMessage: setProvider provider=X]
    B --> C{"activeSessionTrigger set AND new != current AND new requiresApiKey?"}
    C -- All true --> D[postMessage: systemMessage — token cost warning]
    C -- Otherwise --> E
    D --> E[activeProvider = new provider]
    E --> F[postMessage: providerChanged + hasApiKey + requiresApiKey]
    F --> G[fetchModelsForWebview → postMessage: models]
    G --> H[webview: model dropdown repopulated, API key requirement re-evaluated]
    H --> I([User selects new model from dropdown])
    I --> J{next generation triggered}
    J --> K{chatHistory has assistant messages from a different model?}
    K -- Yes --> L["buildSystemPrompt injects attribution note: prior messages were from old-model"]
    K -- No --> M[normal system prompt]
    L & M --> N[sendChat with new provider + new model]
```

---

## Diagram 6 — New Session Flow + VRAM Cleanup

```mermaid
flowchart TD
    A([User clicks Start new session]) --> B[postMessage: newSession]
    B --> C[saveCurrentSession — persists if exchangeCount > 0]
    C --> D["Reset: chatHistory=[], exchangeCount=0, activeSessionTrigger=null, latestSummary=null, currentModel=''"]
    D --> E{autoUnloadModel enabled?}
    E -- Yes --> F[unloadOllamaModel → frees VRAM/RAM immediately]
    E -- No --> G
    F --> G[postMessage: newSessionStarted]
    G --> H["Webview: clear chat, hide followupArea, hide newSessionBtn, limitBar hidden, restore both review buttons, reopen provider section, clear systemPrompt"]
    H --> I[postMessage: historyLoaded sessions]
    I --> J([Idle — ready for new review])

    subgraph Race Condition Window
    K[old sendChat still awaiting provider.generate from aborted session]
    K --> L[abort fires eventually — catch block runs]
    L --> M[postMessage: generationStopped arrives AFTER newSessionStarted]
    M --> N{webview: followupSend has stop class?}
    N -- No — guard blocks --> O([ignored safely])
    N -- Yes — stale processed — BUG --> P[new session streaming container cleared prematurely]
    end
```

---

## Diagram 7 — System Message Routing (Webview)

The `systemMessage` handler routes differently depending on whether a streaming generation is in progress.

```mermaid
flowchart TD
    A([systemMessage received]) --> B{streamingBubble exists?}
    B -- No --> Z[addSystemNote — italic faint text in chat]
    B -- Yes --> C{message content?}
    C -- "Content split into N parts" --> D[parse N, show streaming meta bar, render N part segments]
    C -- "— Part X of N: filename —" --> E[update parts bar: mark X-1 done, X current, show filename]
    C -- "Generating combined summary" --> F[update part info text]
    C -- other --> Z
```

---

## Diagram 8 — Settings Panel Interactions

```mermaid
flowchart TD
    A([User opens Settings gear]) --> B[settingsPanel.classList toggle open]

    B --> C{User action}

    C -- Toggle Streaming --> D[postMessage: toggleStreaming mode=chunked|complete]
    C -- Toggle Enhanced Reviewer --> E[postMessage: toggleEnhancedReviewer enabled=true|false]
    E --> E1{Ollama + enabled?}
    E1 -- Yes --> E2[show reviewer section: base model select + create button]
    E1 -- No --> E3[hide reviewer section]

    C -- Select base model + Create --> F[postMessage: createReviewerModel baseModel]
    F --> G[extension: createReviewerModel streams progress]
    G --> H["postMessage: reviewerModelStatus creating|progress|created|error"]

    C -- Delete reviewer model --> I[postMessage: deleteReviewerModelByName modelName]

    C -- Save Ollama URL --> J[postMessage: saveOllamaUrl url]
    C -- Save Pinned Models --> K[postMessage: savePinnedModels models array]
    K --> K1[extension stores to config, refetches model list]

    C -- Save API Key --> L{inline key typed?}
    L -- Yes → send key inline --> M[postMessage: setApiKey provider key]
    L -- No → fallback --> N[extension: showInputBox password prompt]
    M & N --> O[extension: secrets.store, postMessage: apiKeySet]
    O --> P[webview: clear apiKeyInput, update key status indicator]

    C -- Clear API Key --> Q[postMessage: clearApiKey provider]
    Q --> R[extension: secrets.delete, postMessage: apiKeyCleared]
```

---

## Key State Variables — Danger Zones

| Variable | File | Danger Zone |
|---|---|---|
| `activeAbortController` | extension.ts | Old session's `finally` block must not clobber a new session's controller — guarded by identity check `=== abortController` |
| `sessionActive` | webview.js | Gates button re-enable on `chatError`; must be `false` before first `sessionTriggered` fires |
| `generationWasStopped` | webview.js | Keeps follow-up area visible after stop; reset in `enterStopMode` when next generation starts |
| `streamingBubble` | webview.js | Set to `null` on `newSession`; stale `generationStopped` from old session would clear the **new** session's streaming container — guarded by stop-class check |
| `activeSessionTrigger` | extension.ts | `null` = pre-session; gates provider-switch token warning and `sessionTriggered` message |
| `exchangeCount` | extension.ts | NOT rolled back on abort; only rolled back on API error (non-abort); reset on `newSession` |
| `chatHistory` | extension.ts | User message pushed optimistically before generation; only popped on non-abort errors |
| `followupWasVisible` | webview.js | Captured at `enterStopMode`; determines whether follow-up area is hidden on `generationEnded` |
| `streamingEnabled` | webview.js | Tracks current streaming toggle state; synced to extension on change |
| `enhancedEnabled` | webview.js | Tracks enhanced reviewer toggle; controls visibility of reviewer section |
| `streamingPartsTotal` | webview.js | Number of parts in current multi-part review; reset on `aiThinking` |
| `streamingPartCurrent` | webview.js | Current part index in multi-part review; drives parts progress bar |
