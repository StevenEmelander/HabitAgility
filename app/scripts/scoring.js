/**
 * Habit-points math. Mirrors `infrastructure/lambdas/sync/scoring.js → pointsForEntry`
 * so client-rendered totals match what the server computes.
 *
 * Pure module: no DOM, no state, no fetches. Testable in isolation.
 */

import { DEFAULT_GOAL_POINTS, DEFAULT_POINT_STEP, POINT_STEPS } from './constants.js';

// ── Numeric helpers ───────────────────────────────────────────────────

/** Snap a value to a 2-decimal grid; eliminates JS float drift (0.1+0.2 etc.). */
export function quantize(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** Strip trailing zeros: 1.00 → "1", 0.30 → "0.3", 1.25 → "1.25". */
export function fmtPoints(v) {
  return Number(quantize(v).toFixed(2)).toString();
}

/** Decimal places needed to faithfully render a value at this point step. */
export function decimalsForStep(step) {
  if (step >= 1) return 0;
  if (step === 0.25) return 2;
  return 1; // 0.1 and 0.5
}

/** Format a points value at the sprint's chosen granularity (keeps trailing zeros). */
export function fmtPointsForStep(v, step) {
  return quantize(v).toFixed(decimalsForStep(step));
}

// ── Sprint / habit accessors ──────────────────────────────────────────

/** @param {Sprint|null} sprint */
export function pointStep(sprint) {
  const s = Number(sprint?.pointStep);
  return POINT_STEPS.includes(s) ? s : DEFAULT_POINT_STEP;
}

/** @param {Sprint|null} sprint */
export function goalForSprint(sprint) {
  if (!sprint || sprint.goalPoints == null) return DEFAULT_GOAL_POINTS;
  const t = Number(sprint.goalPoints);
  return Number.isFinite(t) && t >= 0 ? t : DEFAULT_GOAL_POINTS;
}

export function habitsForCategory(sprint, cid) {
  return (sprint?.habitDefinitions || []).filter((h) => h.categoryId === cid);
}

export function habitById(sprint, id) {
  return (sprint?.habitDefinitions || []).find((h) => h.id === id);
}

// ── Earned points ─────────────────────────────────────────────────────

/**
 * Earned points for one habit value. Count habits with `dailyLimit = 0` are
 * unlimited (no upper clamp on units).
 */
export function habitEarned(h, v) {
  if (!h || !h.scoring) return 0;
  if (h.kind === 'boolean') return v ? h.scoring.points || 0 : 0;
  const limit = Number(h.scoring.dailyLimit) || 0;
  const ppu = Number(h.scoring.pointsPerUnit) || 0;
  const n = limit > 0 ? Math.max(0, Math.min(Number(v || 0), limit)) : Math.max(0, Number(v || 0));
  return n * ppu;
}

export function categoryPoints(entry, sprint, cid) {
  if (!entry || !sprint) return 0;
  return habitsForCategory(sprint, cid).reduce(
    (s, h) => s + habitEarned(h, entry.habitValuesById?.[h.id]),
    0,
  );
}

export function totalPoints(entry, sprint) {
  return sprint ? (sprint.categories || []).reduce((s, c) => s + categoryPoints(entry, sprint, c.id), 0) : 0;
}

// ── Sprint metadata helpers ───────────────────────────────────────────

/**
 * Whether the retrospective field is editable for a given sprint.
 * Editable on past and current sprints; locked on upcoming sprints
 * (those that haven't started yet).
 * @param {Sprint|null} sprint
 * @param {string} todayKey  YYYY-MM-DD
 */
export function canEditRetrospective(sprint, todayKey) {
  return Boolean(sprint?.startDate && sprint.startDate <= todayKey);
}

/**
 * Coerce to string, trim leading/trailing whitespace, slice to max length.
 * Used to clamp user-entered sprint metadata before pushing to state.
 * Mirror of the lambda's `clampText` in utils.js.
 * @param {*} value
 * @param {number} max
 */
export function clampSprintText(value, max) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}
