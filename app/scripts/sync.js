import {
  API_ENTRY,
  API_SPRINT,
  API_TREND,
  DEFAULT_GOAL_POINTS,
  DEFAULT_POINT_STEP,
  DEFAULT_SPRINT_LENGTH_DAYS,
  ENTRY_DEBOUNCE_MS,
  SPRINT_DEBOUNCE_MS,
} from './constants.js';
import {
  applyOrphanSweepLocally,
  clone,
  load,
  registerPushers,
  render,
  setSyncStatus,
  state,
  todayKey,
} from './core.js';

const sprintTimers = new Map();
const entryTimers = new Map();
let inflight = 0;

function bumpStatus() {
  setSyncStatus(inflight > 0 ? 'syncing' : 'ok');
}
function markError() {
  setSyncStatus('error');
  render();
}

// ── Per-item pushers ───────────────────────────────────────────────────

function pushSprintSoon(sprintId) {
  const t = sprintTimers.get(sprintId);
  if (t) clearTimeout(t);
  sprintTimers.set(
    sprintId,
    setTimeout(() => flushSprint(sprintId), SPRINT_DEBOUNCE_MS),
  );
}
function pushEntrySoon(dateKey) {
  const t = entryTimers.get(dateKey);
  if (t) clearTimeout(t);
  entryTimers.set(
    dateKey,
    setTimeout(() => flushEntry(dateKey), ENTRY_DEBOUNCE_MS),
  );
}

async function flushSprint(sprintId) {
  sprintTimers.delete(sprintId);
  delete state._dirtySprintIds[sprintId];
  const sprint = state.sprintsById[sprintId];
  if (!sprint) return;
  inflight++;
  bumpStatus();
  render();
  try {
    const res = await fetch(`${API_SPRINT}/${encodeURIComponent(sprintId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        lengthDays: sprint.lengthDays,
        pointStep: sprint.pointStep,
        goalPoints: sprint.goalPoints,
        name: sprint.name || '',
        description: sprint.description || '',
        retrospective: sprint.retrospective || '',
        categories: sprint.categories || [],
        habitDefinitions: sprint.habitDefinitions || [],
      }),
    });
    if (!res.ok) throw new Error('sprint ' + res.status);
    try {
      const payload = await res.clone().json();
      if (payload && Array.isArray(payload.removedHabitIds) && payload.removedHabitIds.length) {
        applyOrphanSweepLocally(payload.removedHabitIds);
      }
    } catch (_) {}
    state.sprintSummaries = null;
    state.trendsCache = {};
  } catch (_) {
    state._dirtySprintIds[sprintId] = true;
    inflight--;
    markError();
    return;
  }
  inflight--;
  bumpStatus();
  render();
}

async function flushEntry(dateKey) {
  entryTimers.delete(dateKey);
  const entry = state.entriesByDate[dateKey];
  const empty = !entry || Object.keys(entry.habitValuesById || {}).length === 0;
  delete state._dirtyEntryDates[dateKey];
  if (empty) state._deletedEntryDates = state._deletedEntryDates.filter((d) => d !== dateKey);
  inflight++;
  bumpStatus();
  render();
  try {
    const res = await fetch(`${API_ENTRY}/${encodeURIComponent(dateKey)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habitValuesById: empty ? {} : entry.habitValuesById }),
    });
    if (!res.ok) throw new Error('entry-put ' + res.status);
    // First-entry → sprint started: the lambda set startDate + endDate on the
    // covering sprint. Patch state so the UI reflects the transition without a
    // full reload.
    try {
      const payload = await res.clone().json();
      if (payload?.sprintStarted) {
        const { sprintId, startDate, endDate } = payload.sprintStarted;
        const sprint = state.sprintsById[sprintId];
        if (sprint) {
          sprint.startDate = startDate;
          sprint.endDate = endDate;
        }
      }
    } catch (_) {}
    for (const url of Object.keys(state.trendsCache)) {
      const r = state.trendsCache[url];
      if (r && r.from <= dateKey && dateKey <= r.to) delete state.trendsCache[url];
    }
    state.sprintSummaries = null;
  } catch (_) {
    if (empty) {
      if (!state._deletedEntryDates.includes(dateKey)) state._deletedEntryDates.push(dateKey);
    } else {
      state._dirtyEntryDates[dateKey] = true;
    }
    inflight--;
    markError();
    return;
  }
  inflight--;
  bumpStatus();
  render();
}

// ── Lazy loaders ───────────────────────────────────────────────────────

const inflightEntry = new Map();
const inflightSprint = new Map();

export async function loadEntry(dateKey) {
  if (state._loadedEntryDates.has(dateKey)) return state.entriesByDate[dateKey];
  if (inflightEntry.has(dateKey)) return inflightEntry.get(dateKey);
  const p = (async () => {
    try {
      const res = await fetch(`${API_ENTRY}/${encodeURIComponent(dateKey)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('entry ' + res.status);
      const data = await res.json();
      state.entriesByDate[dateKey] = {
        habitValuesById: data?.habitValuesById || {},
        sprintId: data?.sprintId || null,
      };
      state._loadedEntryDates.add(dateKey);
      if (state.entriesByDate[dateKey].sprintId) {
        await loadSprint(state.entriesByDate[dateKey].sprintId);
      }
      return state.entriesByDate[dateKey];
    } finally {
      inflightEntry.delete(dateKey);
    }
  })();
  inflightEntry.set(dateKey, p);
  return p;
}

export async function loadSprint(sprintId) {
  if (sprintId == null) return null;
  if (state._loadedSprintIds.has(sprintId)) return state.sprintsById[sprintId];
  if (inflightSprint.has(sprintId)) return inflightSprint.get(sprintId);
  const p = (async () => {
    try {
      const res = await fetch(`${API_SPRINT}/${encodeURIComponent(sprintId)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      const sprint = await res.json();
      state.sprintsById[sprint.id] = sprint;
      state._loadedSprintIds.add(sprint.id);
      return sprint;
    } finally {
      inflightSprint.delete(sprintId);
    }
  })();
  inflightSprint.set(sprintId, p);
  return p;
}

/** POST a new sprint. Body has all fields except id; server assigns the next integer. */
export async function createSprint(template) {
  const res = await fetch(API_SPRINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: template.startDate,
      endDate: template.endDate,
      lengthDays: template.lengthDays,
      pointStep: template.pointStep,
      goalPoints: template.goalPoints,
      // Metadata does NOT inherit — each sprint starts blank.
      name: template.name || '',
      description: template.description || '',
      retrospective: template.retrospective || '',
      categories: template.categories || [],
      habitDefinitions: template.habitDefinitions || [],
    }),
  });
  if (!res.ok) return null;
  const sprint = await res.json();
  state.sprintsById[sprint.id] = sprint;
  state._loadedSprintIds.add(sprint.id);
  state.sprintSummaries = null;
  return sprint;
}

export async function loadSprintSummaries() {
  if (state.sprintSummaries) return state.sprintSummaries;
  const res = await fetch(`${API_TREND}/sprint-summary`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('summaries ' + res.status);
  const data = await res.json();
  state.sprintSummaries = data?.summaries || [];
  return state.sprintSummaries;
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
        <div class="mono muted">HABITAGILITY</div>
        <div style="margin-top:10px; font-size:16px">Cloud unavailable</div>
        <div class="muted" style="margin-top:8px; font-size:13px">${reason}</div>
        <div style="margin-top:10px"><button class="btn primary" data-action="retry-sync">Retry</button></div>
      </div>
    </div>`;
}

/**
 * Ensure today's covering sprint exists in the cloud. Used at boot when the entry's
 * sprintId is null (no sprint covers today yet). Loads the latest summary to clone
 * categories/habits forward, then POSTs a new sprint covering today.
 */
async function ensureCurrentSprint() {
  if (state.currentSprintId) return;
  const today = todayKey();
  let template = null;
  try {
    const summaries = await loadSprintSummaries();
    if (summaries?.length) {
      const latest = summaries[summaries.length - 1];
      template = await loadSprint(latest.sprintId);
    }
  } catch (_) {}
  // Sprint is created in "planning" state — null startDate / endDate. The lambda
  // stamps them on first entry (sets startDate = entry.dateKey, endDate = +length-1).
  // pointStep and goalPoints inherit from the most recent sprint (scoring tunings),
  // but length, name, description, retrospective do not.
  const length = DEFAULT_SPRINT_LENGTH_DAYS;
  const pointStep = template?.pointStep || DEFAULT_POINT_STEP;
  const goalPoints =
    template && Number.isFinite(Number(template.goalPoints))
      ? Number(template.goalPoints)
      : DEFAULT_GOAL_POINTS;
  const categories = template ? clone(template.categories || []) : [];
  const habits = template ? clone(template.habitDefinitions || []) : [];
  const newSprint = await createSprint({
    startDate: null,
    endDate: null,
    lengthDays: length,
    pointStep,
    goalPoints,
    name: '',
    description: '',
    retrospective: '',
    categories,
    habitDefinitions: habits,
  });
  if (!newSprint) return;
  state.currentSprintId = newSprint.id;
  // Reflect on today's cached entry so the UI sees it immediately.
  const todayEntry = state.entriesByDate[today] || { habitValuesById: {}, sprintId: null };
  todayEntry.sprintId = newSprint.id;
  state.entriesByDate[today] = todayEntry;
}

export async function bootSync() {
  setSyncStatus('syncing');
  try {
    const today = todayKey();
    await loadEntry(today);
    state.currentSprintId = state.entriesByDate[today].sprintId;
    if (!state.currentSprintId) await ensureCurrentSprint();
    state.cloudReady = true;
    setSyncStatus('ok');
    render();
  } catch (_) {
    setSyncStatus('error');
    renderCloudUnavailable('Network error while loading data.');
  }
}

export function initSync() {
  registerPushers(pushSprintSoon, pushEntrySoon);
  load();
  render();
  bootSync();
}
