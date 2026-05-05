import {
  addDaysKey,
  API_TREND,
  clone,
  cycleInfo,
  getCurrentCycle,
  getCycleById,
  getEntry,
  hasAnyEntries,
  habitById,
  invalidateTrendsAll,
  invalidateTrendsForDate,
  isCurrentCycleFirstDay,
  POINT_STEPS,
  pointStep,
  pushCycle,
  pushEntry,
  putEntry,
  quantize,
  render,
  showToast,
  state,
  todayKey,
  uid,
  viewDayKey,
} from './core.js';
import {
  bootSync,
  createCycle,
  loadCycle,
  loadCycleSummaries,
  loadEntry,
  loadTrendUrl,
} from './sync.js';

function todayYearMonth() {
  const t = todayKey();
  return t.slice(0, 7); // yyyy-mm
}
function todayYear() { return new Date().getFullYear(); }
function offsetMonth(yyyymm, delta) {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Load the right data for whatever's currently in state.tab + state.trendsMode. */
async function ensureViewLoaded() {
  if (state.tab === 'entry') {
    await loadEntry(viewDayKey());
    return;
  }
  if (state.tab === 'plan') {
    await ensurePlanCycleLoaded();
    return;
  }
  if (state.tab === 'trends') {
    if (state.trendsMode === 'cycle') {
      const id = state.trendsCycleId || state.currentCycleId;
      if (id != null) {
        state.trendsCycleId = id;
        await loadTrendUrl(`${API_TREND}/cycle/${encodeURIComponent(id)}`);
        await loadCycle(id); // for label/header info
      }
    } else if (state.trendsMode === 'month') {
      const yyyymm = state.trendsMonth || todayYearMonth();
      state.trendsMonth = yyyymm;
      await loadTrendUrl(`${API_TREND}/month/${encodeURIComponent(yyyymm)}`);
    } else {
      // year + all-time both use the cycle-summary endpoint
      await loadCycleSummaries();
      if (state.trendsMode === 'year' && state.trendsYear == null) state.trendsYear = todayYear();
    }
  }
}

async function ensurePlanCycleLoaded() {
  if (state.planMode === 'current') {
    await loadCycle(state.currentCycleId);
    return;
  }
  // Next mode: load currentId+1, or create it from current.
  const nextId = state.currentCycleId + 1;
  let next = await loadCycle(nextId);
  if (next) return;
  const cur = getCurrentCycle();
  if (!cur) return;
  const nextStart = addDaysKey(cur.endDate, 1);
  await createCycle({
    startDate: nextStart,
    endDate: addDaysKey(nextStart, cur.lengthDays - 1),
    lengthDays: cur.lengthDays,
    pointStep: cur.pointStep,
    categories: clone(cur.categories || []),
    habitDefinitions: clone(cur.habitDefinitions || []),
  });
}

function getPlanModeCycle() {
  if (state.planMode === 'current') return getCurrentCycle();
  return getCycleById(state.currentCycleId + 1);
}

function ensureLoadedThenRender() {
  ensureViewLoaded().then(() => render()).catch(() => { showToast('Could not load'); render(); });
}

export function setupHandlers() {
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const id = t.dataset.id;
    const delta = parseFloat(t.dataset.delta || '0');

    if (action === 'habit-add-backdrop') {
      if (e.target.closest('.plan-modal-alert')) return;
      state.addHabitDraft = null;
      document.body.style.overflow = '';
      render();
      return;
    }
    if (action === 'retry-sync') { bootSync(); return; }
    if (!state.cloudReady) return;

    if (action === 'tab') {
      state.tab = t.dataset.tab;
      if (state.tab !== 'plan') state.addHabitDraft = null;
      if (state.tab === 'plan' && hasAnyEntries() && !isCurrentCycleFirstDay()) {
        state.planMode = 'next';
      }
      render();
      ensureLoadedThenRender();
      return;
    }
    if (action === 'trends-mode') {
      const m = t.dataset.mode;
      if (m === 'cycle' || m === 'month' || m === 'year' || m === 'all') {
        state.trendsMode = m;
        if (m === 'cycle') state.trendsCycleId = state.currentCycleId;
        if (m === 'month') state.trendsMonth = todayYearMonth();
        if (m === 'year') state.trendsYear = todayYear();
        render();
        ensureLoadedThenRender();
      }
      return;
    }
    if (action === 'trends-prev') {
      if (state.trendsMode === 'cycle' && state.trendsCycleId > 1) {
        state.trendsCycleId -= 1;
      } else if (state.trendsMode === 'month') {
        state.trendsMonth = offsetMonth(state.trendsMonth || todayYearMonth(), -1);
      } else if (state.trendsMode === 'year') {
        state.trendsYear = (state.trendsYear || todayYear()) - 1;
      } else {
        return;
      }
      render();
      ensureLoadedThenRender();
      return;
    }
    if (action === 'trends-next') {
      if (state.trendsMode === 'cycle') {
        state.trendsCycleId = (state.trendsCycleId || state.currentCycleId) + 1;
      } else if (state.trendsMode === 'month') {
        state.trendsMonth = offsetMonth(state.trendsMonth || todayYearMonth(), 1);
      } else if (state.trendsMode === 'year') {
        state.trendsYear = (state.trendsYear || todayYear()) + 1;
      } else {
        return;
      }
      render();
      ensureLoadedThenRender();
      return;
    }
    if (action === 'day-prev') {
      const dk = viewDayKey();
      state.viewDate = addDaysKey(dk, -1);
      render();
      loadEntry(state.viewDate).then(() => render()).catch(() => render());
      return;
    }
    if (action === 'day-next') {
      const n = addDaysKey(viewDayKey(), 1);
      if (n <= todayKey()) {
        state.viewDate = n;
        render();
        loadEntry(state.viewDate).then(() => render()).catch(() => render());
      }
      return;
    }
    if (action === 'day-today') {
      state.viewDate = todayKey();
      render();
      loadEntry(state.viewDate).then(() => render()).catch(() => render());
      return;
    }
    if (action === 'plan-mode') {
      if (!hasAnyEntries()) { state.planMode = 'current'; render(); return; }
      state.planMode = t.dataset.mode;
      render();
      ensureLoadedThenRender();
      return;
    }
    if (action === 'habit-add-cancel') { state.addHabitDraft = null; document.body.style.overflow = ''; render(); return; }
    if (action === 'habit-add-kind') {
      const d = state.addHabitDraft;
      if (!d) return;
      const k = t.getAttribute('data-kind');
      if (k !== 'boolean' && k !== 'count') return;
      d.kind = k;
      render();
      return;
    }
    if (action === 'habit-add-ok') {
      const d = state.addHabitDraft;
      if (!d) return;
      const inp = document.getElementById('plan-new-habit-input');
      const label = inp && inp.value.trim();
      if (!label) { showToast('Enter a name'); return; }
      const kind = d.kind === 'count' ? 'count' : 'boolean';
      const cPlan = getPlanModeCycle();
      if (!cPlan) { showToast('Cycle not loaded'); return; }
      if (!Array.isArray(cPlan.habitDefinitions)) cPlan.habitDefinitions = [];
      cPlan.habitDefinitions.push({
        id: uid('habit'),
        categoryId: d.categoryId,
        label,
        kind,
        scoring: kind === 'count' ? { pointsPerUnit: 1, maxUnits: 4 } : { points: 1 },
      });
      state.addHabitDraft = null;
      document.body.style.overflow = '';
      pushCycle(cPlan.id);
      render();
      return;
    }

    // Entry-tab habit interactions use the cycle from the displayed entry.
    const dk = viewDayKey();
    const entry = getEntry(dk);
    const curCycle = getCycleById(entry.cycleId) || getCurrentCycle();
    const entryHabit = habitById(curCycle, id);
    if (action === 'toggle-habit' && entryHabit && entryHabit.kind === 'boolean') {
      const e = { habitValuesById: { ...(entry.habitValuesById || {}) }, cycleId: entry.cycleId };
      e.habitValuesById[id] = !e.habitValuesById[id];
      putEntry(dk, e);
      pushEntry(dk);
      invalidateTrendsForDate(dk);
      render();
      return;
    }
    if (action === 'counter-habit' && entryHabit && entryHabit.kind === 'count') {
      const e = { habitValuesById: { ...(entry.habitValuesById || {}) }, cycleId: entry.cycleId };
      const cur = Number(e.habitValuesById[id] || 0);
      e.habitValuesById[id] = Math.max(0, Math.min(cur + delta, entryHabit.scoring.maxUnits || 0));
      putEntry(dk, e);
      pushEntry(dk);
      invalidateTrendsForDate(dk);
      render();
      return;
    }

    // Plan-tab cycle edits.
    const cycle = getPlanModeCycle();
    if (!cycle) return;

    if (action === 'point-step') {
      const next = parseFloat(t.dataset.step || '0');
      if (!POINT_STEPS.includes(next)) return;
      cycle.pointStep = next;
      for (const h of (cycle.habitDefinitions || [])) {
        if (!h || !h.scoring) continue;
        if (h.kind === 'boolean' && typeof h.scoring.points === 'number') {
          h.scoring.points = quantize(Math.round(h.scoring.points / next) * next);
        }
        if (h.kind === 'count' && typeof h.scoring.pointsPerUnit === 'number') {
          h.scoring.pointsPerUnit = quantize(Math.round(h.scoring.pointsPerUnit / next) * next);
        }
      }
      pushCycle(cycle.id);
      invalidateTrendsAll();
      render();
      return;
    }
    if (action === 'cycle-len') {
      cycle.lengthDays = Math.max(7, cycle.lengthDays + delta);
      cycle.endDate = addDaysKey(cycle.startDate, cycle.lengthDays - 1);
      pushCycle(cycle.id);
      invalidateTrendsAll();
      // If editing the current cycle, the upcoming cycle's start shifts too — refetch lazily.
      render();
      return;
    }
    if (action === 'add-category') {
      const label = prompt('New category name'); if (!label) return;
      const up = label.trim().toUpperCase();
      if (cycle.categories.some(c => c.label === up)) { showToast('Category exists'); return; }
      cycle.categories.push({ id: uid('cat'), label: up, sortOrder: cycle.categories.length + 1, accent: '#d4a574' });
      pushCycle(cycle.id); render(); return;
    }
    if (action === 'rename-category') {
      const c = cycle.categories.find(x => x.id === id); if (!c) return;
      const next = prompt('Category name', c.label); if (!next) return;
      c.label = next.trim().toUpperCase();
      pushCycle(cycle.id); render(); return;
    }
    if (action === 'remove-category') {
      if (cycle.habitDefinitions.some(h => h.categoryId === id)) { showToast('Remove habits first'); return; }
      cycle.categories = cycle.categories.filter(c => c.id !== id);
      pushCycle(cycle.id); render(); return;
    }
    if (action === 'add-habit') {
      state.addHabitDraft = { categoryId: id, kind: 'boolean' };
      render();
      const inp = document.getElementById('plan-new-habit-input');
      if (inp) { inp.focus(); try { inp.select(); } catch (_) {} }
      return;
    }
    if (action === 'remove-habit') {
      cycle.habitDefinitions = cycle.habitDefinitions.filter(h => h.id !== id);
      pushCycle(cycle.id); invalidateTrendsAll(); render(); return;
    }
    if (action === 'rename-habit') {
      const h = cycle.habitDefinitions.find(x => x.id === id); if (!h) return;
      const next = prompt('Habit label', h.label); if (!next) return;
      h.label = next.trim();
      pushCycle(cycle.id); render(); return;
    }
    if (action === 'switch-kind') {
      const h = cycle.habitDefinitions.find(x => x.id === id); if (!h) return;
      if (h.kind === 'boolean') {
        h.kind = 'count';
        h.scoring = { pointsPerUnit: Math.max(1, h.scoring.points || 1), maxUnits: 4 };
      } else {
        h.kind = 'boolean';
        h.scoring = { points: Math.max(1, h.scoring.pointsPerUnit || 1) };
      }
      pushCycle(cycle.id); invalidateTrendsAll(); render(); return;
    }
    if (action === 'score-edit') {
      const h = cycle.habitDefinitions.find(x => x.id === id); if (!h) return;
      const f = t.dataset.field;
      if (h.kind === 'boolean' && f === 'points') h.scoring.points = quantize(Math.max(0, (h.scoring.points || 0) + delta));
      if (h.kind === 'count' && f === 'pointsPerUnit') h.scoring.pointsPerUnit = quantize(Math.max(0, (h.scoring.pointsPerUnit || 0) + delta));
      if (h.kind === 'count' && f === 'maxUnits') h.scoring.maxUnits = Math.max(0, Math.round((h.scoring.maxUnits || 0) + delta));
      pushCycle(cycle.id); invalidateTrendsAll(); render(); return;
    }
  });
}
