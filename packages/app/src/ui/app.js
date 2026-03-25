/**
 * Resonance — Web UI Application
 * Vanilla JS, no framework, no build step.
 */

// ============================================================================
// API Helpers
// ============================================================================

const API = 'http://localhost:3000';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API + path, opts);
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}


// ============================================================================
// WebSocket for Live Events
// ============================================================================

let ws = null;

function connectEvents() {
  try {
    ws = new WebSocket('ws://localhost:3000/api/events');

    ws.onopen = () => {
      updateRelayDisplay();
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleEvent(event);
      } catch { /* ignore malformed events */ }
    };

    ws.onclose = () => {
      ws = null;
      setTimeout(connectEvents, 2000);
    };

    ws.onerror = () => {
      ws = null;
    };
  } catch {
    setTimeout(connectEvents, 2000);
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'match':
      toast(`New match found! Similarity: ${formatPercent(event.similarity)}`, 'match');
      addActivity('match', `Match with ${truncateDID(event.partnerDID)} (${formatPercent(event.similarity)})`);
      refreshMatches();
      refreshDashboardStats();
      break;

    case 'channel_ready':
      toast('Channel is ready for disclosure.', 'success');
      addActivity('channel', 'Channel opened');
      refreshChannels();
      refreshDashboardStats();
      break;

    case 'confirm_result':
      if (event.confirmed) {
        toast(`Match confirmed! True similarity: ${formatPercent(event.similarity)}`, 'success');
      } else {
        toast('Match could not be confirmed.', 'warning');
      }
      if (activeChannelId === event.channelId) {
        addSystemMessage(event.confirmed
          ? `Match confirmed. True similarity: ${formatPercent(event.similarity)}`
          : 'Match confirmation failed.');
      }
      break;

    case 'disclosure':
      toast('New disclosure received.', 'info');
      if (activeChannelId === event.channelId) {
        addMessageToView({
          text: event.text,
          level: event.level,
          sent: false,
          time: new Date().toISOString(),
        });
      }
      break;

    case 'accept':
      toast(event.message ? `Accepted: ${event.message}` : 'Partner accepted the connection!', 'success');
      addActivity('channel', 'Connection accepted');
      refreshChannels();
      break;

    case 'reject':
      toast(event.reason ? `Rejected: ${event.reason}` : 'Partner rejected the connection.', 'warning');
      refreshChannels();
      break;

    case 'close':
      toast('Channel closed.', 'info');
      if (activeChannelId === event.channelId) {
        closeChannelView();
      }
      refreshChannels();
      refreshDashboardStats();
      break;
  }
}


// ============================================================================
// Screen Management
// ============================================================================

const $loading   = document.getElementById('loading-screen');
const $login     = document.getElementById('login-screen');
const $app       = document.getElementById('app');

function showScreen(name) {
  $loading.style.display = name === 'loading' ? '' : 'none';
  $login.style.display   = name === 'login'   ? '' : 'none';
  $app.style.display     = name === 'app'     ? '' : 'none';
}

async function checkStatus() {
  const data = await api('GET', '/api/status');
  if (data.error) {
    // Server not ready yet — retry
    setTimeout(checkStatus, 1000);
    return;
  }

  if (data.unlocked) {
    onUnlocked(data);
    return;
  }

  // Show login screen
  const loginDesc = document.getElementById('login-description');
  const loginBtn  = document.getElementById('login-btn');

  if (data.initialized) {
    loginDesc.textContent = 'Enter your password to unlock.';
    loginBtn.textContent  = 'Unlock';
  } else {
    loginDesc.textContent = 'Create a password to generate your decentralized identity.';
    loginBtn.textContent  = 'Create Identity';
  }

  showScreen('login');
  document.getElementById('login-password').focus();

  // Store initialized state for the form handler
  window.__initialized = data.initialized;
}


// ============================================================================
// Login
// ============================================================================

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const password = document.getElementById('login-password').value.trim();
  const errorEl  = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  if (!password) {
    errorEl.textContent = 'Please enter a password.';
    return;
  }

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Please wait...';

  const endpoint = window.__initialized ? '/api/unlock' : '/api/init';
  const data = await api('POST', endpoint, { password });

  if (data.error) {
    errorEl.textContent = data.error;
    btn.disabled = false;
    btn.textContent = window.__initialized ? 'Unlock' : 'Create Identity';
    return;
  }

  // If we just initialized, we still need to unlock
  if (!window.__initialized) {
    const unlockData = await api('POST', '/api/unlock', { password });
    if (unlockData.error) {
      errorEl.textContent = unlockData.error;
      btn.disabled = false;
      btn.textContent = 'Create Identity';
      return;
    }
    onUnlocked(unlockData);
  } else {
    onUnlocked(data);
  }
});


async function onUnlocked(data) {
  // Set DID in topbar
  if (data.did) {
    document.getElementById('topbar-did').textContent = truncateDID(data.did);
    document.getElementById('topbar-did').title = data.did;
  }

  showScreen('app');
  connectEvents();

  // Load all data
  await Promise.all([
    refreshDashboardStats(),
    refreshItems(),
    refreshMatches(),
    refreshChannels(),
  ]);

  updateRelayDisplay();
}


// ============================================================================
// Lock
// ============================================================================

document.getElementById('btn-lock').addEventListener('click', async () => {
  await api('POST', '/api/lock');
  if (ws) { ws.close(); ws = null; }
  showScreen('loading');
  document.getElementById('login-password').value = '';
  checkStatus();
});


// ============================================================================
// Tab Navigation
// ============================================================================

const tabButtons = document.querySelectorAll('#tabs button');
const tabPanels  = document.querySelectorAll('.tab-panel');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
  });
});

function switchTab(tab) {
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));

  // Refresh data on tab switch
  switch (tab) {
    case 'dashboard': refreshDashboardStats(); break;
    case 'publish':   refreshItems(); break;
    case 'matches':   refreshMatches(); break;
    case 'channels':  refreshChannels(); break;
  }
}


// ============================================================================
// Dashboard
// ============================================================================

async function refreshDashboardStats() {
  const data = await api('GET', '/api/status');
  if (data.error) return;

  document.getElementById('stat-items').textContent = data.items ?? 0;
  document.getElementById('stat-matches').textContent = data.matches ?? 0;

  const channels = await api('GET', '/api/channels');
  if (!channels.error && Array.isArray(channels)) {
    document.getElementById('stat-channels').textContent = channels.length;
  }

  document.getElementById('stat-relay').textContent = data.relayConnected ? 'Online' : 'Offline';

  updateRelayDot(data.relayConnected);
}

function updateRelayDot(connected) {
  const dot   = document.getElementById('relay-dot');
  const label = document.getElementById('relay-label');
  dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  label.textContent = connected ? 'Connected' : 'Disconnected';
}

async function updateRelayDisplay() {
  const data = await api('GET', '/api/status');
  if (!data.error) updateRelayDot(data.relayConnected);
}


// Activity feed — stored in memory for the session
const activities = [];

function addActivity(type, text) {
  activities.unshift({ type, text, time: new Date() });
  if (activities.length > 50) activities.pop();
  renderActivityFeed();
}

function renderActivityFeed() {
  const feed = document.getElementById('activity-feed');
  if (activities.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
        </div>
        <div class="empty-title">No activity yet</div>
        <div class="empty-description">Publish your first need or offer to get started.</div>
      </div>`;
    return;
  }

  feed.innerHTML = activities.map(a => `
    <div class="activity-item">
      <div class="activity-dot type-${a.type}"></div>
      <div>
        <div class="activity-text">${escapeHtml(a.text)}</div>
        <div class="activity-time">${timeAgo(a.time)}</div>
      </div>
    </div>
  `).join('');
}


// ============================================================================
// Publish
// ============================================================================

const PRIVACY_LABELS = ['Low', 'Medium', 'High'];
const PRIVACY_VALUES = ['low', 'medium', 'high'];
let publishType = 'need';

// Privacy slider
const privacySlider = document.getElementById('privacy-slider');
const privacyLabel  = document.getElementById('privacy-label');

privacySlider.addEventListener('input', () => {
  privacyLabel.textContent = PRIVACY_LABELS[privacySlider.value];
});

// Type toggle
document.querySelectorAll('#publish-form .toggle-group .toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#publish-form .toggle-group .toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    publishType = btn.dataset.value;
  });
});

// Submit
document.getElementById('publish-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const text    = document.getElementById('publish-text').value.trim();
  const privacy = PRIVACY_VALUES[privacySlider.value];

  if (!text) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Publishing...';

  const data = await api('POST', '/api/items', { text, type: publishType, privacy });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Publish';

  if (data.error) {
    toast(data.error, 'error');
    return;
  }

  toast(`Item published! Status: ${data.status}`, 'success');
  addActivity('publish', `Published ${publishType}: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
  document.getElementById('publish-text').value = '';
  refreshItems();
  refreshDashboardStats();
});


// Items list
async function refreshItems() {
  const data = await api('GET', '/api/items');
  const container = document.getElementById('items-list');

  if (data.error || !Array.isArray(data) || data.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="empty-title">No items published</div>
        <div class="empty-description">Use the form above to publish your first need or offer.</div>
      </div>`;
    return;
  }

  container.innerHTML = data.map(item => `
    <div class="item-card" data-id="${item.id}">
      <div class="item-header">
        <span class="badge badge-${item.type}">${item.type}</span>
        <span class="badge badge-${item.status}">${item.status}</span>
      </div>
      <div class="item-text">${escapeHtml(item.rawText)}</div>
      <div class="item-meta">
        <span class="privacy-level">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v14M1 8h14" opacity="0.3"/><circle cx="8" cy="8" r="3"/></svg>
          Privacy: ${item.privacyLevel}
        </span>
        <span>${timeAgo(item.createdAt)}</span>
        ${item.status !== 'withdrawn' ? `<button class="btn btn-ghost btn-sm" onclick="withdrawItem('${item.id}')">Withdraw</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function withdrawItem(id) {
  const data = await api('DELETE', `/api/items/${id}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  toast('Item withdrawn.', 'info');
  refreshItems();
  refreshDashboardStats();
}

// Expose to onclick
window.withdrawItem = withdrawItem;


// ============================================================================
// Search
// ============================================================================

let searchType = 'need';

// Search type toggle
document.querySelectorAll('#search-type-toggle .toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#search-type-toggle .toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    searchType = btn.dataset.value;
  });
});

document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = document.getElementById('search-text').value.trim();
  if (!text) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Searching...';

  const data = await api('POST', '/api/search', { text, type: searchType });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Search';

  const container = document.getElementById('search-results');

  if (data.error) {
    container.innerHTML = `<div class="empty-state"><div class="empty-title">Search failed</div><div class="empty-description">${escapeHtml(data.error)}</div></div>`;
    return;
  }

  const results = data.results || [];

  if (results.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div class="empty-title">No results found</div>
        <div class="empty-description">Try a different search or check that the relay is connected.</div>
      </div>`;
    return;
  }

  container.innerHTML = results.map(r => {
    const pct = Math.round(r.similarity * 100);
    const color = similarityColor(r.similarity);
    return `
      <div class="search-result">
        <div class="search-result-info">
          <span class="search-result-did">${truncateDID(r.did)}</span>
          <span class="search-result-type badge badge-${r.itemType || 'offer'}">${r.itemType || 'unknown'}</span>
        </div>
        <div class="similarity-bar">
          <div class="similarity-track">
            <div class="similarity-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="similarity-value" style="color:${color}">${pct}%</span>
        </div>
      </div>`;
  }).join('');
});


// ============================================================================
// Matches
// ============================================================================

async function refreshMatches() {
  const data = await api('GET', '/api/matches');
  const container = document.getElementById('matches-list');

  if (data.error || !Array.isArray(data) || data.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </div>
        <div class="empty-title">No matches yet</div>
        <div class="empty-description">When someone matches with your published items, they will appear here.</div>
      </div>`;
    return;
  }

  container.innerHTML = data.map(m => {
    const pct = Math.round((m.similarity || 0) * 100);
    const color = similarityColor(m.similarity || 0);
    return `
      <div class="match-card">
        <div class="match-header">
          <span class="match-peer">${truncateDID(m.partnerDID)}</span>
          <div class="similarity-bar">
            <div class="similarity-track">
              <div class="similarity-fill" style="width:${pct}%;background:${color}"></div>
            </div>
            <span class="similarity-value" style="color:${color}">${pct}%</span>
          </div>
        </div>
        <div class="text-sm text-muted">Item: ${truncateDID(m.itemId)}</div>
        <div class="match-actions">
          <button class="btn btn-primary btn-sm" onclick="connectMatch('${m.id}')">Open Channel</button>
        </div>
      </div>`;
  }).join('');
}

async function connectMatch(matchId) {
  const data = await api('POST', '/api/channels', { matchId });
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  toast('Channel initiated! Waiting for partner...', 'info');
  addActivity('channel', 'Channel initiated');
  switchTab('channels');
  refreshChannels();
  refreshDashboardStats();
}

window.connectMatch = connectMatch;


// ============================================================================
// Channels
// ============================================================================

let activeChannelId = null;
let channelMessages = {}; // channelId -> [{ text, level, sent, time }]

async function refreshChannels() {
  const data = await api('GET', '/api/channels');
  const container = document.getElementById('channels-list');

  if (data.error || !Array.isArray(data) || data.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="empty-title">No channels open</div>
        <div class="empty-description">Channels open when you connect with a match for gradual disclosure.</div>
      </div>`;
    return;
  }

  container.innerHTML = data.map(ch => {
    const stateClass = ch.state === 'open' ? 'connected'
                     : ch.state === 'pending' ? 'pending'
                     : 'closed';
    return `
      <div class="channel-item" onclick="openChannel('${ch.id}')">
        <div class="channel-info">
          <span class="status-dot ${stateClass}"></span>
          <span class="channel-peer">${truncateDID(ch.partnerDID || ch.matchId || ch.id)}</span>
        </div>
        <span class="channel-state-badge">
          ${ch.state || 'unknown'}
        </span>
      </div>`;
  }).join('');
}

async function openChannel(channelId) {
  activeChannelId = channelId;
  const channelView = document.getElementById('channel-view');
  const channelList = document.getElementById('channels-list');

  // Fetch channel details
  const ch = await api('GET', `/api/channels/${channelId}`);

  if (ch.error) {
    toast(ch.error, 'error');
    return;
  }

  // Update header
  document.getElementById('channel-peer-did').textContent = truncateDID(ch.partnerDID || ch.matchId || channelId);
  const stateDot = document.getElementById('channel-state-dot');
  stateDot.className = `status-dot ${ch.state === 'open' ? 'connected' : ch.state === 'pending' ? 'pending' : 'closed'}`;

  // Render stored messages
  renderChannelMessages(channelId);

  // Show/hide action buttons based on state
  const isOpen = ch.state === 'open';
  document.getElementById('disclose-form').style.display    = isOpen ? 'flex' : 'none';
  document.getElementById('btn-accept').style.display       = isOpen ? '' : 'none';
  document.getElementById('btn-reject').style.display       = isOpen ? '' : 'none';
  document.getElementById('btn-close-channel').style.display = isOpen ? '' : 'none';

  channelList.style.display = 'none';
  channelView.style.display = '';
}

function closeChannelView() {
  activeChannelId = null;
  document.getElementById('channel-view').style.display  = 'none';
  document.getElementById('channels-list').style.display = '';
}

function renderChannelMessages(channelId) {
  const msgs = channelMessages[channelId] || [];
  const container = document.getElementById('channel-messages');

  if (msgs.length === 0) {
    container.innerHTML = `<div class="message-system">No messages yet. Start by sharing a disclosure.</div>`;
    return;
  }

  container.innerHTML = msgs.map(m => {
    if (m.system) {
      return `<div class="message-system">${escapeHtml(m.text)}</div>`;
    }
    return `
      <div class="message ${m.sent ? 'sent' : 'received'}">
        <div class="message-avatar">${m.sent ? 'You' : 'P'}</div>
        <div>
          <div class="message-bubble">
            <div class="message-level">${escapeHtml(m.level || '')}</div>
            ${escapeHtml(m.text)}
          </div>
          <div class="message-time">${timeAgo(m.time)}</div>
        </div>
      </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function addMessageToView(msg) {
  if (!activeChannelId) return;
  if (!channelMessages[activeChannelId]) channelMessages[activeChannelId] = [];
  channelMessages[activeChannelId].push(msg);
  renderChannelMessages(activeChannelId);
}

function addSystemMessage(text) {
  if (!activeChannelId) return;
  if (!channelMessages[activeChannelId]) channelMessages[activeChannelId] = [];
  channelMessages[activeChannelId].push({ system: true, text, time: new Date().toISOString() });
  renderChannelMessages(activeChannelId);
}

// Back button
document.getElementById('btn-back-channels').addEventListener('click', closeChannelView);

// Disclosure form
document.getElementById('disclose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeChannelId) return;

  const text  = document.getElementById('disclose-text').value.trim();
  const level = document.getElementById('disclose-level').value;

  if (!text) return;

  const data = await api('POST', `/api/channels/${activeChannelId}/disclose`, { text, level });

  if (data.error) {
    toast(data.error, 'error');
    return;
  }

  document.getElementById('disclose-text').value = '';
  addMessageToView({ text, level, sent: true, time: new Date().toISOString() });
});

// Accept
document.getElementById('btn-accept').addEventListener('click', async () => {
  if (!activeChannelId) return;
  const data = await api('POST', `/api/channels/${activeChannelId}/accept`, {});
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  toast('Connection accepted.', 'success');
  addSystemMessage('You accepted the connection.');
  refreshChannels();
});

// Reject
document.getElementById('btn-reject').addEventListener('click', async () => {
  if (!activeChannelId) return;
  const data = await api('POST', `/api/channels/${activeChannelId}/reject`, {});
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  toast('Connection rejected.', 'info');
  closeChannelView();
  refreshChannels();
});

// Close channel
document.getElementById('btn-close-channel').addEventListener('click', async () => {
  if (!activeChannelId) return;
  const data = await api('DELETE', `/api/channels/${activeChannelId}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  toast('Channel closed.', 'info');
  closeChannelView();
  refreshChannels();
  refreshDashboardStats();
});

window.openChannel = openChannel;


// ============================================================================
// Toast Notifications
// ============================================================================

function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;

  // Click to dismiss
  el.addEventListener('click', () => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 200);
  });

  container.appendChild(el);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (el.parentNode) {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 200);
    }
  }, 5000);
}


// ============================================================================
// Utility Functions
// ============================================================================

function truncateDID(did) {
  if (!did) return 'unknown';
  if (did.length <= 24) return did;
  return did.substring(0, 20) + '...';
}

function formatPercent(sim) {
  return Math.round((sim || 0) * 100) + '%';
}

function similarityColor(sim) {
  if (sim >= 0.8) return '#6cffa0'; // green
  if (sim >= 0.6) return '#6c8cff'; // blue
  if (sim >= 0.4) return '#ffc86c'; // gold
  return '#ff6c8c';                 // pink/red
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// ============================================================================
// Boot
// ============================================================================

checkStatus();
