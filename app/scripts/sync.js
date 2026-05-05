import {
  addDaysKey,
  API_CYCLE,
  API_ENTRY,
  API_TREND,
  applyOrphanSweepLocally,
  clone,
  load,
  registerPushers,
  render,
  setSyncStatus,
  state,
  todayKey,
} from './core.js';

const CYCLE_DEBOUNCE_MS = 1500;
const ENTRY_DEBOUNCE_MS = 1500;

const cycleTimers = new Map();
const entryTimers = new Map();
let inflight = 0;

function bumpStatus() { setSyncStatus(inflight > 0 ? 'syncing' : 'ok'); }
function markError() { setSyncStatus('error'); render(); }

// ── Per-item pushers ───────────────────────────────────────────────────

function pushCycleSoon(cycleId) {
  const t = cycleTimers.get(cycleId); if (t) clearTimeout(t);
  cycleTimers.set(cycleId, setTimeout(() => flushCycle(cycleId), CYCLE_DEBOUNCE_MS));
}
function pushEntrySoon(dateKey) {
  const t = entryTimers.get(dateKey); if (t) clearTimeout(t);
  entryTimers.set(dateKey, setTimeout(() => flushEntry(dateKey), ENTRY_DEBOUNCE_MS));
}

async function flushCycle(cycleId) {
  cycleTimers.delete(cycleId);
  delete state._dirtyCycleIds[cycleId];
  const cycle = state.cyclesById[cycleId];
  if (!cycle) return;
  inflight++; bumpStatus(); render();
  try {
    const res = await fetch(`${API_CYCLE}/${encodeURIComponent(cycleId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        lengthDays: cycle.lengthDays,
        pointStep: cycle.pointStep,
        categories: cycle.categories || [],
        habitDefinitions: cycle.habitDefinitions || [],
      }),
    });
    if (!res.ok) throw new Error('cycle ' + res.status);
    try {
      const payload = await res.clone().json();
      if (payload && Array.isArray(payload.removedHabitIds) && payload.removedHabitIds.length) {
        applyOrphanSweepLocally(payload.removedHabitIds);
      }
    } catch (_) {}
    state.cycleSummaries = null;
    state.trendsCache = {};
  } catch (_) {
    state._dirtyCycleIds[cycleId] = true;
    inflight--; markError(); return;
  }
  inflight--; bumpStatus(); render();
}

async function flushEntry(dateKey) {
  entryTimers.delete(dateKey);
  const entry = state.entriesByDate[dateKey];
  const empty = !entry || Object.keys(entry.habitValuesById || {}).length === 0;
  delete state._dirtyEntryDates[dateKey];
  if (empty) state._deletedEntryDates = state._deletedEntryDates.filter((d) => d !== dateKey);
  inflight++; bumpStatus(); render();
  try {
    const res = await fetch(`${API_ENTRY}/${encodeURIComponent(dateKey)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habitValuesById: empty ? {} : entry.habitValuesById }),
    });
    if (!res.ok) throw new Error('entry-put ' + res.status);
    for (const url of Object.keys(state.trendsCache)) {
      const r = state.trendsCache[url];
      if (r && r.from <= dateKey && dateKey <= r.to) delete state.trendsCache[url];
    }
    state.cycleSummaries = null;
  } catch (_) {
    if (empty) {
      if (!state._deletedEntryDates.includes(dateKey)) state._deletedEntryDates.push(dateKey);
    } else {
      state._dirtyEntryDates[dateKey] = true;
    }
    inflight--; markError(); return;
  }
  inflight--; bumpStatus(); render();
}

// ── Lazy loaders ───────────────────────────────────────────────────────

const inflightEntry = new Map();
const inflightCycle = new Map();

export async function loadEntry(dateKey) {
  if (state._loadedEntryDates.has(dateKey)) return state.entriesByDate[dateKey];
  if (inflightEntry.has(dateKey)) return inflightEntry.get(dateKey);
  const p = (async () => {
    try {
      const res = await fetch(`${API_ENTRY}/${encodeURIComponent(dateKey)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('entry ' + res.status);
      const data = await res.json();
      state.entriesByDate[dateKey] = {
        habitValuesById: (data && data.habitValuesById) || {},
        cycleId: (data && data.cycleId) || null,
      };
      state._loadedEntryDates.add(dateKey);
      if (state.entriesByDate[dateKey].cycleId) {
        await loadCycle(state.entriesByDate[dateKey].cycleId);
      }
      return state.entriesByDate[dateKey];
    } finally { inflightEntry.delete(dateKey); }
  })();
  inflightEntry.set(dateKey, p);
  return p;
}

export async function loadCycle(cycleId) {
  if (cycleId == null) return null;
  if (state._loadedCycleIds.has(cycleId)) return state.cyclesById[cycleId];
  if (inflightCycle.has(cycleId)) return inflightCycle.get(cycleId);
  const p = (async () => {
    try {
      const res = await fetch(`${API_CYCLE}/${encodeURIComponent(cycleId)}`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const cycle = await res.json();
      state.cyclesById[cycle.id] = cycle;
      state._loadedCycleIds.add(cycle.id);
      return cycle;
    } finally { inflightCycle.delete(cycleId); }
  })();
  inflightCycle.set(cycleId, p);
  return p;
}

/** POST a new cycle. Body has all fields except id; server assigns the next integer. */
export async function createCycle(template) {
  const res = await fetch(API_CYCLE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: template.startDate,
      endDate: template.endDate,
      lengthDays: template.lengthDays,
      pointStep: template.pointStep,
      categories: template.categories || [],
      habitDefinitions: template.habitDefinitions || [],
    }),
  });
  if (!res.ok) return null;
  const cycle = await res.json();
  state.cyclesById[cycle.id] = cycle;
  state._loadedCycleIds.add(cycle.id);
  state.cycleSummaries = null;
  return cycle;
}

export async function loadCycleSummaries() {
  if (state.cycleSummaries) return state.cycleSummaries;
  const res = await fetch(`${API_TREND}/cycle-summary`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('summaries ' + res.status);
  const data = await res.json();
  state.cycleSummaries = (data && data.summaries) || [];
  return state.cycleSummaries;
}

export async function loadTrendUrl(url) {
  if (state.trendsCache[url]) return state.trendsCache[url];
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('trend ' + res.status);
  const data = await res.json();
  state.trendsCache[url] = data;
  return data;
}

// ── Boot ──────────────────────────────────────────────────────────────

function renderCloudUnavailable(reason) {
  document.body.style.overflow = '';
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <div class="card">
        <div class="mono muted">GOOD HABIT TRACKER</div>
        <div style="margin-top:10px; font-size:16px">Cloud unavailable</div>
        <div class="muted" style="margin-top:8px; font-size:13px">${reason}</div>
        <div style="margin-top:10px"><button class="btn primary" data-action="retry-sync">Retry</button></div>
      </div>
    </div>`;
}

/**
 * Ensure today's covering cycle exists in the cloud. Used at boot when the entry's cycleId
 * is null (no cycle covers today yet). Loads the latest summary to clone categories/habits
 * forward, then POSTs a new cycle covering today.
 */
async function ensureCurrentCycle() {
  if (state.currentCycleId) return;
  const today = todayKey();
  let template = null;
  try {
    const summaries = await loadCycleSummaries();
    if (summaries && summaries.length) {
      const latest = summaries[summaries.length - 1];
      template = await loadCycle(latest.cycleId);
    }
  } catch (_) {}
  const length = (template && template.lengthDays) || 14;
  const pointStep = (template && template.pointStep) || 1;
  const categories = template ? clone(template.categories || []) : [];
  const habits = template ? clone(template.habitDefinitions || []) : [];
  const newCycle = await createCycle({
    startDate: today,
    endDate: addDaysKey(today, length - 1),
    lengthDays: length,
    pointStep,
    categories,
    habitDefinitions: habits,
  });
  if (!newCycle) return;
  state.currentCycleId = newCycle.id;
  // Reflect on today's cached entry so the UI sees it immediately.
  const todayEntry = state.entriesByDate[today] || { habitValuesById: {}, cycleId: null };
  todayEntry.cycleId = newCycle.id;
  state.entriesByDate[today] = todayEntry;
}

export async function bootSync() {
  setSyncStatus('syncing');
  try {
    const today = todayKey();
    await loadEntry(today);
    state.currentCycleId = state.entriesByDate[today].cycleId;
    if (!state.currentCycleId) await ensureCurrentCycle();
    state.cloudReady = true;
    setSyncStatus('ok');
    render();
  } catch (_) {
    setSyncStatus('error');
    renderCloudUnavailable('Network error while loading data.');
  }
}

export function initSync() {
  registerPushers(pushCycleSoon, pushEntrySoon);
  load();
  render();
  bootSync();
}
