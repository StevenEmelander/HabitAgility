/**
 * Core: shared state, render orchestration, and small helpers used across modules.
 * Constants live in `./constants.js`; pure habit math lives in `./scoring.js`.
 * Type definitions live in `./types.js` (no runtime).
 */

import {
  API_ENTRY,
  API_SPRINT,
  API_TREND,
  DEFAULT_GOAL_POINTS,
  POINT_STEPS,
  TOAST_DISMISS_MS,
} from './constants.js';
import { renderEntry } from './entry-ui.js';
import { renderActionMenuModal, renderAddHabitModal, renderPlan, renderTextModal } from './plan-ui.js';
import {
  canEditRetrospective,
  categoryPoints,
  clampSprintText,
  decimalsForStep,
  fmtPoints,
  fmtPointsForStep,
  goalForSprint,
  habitById,
  habitEarned,
  habitsForCategory,
  isSprintInPlanning,
  pointStep,
  quantize,
  totalPoints,
} from './scoring.js';
import { renderTrends } from './trends-ui.js';

// Re-export so existing call sites don't have to change their imports.
export {
  API_SPRINT,
  API_ENTRY,
  API_TREND,
  DEFAULT_GOAL_POINTS,
  POINT_STEPS,
  quantize,
  fmtPoints,
  decimalsForStep,
  fmtPointsForStep,
  pointStep,
  goalForSprint,
  habitsForCategory,
  habitById,
  habitEarned,
  categoryPoints,
  totalPoints,
  canEditRetrospective,
  clampSprintText,
  isSprintInPlanning,
};

// ── App state ─────────────────────────────────────────────────────────

export const state = {
  /** dateKey → { habitValuesById, sprintId }. Sparse, populated on demand. */
  entriesByDate: {},
  _loadedEntryDates: new Set(),

  /** sprintId → full sprint body. Sparse, populated on demand. */
  sprintsById: {},
  _loadedSprintIds: new Set(),

  /** sprintId of the sprint covering todayKey(); resolved at boot. */
  currentSprintId: null,

  /** Sprint summaries for year / all-time trends — array sorted by startDate. */
  sprintSummaries: null,

  /** Daily-bucket trends responses keyed by URL (sprint / month modes). */
  trendsCache: {},

  /** UI state */
  tab: 'entry',
  planMode: 'current',
  viewDate: null,
  cloudReady: false,
  trendsMode: 'sprint',
  trendsStep: 0,
  /** When stepping through sprints in the trends view, this holds the focused sprintId. */
  trendsSprintId: null,
  addHabitDraft: null,
  /** Generic text-input modal (replaces window.prompt for add-category, rename-category, rename-habit).
   *  Shape: { kind, title, hint?, placeholder?, initialValue?, okLabel?, maxlength?, id? } | null */
  textModal: null,
  /** Action-menu modal (the ⋯ menu on habits + categories).
   *  Shape: { title, items: [{ label, action, payload?, kind? }, ...] } | null */
  actionMenu: null,

  /** Per-item dirty tracking */
  _dirtySprintIds: {},
  _dirtyEntryDates: {},
  _deletedEntryDates: [],
};

let syncStatus = 'idle';
let toastTimer = null;
let pushSprintImpl = () => {};
let pushEntryImpl = () => {};

export function registerPushers(pushSprint, pushEntry) {
  pushSprintImpl = typeof pushSprint === 'function' ? pushSprint : () => {};
  pushEntryImpl = typeof pushEntry === 'function' ? pushEntry : () => {};
}

export function setSyncStatus(next) {
  syncStatus = next;
}

// ── Small helpers ─────────────────────────────────────────────────────

export function clone(x) {
  return JSON.parse(JSON.stringify(x));
}
export function uid(p) {
  return p + '_' + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-4);
}
export function fmtDate(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
export function todayKey() {
  return fmtDate(new Date());
}
export function addDaysKey(k, n) {
  const d = new Date(k + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
export function dayLabel(k) {
  return new Date(k + 'T12:00:00')
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
}
export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), TOAST_DISMISS_MS);
}

// ── Sparse accessors ──────────────────────────────────────────────────

/** @returns {import('./types.js').Sprint|null} */
export function getSprintById(id) {
  return id ? state.sprintsById[id] || null : null;
}

/** @returns {import('./types.js').Sprint|null} */
export function getCurrentSprint() {
  return getSprintById(state.currentSprintId);
}

/** @returns {import('./types.js').Entry} */
export function getEntry(dateKey) {
  return state.entriesByDate[dateKey] || { habitValuesById: {}, sprintId: null };
}

/** Sprint covering a date, sourced from the entry's stored sprintId. Null if entry not loaded. */
export function sprintForDate(dateKey) {
  const e = state.entriesByDate[dateKey];
  if (!e || !e.sprintId) return null;
  return getSprintById(e.sprintId);
}

export function isCurrentSprintFirstDay() {
  const cur = getCurrentSprint();
  return !!cur && cur.startDate === todayKey();
}

export function hasAnyEntries() {
  // Best signal we have without bulk-loading: any cached entry has values, OR the current
  // sprint is past its first day (entries must exist somewhere).
  for (const dk of Object.keys(state.entriesByDate)) {
    const e = state.entriesByDate[dk];
    if (e?.habitValuesById && Object.keys(e.habitValuesById).length > 0) return true;
  }
  const cur = getCurrentSprint();
  return !!cur && cur.startDate < todayKey();
}

export function viewDayKey() {
  const t = todayKey();
  if (!state.viewDate) state.viewDate = t;
  if (state.viewDate > t) state.viewDate = t;
  return state.viewDate;
}

// ── Sprint info for header ─────────────────────────────────────────────

export function sprintInfo() {
  const cur = getCurrentSprint();
  if (!cur) return { sprintNum: 0, day: 0, length: 0, daysLeft: 0, cur: null };
  // Planning sprint (no startDate yet): day=0 signals "hasn't started", first entry will be day 1.
  if (!cur.startDate) {
    return { sprintNum: 0, day: 0, length: cur.lengthDays, daysLeft: cur.lengthDays, cur };
  }
  const day = Math.max(
    1,
    Math.floor((new Date(todayKey() + 'T00:00:00') - new Date(cur.startDate + 'T00:00:00')) / 86400000) + 1,
  );
  return {
    sprintNum: 0, // sprint order is no longer locally known; left as 0 (future: derive from summaries)
    day,
    length: cur.lengthDays,
    daysLeft: Math.max(0, cur.lengthDays - day),
    cur,
  };
}

// ── Edit helpers (mark dirty, push) ────────────────────────────────────

function markEntryDirty(dk) {
  state._dirtyEntryDates[dk] = true;
}
function markEntryDeleted(dk) {
  delete state._dirtyEntryDates[dk];
  if (!state._deletedEntryDates.includes(dk)) state._deletedEntryDates.push(dk);
}
function markSprintDirty(id) {
  state._dirtySprintIds[id] = true;
}

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
      if (ids.has(k)) {
        delete e.habitValuesById[k];
        changed = true;
      }
    }
    if (!changed) continue;
    if (Object.keys(e.habitValuesById).length === 0) delete state.entriesByDate[dk];
  }
}

export function pushEntry(dateKey) {
  if (
    state.entriesByDate[dateKey] &&
    Object.keys(state.entriesByDate[dateKey].habitValuesById || {}).length === 0
  ) {
    delete state.entriesByDate[dateKey];
    markEntryDeleted(dateKey);
  } else {
    markEntryDirty(dateKey);
  }
  pushEntryImpl(dateKey);
}

export function pushSprint(sprintId) {
  markSprintDirty(sprintId);
  pushSprintImpl(sprintId);
}

// ── Trends caches ──────────────────────────────────────────────────────

export function invalidateTrendsForDate(dateKey) {
  // Drop daily-bucket caches whose range contains this date.
  for (const url of Object.keys(state.trendsCache)) {
    const r = state.trendsCache[url];
    if (r && r.from <= dateKey && dateKey <= r.to) delete state.trendsCache[url];
  }
  // Sprint summaries are server-invalidated via the entry PUT; drop our cache so the
  // next trends view refetches.
  state.sprintSummaries = null;
}

export function invalidateTrendsAll() {
  state.trendsCache = {};
  state.sprintSummaries = null;
}

// ── load() / render() ─────────────────────────────────────────────────

export function load() {
  // Cloud-only: nothing to seed locally. The boot sync populates everything.
  state.entriesByDate = {};
  state.sprintsById = {};
  state._loadedEntryDates = new Set();
  state._loadedSprintIds = new Set();
  state.currentSprintId = null;
  state.sprintSummaries = null;
  state.trendsCache = {};
  state.viewDate = todayKey();
  state._dirtySprintIds = {};
  state._dirtyEntryDates = {};
  state._deletedEntryDates = [];
  state.trendsMode = 'sprint';
  state.trendsStep = 0;
  state.trendsSprintId = null;
  state.addHabitDraft = null;
  state.textModal = null;
  state.actionMenu = null;
}

export function render() {
  if (!state.cloudReady) {
    document.body.style.overflow = '';
    document.getElementById('app').innerHTML = `
      <div class="shell">
        <div class="card boot-card">
          <div class="mono muted">GOOD HABIT TRACKER</div>
          <div class="boot-headline">Connecting to cloud data…</div>
          <div class="muted boot-sub">This app is cloud-first and does not use local storage.</div>
        </div>
      </div>`;
    return;
  }
  const info = sprintInfo();
  // Sync state pill: hidden when healthy, "SYNCING…" muted while in flight,
  // "SYNC FAILED" in danger red on error.
  const syncPill =
    syncStatus === 'error'
      ? '<div class="pill mono app-sync-pill app-sync-error">SYNC FAILED</div>'
      : syncStatus === 'syncing'
        ? '<div class="pill mono app-sync-pill">SYNCING…</div>'
        : '';
  // Header summary: small mono caption on the right side of the title bar.
  // Mirrors the per-tab Entry context but is always visible across tabs.
  const headerSummary = !info.cur
    ? 'NO SPRINT'
    : !info.cur.startDate
      ? 'PLANNING'
      : `DAY ${info.day}/${info.length}`;
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <header class="app-header">
        <h1 class="app-title">Good Habit Tracker</h1>
        <div class="app-header-meta">
          <div class="mono muted app-header-status">${headerSummary}</div>
          ${syncPill}
        </div>
      </header>
      ${state.tab === 'entry' ? renderEntry() : state.tab === 'trends' ? renderTrends() : renderPlan()}
    </div>
    <nav class="tabs" aria-label="Main">
      <button class="tab ${state.tab === 'entry' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'entry'}" data-action="tab" data-tab="entry">ENTRIES</button>
      <button class="tab ${state.tab === 'trends' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'trends'}" data-action="tab" data-tab="trends">BURNDOWN</button>
      <button class="tab ${state.tab === 'plan' ? 'active' : ''}" role="tab" aria-selected="${state.tab === 'plan'}" data-action="tab" data-tab="plan">PLAN</button>
    </nav>
    ${state.addHabitDraft ? renderAddHabitModal() : ''}
    ${state.textModal ? renderTextModal() : ''}
    ${state.actionMenu ? renderActionMenuModal() : ''}`;
  document.body.style.overflow = state.addHabitDraft || state.textModal || state.actionMenu ? 'hidden' : '';
}
