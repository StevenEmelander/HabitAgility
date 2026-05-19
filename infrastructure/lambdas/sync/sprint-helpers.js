/**
 * Pure helpers for sprint validation, item-shape conversion, and date-range
 * coverage. NO AWS SDK / DynamoDB imports — everything in this module is a
 * function of its inputs only, which lets it import cleanly from tests
 * without requiring the SDK at the test runner's resolution scope.
 *
 * Handlers and DDB CRUD live in `sprints.js`, which imports from here.
 */

const {
  DEFAULT_GOAL_POINTS,
  SPRINT_NAME_MAX,
  SPRINT_DESC_MAX,
  SPRINT_RETRO_MAX,
  PK_SPRINT_DEF,
} = require('./constants');
const { nowIso, safeJsonParseObject, clampText } = require('./utils');

// ── Validation helpers ────────────────────────────────────────────────

// Clamp a length value to a sane integer in [1, 365]. Defends against NaN /
// non-numeric / negative / unreasonably-large values from a buggy or hostile
// client. Returns the fallback for null / undefined / empty input or for
// anything that can't be coerced to a finite number; in-range values that
// happen to coerce to a too-small or too-large number are still clamped to
// the [1, 365] range rather than rejected outright.
function safeLengthDays(value, fallback = 14) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < 1) return 1;
  if (rounded > 365) return 365;
  return rounded;
}

// Clamp a goal-points value to a non-negative finite number, capped at 10_000.
// Returns the fallback for null / undefined / empty / non-finite input or for
// a negative number; in-range values are passed through, oversize are capped.
function safeGoalPoints(value, fallback = DEFAULT_GOAL_POINTS) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 10000) return 10000;
  return n;
}

// pointStep must be one of the canonical step values (mirrors the front-end's
// POINT_STEPS); reject anything else so an arbitrary step doesn't get persisted.
const ALLOWED_POINT_STEPS = new Set([0.1, 0.25, 0.5, 1]);
function safePointStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return ALLOWED_POINT_STEPS.has(n) ? n : undefined;
}

// ── Item-shape conversion (DDB AttributeValue ↔ plain object) ─────────

function sprintItemToObject(item) {
  const body = safeJsonParseObject(item.bodyJson?.S);
  return {
    id: Number(item.dateKey.S),
    startDate: item.startDate ? item.startDate.S : null,
    endDate: item.endDate ? item.endDate.S : null,
    lengthDays: item.lengthDays ? Number(item.lengthDays.N) : 0,
    pointStep: item.pointStep ? Number(item.pointStep.N) : undefined,
    goalPoints: item.goalPoints ? Number(item.goalPoints.N) : DEFAULT_GOAL_POINTS,
    name: item.name ? item.name.S : '',
    description: item.description ? item.description.S : '',
    retrospective: item.retrospective ? item.retrospective.S : '',
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
  };
}

function sprintObjectToItem(s) {
  const item = {
    pk: { S: PK_SPRINT_DEF },
    dateKey: { S: String(s.id) },
    lengthDays: { N: String(Number(s.lengthDays) || 0) },
    bodyJson: {
      S: JSON.stringify({ categories: s.categories || [], habitDefinitions: s.habitDefinitions || [] }),
    },
    updatedAt: { S: nowIso() },
  };
  // Dates are optional: a sprint in "planning" state (never had a first entry)
  // has both dates null. The first PUT /api/entry covering this sprint flips
  // it to "started" by stamping startDate = entry.dateKey, endDate = +lengthDays-1.
  if (s.startDate) item.startDate = { S: s.startDate };
  if (s.endDate) item.endDate = { S: s.endDate };
  if (s.pointStep != null) item.pointStep = { N: String(Number(s.pointStep) || 1) };
  const goal = Number(s.goalPoints);
  item.goalPoints = { N: String(Number.isFinite(goal) && goal >= 0 ? goal : DEFAULT_GOAL_POINTS) };
  // Optional string metadata — write only when non-empty (mirror pointStep).
  const name = clampText(s.name, SPRINT_NAME_MAX);
  if (name) item.name = { S: name };
  const description = clampText(s.description, SPRINT_DESC_MAX);
  if (description) item.description = { S: description };
  const retrospective = clampText(s.retrospective, SPRINT_RETRO_MAX);
  if (retrospective) item.retrospective = { S: retrospective };
  return item;
}

// ── Covering-sprint lookup ────────────────────────────────────────────

/**
 * Find the sprint that covers a given dateKey.
 *   - Started sprint (both dates set) whose range includes dateKey: that sprint.
 *   - Otherwise: the lowest-id "planning" sprint (no startDate), which the
 *     handlePutEntry path stamps as started on first entry.
 *   - Otherwise: null.
 */
function findCovering(sprints, dateKey) {
  const started = sprints.find(
    (s) => s?.startDate && s.endDate && s.startDate <= dateKey && dateKey <= s.endDate,
  );
  if (started) return started;
  const planning = sprints.filter((s) => s && !s.startDate).sort((a, b) => (a.id || 0) - (b.id || 0))[0];
  return planning || null;
}

module.exports = {
  safeLengthDays,
  safeGoalPoints,
  safePointStep,
  sprintItemToObject,
  sprintObjectToItem,
  findCovering,
};
