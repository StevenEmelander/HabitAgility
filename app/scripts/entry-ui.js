import {
  addDaysKey,
  categoryMax,
  categoryPoints,
  escapeHtml,
  fmtPointsForStep,
  getCurrentCycle,
  getCycleById,
  getEntry,
  habitsForCategory,
  pointStep,
  state,
  todayKey,
  totalMax,
  totalPoints,
  viewDayKey,
} from './core.js';

export function renderEntry() {
  const dk = viewDayKey();
  const t = todayKey();
  const e = getEntry(dk);
  const c = getCycleById(e.cycleId) || getCurrentCycle();
  const step = pointStep(c);
  const pts = totalPoints(e, c);
  const max = totalMax(c);
  const categories = (c && c.categories ? c.categories : []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const isCurrentDay = dk === t;
  const canNext = addDaysKey(dk, 1) <= t;
  const dateLine = isCurrentDay
    ? 'TODAY'
    : new Date(dk + 'T12:00:00').toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).toUpperCase();
  const loaded = state._loadedEntryDates.has(dk);
  return `
    <div class="card">
      <div class="row between" style="flex-wrap:wrap;gap:8px;align-items:center">
        <button class="btn" type="button" data-action="day-prev" aria-label="Previous day">←</button>
        <div class="col center" style="flex:1;min-width:0">
          <div class="mono" style="font-size:14px;margin-top:2px">${dateLine}${loaded ? '' : ' · LOADING…'}</div>
        </div>
        <button class="btn" type="button" data-action="day-next" ${canNext ? '' : 'disabled'} aria-label="Next day">→</button>
      </div>
      <div class="row between" style="margin-top:12px"><div class="stat">${fmtPointsForStep(pts, step)}</div><div class="mono muted">/ ${fmtPointsForStep(max, step)}</div></div>
      <div class="progress" style="margin-top:8px"><div class="fill" style="width:${max ? (pts / max) * 100 : 0}%"></div></div>
    </div>
    ${!c ? `<div class="card"><div class="muted" style="font-size:14px;line-height:1.45">No cycle covers this date.</div></div>`
      : categories.length === 0
        ? `<div class="card"><div class="muted" style="font-size:14px;line-height:1.45">No habits yet. Open <strong>PLAN</strong>, add categories, then add habits and point rules.</div></div>`
        : categories.map(cat => renderEntryCategory(c, e, cat, step)).join('')}
  `;
}

function renderEntryCategory(c, e, cat, step) {
  const habits = habitsForCategory(c, cat.id);
  const accent = cat.accent || '#d4a574';
  return `
    <div class="card">
      <div class="row between"><div class="mono" style="color:${accent}">${escapeHtml(cat.label)}</div><div class="mono muted">${fmtPointsForStep(categoryPoints(e, c, cat.id), step)} / ${fmtPointsForStep(categoryMax(c, cat.id), step)}</div></div>
      <div class="col" style="margin-top:8px">${habits.map(h => renderEntryHabit(h, e, accent, step)).join('')}</div>
    </div>`;
}

function renderEntryHabit(h, e, accent, step) {
  const v = (e.habitValuesById || {})[h.id];
  if (h.kind === 'boolean') {
    const on = !!v;
    const pts = fmtPointsForStep(h.scoring.points || 0, step);
    return `<button class="card2 row between habit" data-action="toggle-habit" data-id="${h.id}"><div>${escapeHtml(h.label)}</div><div class="mono" style="color:${on ? accent : 'var(--muted)'}">${on ? '● +' + pts : '○ +' + pts}</div></button>`;
  }
  const n = Number(v || 0), maxUnits = h.scoring.maxUnits || 0, ppu = h.scoring.pointsPerUnit || 0;
  return `<div class="card2">
    <div class="row between"><div>${escapeHtml(h.label)}</div><div class="mono" style="color:${accent}">+${fmtPointsForStep(Math.min(n, maxUnits) * ppu, step)} / ${fmtPointsForStep(maxUnits * ppu, step)}</div></div>
    <div class="counter"><button class="btn" data-action="counter-habit" data-id="${h.id}" data-delta="-1">−</button><div class="mono center">${n} / ${maxUnits}</div><button class="btn" data-action="counter-habit" data-id="${h.id}" data-delta="1">+</button></div>
  </div>`;
}
