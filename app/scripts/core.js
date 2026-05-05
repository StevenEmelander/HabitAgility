import { renderEntry } from './entry-ui.js';
import { renderTrends } from './trends-ui.js';
import { renderPlan, renderAddHabitModal } from './plan-ui.js';

export const API_CYCLE = '/api/cycle';
export const API_ENTRY = '/api/entry';
export const API_TREND = '/api/trend';

export const state = {
  /** dateKey → { habitValuesById, cycleId }. Sparse, populated on demand. */
  entriesByDate: {},
  _loadedEntryDates: new Set(),

  /** cycleId → full cycle body. Sparse, populated on demand. */
  cyclesById: {},
  _loadedCycleIds: new Set(),

  /** cycleId of the cycle covering todayKey(); resolved at boot. */
  currentCycleId: null,

  /** Cycle summaries for year/all-time trends — array sorted by startDate. */
  cycleSummaries: null,

  /** Daily-bucket trends responses keyed by URL (cycle/month modes). */
  trendsCache: {},

  /** UI state */
  tab: 'entry',
  planMode: 'current',
  viewDate: null,
  cloudReady: false,
  trendsMode: 'cycle',
  trendsStep: 0,
  /** When stepping through cycles in the trends view, this holds the focused cycleId. */
  trendsCycleId: null,
  /** Tracks the year (number) for year-mode and yyyy-mm string for month-mode. */
  trendsYear: null,
  trendsMonth: null,
  addHabitDraft: null,

  /** Per-item dirty tracking */
  _dirtyCycleIds: {},
  _dirtyEntryDates: {},
  _deletedEntryDates: [],
};

let syncStatus = 'idle';
let toastTimer = null;
let pushCycleImpl = () => {};
let pushEntryImpl = () => {};

export function registerPushers(pushCycle, pushEntry) {
  pushCycleImpl = typeof pushCycle === 'function' ? pushCycle : () => {};
  pushEntryImpl = typeof pushEntry === 'function' ? pushEntry : () => {};
}

export function setSyncStatus(next) { syncStatus = next; }

export function clone(x) { return JSON.parse(JSON.stringify(x)); }
export function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-4); }
export function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function todayKey() { return fmtDate(new Date()); }
export function addDaysKey(k, n) { const d = new Date(k + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); }

/** Allowed point-step values (cycle.pointStep). */
export const POINT_STEPS = [0.1, 0.25, 0.5, 1];

export function pointStep(cycle) {
  const s = Number(cycle && cycle.pointStep);
  return POINT_STEPS.includes(s) ? s : 1;
}

export function quantize(v) { return Math.round((Number(v) || 0) * 100) / 100; }
export function fmtPoints(v) { return Number(quantize(v).toFixed(2)).toString(); }
export function decimalsForStep(step) {
  if (step >= 1) return 0;
  if (step === 0.25) return 2;
  return 1;
}
export function fmtPointsForStep(v, step) { return quantize(v).toFixed(decimalsForStep(step)); }

// ── Sparse accessors ──────────────────────────────────────────────────

export function getCycleById(id) { return id ? (state.cyclesById[id] || null) : null; }
export function getCurrentCycle() { return getCycleById(state.currentCycleId); }
export function getEntry(dateKey) {
  return state.entriesByDate[dateKey] || { habitValuesById: {}, cycleId: null };
}

/** Cycle covering a date, sourced from the entry's stored cycleId. Null if entry not loaded. */
export function cycleForDate(dateKey) {
  const e = state.entriesByDate[dateKey];
  if (!e || !e.cycleId) return null;
  return getCycleById(e.cycleId);
}

export function isCurrentCycleFirstDay() {
  const cur = getCurrentCycle();
  return !!cur && cur.startDate === todayKey();
}

export function hasAnyEntries() {
  // Best signal we have without bulk-loading: any cached entry has values, OR the current cycle
  // is past its first day (entries must exist somewhere).
  for (const dk of Object.keys(state.entriesByDate)) {
    const e = state.entriesByDate[dk];
    if (e && e.habitValuesById && Object.keys(e.habitValuesById).length > 0) return true;
  }
  const cur = getCurrentCycle();
  return !!cur && cur.startDate < todayKey();
}

// ── Bounded view-date logic ────────────────────────────────────────────

export function viewDayKey() {
  const t = todayKey();
  if (!state.viewDate) state.viewDate = t;
  if (state.viewDate > t) state.viewDate = t;
  return state.viewDate;
}

// ── Habit math (mirrors lambda for parity with server-computed totals) ──

export function habitsForCategory(cycle, cid) { return ((cycle && cycle.habitDefinitions) || []).filter(h => h.categoryId === cid); }
export function habitById(cycle, id) { return ((cycle && cycle.habitDefinitions) || []).find(h => h.id === id); }
export function habitEarned(h, v) { return h.kind === 'boolean' ? (v ? (h.scoring.points || 0) : 0) : Math.max(0, Math.min(Number(v || 0), h.scoring.maxUnits || 0)) * (h.scoring.pointsPerUnit || 0); }
export function habitMax(h) { return h.kind === 'boolean' ? (h.scoring.points || 0) : (h.scoring.maxUnits || 0) * (h.scoring.pointsPerUnit || 0); }
export function categoryPoints(entry, cycle, cid) { if (!entry || !cycle) return 0; return habitsForCategory(cycle, cid).reduce((s, h) => s + habitEarned(h, (entry.habitValuesById || {})[h.id]), 0); }
export function categoryMax(cycle, cid) { return cycle ? habitsForCategory(cycle, cid).reduce((s, h) => s + habitMax(h), 0) : 0; }
export function totalPoints(entry, cycle) { return cycle ? (cycle.categories || []).reduce((s, c) => s + categoryPoints(entry, cycle, c.id), 0) : 0; }
export function totalMax(cycle) { return cycle ? (cycle.categories || []).reduce((s, c) => s + categoryMax(cycle, c.id), 0) : 0; }

// ── Cycle info for header ──────────────────────────────────────────────

export function cycleInfo() {
  const cur = getCurrentCycle();
  if (!cur) return { cycleNum: 0, day: 0, length: 0, daysLeft: 0, cur: null };
  const day = Math.max(1, Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(cur.startDate + 'T00:00:00')) / 86400000) + 1);
  return {
    cycleNum: 0, // cycle order is no longer locally known; left as 0 (future: derive from summaries)
    day,
    length: cur.lengthDays,
    daysLeft: Math.max(0, cur.lengthDays - day),
    cur,
  };
}

// ── Edit helpers (mark dirty, push) ────────────────────────────────────

function markEntryDirty(dk) { state._dirtyEntryDates[dk] = true; }
function markEntryDeleted(dk) {
  delete state._dirtyEntryDates[dk];
  if (!state._deletedEntryDates.includes(dk)) state._deletedEntryDates.push(dk);
}
function markCycleDirty(id) { state._dirtyCycleIds[id] = true; }

export function putEntry(dateKey, entry) {
  state.entriesByDate[dateKey] = entry;
  state._loadedEntryDates.add(dateKey);
  markEntryDirty(dateKey);
}

export function applyOrphanSweepLocally(removedHabitIds) {
  if (!removedHabitIds || !removedHabitIds.length) return;
  const ids = new Set(removedHabitIds);
  for (const dk of Object.keys(state.entriesByDate)) {
    const e = state.entriesByDate[dk];
    if (!e || !e.habitValuesById) continue;
    let changed = false;
    for (const k of Object.keys(e.habitValuesById)) {
      if (ids.has(k)) { delete e.habitValuesById[k]; changed = true; }
    }
    if (!changed) continue;
    if (Object.keys(e.habitValuesById).length === 0) delete state.entriesByDate[dk];
  }
}

export function pushEntry(dateKey) {
  if (state.entriesByDate[dateKey] && Object.keys(state.entriesByDate[dateKey].habitValuesById || {}).length === 0) {
    delete state.entriesByDate[dateKey];
    markEntryDeleted(dateKey);
  } else {
    markEntryDirty(dateKey);
  }
  pushEntryImpl(dateKey);
}

export function pushCycle(cycleId) {
  markCycleDirty(cycleId);
  pushCycleImpl(cycleId);
}

// ── Trends caches ──────────────────────────────────────────────────────

export function invalidateTrendsForDate(dateKey) {
  // Drop daily-bucket caches whose range contains this date.
  for (const url of Object.keys(state.trendsCache)) {
    const r = state.trendsCache[url];
    if (r && r.from <= dateKey && dateKey <= r.to) delete state.trendsCache[url];
  }
  // Cycle summaries are server-invalidated via the entry PUT; drop our cache so the
  // next trends view refetches.
  state.cycleSummaries = null;
}

export function invalidateTrendsAll() {
  state.trendsCache = {};
  state.cycleSummaries = null;
}

// ── load() / render() ─────────────────────────────────────────────────

export function load() {
  // Cloud-only: nothing to seed locally. The boot sync populates everything.
  state.entriesByDate = {};
  state.cyclesById = {};
  state._loadedEntryDates = new Set();
  state._loadedCycleIds = new Set();
  state.currentCycleId = null;
  state.cycleSummaries = null;
  state.trendsCache = {};
  state.viewDate = todayKey();
  state._dirtyCycleIds = {};
  state._dirtyEntryDates = {};
  state._deletedEntryDates = [];
  state.trendsMode = 'cycle';
  state.trendsStep = 0;
  state.trendsCycleId = null;
  state.trendsYear = null;
  state.trendsMonth = null;
  state.addHabitDraft = null;
}

export function dayLabel(k) { return new Date(k + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase(); }
export function escapeHtml(s) { return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

export function render() {
  if (!state.cloudReady) {
    document.body.style.overflow = '';
    document.getElementById('app').innerHTML = `
      <div class="shell">
        <div class="card">
          <div class="mono muted">GOOD HABIT TRACKER</div>
          <div style="margin-top:10px; font-size:16px">Connecting to cloud data…</div>
          <div class="muted" style="margin-top:8px; font-size:13px">This app is cloud-first and does not use local storage.</div>
        </div>
      </div>`;
    return;
  }
  const info = cycleInfo();
  const syncPill = syncStatus === 'error'
    ? '<div class="pill mono" style="border-color:var(--danger);color:var(--danger)">SYNC FAILED</div>'
    : syncStatus === 'syncing' ? '<div class="pill mono">SYNCING…</div>' : '';
  const headerSummary = info.cur
    ? `DAY ${info.day}/${info.length}`
    : 'NO CYCLE';
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <div class="row between" style="gap:10px;align-items:center;flex-wrap:nowrap;margin-bottom:10px">
        <div class="title" style="margin:0;font-size:22px;line-height:1.1">Good Habit Tracker</div>
        <div class="row" style="margin-left:auto;gap:8px;align-items:center;justify-content:flex-end">
          <div class="mono muted" style="font-size:11px;white-space:nowrap;text-align:right">${headerSummary}</div>
          ${syncPill}
        </div>
      </div>
      ${state.tab === 'entry' ? renderEntry() : state.tab === 'trends' ? renderTrends() : renderPlan()}
    </div>
    <nav class="tabs">
      <button class="tab ${state.tab === 'entry' ? 'active' : ''}" data-action="tab" data-tab="entry">ENTRIES</button>
      <button class="tab ${state.tab === 'trends' ? 'active' : ''}" data-action="tab" data-tab="trends">TRENDS</button>
      <button class="tab ${state.tab === 'plan' ? 'active' : ''}" data-action="tab" data-tab="plan">PLAN</button>
    </nav>
    ${state.addHabitDraft ? renderAddHabitModal() : ''}`;
  document.body.style.overflow = state.addHabitDraft ? 'hidden' : '';
}
