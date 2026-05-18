import {
  API_TREND,
  escapeHtml,
  fmtPointsForStep,
  getCurrentSprint,
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
  const cap = maxPts || 120;
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

function pickTrendsSource() {
  if (state.trendsMode === 'sprint') {
    const id = state.trendsSprintId || state.currentSprintId;
    if (id == null) return null;
    return { kind: 'daily', url: `${API_TREND}/sprint/${encodeURIComponent(id)}`, label: `SPRINT ${id}` };
  }
  if (state.trendsMode === 'month') {
    const yyyymm = state.trendsMonth || todayKey().slice(0, 7);
    const [y, m] = yyyymm.split('-').map(Number);
    const labelDate = new Date(Date.UTC(y, m - 1, 1));
    const label = labelDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();
    return { kind: 'daily', url: `${API_TREND}/month/${encodeURIComponent(yyyymm)}`, label };
  }
  if (state.trendsMode === 'year') {
    const yr = state.trendsYear || new Date().getFullYear();
    return { kind: 'summaries', filter: 'year', year: yr, label: String(yr) };
  }
  return { kind: 'summaries', filter: 'all', label: 'ALL TIME' };
}

export function renderTrends() {
  const cur = getCurrentSprint();
  const step = pointStep(cur);
  const source = pickTrendsSource();
  const mode = state.trendsMode;

  let label = 'TRENDS';
  let from = '';
  let to = '';
  let buckets = []; // {key, pts, goal, days}
  let loaded = false;

  if (!source) {
    label = 'TRENDS';
  } else if (source.kind === 'daily') {
    label = source.label;
    const cached = state.trendsCache[source.url];
    if (cached) {
      loaded = true;
      from = cached.from;
      to = cached.to;
      buckets = (cached.buckets || []).slice();
    }
  } else {
    label = source.label;
    const summaries = state.sprintSummaries;
    if (summaries) {
      loaded = true;
      let pool = summaries;
      if (source.filter === 'year') {
        const y = String(source.year);
        pool = summaries.filter((s) => (s.startDate || '').startsWith(y) || (s.endDate || '').startsWith(y));
      }
      buckets = pool.map((s) => ({
        key: s.startDate,
        pts: Number(s.pts) || 0,
        goal: Number(s.goalTotal) || 0,
        days: Number(s.days) || 1,
        sprintId: s.sprintId,
        endDate: s.endDate,
      }));
      if (buckets.length) {
        from = buckets[0].key;
        to = buckets[buckets.length - 1].endDate || buckets[buckets.length - 1].key;
      }
    }
  }

  const sumPts = buckets.reduce((s, b) => s + (b.pts || 0), 0);
  const sumGoal = buckets.reduce((s, b) => s + (b.goal || 0), 0);
  const totalDays = buckets.reduce((s, b) => s + (b.days || 1), 0) || 1;
  const avgPerDay = sumPts / totalDays;
  const avgPctOfGoal = sumGoal ? (sumPts / sumGoal) * 100 : 0;

  // Per-bucket avg points/day for the chart Y-axis.
  const chartPts = buckets.map((b) => ({ key: b.key, pts: b.days ? b.pts / b.days : b.pts }));
  const chartPct = buckets.map((b) => ({ key: b.key, pts: b.goal ? (b.pts / b.goal) * 100 : 0 }));
  const ceilingDayPts = buckets.length
    ? Math.max(...buckets.map((b) => (b.days ? b.pts / b.days : b.pts)), 1)
    : 1;
  const chartDataPts = downsample(chartPts, 120).map((b) => ({ date: b.key, pts: b.pts }));
  const chartDataPct = downsample(chartPct, 120).map((b) => ({ date: b.key, pts: b.pts }));

  // Goal reference for the points chart: sprint/month uses focused sprint's daily goal;
  // year/all-time uses the current sprint's goal as a representative line.
  const goalLine = goalForSprint(cur);

  const prevOk = mode !== 'all' && (mode !== 'sprint' || (state.trendsSprintId || 0) > 1);
  const nextOk = mode !== 'all';

  const metricsBlock = `<div class="grid-metrics">
      <div class="card"><div class="mono muted">POINTS</div><div class="stat" style="font-size:24px">${fmtPointsForStep(sumPts, step)}</div><div class="mono muted">/ ${fmtPointsForStep(sumGoal, step)} goal</div></div>
      <div class="card"><div class="mono muted">AVG / DAY</div><div class="stat" style="font-size:24px">${avgPerDay.toFixed(1)}</div><div class="mono muted">pts (goal ${fmtPointsForStep(goalLine, step)})</div></div>
    </div>`;
  const chartsBlock = !buckets.length
    ? '<div class="card"><div class="muted" style="padding:12px 0">No data for this period.</div></div>'
    : `<div class="card">
        <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
          <div class="mono muted">AVG POINTS / DAY (${buckets.length})</div>
          <div class="mono muted" style="font-size:11px">avg ${avgPerDay.toFixed(1)} · goal ${fmtPointsForStep(goalLine, step)}</div>
        </div>
        ${buildLineChart(chartDataPts, avgPerDay, ceilingDayPts, goalLine)}
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
          <div class="mono muted">PERCENT OF GOAL (${buckets.length})</div>
          <div class="mono muted" style="font-size:11px">avg ${avgPctOfGoal.toFixed(1)}%</div>
        </div>
        ${buildLineChart(chartDataPct, avgPctOfGoal, 100, 100)}
      </div>`;
  return `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <button class="btn ${mode === 'sprint' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="sprint">SPRINT</button>
      <button class="btn ${mode === 'month' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="month">MONTH</button>
      <button class="btn ${mode === 'year' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="year">YEAR</button>
      <button class="btn ${mode === 'all' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="all">ALL TIME</button>
    </div>
    <div class="card">
      <div class="row between" style="flex-wrap:wrap;gap:8px;align-items:center">
        <button class="btn" type="button" data-action="trends-prev" ${prevOk ? '' : 'disabled'} aria-label="Previous period">←</button>
        <div class="col center" style="flex:1;min-width:0">
          <div class="mono" style="font-size:15px;margin-top:4px;text-align:center">${escapeHtml(label)}</div>
          <div class="muted" style="font-size:12px;margin-top:4px">${loaded ? (from && to ? `${from} → ${to}` : '—') : 'loading…'}</div>
        </div>
        <button class="btn" type="button" data-action="trends-next" ${nextOk ? '' : 'disabled'} aria-label="Next period">→</button>
      </div>
    </div>
    ${metricsBlock}
    ${chartsBlock}
  `;
}
