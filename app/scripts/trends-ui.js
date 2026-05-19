import { SPRINT_RETRO_MAX, TRENDS_CHART_MAX_POINTS } from './constants.js';
import {
  API_TREND,
  addDaysKey,
  canEditRetrospective,
  escapeHtml,
  fmtPointsForStep,
  getCurrentSprint,
  getSprintById,
  goalForSprint,
  pointStep,
  state,
  todayKey,
} from './core.js';

/**
 * Line chart with one optional reference line (still used by All-Time).
 * `refY` (numeric) = y-axis value where a dashed reference line is drawn (skip if null).
 */
function buildLineChart(data, avg, dayCeiling, refY) {
  const w = 360;
  const h = 120;
  const p = 4;
  const ceiling = Math.max(dayCeiling, refY || 0, 1, ...data.map((d) => d.pts));
  const dx = data.length > 1 ? (w - p * 2) / (data.length - 1) : 0;
  const y = (v) => p + (h - p * 2) * (1 - v / ceiling);
  const pts = data.map((d, i) => ({ x: p + i * dx, y: y(d.pts) }));
  const refLine =
    refY != null && refY > 0
      ? `<line x1="${p}" y1="${y(refY).toFixed(1)}" x2="${w - p}" y2="${y(refY).toFixed(1)}" stroke="#c79bd9" stroke-width="1.2" stroke-dasharray="4 3"/>`
      : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <line x1="${p}" y1="${y(avg).toFixed(1)}" x2="${w - p}" y2="${y(avg).toFixed(1)}" stroke="#4a4a55" stroke-dasharray="2 4"/>
    ${refLine}
    ${pts.length ? `<path d="M${pts.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' L')}" fill="none" stroke="#d4a574" stroke-width="2"></path>` : ''}
    ${pts.map((q) => `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="2" fill="#d4a574"></circle>`).join('')}
  </svg>`;
}

/**
 * Agile burndown chart.
 *
 * `actual` is a series of `{ dayNum, remaining }` points, dayNum=0 anchored at
 * the start of the sprint with remaining=totalGoal; each subsequent dayNum is
 * end-of-day with the goal reduced by cumulative earned points (clamped at 0).
 *
 * The ideal line runs from (0, totalGoal) → (lengthDays, 0): straight, dashed.
 * The actual line stays AT or ABOVE 0; sitting *below* the ideal means you're
 * ahead of pace.
 */
function buildBurndownChart(actual, totalGoal, lengthDays) {
  const w = 360;
  const h = 120;
  const p = 6;
  const ceiling = Math.max(totalGoal, actual.length ? Math.max(...actual.map((d) => d.remaining)) : 0, 1);
  const dxPerDay = (w - p * 2) / Math.max(1, lengthDays);
  const x = (d) => p + d * dxPerDay;
  const y = (v) => p + (h - p * 2) * (1 - v / ceiling);

  const idealLine = `<line x1="${x(0).toFixed(1)}" y1="${y(totalGoal).toFixed(1)}" x2="${x(lengthDays).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#c79bd9" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  const zeroLine = `<line x1="${p}" y1="${y(0).toFixed(1)}" x2="${w - p}" y2="${y(0).toFixed(1)}" stroke="#4a4a55" stroke-width="0.6" stroke-dasharray="2 4"/>`;

  const pts = actual.map((d) => ({ x: x(d.dayNum), y: y(d.remaining) }));
  const path =
    pts.length > 1
      ? `<path d="M${pts.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' L')}" fill="none" stroke="#d4a574" stroke-width="2"/>`
      : '';
  const dots = pts
    .map((q) => `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="2" fill="#d4a574"/>`)
    .join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    ${zeroLine}
    ${idealLine}
    ${path}
    ${dots}
  </svg>`;
}

/** Downsample a buckets array (server-supplied) to at most maxPts chart points. */
function downsample(buckets, maxPts) {
  const cap = maxPts || TRENDS_CHART_MAX_POINTS;
  if (buckets.length <= cap) return buckets.slice();
  const bucket = Math.ceil(buckets.length / cap);
  const out = [];
  for (let i = 0; i < buckets.length; i += bucket) {
    const slice = buckets.slice(i, i + bucket);
    const ptsSum = slice.reduce((s, b) => s + (b.pts || 0), 0);
    const goalSum = slice.reduce((s, b) => s + (b.goal || 0), 0);
    const daysSum = slice.reduce((s, b) => s + (b.days || 1), 0);
    out.push({ key: slice[0].key, pts: ptsSum, goal: goalSum, days: daysSum });
  }
  return out;
}

// ── Sprint Overview ──────────────────────────────────────────────────

/**
 * Build the actual burndown series for one sprint. Walks each day from
 * sprint.startDate up to min(sprint.endDate, today), folding bucket points
 * into a cumulative total; pushes `{ dayNum, remaining }` after each day.
 *
 * dayNum=0 → start of sprint, remaining=totalGoal (no work done).
 * dayNum=k → end of day k, remaining=max(0, totalGoal - cumEarnedThroughDayK).
 */
function buildBurndownSeries(sprint, buckets, totalGoal) {
  const today = todayKey();
  const series = [];
  if (sprint.startDate > today) return series; // upcoming — no actual data
  const lastDay = sprint.endDate < today ? sprint.endDate : today;
  const ptsByDate = new Map(buckets.map((b) => [b.key, b.pts || 0]));
  series.push({ dayNum: 0, remaining: totalGoal });
  let cum = 0;
  let cur = sprint.startDate;
  let dayIdx = 1;
  while (cur <= lastDay && dayIdx <= sprint.lengthDays) {
    cum += ptsByDate.get(cur) || 0;
    series.push({ dayNum: dayIdx, remaining: Math.max(0, totalGoal - cum) });
    cur = addDaysKey(cur, 1);
    dayIdx++;
  }
  return series;
}

/**
 * Render the focused-sprint overview: name, description, burndown chart, stats,
 * retrospective textarea, and prev/next navigation.
 */
function renderSprintOverview() {
  const cur = getCurrentSprint();
  const focusedId = state.trendsSprintId || state.currentSprintId;
  const sprint = getSprintById(focusedId) || cur;
  if (!sprint) {
    return `<div class="card"><div class="muted" style="padding:12px 0">No sprint to show yet.</div></div>`;
  }
  const step = pointStep(sprint);
  const url = `${API_TREND}/sprint/${encodeURIComponent(sprint.id)}`;
  const cached = state.trendsCache[url];
  const loaded = !!cached;
  const buckets = loaded ? cached.buckets || [] : [];

  const goalPerDay = goalForSprint(sprint);
  const totalGoal = goalPerDay * sprint.lengthDays;
  const sumPts = buckets.reduce((s, b) => s + (b.pts || 0), 0);
  const remaining = Math.max(0, totalGoal - sumPts);

  // Burndown actuals only go up to today (or end-of-sprint, whichever earlier).
  const actualSeries = buildBurndownSeries(sprint, buckets, totalGoal);
  const daysIn = actualSeries.length > 0 ? actualSeries[actualSeries.length - 1].dayNum : 0;
  const idealAtNow = goalPerDay * daysIn;
  const pace = sumPts - idealAtNow; // +ve = ahead, -ve = behind
  const paceClass = pace > 0.01 ? 'pace-ahead' : pace < -0.01 ? 'pace-behind' : 'pace-even';
  const paceLabel = pace > 0.01 ? 'ahead' : pace < -0.01 ? 'behind' : 'on pace';
  const paceSign = pace > 0 ? '+' : '';

  // Prev/next: walk by sprint id (server allocates sequential integers).
  const prevId = sprint.id - 1;
  const nextId = sprint.id + 1;
  const prevOk = prevId >= 1;
  const nextOk = !!getSprintById(nextId) || nextId <= (cur?.id || 0);

  const name = sprint.name || '';
  const description = sprint.description || '';
  const retro = sprint.retrospective || '';
  const canEditRetro = canEditRetrospective(sprint, todayKey());
  const heading = name ? escapeHtml(name) : `Sprint ${sprint.id}`;

  const header = `<div class="card">
    <div class="row between trends-sprint-nav">
      <button class="btn trends-sprint-navbtn" type="button" data-action="trends-prev" ${prevOk ? '' : 'disabled'} aria-label="Previous sprint">←</button>
      <div class="trends-sprint-title ${name ? '' : 'empty'}">${heading}</div>
      <button class="btn trends-sprint-navbtn" type="button" data-action="trends-next" ${nextOk ? '' : 'disabled'} aria-label="Next sprint">→</button>
    </div>
    <div class="trends-sprint-dates">${sprint.startDate} → ${sprint.endDate} · ${sprint.lengthDays} days</div>
    ${description ? `<div class="trends-sprint-desc">${escapeHtml(description)}</div>` : ''}
  </div>`;

  const metrics = `<div class="grid-metrics">
    <div class="card">
      <div class="mono muted">POINTS</div>
      <div class="stat trends-metric-stat">${fmtPointsForStep(sumPts, step)} / ${fmtPointsForStep(totalGoal, step)}</div>
      <div class="mono muted trends-metric-sub">${fmtPointsForStep(remaining, step)} left</div>
    </div>
    <div class="card">
      <div class="mono muted">PACE</div>
      <div class="stat trends-metric-stat ${paceClass}">${paceSign}${fmtPointsForStep(pace, step)}</div>
      <div class="mono muted trends-metric-sub">${paceLabel} · day ${daysIn} / ${sprint.lengthDays}</div>
    </div>
  </div>`;

  const chartLegend = `goal ${fmtPointsForStep(totalGoal, step)} · ${sprint.lengthDays} days`;
  const chart = `<div class="card">
    <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
      <div class="mono muted">BURNDOWN</div>
      <div class="mono muted" style="font-size:11px">${chartLegend}</div>
    </div>
    ${buildBurndownChart(actualSeries, totalGoal, sprint.lengthDays)}
    <div class="row between" style="margin-top:6px;gap:8px">
      <div class="mono muted" style="font-size:10px">ideal · · ·</div>
      <div class="mono muted" style="font-size:10px">${loaded ? (buckets.length ? '' : 'no entries yet') : 'loading…'}</div>
      <div class="mono muted" style="font-size:10px">actual ──</div>
    </div>
  </div>`;

  // Show the retrospective card when there's content OR the user can edit
  // (past + current sprints). Hide entirely on upcoming sprints with no
  // retro yet — no value in showing a locked empty box.
  const showRetro = retro || canEditRetro;
  const retroBlock = showRetro
    ? `<div class="card">
        <div class="trends-retro-label">RETROSPECTIVE</div>
        <textarea
          class="trends-retro-input"
          data-field="sprint-retrospective"
          data-sprint-id="${sprint.id}"
          maxlength="${SPRINT_RETRO_MAX}"
          placeholder="What worked? What didn’t? What to carry forward?"
          autocapitalize="sentences">${escapeHtml(retro)}</textarea>
      </div>`
    : '';

  return `${header}${metrics}${chart}${retroBlock}`;
}

// ── All-Time ──────────────────────────────────────────────────────────

/** Render the all-time chart — one point per sprint at its avg pts/day. */
function renderAllTime() {
  const cur = getCurrentSprint();
  const step = pointStep(cur);
  const summaries = state.sprintSummaries;
  if (!summaries) {
    return `<div class="card"><div class="muted" style="padding:12px 0">Loading…</div></div>`;
  }
  if (!summaries.length) {
    return `<div class="card"><div class="muted" style="padding:12px 0">No sprints yet.</div></div>`;
  }

  // One data point per sprint at avg pts/day.
  const buckets = summaries.map((s) => {
    const days = Number(s.days) || 1;
    const pts = Number(s.pts) || 0;
    return {
      key: s.startDate,
      pts: pts / days,
      days,
      sprintId: s.sprintId,
      name: s.name || '',
      endDate: s.endDate,
      totalPts: pts,
    };
  });

  const totalPtsAcross = buckets.reduce((s, b) => s + (b.totalPts || 0), 0);
  const totalDaysAcross = buckets.reduce((s, b) => s + (b.days || 1), 0) || 1;
  const lifetimeAvg = totalPtsAcross / totalDaysAcross;
  const ceilingDayPts = Math.max(...buckets.map((b) => b.pts), 1);
  const chartData = downsample(buckets, TRENDS_CHART_MAX_POINTS).map((b) => ({
    date: b.key,
    pts: b.pts,
  }));
  const goalLine = goalForSprint(cur);

  const header = `<div class="card">
    <div class="row between" style="gap:8px;align-items:center">
      <div class="mono" style="font-size:15px;letter-spacing:0.05em">ALL-TIME</div>
      <div class="mono muted" style="font-size:11px">${buckets.length} sprint${buckets.length === 1 ? '' : 's'}</div>
    </div>
  </div>`;

  const metrics = `<div class="grid-metrics">
    <div class="card"><div class="mono muted">POINTS</div><div class="stat" style="font-size:24px">${fmtPointsForStep(totalPtsAcross, step)}</div><div class="mono muted">across all sprints</div></div>
    <div class="card"><div class="mono muted">AVG / DAY</div><div class="stat" style="font-size:24px">${lifetimeAvg.toFixed(1)}</div><div class="mono muted">goal ${fmtPointsForStep(goalLine, step)}</div></div>
  </div>`;

  const chart = `<div class="card">
    <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
      <div class="mono muted">AVG POINTS / DAY PER SPRINT</div>
      <div class="mono muted" style="font-size:11px">avg ${lifetimeAvg.toFixed(1)} · goal ${fmtPointsForStep(goalLine, step)}</div>
    </div>
    ${buildLineChart(chartData, lifetimeAvg, ceilingDayPts, goalLine)}
  </div>`;

  // Short legend listing each sprint by name (or "Sprint N" fallback).
  const legendItems = buckets
    .map((b) => {
      const label = b.name ? escapeHtml(b.name) : `Sprint ${b.sprintId}`;
      const avg = b.pts.toFixed(1);
      return `<div class="row between" style="gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
        <div class="mono muted" style="font-size:11px;flex-shrink:0">${avg}/day</div>
      </div>`;
    })
    .join('');
  const legend = `<div class="card">
    <div class="mono muted" style="margin-bottom:6px">SPRINTS</div>
    ${legendItems}
  </div>`;

  return `${header}${metrics}${chart}${legend}`;
}

// ── Entry point ──────────────────────────────────────────────────────

export function renderTrends() {
  const mode = state.trendsMode === 'all' ? 'all' : 'sprint';
  const body = mode === 'all' ? renderAllTime() : renderSprintOverview();
  return `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <button class="btn ${mode === 'sprint' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="sprint">SPRINT OVERVIEW</button>
      <button class="btn ${mode === 'all' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="all">ALL-TIME</button>
    </div>
    ${body}
  `;
}
