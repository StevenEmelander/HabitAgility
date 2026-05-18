import { SPRINT_RETRO_MAX, TRENDS_CHART_MAX_POINTS } from './constants.js';
import {
  API_TREND,
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
 * Render a line chart with one optional reference line.
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
 * Render the focused-sprint overview: name, description, daily-points chart, stats,
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
  const buckets = loaded ? (cached.buckets || []).slice() : [];

  const sumPts = buckets.reduce((s, b) => s + (b.pts || 0), 0);
  const totalDays = buckets.reduce((s, b) => s + (b.days || 1), 0) || 1;
  const avgPerDay = sumPts / totalDays;
  const chartPts = buckets.map((b) => ({ key: b.key, pts: b.days ? b.pts / b.days : b.pts }));
  const ceilingDayPts = buckets.length
    ? Math.max(...buckets.map((b) => (b.days ? b.pts / b.days : b.pts)), 1)
    : 1;
  const chartDataPts = downsample(chartPts, TRENDS_CHART_MAX_POINTS).map((b) => ({
    date: b.key,
    pts: b.pts,
  }));
  const goalLine = goalForSprint(sprint);

  // Prev/next: walk by sprint id (server allocates sequential integers).
  const prevId = sprint.id - 1;
  const nextId = sprint.id + 1;
  const prevOk = prevId >= 1;
  const nextOk = !!getSprintById(nextId) || nextId <= (cur?.id || 0);

  const name = sprint.name || '';
  const description = sprint.description || '';
  const retro = sprint.retrospective || '';
  const canEditRetro = canEditRetrospective(sprint, todayKey());

  const header = `<div class="card">
    <div class="row between" style="gap:8px;align-items:center;margin-bottom:6px">
      <button class="btn" type="button" data-action="trends-prev" ${prevOk ? '' : 'disabled'} aria-label="Previous sprint">←</button>
      <div class="mono muted" style="font-size:11px;letter-spacing:0.07em">SPRINT ${sprint.id}</div>
      <button class="btn" type="button" data-action="trends-next" ${nextOk ? '' : 'disabled'} aria-label="Next sprint">→</button>
    </div>
    <div class="trends-sprint-title ${name ? '' : 'empty'}">${name ? escapeHtml(name) : 'Untitled sprint'}</div>
    <div class="trends-sprint-dates">${sprint.startDate} → ${sprint.endDate} · ${sprint.lengthDays} days</div>
    ${description ? `<div class="trends-sprint-desc">${escapeHtml(description)}</div>` : '<div class="trends-sprint-desc empty">No description.</div>'}
  </div>`;

  const metrics = `<div class="grid-metrics">
    <div class="card"><div class="mono muted">POINTS</div><div class="stat" style="font-size:24px">${fmtPointsForStep(sumPts, step)}</div><div class="mono muted">over ${totalDays} day${totalDays === 1 ? '' : 's'}</div></div>
    <div class="card"><div class="mono muted">AVG / DAY</div><div class="stat" style="font-size:24px">${avgPerDay.toFixed(1)}</div><div class="mono muted">goal ${fmtPointsForStep(goalLine, step)}</div></div>
  </div>`;

  const chart = !buckets.length
    ? `<div class="card"><div class="muted" style="padding:12px 0">${loaded ? 'No data for this sprint yet.' : 'Loading…'}</div></div>`
    : `<div class="card">
        <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
          <div class="mono muted">DAILY POINTS</div>
          <div class="mono muted" style="font-size:11px">avg ${avgPerDay.toFixed(1)} · goal ${fmtPointsForStep(goalLine, step)}</div>
        </div>
        ${buildLineChart(chartDataPts, avgPerDay, ceilingDayPts, goalLine)}
      </div>`;

  const retroLabel = canEditRetro
    ? 'RETROSPECTIVE'
    : 'RETROSPECTIVE (UPCOMING — UNLOCKS WHEN THE SPRINT STARTS)';
  const retroPlaceholder = canEditRetro
    ? 'What worked? What didn’t? What to carry forward?'
    : 'This sprint hasn’t started yet.';
  const retroBlock = `<div class="card">
    <div class="trends-retro-label">${retroLabel}</div>
    <textarea
      class="trends-retro-input"
      data-field="sprint-retrospective"
      data-sprint-id="${sprint.id}"
      maxlength="${SPRINT_RETRO_MAX}"
      placeholder="${retroPlaceholder}"
      ${canEditRetro ? '' : 'disabled'}
      autocapitalize="sentences">${escapeHtml(retro)}</textarea>
  </div>`;

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
