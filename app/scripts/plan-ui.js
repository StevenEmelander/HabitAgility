import {
  escapeHtml,
  fmtPoints,
  fmtPointsForStep,
  getCurrentCycle,
  getCycleById,
  hasAnyEntries,
  isCurrentCycleFirstDay,
  POINT_STEPS,
  pointStep,
  state,
  totalMax,
} from './core.js';

function planCatAccent(cat) {
  const a = String((cat && cat.accent) || '#d4a574').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(a) ? a : '#d4a574';
}

function habitKindLabel(kind) {
  return kind === 'count' ? 'CNT' : 'Y/N';
}

export function renderAddHabitModal() {
  const d = state.addHabitDraft;
  if (!d) return '';
  const kindSel = d.kind || 'boolean';
  const kb = kindSel === 'boolean';
  const kc = kindSel === 'count';
  return `<div class="plan-modal-backdrop" data-action="habit-add-backdrop" role="presentation">
    <div class="plan-modal-alert" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">
      <div id="plan-modal-title" class="plan-modal-alert-title">New habit</div>
      <p class="plan-modal-alert-hint">Name + type.</p>
      <input id="plan-new-habit-input" class="plan-input-inmodal" type="text" placeholder="Name" maxlength="120" autocomplete="off" autocapitalize="sentences" />
      <div class="plan-modal-kind-row">
        <button type="button" class="btn ${kb ? 'primary' : ''}" data-action="habit-add-kind" data-kind="boolean">Yes / no</button>
        <button type="button" class="btn ${kc ? 'primary' : ''}" data-action="habit-add-kind" data-kind="count">Count</button>
      </div>
      <div class="plan-modal-alert-actions">
        <button type="button" class="btn" data-action="habit-add-cancel">Cancel</button>
        <button type="button" class="btn primary" data-action="habit-add-ok">OK</button>
      </div>
    </div>
  </div>`;
}

export function renderPlan() {
  const hasEntries = hasAnyEntries();
  if (!hasEntries) state.planMode = 'current';
  const c = state.planMode === 'next'
    ? getCycleById((state.currentCycleId || 0) + 1)
    : getCurrentCycle();
  const step = pointStep(c);
  const categories = (c && c.categories ? c.categories : []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const cycleHead = hasEntries && state.planMode === 'next' ? 'Upcoming cycle' : 'Current cycle';
  if (!c) {
    return `<div class="plan-root">
      <div class="plan-h">Plan</div>
      ${hasEntries ? `<div class="plan-seg">
        <button type="button" class="btn ${state.planMode === 'current' ? 'primary' : ''}" data-action="plan-mode" data-mode="current">Current</button>
        <button type="button" class="btn ${state.planMode === 'next' ? 'plan' : ''}" data-action="plan-mode" data-mode="next">Next</button>
      </div>` : ''}
      <div class="card"><div class="muted" style="font-size:14px;line-height:1.45">Loading ${cycleHead.toLowerCase()}…</div></div>
    </div>`;
  }
  // Past day 1, editing the current cycle's rules can change today's already-scored
  // values. Warn the user; suggest editing Next instead.
  const showCurrentWarning = state.planMode === 'current' && hasEntries && !isCurrentCycleFirstDay();
  const warning = showCurrentWarning
    ? `<div class="card" style="border-color:var(--danger)"><div style="font-size:13px;line-height:1.4;color:var(--danger)"><strong>Heads up:</strong> editing the current cycle past day 1 can change scores you've already tallied. Consider switching to <strong>Next</strong> to plan the upcoming cycle without affecting history.</div></div>`
    : '';
  return `<div class="plan-root">
    <div class="plan-h">Plan</div>
    ${hasEntries ? `<div class="plan-seg">
      <button type="button" class="btn ${state.planMode === 'current' ? 'primary' : ''}" data-action="plan-mode" data-mode="current">Current</button>
      <button type="button" class="btn ${state.planMode === 'next' ? 'plan' : ''}" data-action="plan-mode" data-mode="next">Next</button>
    </div>` : ''}
    ${warning}
    <div class="card plan-cycle-card">
      <div class="mono muted" style="font-size:10px;letter-spacing:0.07em;margin-bottom:6px">${cycleHead.toUpperCase()}</div>
      <div class="row between" style="flex-wrap:wrap;gap:10px;align-items:flex-start">
        <div style="min-width:0">
          <div style="font-size:20px;font-weight:700;line-height:1.12">${fmtPointsForStep(totalMax(c), step)}<span class="muted" style="font-size:13px;font-weight:500"> max/day</span></div>
          <div class="plan-cycle-dates">${c.startDate} → ${c.endDate}</div>
        </div>
        <div class="col" style="gap:4px;align-items:flex-end;min-width:fit-content">
          <div class="row" style="gap:5px"><button type="button" class="btn" data-action="cycle-len" data-delta="-7">−7d</button><button type="button" class="btn" data-action="cycle-len" data-delta="7">+7d</button></div>
          <span class="mono muted" style="font-size:11px">${c.lengthDays} days</span>
        </div>
      </div>
      ${renderPointStepSelector(step)}
    </div>
    <div class="card plan-cat-toolbar">
      <div class="plan-cat-toolbar-inner">
        <span class="plan-cat-toolbar-lbl">Categories</span>
        <button type="button" class="btn primary" data-action="add-category">+ Category</button>
      </div>
    </div>
    ${categories.map(cat => renderPlanCategory(c, cat, step)).join('')}
  </div>`;
}

function renderPointStepSelector(currentStep) {
  const buttons = POINT_STEPS.map((s) => {
    const active = s === currentStep ? 'primary' : '';
    return `<button type="button" class="btn ${active}" data-action="point-step" data-step="${s}">${fmtPoints(s)}</button>`;
  }).join('');
  return `<div class="row" style="margin-top:10px;gap:5px;flex-wrap:wrap;align-items:center">
    <span class="plan-lbl">Step:</span>
    ${buttons}
  </div>`;
}

function renderPlanCategory(c, cat, step) {
  const habits = (c.habitDefinitions || []).filter(h => h.categoryId === cat.id);
  return `<div class="card plan-cat" style="--cat-accent:${planCatAccent(cat)}">
    <div class="plan-cat-head">
      <div class="plan-cat-title">${escapeHtml(cat.label)}</div>
      <div class="plan-btns">
        <button type="button" class="btn" data-action="rename-category" data-id="${cat.id}" aria-label="Rename category">Name</button>
        <button type="button" class="btn" data-action="add-habit" data-id="${cat.id}" aria-label="Add habit">+ Habit</button>
        <button type="button" class="btn danger" data-action="remove-category" data-id="${cat.id}" aria-label="Delete category">Remove</button>
      </div>
    </div>
    <div class="col plan-cat-habits">${habits.map(h => renderPlanHabit(h, step)).join('')}</div>
  </div>`;
}

function renderPlanHabit(h, step) {
  const ptsOn = h.scoring.points || 0;
  const ppu = h.scoring.pointsPerUnit || 0;
  const cap = h.scoring.maxUnits || 0;
  const stepper = (field, delta, display) => `<div class="row plan-stepper">
    <button type="button" class="btn" data-action="score-edit" data-id="${h.id}" data-field="${field}" data-delta="${-delta}">−</button>
    <div class="mono plan-stepper-val">${display}</div>
    <button type="button" class="btn" data-action="score-edit" data-id="${h.id}" data-field="${field}" data-delta="${delta}">+</button>
  </div>`;
  const scoreBtns = h.kind === 'boolean'
    ? `<div class="plan-scores">
        <div class="plan-score-group">
          <div class="plan-lbl">Points:</div>
          ${stepper('points', step, fmtPointsForStep(ptsOn, step))}
        </div>
      </div>`
    : `<div class="plan-scores">
        <div class="plan-score-group">
          <div class="plan-lbl">Points:</div>
          ${stepper('pointsPerUnit', step, fmtPointsForStep(ppu, step))}
        </div>
        <div class="plan-score-group plan-score-group-max">
          <div class="plan-lbl">Max:</div>
          ${stepper('maxUnits', 1, String(cap))}
        </div>
      </div>`;
  return `<div class="card2 plan-habit">
    <div class="plan-habit-top">
      <div class="plan-habit-name">${escapeHtml(h.label)}</div>
      <div class="plan-btns plan-btns-single">
        <button type="button" class="btn" data-action="rename-habit" data-id="${h.id}" aria-label="Rename habit">✎</button>
        <button type="button" class="btn plan-kind" data-action="switch-kind" data-id="${h.id}" title="Switch type">${habitKindLabel(h.kind)}</button>
        <button type="button" class="btn danger" data-action="remove-habit" data-id="${h.id}" aria-label="Delete habit">✕</button>
      </div>
    </div>
    ${scoreBtns}
  </div>`;
}
