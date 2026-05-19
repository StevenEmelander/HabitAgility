const { GetItemCommand, PutItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { client } = require('./db');
const {
  ROWS_TABLE,
  PK_SPRINT_DEF,
  DEFAULT_GOAL_POINTS,
  SPRINT_NAME_MAX,
  SPRINT_DESC_MAX,
  SPRINT_RETRO_MAX,
} = require('./constants');
const {
  nowIso,
  safeJsonParseObject,
  isValidDateKey,
  isValidSprintId,
  jsonResponse,
  plainResponse,
  clampText,
  todayKey,
} = require('./utils');
const { claimNextSprintId } = require('./meta');

// ── Validation helpers ────────────────────────────────────────────────

// Clamp a length value to a sane integer in [1, 365]. Defends against NaN /
// non-numeric / negative / unreasonably-large values from a buggy or hostile
// client. Returns the default if the input doesn't parse.
function safeLengthDays(value, fallback = 14) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < 1) return 1;
  if (rounded > 365) return 365;
  return rounded;
}

// Clamp a goal-points value to a non-negative finite number, capped at 10_000.
// Returns the fallback if the input doesn't parse.
function safeGoalPoints(value, fallback = DEFAULT_GOAL_POINTS) {
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

// ── Item shape ────────────────────────────────────────────────────────

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

// ── CRUD ──────────────────────────────────────────────────────────────

async function getSprintDef(sprintId) {
  const out = await client.send(
    new GetItemCommand({
      TableName: ROWS_TABLE,
      Key: { pk: { S: PK_SPRINT_DEF }, dateKey: { S: String(sprintId) } },
    }),
  );
  return out.Item ? sprintItemToObject(out.Item) : null;
}

async function putSprintDef(sprint) {
  await client.send(new PutItemCommand({ TableName: ROWS_TABLE, Item: sprintObjectToItem(sprint) }));
}

async function queryAllSprintDefs() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const resp = await client.send(
      new QueryCommand({
        TableName: ROWS_TABLE,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'pk' },
        ExpressionAttributeValues: { ':p': { S: PK_SPRINT_DEF } },
        ExclusiveStartKey,
      }),
    );
    for (const it of resp.Items || []) out.push(sprintItemToObject(it));
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return out;
}

function findCovering(sprints, dateKey) {
  // Started sprints (with set dates) that cover this date take priority.
  const started = sprints.find(
    (s) => s?.startDate && s.endDate && s.startDate <= dateKey && dateKey <= s.endDate,
  );
  if (started) return started;
  // Fallback: the lowest-ID planning sprint (null startDate). The user's
  // first entry into a planning sprint stamps it as started — see
  // `handlePutEntry` in entries.js.
  const planning = sprints.filter((s) => s && !s.startDate).sort((a, b) => (a.id || 0) - (b.id || 0))[0];
  return planning || null;
}

// ── Route handlers ────────────────────────────────────────────────────

async function handleGetSprint(sprintId) {
  if (!isValidSprintId(sprintId)) return plainResponse(400, 'Invalid sprintId');
  const sprint = await getSprintDef(sprintId);
  if (!sprint) return plainResponse(404, 'Not Found');
  return jsonResponse(200, sprint);
}

async function handlePutSprint(sprintId, body) {
  // Lazy require to break the cycle with summaries / orphan-sweep at module load.
  const { deleteSprintSummary } = require('./summaries');
  const { sweepOrphanHabits, restampSprintIds } = require('./orphan-sweep');

  if (!isValidSprintId(sprintId)) return plainResponse(400, 'Invalid sprintId');
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  // Dates are optional (planning sprint), but if either is set, both must be valid.
  const incomingStart = body.startDate || null;
  const incomingEnd = body.endDate || null;
  if (incomingStart && !isValidDateKey(incomingStart)) return plainResponse(400, 'Invalid startDate');
  if (incomingEnd && !isValidDateKey(incomingEnd)) return plainResponse(400, 'Invalid endDate');
  if ((incomingStart === null) !== (incomingEnd === null))
    return plainResponse(400, 'startDate and endDate must both be set or both be null');

  const oldSprint = await getSprintDef(sprintId);
  if (!oldSprint) return plainResponse(404, 'Sprint not found');

  // Defense in depth: retrospective only editable once the sprint has started.
  // (UI also gates this; lambda enforces in case of direct API use.)
  // Planning sprint (null startDate) has no started date → also not editable.
  const incomingRetro = body.retrospective;
  if (incomingRetro != null && incomingRetro !== oldSprint.retrospective) {
    const today = todayKey();
    if (!incomingStart || incomingStart > today) {
      return plainResponse(400, 'Retrospective not editable on upcoming sprint');
    }
  }

  const updated = {
    id: sprintId,
    startDate: incomingStart,
    endDate: incomingEnd,
    lengthDays: safeLengthDays(body.lengthDays, oldSprint.lengthDays || 14),
    pointStep: safePointStep(body.pointStep),
    goalPoints: safeGoalPoints(body.goalPoints, oldSprint.goalPoints),
    name: clampText(body.name, SPRINT_NAME_MAX),
    description: clampText(body.description, SPRINT_DESC_MAX),
    retrospective: clampText(body.retrospective, SPRINT_RETRO_MAX),
    categories: Array.isArray(body.categories) ? body.categories : [],
    habitDefinitions: Array.isArray(body.habitDefinitions) ? body.habitDefinitions : [],
  };
  await putSprintDef(updated);

  // Conditional orphan sweep — only when habit ids are genuinely orphaned.
  const oldIds = new Set((oldSprint.habitDefinitions || []).map((h) => h?.id).filter(Boolean));
  const newIds = new Set((updated.habitDefinitions || []).map((h) => h?.id).filter(Boolean));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  let removedHabitIds = [];
  const affectedSprintIds = new Set([sprintId]);
  let allSprints = null;
  if (removed.length) {
    allSprints = await queryAllSprintDefs();
    const liveElsewhere = new Set();
    for (const s of allSprints) {
      if (s.id === sprintId) continue;
      for (const h of s.habitDefinitions || []) if (h?.id) liveElsewhere.add(h.id);
    }
    const orphaned = new Set(removed.filter((id) => !liveElsewhere.has(id)));
    if (orphaned.size) {
      const sweepFrom = allSprints[0] ? allSprints[0].startDate : updated.startDate;
      const sweepTo = allSprints[allSprints.length - 1]
        ? allSprints[allSprints.length - 1].endDate
        : updated.endDate;
      const sweep = await sweepOrphanHabits(allSprints, orphaned, sweepFrom, sweepTo);
      removedHabitIds = sweep.removedHabitIds;
      for (const id of sweep.affectedSprintIds) affectedSprintIds.add(id);
    }
  }

  // Re-stamp sprintId on entries when the sprint's date range changed —
  // but only if BOTH sides have real dates (skip planning ↔ planning transitions
  // and the planning → started transition that handlePutEntry handles directly).
  if (
    oldSprint.startDate &&
    oldSprint.endDate &&
    updated.startDate &&
    updated.endDate &&
    (oldSprint.startDate !== updated.startDate || oldSprint.endDate !== updated.endDate)
  ) {
    if (!allSprints) allSprints = await queryAllSprintDefs();
    const oldF = oldSprint.startDate;
    const oldT = oldSprint.endDate;
    const newF = updated.startDate;
    const newT = updated.endDate;
    const lo = oldF < newF ? oldF : newF;
    const hi = oldT > newT ? oldT : newT;
    await restampSprintIds(allSprints, lo, hi);
  }

  // Name flows into the summary row (so All-Time chart can label sprints
  // without per-sprint fetches). Pure name edits don't hit the
  // orphan-sweep or date-change branches above, so invalidate explicitly.
  if (oldSprint.name !== updated.name) {
    affectedSprintIds.add(sprintId);
  }

  await Promise.all([...affectedSprintIds].map(deleteSprintSummary));
  return jsonResponse(200, { ok: true, removedHabitIds });
}

async function handlePostSprint(body) {
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  // Dates are optional (planning sprint), but if either is set, both must be valid.
  const incomingStart = body.startDate || null;
  const incomingEnd = body.endDate || null;
  if (incomingStart && !isValidDateKey(incomingStart)) return plainResponse(400, 'Invalid startDate');
  if (incomingEnd && !isValidDateKey(incomingEnd)) return plainResponse(400, 'Invalid endDate');
  if ((incomingStart === null) !== (incomingEnd === null))
    return plainResponse(400, 'startDate and endDate must both be set or both be null');
  const id = await claimNextSprintId();
  const sprint = {
    id,
    startDate: incomingStart,
    endDate: incomingEnd,
    lengthDays: safeLengthDays(body.lengthDays),
    pointStep: safePointStep(body.pointStep),
    goalPoints: safeGoalPoints(body.goalPoints),
    name: clampText(body.name, SPRINT_NAME_MAX),
    description: clampText(body.description, SPRINT_DESC_MAX),
    retrospective: clampText(body.retrospective, SPRINT_RETRO_MAX),
    categories: Array.isArray(body.categories) ? body.categories : [],
    habitDefinitions: Array.isArray(body.habitDefinitions) ? body.habitDefinitions : [],
  };
  await putSprintDef(sprint);
  return jsonResponse(201, sprint);
}

module.exports = {
  sprintItemToObject,
  sprintObjectToItem,
  getSprintDef,
  putSprintDef,
  queryAllSprintDefs,
  findCovering,
  handleGetSprint,
  handlePutSprint,
  handlePostSprint,
};
