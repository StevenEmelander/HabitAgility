import { SPRINT_DESC_MAX, SPRINT_NAME_MAX } from './constants.js';
import {
  POINT_STEPS,
  escapeHtml,
  fmtPoints,
  fmtPointsForStep,
  getCurrentSprint,
  getSprintById,
  goalForSprint,
  hasAnyEntries,
  isCurrentSprintFirstDay,
  pointStep,
  state,
} from './core.js';

function planCatAccent(cat) {
  const a = String(cat?.accent || '#d4a574').trim();
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
  const s = state.planMode === 'next' ? getSprintById((state.currentSprintId || 0) + 1) : getCurrentSprint();
  const step = pointStep(s);
  const categories = (s?.categories ? s.categories : [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const sprintHead = hasEntries && state.planMode === 'next' ? 'Upcoming sprint' : 'Current sprint';
  if (!s) {
    return `<div class="plan-root">
      <div class="plan-h">Plan</div>
      ${
        hasEntries
          ? `<div class="plan-seg">
        <button type="button" class="btn ${state.planMode === 'current' ? 'primary' : ''}" data-action="plan-mode" data-mode="current">Current</button>
        <button type="button" class="btn ${state.planMode === 'next' ? 'plan' : ''}" data-action="plan-mode" data-mode="next">Next</button>
      </div>`
          : ''
      }
      <div class="card"><div class="muted" style="font-size:14px;line-height:1.45">Loading ${sprintHead.toLowerCase()}…</div></div>
    </div>`;
  }
  // Past day 1, editing the current sprint's rules can change today's already-scored
  // values. Warn the user; suggest editing Next instead.
  const showCurrentWarning = state.planMode === 'current' && hasEntries && !isCurrentSprintFirstDay();
  const warning = showCurrentWarning
    ? `<div class="card" style="border-color:var(--danger)"><div style="font-size:13px;line-height:1.4;color:var(--danger)"><strong>Heads up:</strong> editing the current sprint past day 1 can change scores you've already tallied. Consider switching to <strong>Next</strong> to plan the upcoming sprint without affecting history.</div></div>`
    : '';
  const goal = goalForSprint(s);
  return `<div class="plan-root">
    <div class="plan-h">Plan</div>
    ${
      hasEntries
        ? `<div class="plan-seg">
      <button type="button" class="btn ${state.planMode === 'current' ? 'primary' : ''}" data-action="plan-mode" data-mode="current">Current</button>
      <button type="button" class="btn ${state.planMode === 'next' ? 'plan' : ''}" data-action="plan-mode" data-mode="next">Next</button>
    </div>`
        : ''
    }
    ${warning}
    <div class="card plan-sprint-card">
      <div class="mono muted" style="font-size:10px;letter-spacing:0.07em;margin-bottom:6px">${sprintHead.toUpperCase()}</div>
      <div class="col" style="gap:8px;margin-bottom:10px">
        <input
          type="text"
          class="plan-input plan-sprint-name"
          data-field="sprint-name"
          data-sprint-id="${s.id}"
          maxlength="${SPRINT_NAME_MAX}"
          placeholder="Sprint name"
          autocomplete="off"
          autocapitalize="sentences"
          value="${escapeHtml(s.name || '')}" />
        <textarea
          class="plan-input plan-sprint-desc"
          data-field="sprint-description"
          data-sprint-id="${s.id}"
          maxlength="${SPRINT_DESC_MAX}"
          rows="3"
          placeholder="Description / intent for this sprint"
          autocapitalize="sentences">${escapeHtml(s.description || '')}</textarea>
      </div>
      <div style="font-size:20px;font-weight:700;line-height:1.12;margin-bottom:8px">${fmtPointsForStep(goal, step)}<span class="muted" style="font-size:13px;font-weight:500"> goal/day</span></div>
      <div class="plan-date-row">
        <label class="plan-date-field">
          <span class="plan-lbl">Start</span>
          <input
            type="date"
            class="plan-input plan-date-input"
            data-field="sprint-start-date"
            data-sprint-id="${s.id}"
            value="${s.startDate}" />
        </label>
        <label class="plan-date-field">
          <span class="plan-lbl">End</span>
          <input
            type="date"
            class="plan-input plan-date-input"
            data-field="sprint-end-date"
            data-sprint-id="${s.id}"
            min="${s.startDate}"
            value="${s.endDate}" />
        </label>
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <span class="plan-lbl">Length:</span>
        <button type="button" class="btn" data-action="sprint-len" data-delta="-14">−14d</button>
        <button type="button" class="btn" data-action="sprint-len" data-delta="14">+14d</button>
        <span class="mono muted" style="font-size:11px">${s.lengthDays} days</span>
      </div>
      <div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap;align-items:center">
        <span class="plan-lbl">Goal:</span>
        <button type="button" class="btn" data-action="goal-step" data-delta="-1">−</button>
        <div class="mono plan-stepper-val">${fmtPointsForStep(goal, step)}</div>
        <button type="button" class="btn" data-action="goal-step" data-delta="1">+</button>
        <span class="muted" style="font-size:11px">pts/day</span>
      </div>
      ${renderPointStepSelector(step)}
    </div>
    <div class="card plan-cat-toolbar">
      <div class="plan-cat-toolbar-inner">
        <span class="plan-cat-toolbar-lbl">Categories</span>
        <button type="button" class="btn primary" data-action="add-category">+ Category</button>
      </div>
    </div>
    ${categories.map((cat) => renderPlanCategory(s, cat, step)).join('')}
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

function renderPlanCategory(sprint, cat, step) {
  const habits = (sprint.habitDefinitions || []).filter((h) => h.categoryId === cat.id);
  return `<div class="card plan-cat" style="--cat-accent:${planCatAccent(cat)}">
    <div class="plan-cat-head">
      <div class="plan-cat-title">${escapeHtml(cat.label)}</div>
      <div class="plan-btns">
        <button type="button" class="btn" data-action="rename-category" data-id="${cat.id}" aria-label="Rename category">Name</button>
        <button type="button" class="btn" data-action="add-habit" data-id="${cat.id}" aria-label="Add habit">+ Habit</button>
        <button type="button" class="btn danger" data-action="remove-category" data-id="${cat.id}" aria-label="Delete category">Remove</button>
      </div>
    </div>
    <div class="col plan-cat-habits">${habits.map((h) => renderPlanHabit(h, step)).join('')}</div>
  </div>`;
}

function renderPlanHabit(h, step) {
  const ptsOn = h.scoring.points || 0;
  const ppu = h.scoring.pointsPerUnit || 0;
  const limit = Number(h.scoring.dailyLimit) || 0;
  const stepper = (field, delta, display) => `<div class="row plan-stepper">
    <button type="button" class="btn" data-action="score-edit" data-id="${h.id}" data-field="${field}" data-delta="${-delta}">−</button>
    <div class="mono plan-stepper-val">${display}</div>
    <button type="button" class="btn" data-action="score-edit" data-id="${h.id}" data-field="${field}" data-delta="${delta}">+</button>
  </div>`;
  const scoreBtns =
    h.kind === 'boolean'
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
        <div class="plan-score-group plan-score-group-limit">
          <div class="plan-lbl">Limit:</div>
          ${stepper('dailyLimit', 1, limit > 0 ? String(limit) : '∞')}
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
