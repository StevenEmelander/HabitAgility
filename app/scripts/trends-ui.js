import {
  API_TREND,
  escapeHtml,
  fmtPointsForStep,
  getCurrentCycle,
  getCycleById,
  pointStep,
  state,
  todayKey,
} from './core.js';

function buildLineChart(data, avg, dayMax) {
  const w = 360, h = 120, p = 4;
  const max = Math.max(dayMax, 1, ...data.map(d => d.pts));
  const dx = data.length > 1 ? (w - p * 2) / (data.length - 1) : 0;
  const y = (v) => p + (h - p * 2) * (1 - (v / max));
  const pts = data.map((d, i) => ({ x: p + i * dx, y: y(d.pts) }));
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <line x1="${p}" y1="${y(avg).toFixed(1)}" x2="${w - p}" y2="${y(avg).toFixed(1)}" stroke="#4a4a55" stroke-dasharray="2 4"/>
    ${pts.length ? `<path d="M${pts.map(q => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' L')}" fill="none" stroke="#d4a574" stroke-width="2"></path>` : ''}
    ${pts.map(q => `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="2" fill="#d4a574"></circle>`).join('')}
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
    const maxSum = slice.reduce((s, b) => s + (b.max || 0), 0);
    const daysSum = slice.reduce((s, b) => s + (b.days || 1), 0);
    out.push({ key: slice[0].key, pts: ptsSum, max: maxSum, days: daysSum });
  }
  return out;
}

/** Decide which trends URL or summary list applies to the current mode + step. */
function pickTrendsSource() {
  if (state.trendsMode === 'cycle') {
    const id = state.trendsCycleId || state.currentCycleId;
    if (id == null) return null;
    return { kind: 'daily', url: `${API_TREND}/cycle/${encodeURIComponent(id)}`, label: `CYCLE ${id}` };
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
  const cur = getCurrentCycle();
  const step = pointStep(cur);
  const source = pickTrendsSource();
  const mode = state.trendsMode;

  let label = 'TRENDS', from = '', to = '';
  let buckets = []; // {key, pts, max, days}
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
    const summaries = state.cycleSummaries;
    if (summaries) {
      loaded = true;
      let pool = summaries;
      if (source.filter === 'year') {
        const y = String(source.year);
        pool = summaries.filter((s) => (s.startDate || '').startsWith(y) || (s.endDate || '').startsWith(y));
      }
      buckets = pool.map((s) => ({
        key: s.startDate, pts: Number(s.pts) || 0, max: Number(s.max) || 0, days: Number(s.days) || 1,
        cycleId: s.cycleId, endDate: s.endDate,
      }));
      if (buckets.length) { from = buckets[0].key; to = buckets[buckets.length - 1].endDate || buckets[buckets.length - 1].key; }
    }
  }

  const sumPts = buckets.reduce((s, b) => s + (b.pts || 0), 0);
  const sumMax = buckets.reduce((s, b) => s + (b.max || 0), 0);
  const totalDays = buckets.reduce((s, b) => s + (b.days || 1), 0) || 1;
  const avgPerDay = sumPts / totalDays;
  const avgPctPerDay = sumMax ? (sumPts / sumMax) * 100 : 0;

  // Per-bucket avg points/day for the chart Y-axis (so weekly/cycle buckets are comparable).
  const chartPts = buckets.map((b) => ({ key: b.key, pts: (b.days ? b.pts / b.days : b.pts) }));
  const chartPct = buckets.map((b) => ({ key: b.key, pts: b.max ? (b.pts / b.max) * 100 : 0 }));
  const refMax = buckets.length ? Math.max(...buckets.map((b) => (b.days ? b.max / b.days : b.max)), 1) : 1;
  const chartDataPts = downsample(chartPts, 120).map((b) => ({ date: b.key, pts: b.pts }));
  const chartDataPct = downsample(chartPct, 120).map((b) => ({ date: b.key, pts: b.pts }));

  const prevOk = mode !== 'all' && (mode !== 'cycle' || (state.trendsCycleId || 0) > 1);
  const nextOk = mode !== 'all';

  const metricsBlock = `<div class="grid-metrics">
      <div class="card"><div class="mono muted">POINTS</div><div class="stat" style="font-size:24px">${fmtPointsForStep(sumPts, step)}</div><div class="mono muted">/ ${fmtPointsForStep(sumMax, step)}</div></div>
      <div class="card"><div class="mono muted">AVG / DAY</div><div class="stat" style="font-size:24px">${avgPerDay.toFixed(1)}</div><div class="mono muted">pts</div></div>
    </div>`;
  const chartsBlock = !buckets.length
    ? '<div class="card"><div class="muted" style="padding:12px 0">No data for this period.</div></div>'
    : `<div class="card">
        <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
          <div class="mono muted">AVG POINTS / DAY (${buckets.length})</div>
          <div class="mono muted" style="font-size:11px">avg ${avgPerDay.toFixed(1)} pts/day</div>
        </div>
        ${buildLineChart(chartDataPts, avgPerDay, refMax)}
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:8px;gap:8px;align-items:baseline">
          <div class="mono muted">PERCENT OF MAX (${buckets.length})</div>
          <div class="mono muted" style="font-size:11px">avg ${avgPctPerDay.toFixed(1)}%</div>
        </div>
        ${buildLineChart(chartDataPct, avgPctPerDay, 100)}
      </div>`;
  return `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <button class="btn ${mode === 'cycle' ? 'primary' : ''}" type="button" data-action="trends-mode" data-mode="cycle">CYCLE</button>
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
