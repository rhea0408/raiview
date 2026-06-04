const vscode = acquireVsCodeApi();

// ---- Theme sync ----
function syncTheme() {
  const cl = document.body.classList;
  document.documentElement.dataset.theme =
    cl.contains('vscode-dark') || cl.contains('vscode-high-contrast') ? 'dark' : 'light';
}
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---- DOM refs ----
const providerSel       = document.getElementById('providerSelect');
const availableSel      = document.getElementById('availableModels');
const sendBtn           = document.getElementById('sendBtn');
const reviewBtn         = document.getElementById('reviewBtn');
const refreshBtn        = document.getElementById('refreshBtn');
const freeMemoryBtn     = document.getElementById('freeMemoryBtn');
const settingsBtn       = document.getElementById('settingsBtn');
const settingsPanel     = document.getElementById('settingsPanel');
const streamSwitch      = document.getElementById('streamSwitch');
const enhancedRow       = document.getElementById('enhancedRow');
const enhancedSwitch    = document.getElementById('enhancedSwitch');
const reviewerSection   = document.getElementById('reviewerSection');
const derivedModelsList = document.getElementById('derivedModelsList');
const baseModelSel      = document.getElementById('baseModelSelect');
const sysPromptHeader   = document.getElementById('sysPromptHeader');
const sysPromptCollapsible = document.getElementById('sysPromptCollapsible');
const sysPromptTag      = document.getElementById('sysPromptTag');
const systemPromptEl    = document.getElementById('systemPrompt');
const providerHeader    = document.getElementById('providerHeader');
const providerCollapsible = document.getElementById('providerCollapsible');
const chatMessages      = document.getElementById('chatMessages');
const chatEmpty         = document.getElementById('chatEmpty');
const limitBar          = document.getElementById('limitBar');
const limitText         = document.getElementById('limitText');
const limitFill         = document.getElementById('limitFill');
const limitWarning      = document.getElementById('limitWarning');
const followupArea      = document.getElementById('followupArea');
const followupInput     = document.getElementById('followupInput');
const followupSend      = document.getElementById('followupSend');
const newSessionBtn     = document.getElementById('newSessionBtn');
const historyHeader     = document.getElementById('historyHeader');
const historyCollapsible = document.getElementById('historyCollapsible');
const historyPanel      = document.getElementById('historyPanel');
const historyEmpty      = document.getElementById('historyEmpty');
const historyActions    = document.getElementById('historyActions');
const historyCount      = document.getElementById('historyCount');
const clearHistoryBtn   = document.getElementById('clearHistoryBtn');
const sessionOverlay    = document.getElementById('sessionOverlay');
const overlayTitle      = document.getElementById('overlayTitle');
const overlayMessages   = document.getElementById('overlayMessages');
const overlayCloseBtn   = document.getElementById('overlayCloseBtn');
const sysPromptSection  = document.getElementById('sysPromptSection');
const keyProviderSel    = document.getElementById('keyProviderSelect');
const apiKeyHintEl      = document.getElementById('apiKeyHint');
const apiKeyStatusEl    = document.getElementById('apiKeyStatus');
const apiKeyInput       = document.getElementById('apiKeyInput');
const saveKeyBtn        = document.getElementById('saveKeyBtn');
const clearKeyBtn       = document.getElementById('clearKeyBtn');
const ollamaSettingsRow  = document.getElementById('ollamaSettingsRow');
const ollamaUrlInput     = document.getElementById('ollamaUrlInput');
const saveOllamaUrlBtn   = document.getElementById('saveOllamaUrlBtn');
const ollamaPinnedModels = document.getElementById('ollamaPinnedModels');
const savePinnedModelsBtn = document.getElementById('savePinnedModelsBtn');

// ---- State ----
let currentProvider = 'ollama';
let hasApiKey = false;
let requiresApiKey = false;
let providerKeyStatus = {};
let sessionActive = false;
let autoUnloadModel = false;
let streamingBubble = null;   // holds the streaming container div
let followupWasVisible = false;
let followupShownThisGeneration = false;
let generationWasStopped = false;
let userScrolledUp = false;
let streamingEnabled = true;
let enhancedEnabled = false;

// Parts tracking for multi-part reviews
let streamingPartsTotal = 0;
let streamingPartCurrent = 0;

// Buffer for parts messages that arrive before aiThinking creates the container
let pendingPartsTotal = 0;
let pendingPartInfoText = '';

// ---- Auto-scroll ----
function scrollToBottom() {
  if (!userScrolledUp) chatMessages.scrollTop = chatMessages.scrollHeight;
}
chatMessages.addEventListener('scroll', () => {
  const dist = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
  userScrolledUp = dist > 50;
});

// ---- Utility ----
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function populateSelect(selectEl, names, defaultVal) {
  selectEl.innerHTML = '';
  if (!names || names.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No models found';
    selectEl.appendChild(opt); return;
  }
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (defaultVal && name === defaultVal) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function escHtml(str) {
  return String(str)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('\n').join('<br>');
}

function updateApiKeyStatus() {
  const p = keyProviderSel ? keyProviderSel.value : currentProvider;
  const has = providerKeyStatus[p] ?? false;
  if (apiKeyHintEl) {
    apiKeyHintEl.textContent = p === 'ollama'
      ? 'Applies to the configured Ollama URL. Leave blank for local Ollama.' : '';
  }
  if (apiKeyStatusEl) {
    apiKeyStatusEl.textContent = has ? '● Key is set.' : 'No key saved.';
    apiKeyStatusEl.className = 'key-status' + (has ? ' set' : '');
  }
  if (clearKeyBtn) clearKeyBtn.disabled = !has;
}

function updateButtons() {
  const canSend = !requiresApiKey || hasApiKey;
  sendBtn.disabled = !canSend;
  enhancedRow.style.display = currentProvider === 'ollama' ? 'flex' : 'none';
  freeMemoryBtn.style.display =
    (currentProvider === 'ollama' && !autoUnloadModel && !sessionActive) ? 'grid' : 'none';
  derivedModelsList.style.display = currentProvider === 'ollama' ? 'block' : 'none';
  ollamaSettingsRow.style.display = currentProvider === 'ollama' ? 'block' : 'none';
  if (currentProvider !== 'ollama') reviewerSection.classList.remove('visible');
}

function setInputsDisabled(disabled) {
  followupInput.disabled = disabled;
  followupSend.disabled = disabled;
}

// ---- Collapsible section helpers ----
function openSection(headEl, collEl) {
  headEl.classList.add('open');
  collEl.classList.add('open');
}
function closeSection(headEl, collEl) {
  headEl.classList.remove('open');
  collEl.classList.remove('open');
}
function toggleSection(headEl, collEl) {
  const isOpen = headEl.classList.toggle('open');
  collEl.classList.toggle('open', isOpen);
  return isOpen;
}

// ---- Chat area helpers ----
function clearChatMessages() {
  chatMessages.innerHTML = '';
  chatMessages.appendChild(chatEmpty);
  chatEmpty.style.display = '';
}

function hideChatEmpty() {
  chatEmpty.style.display = 'none';
}

function appendToChat(el) {
  hideChatEmpty();
  chatMessages.appendChild(el);
  scrollToBottom();
}

// ---- New message wrappers ----
function addUserBubble(text, timestamp) {
  const el = document.createElement('div');
  el.className = 'user-msg';
  el.innerHTML = escHtml(text);
  const wrap = document.createElement('div');
  wrap.className = 'chat-body';
  wrap.style.gap = '0';
  wrap.appendChild(el);
  // user bubbles sit inside a chat-body wrapper for consistent padding
  const container = document.createElement('div');
  container.className = 'chat-body';
  container.appendChild(el);
  appendToChat(container);
}

function addAssistantMessage(html, meta) {
  const container = document.createElement('div');
  container.className = 'chat-body';
  const msg = document.createElement('div');
  msg.className = 'assistant-msg';
  msg.innerHTML = html;
  container.appendChild(msg);
  if (meta) {
    const foot = document.createElement('div');
    foot.className = 'msg-foot';
    const m = document.createElement('span');
    m.className = 'm';
    // split "model · time" — accent on model part
    const parts = meta.split(' · ');
    m.textContent = parts[0] || meta;
    foot.appendChild(m);
    if (parts.length > 1) {
      foot.appendChild(document.createTextNode(' · ' + parts.slice(1).join(' · ')));
    }
    container.appendChild(foot);
  }
  appendToChat(container);
  return container;
}

function addSystemNote(text) {
  const el = document.createElement('div');
  el.className = 'system-note';
  el.textContent = text;
  appendToChat(el);
}

function addErrorMessage(text) {
  const el = document.createElement('div');
  el.className = 'error-msg';
  el.textContent = '⚠ ' + text;
  const container = document.createElement('div');
  container.className = 'chat-body';
  container.appendChild(el);
  appendToChat(container);
}

// ---- Streaming state ----
function createStreamingContainer() {
  const container = document.createElement('div');
  container.className = 'chat-body';
  container.id = 'streamingContainer';

  const metaEl = document.createElement('div');
  metaEl.className = 'stream-meta';
  metaEl.id = 'streamingMeta';
  metaEl.style.display = 'none';
  container.appendChild(metaEl);

  const partsEl = document.createElement('div');
  partsEl.className = 'parts';
  partsEl.id = 'streamingParts';
  partsEl.style.display = 'none';
  container.appendChild(partsEl);

  const partInfoEl = document.createElement('div');
  partInfoEl.className = 'stream-meta';
  partInfoEl.id = 'streamingPartInfo';
  partInfoEl.style.display = 'none';
  container.appendChild(partInfoEl);

  const contentEl = document.createElement('div');
  contentEl.id = 'streamingContent';
  contentEl.innerHTML =
    '<div class="thinking"><span class="cur"></span>' +
    '<span class="lab">Thinking<span class="dots"></span></span></div>';
  container.appendChild(contentEl);

  return container;
}

function updateStreamingParts(total, current) {
  const partsEl = document.getElementById('streamingParts');
  const metaEl  = document.getElementById('streamingMeta');
  if (!partsEl || !metaEl) return;
  partsEl.style.display = 'flex';
  metaEl.style.display  = 'block';
  partsEl.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const seg = document.createElement('i');
    if (i < current - 1)      seg.className = 'done';
    else if (i === current - 1) seg.className = 'cur';
    partsEl.appendChild(seg);
  }
}

function updateStreamingPartInfo(text) {
  const el = document.getElementById('streamingPartInfo');
  if (!el) return;
  // "— Part X of N: filename —"
  const match = text.match(/Part (\d+) of (\d+)(?::\s*(.+?))?(?:\s*—\s*)?$/);
  if (match) {
    const partNum = parseInt(match[1], 10);
    const partTotal = parseInt(match[2], 10);
    const filename = (match[3] || '').replace(/\s*—\s*$/, '').trim();
    el.style.display = 'block';
    el.innerHTML =
      '— Part <b>' + partNum + '</b> of <b>' + partTotal + '</b> —' +
      (filename ? '<br><span class="file">' + escHtml(filename) + '</span>' : '');
    updateStreamingParts(partTotal, partNum);
    streamingPartCurrent = partNum;
    streamingPartsTotal  = partTotal;
  } else {
    el.style.display = 'block';
    el.textContent = text;
  }
}

// ---- Structured review rendering ----
const SEV_MAP = {
  'critical': 'crit',
  'warning':  'warn',
  'suggestion': 'info',
  'info':     'info',
  'ok':       'ok',
  'passed':   'ok',
};
const SEV_LABEL = {
  'crit': 'Critical',
  'warn': 'Warning',
  'info': 'Suggestion',
  'ok':   'Passed',
};
const RATING_SEV = {
  'Looks Good':          'ok',
  'Needs Minor Changes': 'warn',
  'Needs Major Revision':'crit',
};
const RATING_ICON = {
  ok:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  crit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
};

function renderStructuredReview(data) {
  // Group findings by category, assign section numbers
  const findings = (data.findings || []).filter(f => f.severity && f.description);
  const categories = [];
  const catMap = {};
  findings.forEach(f => {
    const cat = f.category || 'General';
    if (!catMap[cat]) {
      catMap[cat] = [];
      categories.push(cat);
    }
    catMap[cat].push(f);
  });

  let html = '<div class="review">';

  categories.forEach((cat, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    html += '<div><h4><span class="num">' + num + '</span>' + escHtml(cat) + '</h4>';
    html += '<div class="findings">';
    catMap[cat].forEach(f => {
      const sevKey = (f.severity || 'info').toLowerCase();
      const sev = SEV_MAP[sevKey] || 'info';
      const label = SEV_LABEL[sev] || f.severity;
      const desc = f.title
        ? '<strong>' + escHtml(f.title) + '</strong> ' + escHtml(f.description || '')
        : escHtml(f.description || '');
      html +=
        '<div class="finding ' + sev + '">' +
        '<span class="chip"><span class="d"></span>' + label + '</span>' +
        '<span class="tx">' + desc + '</span>' +
        '</div>';
    });
    html += '</div></div>';
  });

  // Rating
  const ratingRaw = data.rating;
  let ratingStr = '';
  if (typeof ratingRaw === 'string') {
    ratingStr = ratingRaw;
  } else if (typeof ratingRaw === 'number') {
    ratingStr = ratingRaw >= 90 ? 'Looks Good'
              : ratingRaw >= 70 ? 'Needs Minor Changes'
              : 'Needs Major Revision';
  } else if (ratingRaw && typeof ratingRaw === 'object') {
    ratingStr = String(Object.values(ratingRaw)[0] || '');
  }
  if (ratingStr) {
    const sevClass = RATING_SEV[ratingStr] || 'warn';
    const icon = RATING_ICON[sevClass] || RATING_ICON.warn;
    html +=
      '<div class="summary ' + sevClass + '">' +
      '<div class="ic-w">' + icon + '</div>' +
      '<div class="st">' +
      '<div class="l1">Summary Rating</div>' +
      '<div class="l2">' + escHtml(ratingStr) + '</div>' +
      '</div></div>';
  }

  html += '</div>';
  return html;
}

function finalizeStreamingBubble(html, meta) {
  const container = document.getElementById('streamingContainer');
  if (!container) return;
  container.id = '';
  container.innerHTML = '<div class="assistant-msg">' + html + '</div>';
  if (meta) {
    const foot = document.createElement('div');
    foot.className = 'msg-foot';
    const parts = meta.split(' · ');
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = parts[0] || meta;
    foot.appendChild(m);
    if (parts.length > 1) {
      foot.appendChild(document.createTextNode(' · ' + parts.slice(1).join(' · ')));
    }
    container.appendChild(foot);
  }
  streamingBubble = null;
  scrollToBottom();
}

// ---- Derived models list ----
function renderDerivedModels(models) {
  derivedModelsList.innerHTML = '';
  if (!models || models.length === 0) { derivedModelsList.style.display = 'none'; return; }
  derivedModelsList.style.display = 'block';
  models.forEach(name => {
    const item = document.createElement('div');
    item.className = 'derived-model-item';
    const label = document.createElement('span');
    label.textContent = name;
    const btn = document.createElement('button');
    btn.className = 'derived-model-delete';
    btn.title = 'Delete model';
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      vscode.postMessage({ command: 'deleteReviewerModelByName', modelName: name });
    });
    item.appendChild(label);
    item.appendChild(btn);
    derivedModelsList.appendChild(item);
  });
}

// ---- Session viewer ----
function truncateUserContent(content) {
  if (content.startsWith('Review the following git diff')) return '<em>📋 Git Changes Review</em>';
  if (content.startsWith('Review the following file') || content.startsWith('Review the following code'))
    return '<em>📋 File Review</em>';
  const MAX = 300;
  if (content.length <= MAX) return escHtml(content);
  const preview = content.slice(0, MAX);
  const remaining = content.slice(MAX).split('\n').length;
  return escHtml(preview) + '<span style="color:var(--text-faint);font-style:italic;"> … [' + remaining + ' more lines]</span>';
}

function renderSessionOverlay(session) {
  overlayTitle.textContent = session.title || 'Session transcript';
  overlayMessages.innerHTML = '';
  session.messages.forEach(m => {
    const isUser = m.role === 'user';
    if (isUser) {
      const el = document.createElement('div');
      el.className = 'user-msg fade';
      el.style.marginBottom = '10px';
      el.innerHTML = truncateUserContent(m.content);
      overlayMessages.appendChild(el);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'fade';
      wrap.style.marginBottom = '10px';
      const msg = document.createElement('div');
      msg.className = 'assistant-msg';
      msg.innerHTML = m.structured ? renderStructuredReview(m.structured) : (m.html || escHtml(m.content));
      wrap.appendChild(msg);
      const foot = document.createElement('div');
      foot.className = 'msg-foot';
      const mEl = document.createElement('span');
      mEl.className = 'm';
      mEl.textContent = m.model || session.model || 'AI';
      foot.appendChild(mEl);
      foot.appendChild(document.createTextNode(' · ' + formatTime(m.timestamp)));
      wrap.appendChild(foot);
      overlayMessages.appendChild(wrap);
    }
  });
  sessionOverlay.classList.add('visible');
  sessionOverlay.scrollIntoView({ block: 'nearest' });
}

// ---- History sessions ----
function ratingToSev(ratingStr) {
  if (!ratingStr) return '--text-faint';
  if (ratingStr === 'Looks Good') return '--sev-ok';
  if (ratingStr === 'Needs Major Revision') return '--sev-crit';
  return '--sev-warn';
}

function renderHistory(sessions) {
  historyPanel.querySelectorAll('.sess').forEach(el => el.remove());
  if (!sessions || sessions.length === 0) {
    historyEmpty.style.display = 'block';
    historyActions.style.display = 'none';
    historyCount.style.display = 'none';
    return;
  }
  historyEmpty.style.display = 'none';
  historyActions.style.display = 'flex';
  historyCount.textContent = String(sessions.length);
  historyCount.style.display = '';

  const chevSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="arrow"><path d="M9 6l6 6-6 6"/></svg>';

  sessions.forEach(session => {
    const date = new Date(session.startedAt).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const card = document.createElement('div');
    card.className = 'sess';
    const sevVar = ratingToSev(session.rating);
    card.innerHTML =
      '<span class="tag-diff">```diff</span>' +
      '<div class="meta">' +
        '<div class="l1">' + escHtml(date) + '</div>' +
        '<div class="l2">' + escHtml(session.provider || 'ollama') + ' · ' + (session.exchangeCount || 0) + ' exchanges</div>' +
      '</div>' +
      '<span class="rate" style="background:var(' + sevVar + ')"></span>' +
      chevSvg;
    card.addEventListener('click', () => {
      vscode.postMessage({ command: 'loadSession', sessionId: session.id });
    });
    historyPanel.appendChild(card);
  });
}

// ---- Session trigger (review started) ----
function onSessionTriggered(trigger) {
  sessionActive = true;
  closeSection(providerHeader, providerCollapsible);
  freeMemoryBtn.style.display = 'none';
  if (trigger === 'git') {
    sendBtn.classList.add('hidden-btn');
    reviewBtn.classList.remove('hidden-btn');
  } else {
    reviewBtn.classList.add('hidden-btn');
    sendBtn.classList.remove('hidden-btn');
  }
  newSessionBtn.classList.add('visible');
}

// ---- Exchange limit ----
function updateExchangeBar(count, limit, warn) {
  limitBar.style.display = 'flex';
  limitText.textContent = count + ' / ' + limit;
  const pct = Math.min(100, Math.round((count / limit) * 100));
  limitFill.style.width = pct + '%';
  limitFill.className = count >= limit ? 'danger' : count >= warn ? 'warn' : '';
  if (count >= limit) {
    limitWarning.textContent = 'Session limit reached. Start a new session to continue.';
    limitWarning.classList.add('visible');
    setInputsDisabled(true);
    followupSend.style.display = 'none';
    newSessionBtn.textContent = '↺ Start new session (limit reached)';
  } else if (count >= warn) {
    limitWarning.textContent =
      'Approaching session limit (' + count + '/' + limit + ' exchanges). Consider starting a new session soon.';
    limitWarning.classList.add('visible');
  } else {
    limitWarning.classList.remove('visible');
  }
}

// ---- Follow-up: stop mode ----
function enterStopMode() {
  followupWasVisible = followupArea.classList.contains('visible');
  followupShownThisGeneration = false;
  generationWasStopped = false;
  followupArea.classList.add('visible');
  followupInput.disabled = true;
  followupSend.disabled = false;
  followupSend.textContent = '⏹ Stop';
  followupSend.classList.add('stop');
  if (sessionActive) {
    reviewBtn.disabled = true;
    sendBtn.disabled = true;
  }
}

function exitStopMode() {
  followupSend.textContent = 'Send';
  followupSend.classList.remove('stop');
  followupSend.style.display = '';
  followupInput.disabled = false;
  if (!followupWasVisible && !followupShownThisGeneration && !generationWasStopped) {
    followupArea.classList.remove('visible');
  }
}

function sendFollowup() {
  if (followupSend.classList.contains('stop')) {
    vscode.postMessage({ command: 'stopGeneration' });
    return;
  }
  const content = followupInput.value.trim();
  if (!content) return;
  const model = availableSel.value || '';
  followupInput.value = '';
  setInputsDisabled(true);
  vscode.postMessage({ command: 'followUp', content, model });
}

function enableVisibleReviewBtn() {
  if (sessionActive) {
    if (!reviewBtn.classList.contains('hidden-btn')) reviewBtn.disabled = false;
    if (!sendBtn.classList.contains('hidden-btn'))   updateButtons();
  }
}

// ---- Settings: switch toggles ----
streamSwitch.addEventListener('click', () => {
  streamingEnabled = !streamingEnabled;
  streamSwitch.classList.toggle('on', streamingEnabled);
  vscode.postMessage({ command: 'toggleStreaming', mode: streamingEnabled ? 'chunked' : 'complete' });
});

enhancedSwitch.addEventListener('click', () => {
  enhancedEnabled = !enhancedEnabled;
  enhancedSwitch.classList.toggle('on', enhancedEnabled);
  vscode.postMessage({ command: 'toggleEnhancedReviewer', enabled: enhancedEnabled });
  reviewerSection.classList.toggle('visible', enhancedEnabled && currentProvider === 'ollama');
});

// ---- Settings gear ----
settingsBtn.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('on', isOpen);
});

// ---- Provider section collapsible ----
providerHeader.addEventListener('click', () => {
  toggleSection(providerHeader, providerCollapsible);
});

// ---- System prompt collapsible ----
sysPromptHeader.addEventListener('click', () => {
  toggleSection(sysPromptHeader, sysPromptCollapsible);
});
systemPromptEl.addEventListener('input', () => {
  const hasPrompt = systemPromptEl.value.trim().length > 0;
  sysPromptTag.style.display = hasPrompt ? '' : 'none';
  vscode.postMessage({ command: 'setSystemPrompt', prompt: systemPromptEl.value });
});

// ---- History collapsible ----
historyHeader.addEventListener('click', () => {
  toggleSection(historyHeader, historyCollapsible);
});

// ---- Provider change ----
providerSel.addEventListener('change', () => {
  vscode.postMessage({ command: 'setProvider', provider: providerSel.value });
});

// ---- Ollama URL + Pinned Models ----
saveOllamaUrlBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'saveOllamaUrl', url: ollamaUrlInput.value });
});
savePinnedModelsBtn.addEventListener('click', () => {
  const models = ollamaPinnedModels.value.split('\n').map(s => s.trim()).filter(Boolean);
  vscode.postMessage({ command: 'savePinnedModels', models });
});

// ---- API Key ----
if (keyProviderSel) keyProviderSel.addEventListener('change', updateApiKeyStatus);
if (saveKeyBtn) saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput ? apiKeyInput.value.trim() : '';
  if (keyProviderSel) vscode.postMessage({ command: 'setApiKey', provider: keyProviderSel.value, key });
});
if (clearKeyBtn) clearKeyBtn.addEventListener('click', () => {
  if (keyProviderSel) vscode.postMessage({ command: 'clearApiKey', provider: keyProviderSel.value });
});

// ---- Refresh / Free memory ----
refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spin');
  vscode.postMessage({ command: 'refreshModels' });
  setTimeout(() => refreshBtn.classList.remove('spin'), 1000);
});
freeMemoryBtn.addEventListener('click', () => {
  freeMemoryBtn.disabled = true;
  freeMemoryBtn.title = 'Unloading…';
  vscode.postMessage({ command: 'freeMemory', model: availableSel.value });
});

// ---- Review Git Changes ----
reviewBtn.addEventListener('click', () => {
  const model = availableSel.value || '';
  if (!model) { addErrorMessage('No model selected.'); return; }
  reviewBtn.disabled = true;
  sendBtn.disabled = true;
  const additionalPrompt = systemPromptEl.value.trim();
  if (additionalPrompt) addUserBubble(additionalPrompt, Date.now());
  vscode.postMessage({ command: 'reviewChanges', model });
});

// ---- Send for Review ----
sendBtn.addEventListener('click', () => {
  const model = availableSel.value || '';
  if (!model) { addErrorMessage('No model selected.'); return; }
  reviewBtn.disabled = true;
  sendBtn.disabled = true;
  const additionalPrompt = systemPromptEl.value.trim();
  if (additionalPrompt) addUserBubble(additionalPrompt, Date.now());
  vscode.postMessage({ command: 'sendToProvider', model, customInput: '' });
});

// ---- Follow-up ----
followupSend.addEventListener('click', sendFollowup);
followupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
});

// ---- New session ----
newSessionBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'newSession', model: availableSel.value });
});

// ---- Clear history ----
clearHistoryBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'clearHistory' });
});

// ---- Session overlay close ----
overlayCloseBtn.addEventListener('click', () => {
  sessionOverlay.classList.remove('visible');
});

// ---- Reviewer model ----
document.getElementById('createReviewerBtn').addEventListener('click', () => {
  const base = baseModelSel.value;
  if (!base) {
    document.getElementById('reviewerStatus').textContent = '⚠ Select a base model first.';
    return;
  }
  vscode.postMessage({ command: 'createReviewerModel', baseModel: base });
});

// ---- Messages from extension host ----
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {

    case 'init': {
      providerSel.innerHTML = '';
      keyProviderSel.innerHTML = '';
      msg.providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name; opt.textContent = p.displayName;
        if (p.name === msg.activeProvider) opt.selected = true;
        providerSel.appendChild(opt);
        keyProviderSel.appendChild(opt.cloneNode(true));
      });
      currentProvider     = msg.activeProvider;
      hasApiKey           = msg.hasApiKey;
      requiresApiKey      = msg.providers.find(p => p.name === msg.activeProvider)?.requiresApiKey ?? false;
      providerKeyStatus   = msg.providerKeyStatus ?? {};
      autoUnloadModel     = msg.autoUnloadModel ?? false;
      streamingEnabled    = msg.streamingMode === 'chunked';
      enhancedEnabled     = msg.enhancedReviewer;
      streamSwitch.classList.toggle('on', streamingEnabled);
      enhancedSwitch.classList.toggle('on', enhancedEnabled);
      if (enhancedEnabled && currentProvider === 'ollama') reviewerSection.classList.add('visible');
      if (msg.systemPrompt) {
        systemPromptEl.value = msg.systemPrompt;
        sysPromptTag.style.display = '';
      }
      if (msg.ollamaUrl) ollamaUrlInput.value = msg.ollamaUrl;
      ollamaPinnedModels.value = (msg.ollamaModels ?? []).join('\n');
      updateButtons();
      updateApiKeyStatus();
      break;
    }

    case 'models':
      populateSelect(availableSel, msg.available);
      populateSelect(baseModelSel, msg.available.filter(m => !m.startsWith('code-reviewer')));
      break;

    case 'derivedModelsList':
      renderDerivedModels(msg.models);
      break;

    case 'providerChanged':
      currentProvider = msg.provider;
      hasApiKey       = msg.hasApiKey;
      requiresApiKey  = msg.requiresApiKey;
      updateButtons();
      break;

    case 'apiKeySet':
      providerKeyStatus[msg.provider] = true;
      if (msg.isActiveProvider) { hasApiKey = true; updateButtons(); }
      if (apiKeyInput) apiKeyInput.value = '';
      updateApiKeyStatus();
      break;

    case 'apiKeyCleared':
      providerKeyStatus[msg.provider] = false;
      if (msg.isActiveProvider) { hasApiKey = false; updateButtons(); }
      updateApiKeyStatus();
      break;

    case 'sessionTriggered':
      onSessionTriggered(msg.trigger);
      break;

    case 'userMessage':
      addUserBubble(msg.text, msg.timestamp);
      break;

    case 'systemMessage': {
      const text = msg.text || '';
      // "Content split into N parts" — buffer total and apply if container exists
      if (text.includes('Content split into')) {
        const m = text.match(/Content split into (\d+) parts/);
        if (m) {
          pendingPartsTotal = parseInt(m[1], 10);
          if (streamingBubble) {
            const metaEl = document.getElementById('streamingMeta');
            if (metaEl) {
              metaEl.style.display = 'block';
              metaEl.innerHTML = 'Content split into <b>' + pendingPartsTotal + '</b> parts. Reviewing each part in sequence…';
            }
            updateStreamingParts(pendingPartsTotal, 0);
            streamingPartsTotal = pendingPartsTotal;
          }
        }
        break;
      }
      // "— Part X of N: filename —" or "Generating combined summary" — buffer and apply
      if (text.startsWith('— Part') || text.includes('Generating combined summary')) {
        pendingPartInfoText = text;
        if (streamingBubble) {
          updateStreamingPartInfo(text);
        }
        break;
      }
      addSystemNote(text);
      break;
    }

    case 'generationStarted':
      enterStopMode();
      break;

    case 'generationEnded':
      if (followupSend.classList.contains('stop')) exitStopMode();
      enableVisibleReviewBtn();
      break;

    case 'generationStopped':
      if (!followupSend.classList.contains('stop')) break;
      generationWasStopped = true;
      exitStopMode();
      // Replace streaming container with a stopped note
      const stoppedContainer = document.getElementById('streamingContainer');
      if (stoppedContainer) {
        stoppedContainer.id = '';
        stoppedContainer.innerHTML =
          '<div class="system-note" style="padding:8px 0">Generation stopped.</div>';
      }
      streamingBubble = null;
      setInputsDisabled(false);
      followupArea.classList.add('visible');
      followupInput.focus();
      enableVisibleReviewBtn();
      break;

    case 'aiThinking':
      streamingBubble = createStreamingContainer();
      appendToChat(streamingBubble);
      streamingPartsTotal  = 0;
      streamingPartCurrent = 0;
      // Apply any parts info that arrived before the container was created
      if (pendingPartsTotal > 0) {
        const metaEl = document.getElementById('streamingMeta');
        if (metaEl) {
          metaEl.style.display = 'block';
          metaEl.innerHTML = 'Content split into <b>' + pendingPartsTotal + '</b> parts. Reviewing each part in sequence…';
        }
        updateStreamingParts(pendingPartsTotal, 0);
        streamingPartsTotal = pendingPartsTotal;
        pendingPartsTotal = 0;
      }
      if (pendingPartInfoText) {
        updateStreamingPartInfo(pendingPartInfoText);
        pendingPartInfoText = '';
      }
      break;

    case 'streamStart':
      if (!streamingBubble) {
        streamingBubble = createStreamingContainer();
        appendToChat(streamingBubble);
      }
      break;

    case 'streamUpdate':
      if (streamingBubble && msg.html) {
        const contentEl = document.getElementById('streamingContent');
        if (contentEl) contentEl.innerHTML = '<div class="assistant-msg">' + msg.html + '</div>';
        scrollToBottom();
      }
      break;

    case 'streamEnd': {
      const content = msg.structured ? renderStructuredReview(msg.structured) : (msg.html || '');
      const meta = (msg.model || 'AI') + ' · ' + formatTime(msg.timestamp || Date.now());
      if (streamingBubble) {
        finalizeStreamingBubble(content, meta);
      }
      setInputsDisabled(false);
      break;
    }

    case 'chatMessage': {
      const content = msg.structured ? renderStructuredReview(msg.structured) : (msg.html || '');
      const meta = (msg.model || 'AI') + ' · ' + formatTime(msg.timestamp || Date.now());
      if (streamingBubble) {
        finalizeStreamingBubble(content, meta);
      } else {
        addAssistantMessage(content, meta);
      }
      setInputsDisabled(false);
      break;
    }

    case 'chatError': {
      const stContainer = document.getElementById('streamingContainer');
      if (stContainer) {
        stContainer.id = '';
        stContainer.innerHTML = '<div class="error-msg">⚠ ' + escHtml(msg.message) + '</div>';
      } else {
        addErrorMessage(msg.message);
      }
      streamingBubble = null;
      setInputsDisabled(false);
      if (!sessionActive) { reviewBtn.disabled = false; updateButtons(); }
      break;
    }

    case 'showFollowup':
      followupShownThisGeneration = true;
      followupArea.classList.add('visible');
      newSessionBtn.classList.add('visible');
      setInputsDisabled(false);
      followupInput.focus();
      break;

    case 'exchangeUpdate':
      updateExchangeBar(msg.count, msg.limit, msg.warn);
      break;

    case 'newSessionStarted':
      clearChatMessages();
      followupArea.classList.remove('visible');
      newSessionBtn.classList.remove('visible');
      newSessionBtn.textContent = '↺ Start new session';
      limitBar.style.display = 'none';
      limitWarning.classList.remove('visible');
      followupSend.style.display = '';
      sessionActive = false;
      streamingBubble = null;
      userScrolledUp = false;
      streamingPartsTotal = 0;
      streamingPartCurrent = 0;
      pendingPartsTotal = 0;
      pendingPartInfoText = '';
      exitStopMode();
      reviewBtn.classList.remove('hidden-btn');
      reviewBtn.disabled = false;
      sendBtn.classList.remove('hidden-btn');
      openSection(providerHeader, providerCollapsible);
      // reset system prompt
      closeSection(sysPromptHeader, sysPromptCollapsible);
      systemPromptEl.value = '';
      sysPromptTag.style.display = 'none';
      vscode.postMessage({ command: 'setSystemPrompt', prompt: '' });
      updateButtons();
      break;

    case 'historyLoaded':
      renderHistory(msg.sessions);
      break;

    case 'sessionView':
      renderSessionOverlay(msg.session);
      break;

    case 'reviewerModelStatus': {
      const statusEl = document.getElementById('reviewerStatus');
      const createBtn = document.getElementById('createReviewerBtn');
      if (msg.status === 'creating')  { statusEl.textContent = '⏳ Creating code-reviewer model...'; createBtn.disabled = true; }
      else if (msg.status === 'progress') { statusEl.textContent = '⏳ ' + msg.message; }
      else if (msg.status === 'created')  { statusEl.textContent = '✅ ' + (msg.model || 'code-reviewer') + ' ready.'; createBtn.disabled = false; }
      else if (msg.status === 'error')    { statusEl.textContent = '⚠ ' + msg.message; createBtn.disabled = false; }
      break;
    }

    case 'selectModel': {
      for (let i = 0; i < availableSel.options.length; i++) {
        if (availableSel.options[i].value === msg.model ||
            availableSel.options[i].value.startsWith(msg.model + ':')) {
          availableSel.selectedIndex = i; break;
        }
      }
      break;
    }

    case 'loading':
      if (!msg.loading) setInputsDisabled(false);
      break;

    case 'freeMemoryStatus':
      freeMemoryBtn.disabled = msg.loading;
      freeMemoryBtn.title = msg.loading ? 'Unloading…' : 'Unload model from Ollama memory';
      break;
  }
});

// Signal ready
vscode.postMessage({ command: 'ready' });
