import {
  addDaysKey,
  categoryPoints,
  escapeHtml,
  fmtPointsForStep,
  getCurrentSprint,
  getEntry,
  getSprintById,
  goalForSprint,
  habitsForCategory,
  pointStep,
  state,
  todayKey,
  totalPoints,
  viewDayKey,
} from './core.js';

export function renderEntry() {
  const dk = viewDayKey();
  const t = todayKey();
  const e = getEntry(dk);
  const s = getSprintById(e.sprintId) || getCurrentSprint();
  const step = pointStep(s);
  const goal = goalForSprint(s);
  const pts = totalPoints(e, s);
  const categories = (s?.categories ? s.categories : [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const isCurrentDay = dk === t;
  const canNext = addDaysKey(dk, 1) <= t;
  const dateLine = isCurrentDay
    ? 'TODAY'
    : new Date(dk + 'T12:00:00')
        .toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
        .toUpperCase();
  const loaded = state._loadedEntryDates.has(dk);
  const fillPct = goal > 0 ? Math.min(100, (pts / goal) * 100) : 0;
  const sprintName = s?.name ? `<div class="entry-sprint-name">${escapeHtml(s.name)}</div>` : '';
  return `
    <div class="card">
      ${sprintName}
      <div class="row between" style="flex-wrap:wrap;gap:8px;align-items:center">
        <button class="btn" type="button" data-action="day-prev" aria-label="Previous day">←</button>
        <div class="col center" style="flex:1;min-width:0">
          <div class="mono" style="font-size:14px;margin-top:2px">${dateLine}${loaded ? '' : ' · LOADING…'}</div>
        </div>
        <button class="btn" type="button" data-action="day-next" ${canNext ? '' : 'disabled'} aria-label="Next day">→</button>
      </div>
      <div class="row between" style="margin-top:12px"><div class="stat">${fmtPointsForStep(pts, step)}</div><div class="mono muted">/ ${fmtPointsForStep(goal, step)}</div></div>
      <div class="progress" style="margin-top:8px"><div class="fill" style="width:${fillPct}%"></div></div>
    </div>
    ${
      !s
        ? `<div class="card"><div class="muted" style="font-size:14px;line-height:1.45">No sprint covers this date.</div></div>`
        : categories.length === 0
          ? `<div class="card"><div class="muted" style="font-size:14px;line-height:1.45">No habits yet. Open <strong>PLAN</strong>, add categories, then add habits and point rules.</div></div>`
          : categories.map((cat) => renderEntryCategory(s, e, cat, step)).join('')
    }
  `;
}

function renderEntryCategory(s, e, cat, step) {
  const habits = habitsForCategory(s, cat.id);
  const accent = cat.accent || '#d4a574';
  return `
    <div class="card">
      <div class="row between"><div class="mono" style="color:${accent}">${escapeHtml(cat.label)}</div><div class="mono muted">${fmtPointsForStep(categoryPoints(e, s, cat.id), step)}</div></div>
      <div class="col" style="margin-top:8px">${habits.map((h) => renderEntryHabit(h, e, accent, step)).join('')}</div>
    </div>`;
}

function renderEntryHabit(h, e, accent, step) {
  const v = e.habitValuesById?.[h.id];
  const hid = escapeHtml(h.id);
  const labelText = escapeHtml(h.label);
  if (h.kind === 'boolean') {
    const on = !!v;
    const pts = fmtPointsForStep(h.scoring.points || 0, step);
    return `<button class="card2 row between habit" data-action="toggle-habit" data-id="${hid}" aria-pressed="${on}" aria-label="${labelText}, ${on ? 'on' : 'off'}, +${pts} points"><div>${labelText}</div><div class="mono" style="color:${on ? accent : 'var(--muted)'}">${on ? '● +' + pts : '○ +' + pts}</div></button>`;
  }
  const n = Number(v || 0);
  const limit = Number(h.scoring.dailyLimit) || 0;
  const ppu = Number(h.scoring.pointsPerUnit) || 0;
  const earned = limit > 0 ? Math.min(n, limit) * ppu : n * ppu;
  // Header: "+earned" (and "/+limit·ppu" only when bounded).
  const headerPts =
    limit > 0
      ? `+${fmtPointsForStep(earned, step)} / ${fmtPointsForStep(limit * ppu, step)}`
      : `+${fmtPointsForStep(earned, step)}`;
  // Counter: "n / limit" when bounded, just "n" when unlimited.
  const counterDisplay = limit > 0 ? `${n} / ${limit}` : `${n}`;
  return `<div class="card2">
    <div class="row between"><div>${labelText}</div><div class="mono" style="color:${accent}">${headerPts}</div></div>
    <div class="counter"><button class="btn" data-action="counter-habit" data-id="${hid}" data-delta="-1" aria-label="Decrement ${labelText}">−</button><div class="mono center" aria-live="polite">${counterDisplay}</div><button class="btn" data-action="counter-habit" data-id="${hid}" data-delta="1" aria-label="Increment ${labelText}">+</button></div>
  </div>`;
}
