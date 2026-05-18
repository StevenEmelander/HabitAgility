/**
 * Shared constants for the Good Habit Tracker front-end.
 * Mirrors values used by the lambda (kept in sync manually; if these drift the
 * UI will compute values that disagree with server-rendered totals).
 */

/** Daily goal points used when a sprint has no `goalPoints` set. */
export const DEFAULT_GOAL_POINTS = 10;

/** Default sprint length used when extending forward from no template. */
export const DEFAULT_SPRINT_LENGTH_DAYS = 14;

/** Allowed point-step values for `sprint.pointStep`. */
export const POINT_STEPS = [0.1, 0.25, 0.5, 1];

/** Default `pointStep` when missing on a sprint. */
export const DEFAULT_POINT_STEP = 1;

/** Per-item write debounce (ms). One pending request per item id; resets on new edit. */
export const SPRINT_DEBOUNCE_MS = 1500;
export const ENTRY_DEBOUNCE_MS = 1500;

// ── API base paths ────────────────────────────────────────────────────

export const API_SPRINT = '/api/sprint';
export const API_ENTRY = '/api/entry';
export const API_TREND = '/api/trend';

// ── UI / rendering ────────────────────────────────────────────────────

/** Toast auto-dismiss timer (ms). */
export const TOAST_DISMISS_MS = 2200;

/** Maximum chart points after server-supplied bucket downsampling. */
export const TRENDS_CHART_MAX_POINTS = 120;
