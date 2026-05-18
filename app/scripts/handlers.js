/**
 * Click-action dispatch for the whole app. One delegated `click` listener on
 * `document.body`; data-action attribute selects the handler.
 *
 * Handlers are grouped into action maps by tab (entry / plan / trends) plus a
 * `globalActions` map for tab-switching, retry, and modal chrome.
 *
 * Helpers that mutate state but don't directly correspond to a click action live at
 * the top of this file (date math, ensure-loaded plumbing, plan-mode sprint resolver).
 */

import { API_TREND } from './constants.js';
import {
  POINT_STEPS,
  addDaysKey,
  clone,
  getCurrentSprint,
  getEntry,
  getSprintById,
  habitById,
  hasAnyEntries,
  invalidateTrendsAll,
  invalidateTrendsForDate,
  isCurrentSprintFirstDay,
  pushEntry,
  pushSprint,
  putEntry,
  quantize,
  render,
  showToast,
  state,
  todayKey,
  uid,
  viewDayKey,
} from './core.js';
import { bootSync, createSprint, loadEntry, loadSprint, loadSprintSummaries, loadTrendUrl } from './sync.js';

// ── Date helpers ──────────────────────────────────────────────────────

function todayYearMonth() {
  return todayKey().slice(0, 7);
}
function todayYear() {
  return new Date().getFullYear();
}

function offsetMonth(yyyymm, delta) {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── View / data loading ───────────────────────────────────────────────

/** Load the right data for whatever's currently in state.tab + state.trendsMode. */
async function ensureViewLoaded() {
  if (state.tab === 'entry') {
    await loadEntry(viewDayKey());
    return;
  }
  if (state.tab === 'plan') {
    await ensurePlanSprintLoaded();
    return;
  }
  if (state.tab === 'trends') {
    if (state.trendsMode === 'sprint') {
      const id = state.trendsSprintId || state.currentSprintId;
      if (id != null) {
        state.trendsSprintId = id;
        await loadTrendUrl(`${API_TREND}/sprint/${encodeURIComponent(id)}`);
        await loadSprint(id);
      }
    } else if (state.trendsMode === 'month') {
      const yyyymm = state.trendsMonth || todayYearMonth();
      state.trendsMonth = yyyymm;
      await loadTrendUrl(`${API_TREND}/month/${encodeURIComponent(yyyymm)}`);
    } else {
      // year + all-time both use the sprint-summary endpoint.
      await loadSprintSummaries();
      if (state.trendsMode === 'year' && state.trendsYear == null) state.trendsYear = todayYear();
    }
  }
}

function ensureLoadedThenRender() {
  ensureViewLoaded()
    .then(() => render())
    .catch(() => {
      showToast('Could not load');
      render();
    });
}

async function ensurePlanSprintLoaded() {
  if (state.planMode === 'current') {
    await loadSprint(state.currentSprintId);
    return;
  }
  // Next mode: load currentId+1, or create it from current.
  const nextId = state.currentSprintId + 1;
  if (await loadSprint(nextId)) return;
  const cur = getCurrentSprint();
  if (!cur) return;
  const nextStart = addDaysKey(cur.endDate, 1);
  await createSprint({
    startDate: nextStart,
    endDate: addDaysKey(nextStart, cur.lengthDays - 1),
    lengthDays: cur.lengthDays,
    pointStep: cur.pointStep,
    goalPoints: cur.goalPoints,
    categories: clone(cur.categories || []),
    habitDefinitions: clone(cur.habitDefinitions || []),
  });
}

function getPlanModeSprint() {
  if (state.planMode === 'current') return getCurrentSprint();
  return getSprintById(state.currentSprintId + 1);
}

// ── Action handlers ───────────────────────────────────────────────────
// Each handler receives a context object: { target, action, id, delta }.
// `target` = the matched element with data-action; `id`/`delta` are pre-parsed.

/** Actions that need to fire even when cloud isn't ready (modal close, retry). */
const preBootActions = {
  'habit-add-backdrop': ({ event }) => {
    if (event.target.closest('.plan-modal-alert')) return;
    state.addHabitDraft = null;
    document.body.style.overflow = '';
    render();
  },
  'retry-sync': () => {
    bootSync();
  },
};

/** Tab-switching, modal chrome — run after cloud is ready. */
const globalActions = {
  tab: ({ target }) => {
    state.tab = target.dataset.tab;
    if (state.tab !== 'plan') state.addHabitDraft = null;
    if (state.tab === 'plan' && hasAnyEntries() && !isCurrentSprintFirstDay()) {
      state.planMode = 'next';
    }
    render();
    ensureLoadedThenRender();
  },
  'habit-add-cancel': () => {
    state.addHabitDraft = null;
    document.body.style.overflow = '';
    render();
  },
  'habit-add-kind': ({ target }) => {
    const d = state.addHabitDraft;
    if (!d) return;
    const k = target.getAttribute('data-kind');
    if (k !== 'boolean' && k !== 'count') return;
    d.kind = k;
    render();
  },
  'habit-add-ok': () => {
    const d = state.addHabitDraft;
    if (!d) return;
    const inp = document.getElementById('plan-new-habit-input');
    const label = inp?.value.trim();
    if (!label) {
      showToast('Enter a name');
      return;
    }
    const kind = d.kind === 'count' ? 'count' : 'boolean';
    const sPlan = getPlanModeSprint();
    if (!sPlan) {
      showToast('Sprint not loaded');
      return;
    }
    if (!Array.isArray(sPlan.habitDefinitions)) sPlan.habitDefinitions = [];
    sPlan.habitDefinitions.push({
      id: uid('habit'),
      categoryId: d.categoryId,
      label,
      kind,
      scoring: kind === 'count' ? { pointsPerUnit: 1, dailyLimit: 4 } : { points: 1 },
    });
    state.addHabitDraft = null;
    document.body.style.overflow = '';
    pushSprint(sPlan.id);
    render();
  },
};

// ── Entry-tab actions ─────────────────────────────────────────────────

const entryActions = {
  'day-prev': () => {
    state.viewDate = addDaysKey(viewDayKey(), -1);
    render();
    loadEntry(state.viewDate)
      .then(() => render())
      .catch(() => render());
  },
  'day-next': () => {
    const n = addDaysKey(viewDayKey(), 1);
    if (n > todayKey()) return;
    state.viewDate = n;
    render();
    loadEntry(state.viewDate)
      .then(() => render())
      .catch(() => render());
  },
  'day-today': () => {
    state.viewDate = todayKey();
    render();
    loadEntry(state.viewDate)
      .then(() => render())
      .catch(() => render());
  },
  'toggle-habit': ({ id }) => {
    const habit = entryHabitFor(id);
    if (!habit || habit.kind !== 'boolean') return;
    const dk = viewDayKey();
    const entry = getEntry(dk);
    const e = { habitValuesById: { ...(entry.habitValuesById || {}) }, sprintId: entry.sprintId };
    e.habitValuesById[id] = !e.habitValuesById[id];
    putEntry(dk, e);
    pushEntry(dk);
    invalidateTrendsForDate(dk);
    render();
  },
  'counter-habit': ({ id, delta }) => {
    const habit = entryHabitFor(id);
    if (!habit || habit.kind !== 'count') return;
    const dk = viewDayKey();
    const entry = getEntry(dk);
    const e = { habitValuesById: { ...(entry.habitValuesById || {}) }, sprintId: entry.sprintId };
    const cur = Number(e.habitValuesById[id] || 0);
    const limit = Number(habit.scoring.dailyLimit) || 0;
    const next = cur + delta;
    // dailyLimit = 0 → unlimited.
    e.habitValuesById[id] = limit > 0 ? Math.max(0, Math.min(next, limit)) : Math.max(0, next);
    putEntry(dk, e);
    pushEntry(dk);
    invalidateTrendsForDate(dk);
    render();
  },
};

function entryHabitFor(habitId) {
  const dk = viewDayKey();
  const entry = getEntry(dk);
  const sprint = getSprintById(entry.sprintId) || getCurrentSprint();
  return habitById(sprint, habitId);
}

// ── Trends-tab actions ────────────────────────────────────────────────

const trendsActions = {
  'trends-mode': ({ target }) => {
    const m = target.dataset.mode;
    if (!['sprint', 'month', 'year', 'all'].includes(m)) return;
    state.trendsMode = m;
    if (m === 'sprint') state.trendsSprintId = state.currentSprintId;
    if (m === 'month') state.trendsMonth = todayYearMonth();
    if (m === 'year') state.trendsYear = todayYear();
    render();
    ensureLoadedThenRender();
  },
  'trends-prev': () => {
    if (state.trendsMode === 'sprint' && state.trendsSprintId > 1) {
      state.trendsSprintId -= 1;
    } else if (state.trendsMode === 'month') {
      state.trendsMonth = offsetMonth(state.trendsMonth || todayYearMonth(), -1);
    } else if (state.trendsMode === 'year') {
      state.trendsYear = (state.trendsYear || todayYear()) - 1;
    } else {
      return;
    }
    render();
    ensureLoadedThenRender();
  },
  'trends-next': () => {
    if (state.trendsMode === 'sprint') {
      state.trendsSprintId = (state.trendsSprintId || state.currentSprintId) + 1;
    } else if (state.trendsMode === 'month') {
      state.trendsMonth = offsetMonth(state.trendsMonth || todayYearMonth(), 1);
    } else if (state.trendsMode === 'year') {
      state.trendsYear = (state.trendsYear || todayYear()) + 1;
    } else {
      return;
    }
    render();
    ensureLoadedThenRender();
  },
};

// ── Plan-tab actions (operate on the plan-mode sprint) ───────────────

const planActions = {
  'plan-mode': ({ target }) => {
    if (!hasAnyEntries()) {
      state.planMode = 'current';
      render();
      return;
    }
    state.planMode = target.dataset.mode;
    render();
    ensureLoadedThenRender();
  },
  'point-step': ({ target }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const next = Number.parseFloat(target.dataset.step || '0');
    if (!POINT_STEPS.includes(next)) return;
    sprint.pointStep = next;
    for (const h of sprint.habitDefinitions || []) {
      if (!h || !h.scoring) continue;
      if (h.kind === 'boolean' && typeof h.scoring.points === 'number') {
        h.scoring.points = quantize(Math.round(h.scoring.points / next) * next);
      }
      if (h.kind === 'count' && typeof h.scoring.pointsPerUnit === 'number') {
        h.scoring.pointsPerUnit = quantize(Math.round(h.scoring.pointsPerUnit / next) * next);
      }
    }
    if (typeof sprint.goalPoints === 'number') {
      sprint.goalPoints = quantize(Math.round(sprint.goalPoints / next) * next);
    }
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
  'goal-step': ({ delta }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const step = typeof sprint.pointStep === 'number' && sprint.pointStep > 0 ? sprint.pointStep : 1;
    const cur = Number(sprint.goalPoints) || 0;
    sprint.goalPoints = quantize(Math.max(0, cur + delta * step));
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
  'sprint-len': ({ delta }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    sprint.lengthDays = Math.max(7, sprint.lengthDays + delta);
    sprint.endDate = addDaysKey(sprint.startDate, sprint.lengthDays - 1);
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
  'add-category': () => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const label = prompt('New category name');
    if (!label) return;
    const up = label.trim().toUpperCase();
    if (sprint.categories.some((c) => c.label === up)) {
      showToast('Category exists');
      return;
    }
    sprint.categories.push({
      id: uid('cat'),
      label: up,
      sortOrder: sprint.categories.length + 1,
      accent: '#d4a574',
    });
    pushSprint(sprint.id);
    render();
  },
  'rename-category': ({ id }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const c = sprint.categories.find((x) => x.id === id);
    if (!c) return;
    const next = prompt('Category name', c.label);
    if (!next) return;
    c.label = next.trim().toUpperCase();
    pushSprint(sprint.id);
    render();
  },
  'remove-category': ({ id }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    if (sprint.habitDefinitions.some((h) => h.categoryId === id)) {
      showToast('Remove habits first');
      return;
    }
    sprint.categories = sprint.categories.filter((c) => c.id !== id);
    pushSprint(sprint.id);
    render();
  },
  'add-habit': ({ id }) => {
    state.addHabitDraft = { categoryId: id, kind: 'boolean' };
    render();
    const inp = document.getElementById('plan-new-habit-input');
    if (inp) {
      inp.focus();
      try {
        inp.select();
      } catch (_) {}
    }
  },
  'remove-habit': ({ id }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    sprint.habitDefinitions = sprint.habitDefinitions.filter((h) => h.id !== id);
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
  'rename-habit': ({ id }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const h = sprint.habitDefinitions.find((x) => x.id === id);
    if (!h) return;
    const next = prompt('Habit label', h.label);
    if (!next) return;
    h.label = next.trim();
    pushSprint(sprint.id);
    render();
  },
  'switch-kind': ({ id }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const h = sprint.habitDefinitions.find((x) => x.id === id);
    if (!h) return;
    if (h.kind === 'boolean') {
      h.kind = 'count';
      h.scoring = { pointsPerUnit: Math.max(1, h.scoring.points || 1), dailyLimit: 4 };
    } else {
      h.kind = 'boolean';
      h.scoring = { points: Math.max(1, h.scoring.pointsPerUnit || 1) };
    }
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
  'score-edit': ({ target, id, delta }) => {
    const sprint = getPlanModeSprint();
    if (!sprint) return;
    const h = sprint.habitDefinitions.find((x) => x.id === id);
    if (!h) return;
    const f = target.dataset.field;
    if (h.kind === 'boolean' && f === 'points') {
      h.scoring.points = quantize(Math.max(0, (h.scoring.points || 0) + delta));
    } else if (h.kind === 'count' && f === 'pointsPerUnit') {
      h.scoring.pointsPerUnit = quantize(Math.max(0, (h.scoring.pointsPerUnit || 0) + delta));
    } else if (h.kind === 'count' && f === 'dailyLimit') {
      h.scoring.dailyLimit = Math.max(0, Math.round((h.scoring.dailyLimit || 0) + delta));
    } else {
      return;
    }
    pushSprint(sprint.id);
    invalidateTrendsAll();
    render();
  },
};

// ── Dispatch ──────────────────────────────────────────────────────────

/** Lookup order: pre-boot → global → entry → trends → plan. */
function findHandler(action) {
  return (
    preBootActions[action] ??
    globalActions[action] ??
    entryActions[action] ??
    trendsActions[action] ??
    planActions[action]
  );
}

export function setupHandlers() {
  document.body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const handler = findHandler(action);
    if (!handler) return;

    // Pre-boot handlers run unconditionally.
    if (preBootActions[action]) {
      preBootActions[action]({ event, target, action });
      return;
    }
    // Everything else gates on cloud being ready.
    if (!state.cloudReady) return;

    const ctx = {
      event,
      target,
      action,
      id: target.dataset.id,
      delta: Number.parseFloat(target.dataset.delta || '0'),
    };
    handler(ctx);
  });
}
