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
    startDate: { S: s.startDate },
    endDate: { S: s.endDate },
    lengthDays: { N: String(Number(s.lengthDays) || 0) },
    bodyJson: {
      S: JSON.stringify({ categories: s.categories || [], habitDefinitions: s.habitDefinitions || [] }),
    },
    updatedAt: { S: nowIso() },
  };
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
  return sprints.find((s) => s && s.startDate <= dateKey && dateKey <= s.endDate) || null;
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
  if (!isValidDateKey(body.startDate) || !isValidDateKey(body.endDate))
    return plainResponse(400, 'Invalid dates');

  const oldSprint = await getSprintDef(sprintId);
  if (!oldSprint) return plainResponse(404, 'Sprint not found');

  // Defense in depth: retrospective only editable once the sprint has started.
  // (UI also gates this; lambda enforces in case of direct API use.)
  const incomingRetro = body.retrospective;
  if (incomingRetro != null && incomingRetro !== oldSprint.retrospective) {
    const today = todayKey();
    if (body.startDate > today) {
      return plainResponse(400, 'Retrospective not editable on upcoming sprint');
    }
  }

  const updated = {
    id: sprintId,
    startDate: body.startDate,
    endDate: body.endDate,
    lengthDays: body.lengthDays,
    pointStep: body.pointStep,
    goalPoints: body.goalPoints,
    name: clampText(body.name, SPRINT_NAME_MAX),
    description: clampText(body.description, SPRINT_DESC_MAX),
    retrospective: clampText(body.retrospective, SPRINT_RETRO_MAX),
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
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

  // Re-stamp sprintId on entries when the sprint's date range changed.
  if (oldSprint.startDate !== updated.startDate || oldSprint.endDate !== updated.endDate) {
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
  if (!isValidDateKey(body.startDate) || !isValidDateKey(body.endDate))
    return plainResponse(400, 'Invalid dates');
  const id = await claimNextSprintId();
  const sprint = {
    id,
    startDate: body.startDate,
    endDate: body.endDate,
    lengthDays: body.lengthDays,
    pointStep: body.pointStep,
    goalPoints: body.goalPoints,
    name: clampText(body.name, SPRINT_NAME_MAX),
    description: clampText(body.description, SPRINT_DESC_MAX),
    retrospective: clampText(body.retrospective, SPRINT_RETRO_MAX),
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
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
