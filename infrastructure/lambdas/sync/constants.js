// ── Table names + auth secret (env-injected) ─────────────────────────
const META_TABLE = process.env.CYCLES_TABLE_NAME; // physical name retained; conceptually the "meta" table
const ROWS_TABLE = process.env.ENTRIES_TABLE_NAME; // physical name retained; holds DAY / SPRINT_DEF / SPRINT_SUM partitions
const CF_SECRET = process.env.CF_SECRET;

// ── User namespace ────────────────────────────────────────────────────
// Single-user today; multi-user becomes a one-line change: replace USER_ID with a
// per-request lookup of req.headers / auth context. Every DDB key is prefixed.
const USER_ID = 'main';
function userKey(suffix) {
  return `${USER_ID}#${suffix}`;
}
const PK_DAY = userKey('DAY');
const PK_SPRINT_DEF = userKey('SPRINT_DEF');
const PK_SPRINT_SUM = userKey('SPRINT_SUM');
const META_ROW_ID = USER_ID;

const DEFAULT_GOAL_POINTS = 10;

// ── Sprint metadata length caps ───────────────────────────────────────
// Enforced both client-side (UI maxlength) and server-side (defense in depth).
const SPRINT_NAME_MAX = 80;
const SPRINT_DESC_MAX = 2000;
const SPRINT_RETRO_MAX = 5000;

module.exports = {
  META_TABLE,
  ROWS_TABLE,
  CF_SECRET,
  USER_ID,
  userKey,
  PK_DAY,
  PK_SPRINT_DEF,
  PK_SPRINT_SUM,
  META_ROW_ID,
  DEFAULT_GOAL_POINTS,
  SPRINT_NAME_MAX,
  SPRINT_DESC_MAX,
  SPRINT_RETRO_MAX,
};
