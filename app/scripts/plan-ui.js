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

/**
 * Action-menu modal — vertical list of buttons for the ⋯ menu on habits and
 * categories. Replaces the inline [✎] / [KIND] / [✕] triplet on each habit
 * (and the [Name] / [Remove] pair on each category), which together ate
 * ~132 px of horizontal real estate per row.
 *
 * Shape of state.actionMenu:
 *   {
 *     title: string,
 *     items: [
 *       { label, action, payload?, kind?: 'normal' | 'danger' },
 *       ...
 *     ],
 *   }
 *
 * Each item dispatches its `action` with `payload` (so the existing
 * rename-habit / remove-habit / switch-kind / rename-category / remove-category
 * handlers can stay unchanged — the menu just forwards to them).
 */
export function renderActionMenuModal() {
  const m = state.actionMenu;
  if (!m) return '';
  const buttons = (m.items || [])
    .map(
      (it, i) =>
        `<button type="button" class="plan-menu-item ${it.kind === 'danger' ? 'plan-menu-item-danger' : ''}" data-action="action-menu-pick" data-idx="${i}">${escapeHtml(it.label)}</button>`,
    )
    .join('');
  return `<div class="plan-modal-backdrop" data-action="action-menu-backdrop" role="presentation">
    <div class="plan-modal-alert plan-modal-menu" role="dialog" aria-modal="true" aria-labelledby="action-menu-title">
      <div id="action-menu-title" class="plan-modal-menu-title">${escapeHtml(m.title || '')}</div>
      <div class="plan-menu-items">${buttons}</div>
      <div class="plan-modal-alert-actions">
        <button type="button" class="btn" data-action="action-menu-cancel">Cancel</button>
      </div>
    </div>
  </div>`;
}

/**
 * Generic text-input modal — replaces window.prompt() for three sites that
 * needed a single text field: add-category, rename-category, rename-habit.
 * Shape of state.textModal:
 *   { kind, title, hint?, placeholder?, initialValue?, okLabel?, maxlength?, id? }
 * Handler dispatch via state.textModal.kind in handlers.js.
 */
export function renderTextModal() {
  const m = state.textModal;
  if (!m) return '';
  return `<div class="plan-modal-backdrop" data-action="text-modal-backdrop" role="presentation">
    <div class="plan-modal-alert" role="dialog" aria-modal="true" aria-labelledby="text-modal-title">
      <div id="text-modal-title" class="plan-modal-alert-title">${escapeHtml(m.title || '')}</div>
      ${m.hint ? `<p class="plan-modal-alert-hint">${escapeHtml(m.hint)}</p>` : ''}
      <input
        id="text-modal-input"
        class="plan-input-inmodal"
        type="text"
        placeholder="${escapeHtml(m.placeholder || '')}"
        maxlength="${m.maxlength || 120}"
        value="${escapeHtml(m.initialValue || '')}"
        autocomplete="off"
        autocapitalize="sentences" />
      <div class="plan-modal-alert-actions">
        <button type="button" class="btn" data-action="text-modal-cancel">Cancel</button>
        <button type="button" class="btn primary" data-action="text-modal-ok">${escapeHtml(m.okLabel || 'OK')}</button>
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
      ${
        hasEntries
          ? `<div class="plan-seg">
        <button type="button" class="btn ${state.planMode === 'current' ? 'primary' : ''}" data-action="plan-mode" data-mode="current">Current</button>
        <button type="button" class="btn ${state.planMode === 'next' ? 'plan' : ''}" data-action="plan-mode" data-mode="next">Next</button>
      </div>`
          : ''
      }
      <div class="card"><div class="muted plan-loading">Loading ${sprintHead.toLowerCase()}…</div></div>
    </div>`;
  }
  // Past day 1, editing the current sprint's rules can change today's already-scored
  // values. Warn the user; suggest editing Next instead.
  // Condensed single-line banners. The previous 3-line prose versions ate
  // ~80 px each on a sprint that was probably 2/3 in this state — the user
  // gets the gist after one read; verbose explainers belong in docs.
  const showCurrentWarning = state.planMode === 'current' && hasEntries && !isCurrentSprintFirstDay();
  const warning = showCurrentWarning
    ? `<div class="card plan-warning">⚠ Editing past day 1 may change today's tallied score. Use <strong>Next</strong> instead.</div>`
    : '';
  const planningHint = isSprintInPlanning(s)
    ? `<div class="card plan-hint">📋 Planning — start date locks on your first entry.</div>`
    : '';
  const goal = goalForSprint(s);
  return `<div class="plan-root">
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
      <div class="mono muted plan-section-label plan-sprint-head">${sprintHead.toUpperCase()}</div>
      <div class="plan-meta">
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
      <div class="plan-section">
        <div class="plan-section-label">SCHEDULE</div>
        ${renderSprintDates(s)}
      </div>
      <div class="plan-section">
        <div class="plan-section-label">SCORING</div>
        ${renderPointStepSelector(step)}
        <div class="plan-scoring-row">
          <span class="plan-lbl">Velocity:</span>
          <button type="button" class="btn" data-action="goal-step" data-delta="-1" aria-label="Decrease velocity">−</button>
          <div class="mono plan-stepper-val">${fmtPointsForStep(goal, step)}</div>
          <button type="button" class="btn" data-action="goal-step" data-delta="1" aria-label="Increase velocity">+</button>
          <span class="muted plan-scoring-unit">pts/day</span>
        </div>
      </div>
    </div>
    ${
      categories.length === 0
        ? `<div class="card plan-empty">
            <div class="plan-empty-title">No categories yet</div>
            <div class="plan-empty-body">Group your habits by area — try <em>Health</em>, <em>Focus</em>, or <em>Recovery</em>.</div>
            <button type="button" class="btn primary plan-empty-cta" data-action="add-category">+ Category</button>
          </div>`
        : `${categories.map((cat) => renderPlanCategory(s, cat, step)).join('')}
           <button type="button" class="btn plan-add-cat" data-action="add-category">+ Category</button>`
    }
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
    return `<button type="button" class="btn ${active}" data-action="point-step" data-step="${s}" aria-label="Set granularity to ${fmtPoints(s)}">${fmtPoints(s)}</button>`;
  }).join('');
  return `<div class="plan-scoring-row plan-scoring-row-step">
    <span class="plan-lbl">Granularity:</span>
    ${buttons}
  </div>`;
}

function renderPlanCategory(sprint, cat, step) {
  const habits = (sprint.habitDefinitions || []).filter((h) => h.categoryId === cat.id);
  const cid = escapeHtml(cat.id);
  const count = habits.length;
  return `<div class="card plan-cat" style="--cat-accent:${planCatAccent(cat)}">
    <div class="plan-cat-head">
      <div class="plan-cat-title">${escapeHtml(cat.label)}${count > 0 ? ` <span class="plan-cat-count">${count}</span>` : ''}</div>
      <div class="plan-cat-actions">
        <button type="button" class="btn" data-action="add-habit" data-id="${cid}" aria-label="Add habit">+ Habit</button>
        <button type="button" class="btn plan-menu-btn" data-action="cat-menu" data-id="${cid}" aria-label="Category actions">⋯</button>
      </div>
    </div>
    <div class="col plan-cat-habits">${habits.map((h) => renderPlanHabit(h, step)).join('')}</div>
  </div>`;
}

/**
 * Compact one-row habit layout:
 *   [Name........................]  [stepper]  [⋯]
 *
 * For count habits a second tiny row hangs the limit stepper below — keeps
 * both controls visible without ballooning the card to three rows like before.
 * The ⋯ menu opens an action sheet with Rename, Switch kind, and Delete
 * (replaces the inline [✎] [KIND] [✕] triplet that took ~132 px of width per
 * habit). Drops the "Points:" / "Limit:" labels since the stepper context is
 * obvious and the chrome was redundant.
 */
function renderPlanHabit(h, step) {
  const hid = escapeHtml(h.id);
  const ptsOn = h.scoring.points || 0;
  const ppu = h.scoring.pointsPerUnit || 0;
  const limit = Number(h.scoring.dailyLimit) || 0;
  const stepper = (field, delta, display, ariaName) => `<div class="row plan-stepper">
    <button type="button" class="btn plan-stepper-btn" data-action="score-edit" data-id="${hid}" data-field="${field}" data-delta="${-delta}" aria-label="Decrease ${ariaName}">−</button>
    <div class="mono plan-stepper-val">${display}</div>
    <button type="button" class="btn plan-stepper-btn" data-action="score-edit" data-id="${hid}" data-field="${field}" data-delta="${delta}" aria-label="Increase ${ariaName}">+</button>
  </div>`;
  const mainStepper =
    h.kind === 'boolean'
      ? stepper('points', step, `+${fmtPointsForStep(ptsOn, step)}`, 'points')
      : stepper('pointsPerUnit', step, `+${fmtPointsForStep(ppu, step)}/u`, 'points per unit');
  const limitRow =
    h.kind === 'count'
      ? `<div class="plan-habit-limit">${stepper('dailyLimit', 1, limit > 0 ? `≤${limit}` : '∞', 'daily limit')}</div>`
      : '';
  return `<div class="card2 plan-habit">
    <div class="plan-habit-row">
      <div class="plan-habit-name">${escapeHtml(h.label)}</div>
      ${mainStepper}
      <button type="button" class="btn plan-menu-btn" data-action="habit-menu" data-id="${hid}" aria-label="Habit actions">⋯</button>
    </div>
    ${limitRow}
  </div>`;
}
