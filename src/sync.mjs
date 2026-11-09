import { readJSON, atomicJSON } from './state.mjs';

export function initialState(scope, destination) {
  return { version: 1, scope, destination, phase: 'baseline', seen: [], cursor: null, cursors: [], scan: [], jobs: {}, lastScanAt: null, lastError: null, baselineStartedAt: new Date().toISOString() };
}
export function safeError(error) {
  return String(error?.message || '').match(/^[A-Z][A-Z_0-9]+/)?.[0] || 'OPERATION_FAILED';
}

export async function synchronize({ statePath, scope, destination, fetchPage, processItem, maxPages = 5, maxJobs = 10, now = () => Date.now(), pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  let state = await readJSON(statePath, null);
  if (!state) { state = initialState(scope, destination); await atomicJSON(statePath, state); }
  if (state.version !== 1 || !['baseline','watching'].includes(state.phase) || !Array.isArray(state.seen) || !Array.isArray(state.scan) || !Array.isArray(state.cursors) || !state.jobs || typeof state.jobs !== 'object') throw new Error('STATE_INVALID: refusing to reset');
  if (state.scope !== scope) throw new Error('SESSION_CHANGED: use the original account session or explicitly start with a new state directory');
  if (state.destination !== destination) throw new Error('DESTINATION_CHANGED: use a new state directory for a different vault');
  const save = () => atomicJSON(statePath, state);
  const seen = new Set(state.seen);
  let baselineFinished = false;
  try {
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const page = await fetchPage(state.cursor);
      if (!Array.isArray(page.items) || (page.cursor !== null && typeof page.cursor !== 'string')) throw new Error('X_SCHEMA_CHANGED');
      // X ends some bookmark timelines with a cursor-only page that echoes
      // the requested bottom cursor, without a TimelineTerminateTimeline.
      // Only this empty, immediate repeat is EOF; other cycles still fail.
      const emptyEnd = page.items.length === 0 && state.cursor !== null && page.cursor === state.cursor;
      if (!emptyEnd && page.cursor && (page.cursor === state.cursor || state.cursors.includes(page.cursor))) throw new Error('CURSOR_STALLED: pagination made no progress');
      const knownPage = page.items.length > 0 && page.items.every(item => seen.has(item.id));
      if (state.phase === 'baseline') {
        for (const item of page.items) seen.add(item.id);
        state.seen = [...seen];
      } else {
        const batch = new Map(state.scan.map(item => [item.id, item]));
        for (const item of page.items) if (!seen.has(item.id)) batch.set(item.id, item);
        state.scan = [...batch.values()];
      }
      if (emptyEnd || !page.cursor || (state.phase === 'watching' && knownPage)) {
        if (state.phase === 'baseline') {
          state.phase = 'watching'; state.baselineCompletedAt = new Date(now()).toISOString(); baselineFinished = true;
        } else {
          // Persist discovery and its durable queue together BEFORE any content work.
          for (const item of state.scan) {
            seen.add(item.id);
            state.jobs[item.id] ??= { ...item, status: 'pending', attempts: 0, nextAttemptAt: 0, discoveredAt: new Date(now()).toISOString() };
          }
          state.seen = [...seen];
        }
        state.cursor = null; state.cursors = []; state.scan = [];
        state.lastScanAt = new Date(now()).toISOString(); state.lastError = null;
        await save(); break;
      }
      state.cursor = page.cursor; state.cursors.push(page.cursor); state.lastError = null;
      await save();
      if (pageNo + 1 < maxPages) await pause(1000);
    }
  } catch (error) {
    state.lastError = safeError(error); await save();
  }
  // Baseline never downloads historical bodies or media. Pending work is retried independently of discovery.
  if (state.phase === 'watching' && !baselineFinished) {
    const due = Object.values(state.jobs).filter(j => j.status === 'pending' && j.nextAttemptAt <= now()).slice(0, maxJobs);
    for (const job of due) {
      try {
        const result = await processItem(job);
        if (!['saved','skipped-existing'].includes(result?.status)) throw new Error('ARCHIVE_INCOMPLETE');
        job.status = 'done'; job.completedAt = new Date(now()).toISOString(); job.notePath = result.notePath;
        job.lastError = null;
      } catch (error) {
        job.attempts++; job.lastError = safeError(error);
        job.nextAttemptAt = now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts - 1, 6));
      }
      await save();
    }
  }
  return summarize(state);
}

export function summarize(state) {
  if (!state) return { phase: 'not-started', baselineCount: 0, pending: 0, completed: 0 };
  const jobs = Object.values(state.jobs);
  return { phase: state.phase, knownBookmarks: state.seen.length, scanInProgress: state.cursor !== null, discoveredInScan: state.scan.length, pending: jobs.filter(j=>j.status==='pending').length, completed: jobs.filter(j=>j.status==='done').length, retrying: jobs.filter(j=>j.status==='pending'&&j.attempts>0).length, lastScanAt: state.lastScanAt, lastError: state.lastError, jobErrors: [...new Set(jobs.filter(j=>j.status==='pending'&&j.lastError).map(j=>j.lastError))] };
}
