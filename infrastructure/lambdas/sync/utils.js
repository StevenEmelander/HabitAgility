// ── Time / dates ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from, to) {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

function clampToToday(dateKey) {
  const t = todayKey();
  return dateKey > t ? t : dateKey;
}

// ── Numeric ───────────────────────────────────────────────────────────

function quantize(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

// ── Strings ───────────────────────────────────────────────────────────

// Coerce to string, strip leading/trailing whitespace, slice to max length.
// Used for user-controlled sprint metadata (name/description/retrospective)
// as the lambda's defense-in-depth clamp.
function clampText(value, max) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ── HTTP response helpers ─────────────────────────────────────────────

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
  };
}

function plainResponse(statusCode, text) {
  return { statusCode, headers: { 'Content-Type': 'text/plain' }, body: text };
}

// Request body cap: 64 KiB. Sprint defs with very large category/habit arrays
// are well under this; an oversized POST/PUT signals abuse or a client bug.
// The Lambda Function URL accepts up to 6 MB which would otherwise pass through
// unchecked. Sentinel return value: a Symbol distinguishes "body too large" from
// "no body" or "JSON parse failed."
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TOO_LARGE = Symbol('BODY_TOO_LARGE');

function getBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return BODY_TOO_LARGE;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── JSON parsing ──────────────────────────────────────────────────────

// Parse a JSON string and return ONLY a plain object — primitives, arrays,
// and null all collapse to `{}`. Callers (entry valuesJson, sprint bodyJson)
// always expect an object shape; tightening here prevents `body.categories ||
// []` from surfacing surprising results if a caller ever stores an array.
function safeJsonParseObject(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ── Validators ────────────────────────────────────────────────────────

function isValidDateKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidSprintId(v) {
  return Number.isInteger(v) && v >= 1;
}
function parseSprintIdParam(s) {
  const n = Number(s);
  return isValidSprintId(n) ? n : null;
}

module.exports = {
  sleep,
  nowIso,
  todayKey,
  addDays,
  daysBetweenInclusive,
  clampToToday,
  quantize,
  clampText,
  jsonResponse,
  plainResponse,
  getBody,
  BODY_TOO_LARGE,
  safeJsonParseObject,
  isValidDateKey,
  isValidSprintId,
  parseSprintIdParam,
};
