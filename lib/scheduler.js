import * as store from './store.js';
import { sendMessage } from './discord.js';

const runtimes = new Map();

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sleeps, but wakes early if the task is stopped.
async function interruptibleSleep(rt, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (rt.stopped) return;
    await sleep(Math.min(1000, end - Date.now()));
  }
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function inWindow(task, date = new Date()) {
  const start = toMinutes(task.startTime);
  const end = toMinutes(task.endTime);
  if (start === end) return true;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  return start < end
    ? nowMin >= start && nowMin < end
    : nowMin >= start || nowMin < end; // overnight window
}

async function loop(taskId) {
  const rt = runtimes.get(taskId);
  const task = store.getTask(taskId);
  if (!task) return;

  store.addLog('info', `Task "${task.name}" started`, taskId);
  store.updateTask(taskId, { status: 'running' });

  let sentThisRun = 0;

  while (!rt.stopped) {
    if (rt.paused) {
      await sleep(1000);
      continue;
    }

    const fresh = store.getTask(taskId);
    if (!fresh || !fresh.channelId) {
      store.addLog('error', `Task "${task.name}" stopped: no channel selected`, taskId);
      break;
    }

    if (fresh.maxPerRun > 0 && sentThisRun >= fresh.maxPerRun) {
      store.addLog('info', `Task "${task.name}" reached its ${fresh.maxPerRun}-message limit`, taskId);
      break;
    }

    if (fresh.runMode !== 'continuous' && !inWindow(fresh)) {
      await interruptibleSleep(rt, 15000);
      continue;
    }

    if (!store.messageCount()) {
      store.addLog('warn', `Task "${task.name}" has no messages to send`, taskId);
      await interruptibleSleep(rt, 10000);
      continue;
    }

    const msg = store.nextMessageForTask(taskId);
    try {
      await sendMessage(store.getToken(), fresh.channelId, msg.content, store.getTokenType());
      sentThisRun += 1;
      store.updateTask(taskId, {
        sentCount: (fresh.sentCount || 0) + 1,
        lastSentAt: new Date().toISOString(),
        lastMessageId: msg.id,
      });
      const preview = msg.content.length > 60 ? `${msg.content.slice(0, 60)}...` : msg.content;
      store.addLog('success', `Sent to ${fresh.channelName || fresh.channelId}: ${preview}`, taskId);
    } catch (err) {
      store.addLog('error', `Send failed on "${fresh.name}": ${err.message}`, taskId);
      if (err.status === 401 || err.status === 403) {
        store.addLog('error', `Task "${fresh.name}" stopped: check the bot token and channel permissions`, taskId);
        break;
      }
    }

    const delaySec = randInt(fresh.minDelay, fresh.maxDelay);
    store.addLog('debug', `Task "${fresh.name}" waiting ${delaySec}s before next message`, taskId);
    await interruptibleSleep(rt, delaySec * 1000);
  }

  store.updateTask(taskId, { status: 'stopped' });
  store.addLog('info', `Task "${task.name}" stopped`, taskId);
  runtimes.delete(taskId);
}

export function startTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'Task not found' };
  if (!store.getToken()) return { ok: false, error: 'Connect a bot token first' };
  if (!task.channelId) return { ok: false, error: 'No channel selected for this task' };
  if (runtimes.has(Number(taskId))) return { ok: false, error: 'Task already running' };

  runtimes.set(Number(taskId), { stopped: false, paused: false });
  loop(Number(taskId));
  return { ok: true };
}

export function pauseTask(taskId) {
  const rt = runtimes.get(Number(taskId));
  if (!rt) return { ok: false, error: 'Task is not running' };
  rt.paused = true;
  store.updateTask(taskId, { status: 'paused' });
  store.addLog('info', `Task "${store.getTask(taskId)?.name}" paused`, taskId);
  return { ok: true };
}

export function resumeTask(taskId) {
  const rt = runtimes.get(Number(taskId));
  if (!rt) return { ok: false, error: 'Task is not running' };
  rt.paused = false;
  store.updateTask(taskId, { status: 'running' });
  store.addLog('info', `Task "${store.getTask(taskId)?.name}" resumed`, taskId);
  return { ok: true };
}

export function stopTask(taskId) {
  const rt = runtimes.get(Number(taskId));
  if (rt) rt.stopped = true;
  store.updateTask(taskId, { status: 'stopped' });
  return { ok: true };
}

export function stopAll() {
  for (const rt of runtimes.values()) rt.stopped = true;
  runtimes.clear();
}
