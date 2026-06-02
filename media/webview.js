const vscode = acquireVsCodeApi();

// DOM refs
const providerSel     = document.getElementById('providerSelect');
const apiKeyBtn       = document.getElementById('apiKeyBtn');
const availableSel    = document.getElementById('availableModels');
const sendBtn         = document.getElementById('sendBtn');
const reviewBtn       = document.getElementById('reviewBtn');
const refreshBtn      = document.getElementById('refreshBtn');
const freeMemoryBtn   = document.getElementById('freeMemoryBtn');
const settingsBtn     = document.getElementById('settingsBtn');
const settingsPanel   = document.getElementById('settingsPanel');
const streamToggle    = document.getElementById('streamToggle');
const enhancedRow     = document.getElementById('enhancedRow');
const enhancedToggle  = document.getElementById('enhancedToggle');
const reviewerSection = document.getElementById('reviewerSection');
const derivedModelsList = document.getElementById('derivedModelsList');
const baseModelSel    = document.getElementById('baseModelSelect');
const sysPromptHeader = document.getElementById('sysPromptHeader');
const systemPromptEl  = document.getElementById('systemPrompt');
const providerHeader  = document.getElementById('providerHeader');
const providerBody    = document.getElementById('providerBody');
const chatMessages    = document.getElementById('chatMessages');
const chatEmpty       = document.getElementById('chatEmpty');
const limitBar        = document.getElementById('limitBar');
const limitText       = document.getElementById('limitText');
const limitFill       = document.getElementById('limitFill');
const limitWarning    = document.getElementById('limitWarning');
const followupArea    = document.getElementById('followupArea');
const followupInput   = document.getElementById('followupInput');
const followupSend    = document.getElementById('followupSend');
const newSessionBtn   = document.getElementById('newSessionBtn');
const historyHeader   = document.getElementById('historyHeader');
const historyPanel    = document.getElementById('historyPanel');
const historyEmpty    = document.getElementById('historyEmpty');
const historyActions  = document.getElementById('historyActions');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const sessionOverlay  = document.getElementById('sessionOverlay');
const overlayTitle    = document.getElementById('overlayTitle');
const overlayMessages = document.getElementById('overlayMessages');
const overlayCloseBtn = document.getElementById('overlayCloseBtn');
const sysPromptSection = document.getElementById('sysPromptSection');

let currentProvider = 'ollama';
let hasApiKey = false;
let requiresApiKey = false;
let sessionActive = false;
let autoUnloadModel = false;
let streamingBubble = null;
let followupWasVisible = false;
let followupShownThisGeneration = false;
let generationWasStopped = false;
let userScrolledUp = false;

// ---- Auto-scroll (skipped when user has scrolled up) ----
function scrollToBottom() {
  if (!userScrolledUp) chatMessages.scrollTop = chatMessages.scrollHeight;
}
chatMessages.addEventListener('scroll', () => {
  const distanceFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
  userScrolledUp = distanceFromBottom > 50;
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

function updateButtons() {
  const canSend = !requiresApiKey || hasApiKey;
  sendBtn.disabled = !canSend;
  apiKeyBtn.style.display = requiresApiKey ? 'block' : 'none';
  apiKeyBtn.textContent = hasApiKey ? '🔑 Update API Key' : '🔑 Set API Key';
  enhancedRow.style.display = currentProvider === 'ollama' ? 'flex' : 'none';
  freeMemoryBtn.style.display = (currentProvider === 'ollama' && !autoUnloadModel && !sessionActive) ? 'block' : 'none';
  derivedModelsList.style.display = currentProvider === 'ollama' ? 'block' : 'none';
  if (currentProvider !== 'ollama') reviewerSection.classList.remove('visible');
}

function setInputsDisabled(disabled) {
  followupInput.disabled = disabled;
  followupSend.disabled = disabled;
}

// ---- Chat bubble builders ----
function createBubble(role, bodyHtml, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + role;
  const metaEl = document.createElement('div');
  metaEl.className = 'bubble-meta';
  metaEl.textContent = meta;
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.innerHTML = bodyHtml;
  if (role === 'user') { wrap.appendChild(metaEl); wrap.appendChild(body); }
  else { wrap.appendChild(body); wrap.appendChild(metaEl); }
  return wrap;
}

function escHtml(str) {
  return String(str)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('\n').join('<br>');
}

function addUserBubble(text, timestamp) {
  if (chatEmpty) chatEmpty.style.display = 'none';
  const bubble = createBubble('user', escHtml(text), 'You · ' + formatTime(timestamp || Date.now()));
  chatMessages.appendChild(bubble);
  scrollToBottom();
}

function addAIBubble(html, meta, isStreaming) {
  if (chatEmpty) chatEmpty.style.display = 'none';
  const bodyHtml = isStreaming ? '<span class="spinner"></span> Thinking...' : html;
  const bubble = createBubble('ai', bodyHtml, meta || '');
  chatMessages.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function addSystemBubble(text) {
  if (chatEmpty) chatEmpty.style.display = 'none';
  const bubble = createBubble('system', escHtml(text), '');
  chatMessages.appendChild(bubble);
  scrollToBottom();
}

function addErrorBubble(message) {
  if (chatEmpty) chatEmpty.style.display = 'none';
  const bubble = createBubble('error', '⚠ ' + escHtml(message), '');
  chatMessages.appendChild(bubble);
  scrollToBottom();
}

function getBubbleBody(bubble) {
  return bubble.querySelector('.bubble-body');
}
function getBubbleMeta(bubble) {
  return bubble.querySelector('.bubble-meta');
}

// ---- Session trigger ----
function onSessionTriggered(trigger) {
  sessionActive = true;
  sysPromptSection.style.display = 'none';
  freeMemoryBtn.style.display = 'none';
  providerHeader.classList.remove('open');
  providerBody.style.display = 'none';
  if (trigger === 'git') { sendBtn.style.display = 'none'; }
  else { reviewBtn.style.display = 'none'; }
  newSessionBtn.classList.add('visible');
}

// ---- Exchange limit ----
function updateExchangeBar(count, limit, warn) {
  limitBar.classList.remove('hidden');
  limitText.textContent = count + ' / ' + limit;
  const pct = Math.min(100, Math.round((count / limit) * 100));
  limitFill.style.width = pct + '%';
  limitFill.className = 'limit-fill' + (count >= limit ? ' danger' : count >= warn ? ' warn' : '');
  if (count >= limit) {
    limitWarning.textContent = 'Session limit reached. Start a new session to continue.';
    limitWarning.classList.add('visible');
    setInputsDisabled(true);
    followupSend.style.display = 'none';
    newSessionBtn.textContent = 'Start new session (limit reached)';
  } else if (count >= warn) {
    limitWarning.textContent = 'Approaching session limit (' + count + '/' + limit + ' exchanges). Consider starting a new session soon.';
    limitWarning.classList.add('visible');
  } else {
    limitWarning.classList.remove('visible');
  }
}

// ---- Settings gear ----
settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('open'));

// ---- Streaming toggle ----
streamToggle.addEventListener('change', () => {
  vscode.postMessage({ command: 'toggleStreaming', mode: streamToggle.checked ? 'chunked' : 'complete' });
});

// ---- Enhanced reviewer toggle ----
enhancedToggle.addEventListener('change', () => {
  const on = enhancedToggle.checked;
  vscode.postMessage({ command: 'toggleEnhancedReviewer', enabled: on });
  reviewerSection.classList.toggle('visible', on);
});

// ---- System prompt ----
// Provider section starts expanded
providerHeader.classList.add('open');
providerBody.style.display = 'flex';
providerHeader.addEventListener('click', () => {
  const isOpen = providerHeader.classList.toggle('open');
  providerBody.style.display = isOpen ? 'flex' : 'none';
});

sysPromptHeader.addEventListener('click', () => {
  const isOpen = sysPromptHeader.classList.toggle('open');
  systemPromptEl.style.display = isOpen ? 'block' : 'none';
});
systemPromptEl.addEventListener('input', () => {
  vscode.postMessage({ command: 'setSystemPrompt', prompt: systemPromptEl.value });
});

// ---- Provider change ----
providerSel.addEventListener('change', () => {
  vscode.postMessage({ command: 'setProvider', provider: providerSel.value });
});

// ---- API Key ----
apiKeyBtn.addEventListener('click', () => vscode.postMessage({ command: 'setApiKey' }));

// ---- Refresh models ----
refreshBtn.addEventListener('click', () => vscode.postMessage({ command: 'refreshModels' }));
freeMemoryBtn.addEventListener('click', () => vscode.postMessage({ command: 'freeMemory' }));

// ---- Review Git Changes ----
reviewBtn.addEventListener('click', () => {
  const model = availableSel.value || '';
  if (!model) { addErrorBubble('No model selected.'); return; }
  reviewBtn.disabled = true;
  sendBtn.disabled = true;
  const additionalPrompt = systemPromptEl.value.trim();
  if (additionalPrompt) addUserBubble(additionalPrompt, Date.now());
  vscode.postMessage({ command: 'reviewChanges', model });
});

// ---- Send for Review (active file) ----
sendBtn.addEventListener('click', () => {
  const model = availableSel.value || '';
  if (!model) { addErrorBubble('No model selected.'); return; }
  reviewBtn.disabled = true;
  sendBtn.disabled = true;
  const additionalPrompt = systemPromptEl.value.trim();
  if (additionalPrompt) addUserBubble(additionalPrompt, Date.now());
  vscode.postMessage({ command: 'sendToProvider', model, customInput: '' });
});

// ---- Re-enable whichever review button is still visible (for re-review during active session) ----
function enableVisibleReviewBtn() {
  if (sessionActive) {
    if (reviewBtn.style.display !== 'none') reviewBtn.disabled = false;
    if (sendBtn.style.display !== 'none') updateButtons();
  }
}

// ---- Follow-up send / stop ----
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
followupSend.addEventListener('click', sendFollowup);
followupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
});

// ---- New session ----
newSessionBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'newSession' });
});

// ---- History panel toggle ----
historyHeader.addEventListener('click', () => {
  const isOpen = historyHeader.classList.toggle('open');
  historyPanel.classList.toggle('open', isOpen);
});

// ---- Clear history ----
clearHistoryBtn.addEventListener('click', () => {
  vscode.postMessage({ command: 'clearHistory' });
});

// ---- Reviewer model ----
document.getElementById('createReviewerBtn').addEventListener('click', () => {
  const base = baseModelSel.value;
  if (!base) { document.getElementById('reviewerStatus').textContent = '⚠ Select a base model first.'; return; }
  vscode.postMessage({ command: 'createReviewerModel', baseModel: base });
});
function renderStructuredReview(data) {
  const severityEmoji = { Critical: '🔴', Warning: '🟡', Suggestion: '🔵' };
  const ratingEmoji = { 'Looks Good': '✅', 'Needs Minor Changes': '⚠️', 'Needs Major Revision': '🛑' };
  const findings = (data.findings || [])
    .filter(f => f.severity && f.category && f.title && f.description)
    .map(f => {
    const sev = f.severity || 'Suggestion';
    return `<div class="finding finding-${sev.toLowerCase()}">` +
      `<div class="finding-header">` +
      `<span class="finding-badge">${severityEmoji[sev] || ''} ${sev}</span>` +
      `<span class="finding-category">${f.category || ''}</span>` +
      `</div>` +
      `<strong class="finding-title">${f.title || ''}</strong>` +
      `<p class="finding-desc">${f.description || ''}</p>` +
      `</div>`;
  }).join('');
  const ratingRaw = data.rating;
  let rating = '';
  if (typeof ratingRaw === 'string') {
    rating = ratingRaw;
  } else if (typeof ratingRaw === 'number') {
    // Model returned a numeric score — map to the nearest label
    rating = ratingRaw >= 90 ? 'Looks Good' : ratingRaw >= 70 ? 'Needs Minor Changes' : 'Needs Major Revision';
  } else if (ratingRaw && typeof ratingRaw === 'object') {
    rating = String(Object.values(ratingRaw)[0] || '');
  }
  const ratingLine = rating ? `<div class="review-rating">${ratingEmoji[rating] || ''} ${rating}</div>` : '';
  return findings + ratingLine;
}

function renderDerivedModels(models) {
  const list = document.getElementById('derivedModelsList');
  list.innerHTML = '';
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
    list.appendChild(item);
  });
}

// ---- Overlay close ----
overlayCloseBtn.addEventListener('click', () => {
  sessionOverlay.classList.remove('visible');
});


// ---- Render history sessions ----
function renderHistory(sessions) {
  historyPanel.querySelectorAll('.history-card').forEach(el => el.remove());
  if (!sessions || sessions.length === 0) {
    historyEmpty.style.display = 'block';
    historyActions.style.display = 'none';
    return;
  }
  historyEmpty.style.display = 'none';
  historyActions.style.display = 'flex';
  sessions.forEach(session => {
    const card = document.createElement('div');
    card.className = 'history-card';
    const date = new Date(session.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const titleEl = document.createElement('div');
    titleEl.className = 'hc-title';
    titleEl.textContent = session.title || 'Review session';
    const metaEl = document.createElement('div');
    metaEl.className = 'hc-meta';
    metaEl.textContent = date + ' · ' + session.provider + ' · ' + session.exchangeCount + ' exchanges';
    card.appendChild(titleEl);
    card.appendChild(metaEl);
    card.addEventListener('click', () => {
      vscode.postMessage({ command: 'loadSession', sessionId: session.id });
    });
    historyPanel.insertBefore(card, historyActions);
  });
}

// ---- Render session overlay ----
function truncateUserContent(content) {
  // Review trigger messages — show a clean label, never the raw diff/file content
  if (content.startsWith('Review the following git diff')) return '<em>📋 Git Changes Review</em>';
  if (content.startsWith('Review the following file') || content.startsWith('Review the following code')) return '<em>📋 File Review</em>';
  const MAX = 300;
  if (content.length <= MAX) return escHtml(content);
  const preview = content.slice(0, MAX);
  const remaining = content.slice(MAX).split('\n').length;
  return escHtml(preview) + `<span class="prompt-truncated"> … [${remaining} more lines]</span>`;
}

function renderSessionOverlay(session) {
  overlayTitle.textContent = session.title || 'Past Session';
  overlayMessages.innerHTML = '';
  session.messages.forEach(m => {
    const isUser = m.role === 'user';
    const wrap = document.createElement('div');
    wrap.className = 'bubble ' + (isUser ? 'user' : 'ai');
    wrap.style.marginBottom = '8px';
    const body = document.createElement('div');
    body.className = 'bubble-body';
    if (isUser) {
      body.innerHTML = truncateUserContent(m.content);
    } else {
      body.innerHTML = m.structured ? renderStructuredReview(m.structured) : (m.html || escHtml(m.content));
    }
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    meta.textContent = (isUser ? 'You' : (m.model || session.model || 'AI')) + ' · ' + formatTime(m.timestamp);
    if (isUser) { wrap.appendChild(meta); wrap.appendChild(body); }
    else { wrap.appendChild(body); wrap.appendChild(meta); }
    overlayMessages.appendChild(wrap);
  });
  sessionOverlay.classList.add('visible');
}

// ---- Messages from extension host ----
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {

    case 'init': {
      providerSel.innerHTML = '';
      msg.providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name; opt.textContent = p.displayName;
        if (p.name === msg.activeProvider) opt.selected = true;
        providerSel.appendChild(opt);
      });
      currentProvider = msg.activeProvider;
      hasApiKey = msg.hasApiKey;
      requiresApiKey = msg.providers.find(p => p.name === msg.activeProvider)?.requiresApiKey ?? false;
      autoUnloadModel = msg.autoUnloadModel ?? false;
      streamToggle.checked = msg.streamingMode === 'chunked';
      enhancedToggle.checked = msg.enhancedReviewer;
      if (msg.enhancedReviewer && currentProvider === 'ollama') reviewerSection.classList.add('visible');
      if (msg.systemPrompt) systemPromptEl.value = msg.systemPrompt;
      updateButtons();
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
      hasApiKey = msg.hasApiKey;
      requiresApiKey = msg.requiresApiKey;
      updateButtons();
      break;

    case 'apiKeySet':
      hasApiKey = msg.hasApiKey;
      updateButtons();
      break;

    case 'sessionTriggered':
      onSessionTriggered(msg.trigger);
      break;

    case 'userMessage':
      addUserBubble(msg.text, msg.timestamp);
      break;

    case 'systemMessage':
      addSystemBubble(msg.text);
      break;

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
      if (streamingBubble) {
        getBubbleBody(streamingBubble).innerHTML = '';
        getBubbleMeta(streamingBubble).textContent = 'Stopped';
        streamingBubble = null;
      }
      setInputsDisabled(false);
      followupArea.classList.add('visible');
      followupInput.focus();
      enableVisibleReviewBtn();
      break;

    case 'aiThinking':
      streamingBubble = addAIBubble('', '', true);
      break;

    case 'streamStart':
      if (!streamingBubble) streamingBubble = addAIBubble('', '', true);
      break;

    case 'streamUpdate':
      if (streamingBubble && msg.html) {
        getBubbleBody(streamingBubble).innerHTML = msg.html;
        scrollToBottom();
      }
      break;

    case 'streamEnd':
      if (streamingBubble) {
        const streamContent = msg.structured ? renderStructuredReview(msg.structured) : (msg.html || '');
        if (streamContent) getBubbleBody(streamingBubble).innerHTML = streamContent;
        getBubbleMeta(streamingBubble).textContent = (msg.model || 'AI') + ' · ' + formatTime(msg.timestamp || Date.now());
        streamingBubble = null;
      }
      setInputsDisabled(false);
      break;

    case 'chatMessage':
      if (streamingBubble) {
        const chatContent = msg.structured ? renderStructuredReview(msg.structured) : (msg.html || '');
        getBubbleBody(streamingBubble).innerHTML = chatContent;
        getBubbleMeta(streamingBubble).textContent = (msg.model || 'AI') + ' · ' + formatTime(msg.timestamp || Date.now());
        streamingBubble = null;
      } else {
        const html = msg.structured ? renderStructuredReview(msg.structured) : (msg.html || '');
        addAIBubble(html, (msg.model || 'AI') + ' · ' + formatTime(msg.timestamp || Date.now()), false);
      }
      setInputsDisabled(false);
      break;

    case 'chatError':
      if (streamingBubble) {
        streamingBubble.className = 'bubble error';
        getBubbleBody(streamingBubble).textContent = '⚠ ' + msg.message;
        getBubbleMeta(streamingBubble).textContent = '';
        streamingBubble = null;
      } else {
        addErrorBubble(msg.message);
      }
      setInputsDisabled(false);
      if (!sessionActive) {
        reviewBtn.disabled = false;
        updateButtons();
      }
      break;

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
      chatMessages.innerHTML = '';
      chatEmpty.style.display = 'block';
      chatMessages.appendChild(chatEmpty);
      followupArea.classList.remove('visible');
      newSessionBtn.classList.remove('visible');
      newSessionBtn.textContent = 'Start new session';
      limitBar.classList.add('hidden');
      limitWarning.classList.remove('visible');
      followupSend.style.display = '';
      sessionActive = false;
      streamingBubble = null;
      userScrolledUp = false;
      exitStopMode();
      reviewBtn.style.display = '';
      reviewBtn.disabled = false;
      sendBtn.style.display = '';
      sysPromptSection.style.display = '';
      sysPromptHeader.classList.remove('open');
      systemPromptEl.style.display = 'none';
      systemPromptEl.value = '';
      vscode.postMessage({ command: 'setSystemPrompt', prompt: '' });
      providerHeader.classList.add('open');
      providerBody.style.display = 'flex';
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
      if (msg.status === 'creating') { statusEl.textContent = '⏳ Creating code-reviewer model...'; createBtn.disabled = true; }
      else if (msg.status === 'progress') { statusEl.textContent = '⏳ ' + msg.message; }
      else if (msg.status === 'created') { statusEl.textContent = '✅ ' + (msg.model || 'code-reviewer') + ' ready.'; createBtn.disabled = false; }
      else if (msg.status === 'error') { statusEl.textContent = '⚠ ' + msg.message; createBtn.disabled = false; }
      break;
    }

    case 'selectModel': {
      for (let i = 0; i < availableSel.options.length; i++) {
        if (availableSel.options[i].value === msg.model || availableSel.options[i].value.startsWith(msg.model + ':')) {
          availableSel.selectedIndex = i; break;
        }
      }
      break;
    }

    case 'loading':
      if (!msg.loading) setInputsDisabled(false);
      break;
  }
});

// Signal ready
vscode.postMessage({ command: 'ready' });
