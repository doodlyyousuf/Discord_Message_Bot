/* ============================================================
   Discord Scheduler - frontend logic
   ============================================================ */

const state = {
  config: { connected: false, hasToken: false, user: null, guildId: null, channelId: null },
  stats: {},
  tasks: [],
  guilds: [],
  channelsByGuild: {},
  messages: { items: [], total: 0, limit: 50, offset: 0 },
  search: '',
  editingMessageId: null,
  editingTaskId: null,
  activeView: 'dashboard',
  pollTimer: null,
  authMode: 'login',
};

/* ------------------------------------------------------------ helpers */

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (res.status === 401 && data.unauthorized) {
    handleUnauthorized();
    throw new Error('Please sign in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function toast(message, isError = false) {
  const el = $('#snackbar');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function confirmAction(title, text) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const okBtn = $('#confirmOkBtn');
    const handler = () => {
      dlg.removeEventListener('close', handler);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', handler);
    dlg.showModal();
  });
}

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function windowLabel(task) {
  return `${task.startTime} - ${task.endTime}`;
}

/* ------------------------------------------------------------ navigation */

function switchView(view) {
  state.activeView = view;
  $$('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'messages') loadMessages();
  if (view === 'tasks') renderTasks();
  if (view === 'dashboard') refreshState();
  if (view === 'connection') renderConnection();
}

/* ------------------------------------------------------------ theme */

let accentId = localStorage.getItem('accent') || 'blue';
let motionSpeed = Number(localStorage.getItem('motionSpeed')) || 7;

function currentMode() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function initTheme() {
  const savedMode = localStorage.getItem('theme') || 'light';
  document.documentElement.dataset.theme = savedMode;
  applyTheme(savedMode);

  $('#themeToggle').addEventListener('click', () => {
    const next = currentMode() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  });

  initAccentPicker();
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('#themeIcon').textContent = mode === 'dark' ? 'light_mode' : 'dark_mode';
  if (window.Theme) {
    const theme = window.Theme.applyAccent(accentId, mode);
    $('#accentIcon').textContent = theme.icon;
  }
}

function initAccentPicker() {
  const menu = $('#themeMenu');

  const render = () => {
    menu.innerHTML =
      window.Theme.THEMES.map(
        (t) => `
      <button class="theme-item ${t.id === accentId ? 'selected' : ''}" data-accent="${t.id}">
        <span class="material-symbols-rounded">${t.icon}</span>
        <span>${t.name}</span>
        <span class="material-symbols-rounded theme-check">check</span>
      </button>`
      ).join('') +
      `
      <div class="menu-divider"></div>
      <div class="speed-row">
        <span class="material-symbols-rounded">speed</span>
        <div class="speed-control">
          <label>Animation speed</label>
          <input type="range" id="speedRange" min="1" max="10" step="1" value="${motionSpeed}" />
        </div>
      </div>`;

    menu.querySelectorAll('.theme-item').forEach((btn) =>
      btn.addEventListener('click', () => {
        accentId = btn.dataset.accent;
        localStorage.setItem('accent', accentId);
        applyTheme(currentMode());
        render();
        menu.hidden = true;
      })
    );

    const speed = menu.querySelector('#speedRange');
    if (speed) {
      speed.addEventListener('input', (e) => {
        motionSpeed = Number(e.target.value);
        localStorage.setItem('motionSpeed', motionSpeed);
        applyMotionSpeed(motionSpeed);
      });
    }
  };

  $('#accentBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!menu.hidden) menu.hidden = true;
  });

  render();
}

/* ------------------------------------------------------------ motion */

function applyMotion(enabled) {
  document.documentElement.dataset.motion = enabled ? 'on' : 'off';
  $('#motionIcon').textContent = enabled ? 'animation' : 'motion_photos_off';
}

function applyMotionSpeed(speed) {
  const factor = Math.max(0.2, Number(speed) / 5);
  const base = { b1: 26, b2: 32, b3: 24 };
  const root = document.documentElement;
  root.style.setProperty('--blob-dur-1', `${(base.b1 / factor).toFixed(1)}s`);
  root.style.setProperty('--blob-dur-2', `${(base.b2 / factor).toFixed(1)}s`);
  root.style.setProperty('--blob-dur-3', `${(base.b3 / factor).toFixed(1)}s`);
}

function initMotion() {
  const saved = localStorage.getItem('motion');
  const prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  applyMotion(saved ? saved === 'on' : !prefersReduced);
  applyMotionSpeed(motionSpeed);

  $('#motionToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.motion !== 'on';
    applyMotion(next);
    localStorage.setItem('motion', next ? 'on' : 'off');
  });
}

async function refreshState() {
  try {
    const data = await request('GET', '/state');
    state.config = data.config;
    state.stats = data.stats;
    state.tasks = data.tasks;
    renderConnectionStatus();
    if (state.activeView === 'dashboard') renderDashboard();
    if (state.activeView === 'tasks') renderTasks();
  } catch (err) {
    /* silent during polling */
  }
}

function renderConnectionStatus() {
  const chip = $('#connectionChip');
  const label = $('#connectionLabel');
  const online = state.config.connected && state.config.hasToken;
  chip.classList.toggle('online', online);
  label.textContent = online ? (state.config.user?.username || 'Connected') : 'Disconnected';
}

function renderDashboard() {
  const s = state.stats || {};
  animateNumber($('#statMessages'), s.totalMessages || 0);
  animateNumber($('#statActive'), s.activeTasks || 0);
  animateNumber($('#statSentToday'), s.sentToday || 0);
  animateNumber($('#statTotalSent'), s.totalSent || 0);
  renderLogs(s.recentActivity || []);
}

function animateNumber(el, value) {
  el.textContent = value;
}

function renderLogs(logs) {
  const list = $('#dashboardLogs');
  if (!logs.length) {
    list.innerHTML = '<li class="empty-state">No activity yet.</li>';
    return;
  }
  const iconFor = { success: 'check_circle', error: 'error', warn: 'warning', info: 'info', debug: 'schedule' };
  list.innerHTML = logs
    .map(
      (l) => `
      <li class="log-item ${escapeHtml(l.level)}">
        <span class="log-icon material-symbols-rounded">${iconFor[l.level] || 'info'}</span>
        <div class="log-body">
          <div class="log-message">${escapeHtml(l.message)}</div>
          <div class="log-time">${formatTime(l.at)}</div>
        </div>
      </li>`
    )
    .join('');
}

/* ------------------------------------------------------------ connection */

function renderConnection() {
  const detail = $('#connectionDetail');
  if (state.config.connected && state.config.hasToken) {
    detail.innerHTML = `Connected as <strong>${escapeHtml(state.config.user?.username || 'bot')}</strong>.`;
    $('#disconnectBtn').disabled = false;
  } else {
    detail.textContent = 'Not connected.';
    $('#disconnectBtn').disabled = true;
  }
  $('#guildSelect').disabled = !state.config.connected;
  if (state.config.guildId && $('#guildSelect').value !== state.config.guildId) {
    $('#guildSelect').value = state.config.guildId;
  }
}

async function loadGuilds() {
  if (!state.config.connected) return;
  try {
    const { guilds } = await request('GET', '/guilds');
    state.guilds = guilds;
    const options = ['<option value="">Select a server</option>']
      .concat(guilds.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`))
      .join('');
    $('#guildSelect').innerHTML = options;
    if (state.config.guildId) {
      $('#guildSelect').value = state.config.guildId;
      await loadChannels(state.config.guildId, $('#channelSelect'));
      if (state.config.channelId) $('#channelSelect').value = state.config.channelId;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadChannels(guildId, selectEl) {
  if (!guildId) {
    selectEl.innerHTML = '<option value="">Select a channel</option>';
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = true;
  selectEl.innerHTML = '<option value="">Loading...</option>';
  try {
    const { channels } = await request('GET', `/guilds/${guildId}/channels`);
    state.channelsByGuild[guildId] = channels;
    selectEl.innerHTML =
      '<option value="">Select a channel</option>' +
      channels.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
    selectEl.disabled = false;
  } catch (err) {
    selectEl.innerHTML = '<option value="">Failed to load</option>';
    toast(err.message, true);
  }
}

async function connectBot() {
  const token = $('#tokenInput').value.trim();
  if (!token) return toast('Enter a bot token', true);
  const btn = $('#connectBtn');
  btn.disabled = true;
  try {
    const data = await request('POST', '/connect', { token });
    state.config = data.config;
    toast(`Connected as ${data.user.username}`);
    $('#tokenInput').value = '';
    renderConnectionStatus();
    renderConnection();
    await loadGuilds();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function disconnectBot() {
  const ok = await confirmAction('Disconnect bot?', 'Running tasks will be stopped.');
  if (!ok) return;
  try {
    await request('POST', '/disconnect');
    state.config = { connected: false, hasToken: false, user: null, guildId: null, channelId: null };
    $('#guildSelect').innerHTML = '<option value="">Select a server</option>';
    $('#channelSelect').innerHTML = '<option value="">Select a channel</option>';
    toast('Disconnected');
    renderConnectionStatus();
    renderConnection();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------ messages */

async function loadMessages() {
  try {
    const q = state.search ? `&search=${encodeURIComponent(state.search)}` : '';
    const data = await request('GET', `/messages?limit=${state.messages.limit}&offset=${state.messages.offset}${q}`);
    state.messages = data;
    renderMessages();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderMessages() {
  const { items, total, limit, offset } = state.messages;
  const list = $('#messageList');
  const countLabel = $('#messageCountLabel');
  countLabel.textContent = `${total.toLocaleString()} message${total === 1 ? '' : 's'}`;

  if (!items.length) {
    list.innerHTML = `<li class="empty-state card">${
      state.search ? 'No messages match your search.' : 'No messages yet. Add one or import a file.'
    }</li>`;
  } else {
    list.innerHTML = items
      .map(
        (m, i) => `
        <li class="message-item" data-id="${m.id}">
          <span class="message-index">${offset + i + 1}</span>
          <div class="message-text">
            <div>${escapeHtml(m.content)}</div>
            <div class="message-meta">Used ${m.uses || 0} time${(m.uses || 0) === 1 ? '' : 's'}</div>
          </div>
          <div class="message-actions">
            <button class="icon-button edit-message" title="Edit" data-id="${m.id}">
              <span class="material-symbols-rounded">edit</span>
            </button>
            <button class="icon-button delete-message" title="Delete" data-id="${m.id}">
              <span class="material-symbols-rounded">delete</span>
            </button>
          </div>
        </li>`
      )
      .join('');
  }

  const page = Math.floor(offset / limit) + 1;
  const maxPage = Math.max(1, Math.ceil(total / limit));
  $('#pageLabel').textContent = `Page ${page} of ${maxPage}`;
  $('#prevPage').disabled = offset <= 0;
  $('#nextPage').disabled = offset + limit >= total;

  $$('.edit-message').forEach((b) =>
    b.addEventListener('click', () => openMessageDialog(Number(b.dataset.id)))
  );
  $$('.delete-message').forEach((b) =>
    b.addEventListener('click', () => deleteMessage(Number(b.dataset.id)))
  );
}

function openMessageDialog(id = null) {
  state.editingMessageId = id;
  const dlg = $('#messageDialog');
  const msg = id ? state.messages.items.find((m) => m.id === id) : null;
  $('#messageDialogTitle').textContent = id ? 'Edit message' : 'Add message';
  $('#messageContent').value = msg ? msg.content : '';
  dlg.showModal();
}

async function saveMessage() {
  const content = $('#messageContent').value.trim();
  if (!content) {
    toast('Message cannot be empty', true);
    return;
  }
  try {
    if (state.editingMessageId) {
      await request('PUT', `/messages/${state.editingMessageId}`, { content });
      toast('Message updated');
    } else {
      await request('POST', '/messages', { content });
      toast('Message added');
    }
    $('#messageDialog').close();
    await loadMessages();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteMessage(id) {
  const ok = await confirmAction('Delete message?', 'This cannot be undone.');
  if (!ok) return;
  try {
    await request('DELETE', `/messages/${id}`);
    if (state.messages.items.length === 1 && state.messages.offset > 0) {
      state.messages.offset = Math.max(0, state.messages.offset - state.messages.limit);
    }
    toast('Message deleted');
    await loadMessages();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearMessages() {
  const ok = await confirmAction('Clear all messages?', 'Every message in the pool will be removed.');
  if (!ok) return;
  try {
    const { removed } = await request('DELETE', '/messages');
    toast(`Cleared ${removed} messages`);
    state.messages.offset = 0;
    await loadMessages();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------ import */

async function confirmImport() {
  const fileInput = $('#importFile');
  const paste = $('#importPaste').value;
  let text = paste;
  let filename = 'pasted text';

  if (fileInput.files && fileInput.files[0]) {
    filename = fileInput.files[0].name;
    text = await fileInput.files[0].text();
  }

  if (!text || !text.trim()) {
    toast('Choose a file or paste messages', true);
    return;
  }

  try {
    const { added } = await request('POST', '/messages/import', {
      text,
      filename,
      hasHeader: $('#hasHeader').checked,
    });
    $('#importDialog').close();
    fileInput.value = '';
    $('#importPaste').value = '';
    toast(`Imported ${added.toLocaleString()} messages`);
    state.messages.offset = 0;
    await loadMessages();
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------ tasks */

function renderTasks() {
  const grid = $('#taskList');
  if (!state.tasks.length) {
    grid.innerHTML = '<div class="card empty-state">No tasks yet. Create your first schedule.</div>';
    return;
  }

  const statusIcon = { running: 'play_circle', paused: 'pause_circle', stopped: 'stop_circle', idle: 'schedule' };

  grid.innerHTML = state.tasks
    .map((t) => {
      const statusClass = t.status || 'idle';
      return `
      <div class="task-card" data-id="${t.id}">
        <div class="task-card-head">
          <div>
            <div class="task-title">${escapeHtml(t.name)}</div>
            <div class="task-channel">
              <span class="material-symbols-rounded">tag</span>
              ${escapeHtml(t.channelName ? '#' + t.channelName : 'No channel')}
            </div>
          </div>
          <span class="status-chip ${statusClass}">
            <span class="material-symbols-rounded">${statusIcon[statusClass] || 'schedule'}</span>
            ${statusClass}
          </span>
        </div>
        <div class="task-details">
          <div class="task-detail">
            <div class="task-detail-label">${t.runMode === 'continuous' ? 'Mode' : 'Window'}</div>
            <div class="task-detail-value">${t.runMode === 'continuous' ? 'Continuous' : windowLabel(t)}</div>
          </div>
          <div class="task-detail">
            <div class="task-detail-label">Delay</div>
            <div class="task-detail-value">${t.minDelay}-${t.maxDelay}s</div>
          </div>
          <div class="task-detail">
            <div class="task-detail-label">Sent</div>
            <div class="task-detail-value">${t.sentCount || 0}</div>
          </div>
          <div class="task-detail">
            <div class="task-detail-label">Last sent</div>
            <div class="task-detail-value">${formatDateTime(t.lastSentAt)}</div>
          </div>
        </div>
        <div class="task-actions">
          ${
            statusClass === 'running'
              ? `<button class="tonal-button" data-action="pause" data-id="${t.id}"><span class="material-symbols-rounded">pause</span> Pause</button>`
              : ''
          }
          ${
            statusClass === 'paused'
              ? `<button class="filled-button" data-action="resume" data-id="${t.id}"><span class="material-symbols-rounded">play_arrow</span> Resume</button>`
              : ''
          }
          ${
            statusClass === 'idle' || statusClass === 'stopped'
              ? `<button class="filled-button" data-action="start" data-id="${t.id}"><span class="material-symbols-rounded">play_arrow</span> Start</button>`
              : ''
          }
          ${
            statusClass === 'running' || statusClass === 'paused'
              ? `<button class="outlined-button" data-action="stop" data-id="${t.id}"><span class="material-symbols-rounded">stop</span> Stop</button>`
              : ''
          }
          <button class="text-button" data-action="edit" data-id="${t.id}"><span class="material-symbols-rounded">edit</span></button>
          <button class="text-button danger-text" data-action="delete" data-id="${t.id}"><span class="material-symbols-rounded">delete</span></button>
        </div>
      </div>`;
    })
    .join('');

  grid.querySelectorAll('[data-action]').forEach((btn) =>
    btn.addEventListener('click', () => handleTaskAction(btn.dataset.action, Number(btn.dataset.id)))
  );
}

async function handleTaskAction(action, id) {
  try {
    if (action === 'edit') return openTaskDialog(id);
    if (action === 'delete') {
      const task = state.tasks.find((t) => t.id === id);
      const ok = await confirmAction('Delete task?', `"${task?.name || 'Task'}" will be removed.`);
      if (!ok) return;
      await request('DELETE', `/tasks/${id}`);
      toast('Task deleted');
    } else {
      await request('POST', `/tasks/${id}/${action}`);
      toast(`Task ${action === 'start' ? 'started' : action === 'resume' ? 'resumed' : action}`);
    }
    await refreshState();
    renderTasks();
  } catch (err) {
    toast(err.message, true);
  }
}

async function openTaskDialog(id = null) {
  state.editingTaskId = id;
  const dlg = $('#taskDialog');
  const task = id ? state.tasks.find((t) => t.id === id) : null;
  $('#taskDialogTitle').textContent = id ? 'Edit task' : 'New task';
  $('#taskName').value = task ? task.name : `Task ${state.tasks.length + 1}`;
  $('#taskStart').value = task ? task.startTime : '09:00';
  $('#taskEnd').value = task ? task.endTime : '21:00';
  $('#taskMinDelay').value = task ? task.minDelay : 30;
  $('#taskMaxDelay').value = task ? task.maxDelay : 120;
  $('#taskMaxPerRun').value = task ? task.maxPerRun : 0;
  $('#taskRunMode').value = task ? task.runMode || 'scheduled' : 'scheduled';

  // Populate server select
  const guildSelect = $('#taskGuild');
  guildSelect.innerHTML =
    '<option value="">Select a server</option>' +
    state.guilds.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');

  const guildId = task ? task.guildId : state.config.guildId;
  if (guildId) {
    guildSelect.value = guildId;
    await loadChannels(guildId, $('#taskChannel'));
    const channelId = task ? task.channelId : state.config.channelId;
    if (channelId) $('#taskChannel').value = channelId;
  } else {
    $('#taskChannel').innerHTML = '<option value="">Select a channel</option>';
    $('#taskChannel').disabled = true;
  }

  dlg.showModal();
}

async function saveTask() {
  const guildId = $('#taskGuild').value;
  const channelId = $('#taskChannel').value;
  const channelName = $('#taskChannel').selectedOptions[0]?.textContent?.replace(/^#/, '') || null;

  if (!guildId) return toast('Select a server', true);
  if (!channelId) return toast('Select a channel', true);

  const payload = {
    name: $('#taskName').value.trim() || 'Untitled task',
    guildId,
    channelId,
    channelName,
    startTime: $('#taskStart').value || '09:00',
    endTime: $('#taskEnd').value || '21:00',
    minDelay: Number($('#taskMinDelay').value) || 30,
    maxDelay: Number($('#taskMaxDelay').value) || 120,
    maxPerRun: Number($('#taskMaxPerRun').value) || 0,
    runMode: $('#taskRunMode').value || 'scheduled',
  };

  if (payload.maxDelay < payload.minDelay) {
    return toast('Max delay must be greater than min delay', true);
  }

  try {
    if (state.editingTaskId) {
      await request('PUT', `/tasks/${state.editingTaskId}`, payload);
      toast('Task updated');
    } else {
      await request('POST', '/tasks', payload);
      toast('Task created');
    }
    $('#taskDialog').close();
    await refreshState();
    renderTasks();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------ events */

function bindEvents() {
  $$('.nav-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#gotoTasksBtn').addEventListener('click', () => switchView('tasks'));
  $('#newTaskBtn').addEventListener('click', () => openTaskDialog());

  $('#addMessageBtn').addEventListener('click', () => openMessageDialog());
  $('#saveMessageBtn').addEventListener('click', (e) => {
    e.preventDefault();
    saveMessage();
  });

  let searchTimer;
  $('#messageSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.messages.offset = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMessages, 250);
  });

  $('#prevPage').addEventListener('click', () => {
    state.messages.offset = Math.max(0, state.messages.offset - state.messages.limit);
    loadMessages();
  });
  $('#nextPage').addEventListener('click', () => {
    state.messages.offset += state.messages.limit;
    loadMessages();
  });

  $('#clearMessagesBtn').addEventListener('click', clearMessages);
  $('#importBtn').addEventListener('click', () => $('#importDialog').showModal());
  $('#confirmImportBtn').addEventListener('click', (e) => {
    e.preventDefault();
    confirmImport();
  });

  $('#saveTaskBtn').addEventListener('click', (e) => {
    e.preventDefault();
    saveTask();
  });
  $('#taskGuild').addEventListener('change', (e) => loadChannels(e.target.value, $('#taskChannel')));

  $('#connectBtn').addEventListener('click', connectBot);
  $('#disconnectBtn').addEventListener('click', disconnectBot);
  $('#refreshGuilds').addEventListener('click', loadGuilds);

  $('#guildSelect').addEventListener('change', async (e) => {
    await loadChannels(e.target.value, $('#channelSelect'));
  });

  $('#channelSelect').addEventListener('change', async (e) => {
    try {
      const { config } = await request('POST', '/config', {
        guildId: $('#guildSelect').value,
        channelId: e.target.value,
      });
      state.config = config;
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#clearLogsBtn').addEventListener('click', async () => {
    const ok = await confirmAction('Clear activity log?', 'All log entries will be removed.');
    if (!ok) return;
    await request('DELETE', '/logs');
    await refreshState();
  });
}

/* ------------------------------------------------------------ auth */

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    return await res.json();
  } catch {
    return { authenticated: false, needsSetup: true };
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#loginTitle').textContent = register ? 'Create your account' : 'Welcome back';
  $('#loginSubtitle').textContent = register
    ? 'Pick a username and password to get started.'
    : 'Sign in to manage your schedules.';
  $('#loginSubmitLabel').textContent = register ? 'Create account' : 'Sign in';
  $('#loginToggle').textContent = register
    ? 'Already have an account? Sign in'
    : 'New here? Create an account';
  $('#loginPassword').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  $('#loginError').textContent = '';
}

function showLogin(needsSetup) {
  setAuthMode(needsSetup ? 'register' : 'login');
  document.body.classList.remove('authed');
}

async function submitLogin(event) {
  event.preventDefault();
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  const errorEl = $('#loginError');
  if (!username || !password) {
    errorEl.textContent = 'Enter a username and password';
    return;
  }
  const path = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sign in failed');
    $('#loginPassword').value = '';
    errorEl.textContent = '';
    await enterApp(data.user);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function logout() {
  const ok = await confirmAction('Sign out?', 'You will need to sign in again.');
  if (!ok) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  $('#loginUsername').value = '';
  $('#loginPassword').value = '';
  const info = await checkAuth();
  showLogin(Boolean(info.needsSetup));
}

function handleUnauthorized() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  showLogin(false);
}

async function enterApp(user) {
  document.body.classList.add('authed');
  $('#userName').textContent = user?.username || 'account';
  await refreshState();
  if (state.config.connected) await loadGuilds();
  renderConnection();
  if (!state.pollTimer) state.pollTimer = setInterval(refreshState, 4000);
}

/* ------------------------------------------------------------ init */

async function init() {
  initTheme();
  initMotion();
  bindEvents();

  $('#loginForm').addEventListener('submit', submitLogin);
  $('#loginToggle').addEventListener('click', () => {
    setAuthMode(state.authMode === 'register' ? 'login' : 'register');
  });
  $('#logoutBtn').addEventListener('click', logout);

  const auth = await checkAuth();
  if (!auth.authenticated) {
    showLogin(Boolean(auth.needsSetup));
    return;
  }
  await enterApp(auth.user);
}

document.addEventListener('DOMContentLoaded', init);
