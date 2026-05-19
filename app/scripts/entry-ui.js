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
  isSprintInPlanning,
  pointStep,
  state,
  todayKey,
  totalPoints,
  viewDayKey,
} from './core.js';

/**
 * Day-in-sprint for a specific viewed date.
 *   Planning sprint (no startDate) → null (caller renders a "—" or skips).
 *   Started sprint, dateKey >= startDate → 1-based day index.
 *   Started sprint, dateKey < startDate → 0 (pre-start; rare).
 */
function dayInSprint(sprint, dateKey) {
  if (!sprint?.startDate) return null;
  const ms = new Date(dateKey + 'T00:00:00') - new Date(sprint.startDate + 'T00:00:00');
  return Math.max(0, Math.floor(ms / 86400000) + 1);
}

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

  // Sprint context line: name (if set) + day-in-sprint or planning badge.
  // Only render when we have meaningful context to show (name OR a real sprint).
  let sprintContext = '';
  if (s) {
    const nameSpan = s.name ? `<span class="entry-sprint-name">${escapeHtml(s.name)}</span>` : '';
    const dayBadge = isSprintInPlanning(s)
      ? '<span class="entry-day-badge entry-day-badge-planning">PLANNING</span>'
      : (() => {
          const day = dayInSprint(s, dk);
          if (day == null) return '';
          return `<span class="entry-day-badge">DAY ${day} / ${s.lengthDays}</span>`;
        })();
    if (nameSpan || dayBadge) {
      sprintContext = `<div class="entry-sprint-ctx">${nameSpan}${dayBadge}</div>`;
    }
  }

  return `
    <div class="card entry-header">
      ${sprintContext}
      <div class="entry-day-nav">
        <button class="btn entry-nav-btn" type="button" data-action="day-prev" aria-label="Previous day">←</button>
        <div class="mono entry-date-line">${dateLine}${loaded ? '' : ' · LOADING…'}</div>
        <button class="btn entry-nav-btn" type="button" data-action="day-next" ${canNext ? '' : 'disabled'} aria-label="Next day">→</button>
      </div>
      <div class="entry-stat-row">
        <div class="stat">${fmtPointsForStep(pts, step)}</div>
        <div class="mono muted entry-stat-goal">/ ${fmtPointsForStep(goal, step)}</div>
      </div>
      <div class="progress entry-progress"><div class="fill" style="width:${fillPct}%"></div></div>
    </div>
    ${
      !s
        ? `<div class="card"><div class="muted entry-empty">No sprint covers this date.</div></div>`
        : categories.length === 0
          ? `<div class="card"><div class="muted entry-empty">No habits yet. Open <strong>PLAN</strong>, add categories, then add habits and point rules.</div></div>`
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
    // On state gets a filled background using the category accent (low-alpha
    // tint) so the contrast between done / not-done reads at a glance, not
    // just from the glyph. Inline style binds the tint to the accent color
    // since accents vary per category.
    const onStyle = on
      ? `background:color-mix(in srgb, ${accent} 18%, var(--card2));border-color:${accent}`
      : '';
    return `<button class="card2 row between habit habit-bool ${on ? 'on' : ''}" style="${onStyle}" data-action="toggle-habit" data-id="${hid}" aria-pressed="${on}" aria-label="${labelText}, ${on ? 'on' : 'off'}, +${pts} points">
      <div class="habit-bool-label">${labelText}</div>
      <div class="mono habit-bool-pts" style="color:${on ? accent : 'var(--muted)'}">${on ? '✓' : '○'} +${pts}</div>
    </button>`;
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
