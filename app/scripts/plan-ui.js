import { SPRINT_DESC_MAX, SPRINT_NAME_MAX } from './constants.js';
import {
  POINT_STEPS,
  addDaysKey,
  escapeHtml,
  fmtPoints,
  fmtPointsForStep,
  getCurrentSprint,
  getSprintById,
  goalForSprint,
  hasAnyEntries,
  isCurrentSprintFirstDay,
  isSprintInPlanning,
  pointStep,
  state,
  todayKey,
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
  // Planning hint — surfaces what the disabled start-date input means on iOS
  // (no hover → tooltip is invisible). Mirrors the "Sprint hasn't started yet"
  // message shown in Trends Sprint Overview.
  const planningHint = isSprintInPlanning(s)
    ? `<div class="card" style="border-color:var(--plan)"><div style="font-size:13px;line-height:1.45;color:var(--plan)"><strong>Planning:</strong> this sprint hasn't started yet. The start date will be set automatically when you make your first entry on the <strong>Entries</strong> tab. Until then, adjust the end date to change the duration.</div></div>`
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
    ${planningHint}
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
      <div class="plan-goal-headline">${fmtPointsForStep(goal, step)}<span class="plan-goal-headline-unit">goal/day</span></div>
      ${renderSprintDates(s)}
      <div class="mono muted plan-length-line">${s.lengthDays} day${s.lengthDays === 1 ? '' : 's'}${isSprintInPlanning(s) ? ' · planning' : ''}</div>
      <div class="plan-scoring">
        <div class="plan-scoring-label">SCORING</div>
        <div class="plan-scoring-row">
          <span class="plan-lbl">Goal:</span>
          <button type="button" class="btn" data-action="goal-step" data-delta="-1" aria-label="Decrease goal">−</button>
          <div class="mono plan-stepper-val">${fmtPointsForStep(goal, step)}</div>
          <button type="button" class="btn" data-action="goal-step" data-delta="1" aria-label="Increase goal">+</button>
          <span class="muted plan-scoring-unit">pts/day</span>
        </div>
        ${renderPointStepSelector(step)}
      </div>
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

/**
 * Date inputs for the sprint card.
 *
 * Planning sprint (no startDate yet): start input shows today and is disabled;
 * end input shows today + lengthDays - 1 and is editable. Changing end adjusts
 * lengthDays (start stays auto-today). The lambda stamps real startDate +
 * endDate on the first PUT /api/entry against this sprint.
 *
 * Started sprint (startDate set): both inputs are disabled — dates are locked
 * after the sprint has begun, so the user can't accidentally shift a window
 * that already has stamped entries.
 */
function renderSprintDates(s) {
  const planning = isSprintInPlanning(s);
  const today = todayKey();
  const displayStart = planning ? today : s.startDate;
  const displayEnd = planning ? addDaysKey(today, Math.max(1, s.lengthDays) - 1) : s.endDate;
  const startTitle = planning ? 'Auto-set to today; locks to first-entry date' : 'Locked after sprint starts';
  const endTitle = planning ? 'Adjust the end date to change duration' : 'Locked after sprint starts';
  return `<div class="plan-date-row">
    <label class="plan-date-field">
      <span class="plan-lbl">Start</span>
      <input
        type="date"
        class="plan-input plan-date-input"
        data-field="sprint-start-date"
        data-sprint-id="${s.id}"
        value="${displayStart}"
        title="${startTitle}"
        disabled />
    </label>
    <label class="plan-date-field">
      <span class="plan-lbl">End</span>
      <input
        type="date"
        class="plan-input plan-date-input"
        data-field="sprint-end-date"
        data-sprint-id="${s.id}"
        min="${displayStart}"
        value="${displayEnd}"
        title="${endTitle}"
        ${planning ? '' : 'disabled'} />
    </label>
  </div>`;
}

function renderPointStepSelector(currentStep) {
  const buttons = POINT_STEPS.map((s) => {
    const active = s === currentStep ? 'primary' : '';
    return `<button type="button" class="btn ${active}" data-action="point-step" data-step="${s}" aria-label="Set point step to ${fmtPoints(s)}">${fmtPoints(s)}</button>`;
  }).join('');
  return `<div class="plan-scoring-row plan-scoring-row-step">
    <span class="plan-lbl">Step:</span>
    ${buttons}
  </div>`;
}

function renderPlanCategory(sprint, cat, step) {
  const habits = (sprint.habitDefinitions || []).filter((h) => h.categoryId === cat.id);
  const cid = escapeHtml(cat.id);
  return `<div class="card plan-cat" style="--cat-accent:${planCatAccent(cat)}">
    <div class="plan-cat-head">
      <div class="plan-cat-title">${escapeHtml(cat.label)}</div>
      <div class="plan-btns">
        <button type="button" class="btn" data-action="rename-category" data-id="${cid}" aria-label="Rename category">Name</button>
        <button type="button" class="btn" data-action="add-habit" data-id="${cid}" aria-label="Add habit">+ Habit</button>
        <button type="button" class="btn danger" data-action="remove-category" data-id="${cid}" aria-label="Delete category">Remove</button>
      </div>
    </div>
    <div class="col plan-cat-habits">${habits.map((h) => renderPlanHabit(h, step)).join('')}</div>
  </div>`;
}

function renderPlanHabit(h, step) {
  const hid = escapeHtml(h.id);
  const ptsOn = h.scoring.points || 0;
  const ppu = h.scoring.pointsPerUnit || 0;
  const limit = Number(h.scoring.dailyLimit) || 0;
  const stepper = (field, delta, display) => `<div class="row plan-stepper">
    <button type="button" class="btn" data-action="score-edit" data-id="${hid}" data-field="${field}" data-delta="${-delta}" aria-label="Decrease ${field}">−</button>
    <div class="mono plan-stepper-val">${display}</div>
    <button type="button" class="btn" data-action="score-edit" data-id="${hid}" data-field="${field}" data-delta="${delta}" aria-label="Increase ${field}">+</button>
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
        <button type="button" class="btn" data-action="rename-habit" data-id="${hid}" aria-label="Rename habit">✎</button>
        <button type="button" class="btn plan-kind" data-action="switch-kind" data-id="${hid}" title="Switch type" aria-label="Switch habit type">${habitKindLabel(h.kind)}</button>
        <button type="button" class="btn danger" data-action="remove-habit" data-id="${hid}" aria-label="Delete habit">✕</button>
      </div>
    </div>
    ${scoreBtns}
  </div>`;
}
