const {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { client } = require('./db');
const { ROWS_TABLE, PK_SPRINT_SUM, DEFAULT_GOAL_POINTS } = require('./constants');
const {
  nowIso,
  quantize,
  clampToToday,
  daysBetweenInclusive,
  addDays,
  isValidSprintId,
  jsonResponse,
  plainResponse,
} = require('./utils');
const { pointsForEntry } = require('./scoring');
const { queryAllSprintDefs, getSprintDef, findCovering } = require('./sprints');
// `entries` is required lazily inside functions to avoid the circular import that
// would leave `queryEntriesBetween` captured as `undefined` at module load
// (entries.js → summaries.js → entries.js).

// ── Item shape ────────────────────────────────────────────────────────

function summaryItemToObject(item) {
  return {
    sprintId: Number(item.dateKey.S),
    startDate: item.startDate ? item.startDate.S : null,
    endDate: item.endDate ? item.endDate.S : null,
    pts: item.pts ? Number(item.pts.N) : 0,
    days: item.days ? Number(item.days.N) : 0,
    goalPoints: item.goalPoints ? Number(item.goalPoints.N) : DEFAULT_GOAL_POINTS,
    goalTotal: item.goalTotal ? Number(item.goalTotal.N) : 0,
    name: item.name ? item.name.S : '',
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────

async function getSprintSummary(sprintId) {
  const out = await client.send(
    new GetItemCommand({
      TableName: ROWS_TABLE,
      Key: { pk: { S: PK_SPRINT_SUM }, dateKey: { S: String(sprintId) } },
    }),
  );
  if (!out.Item) return null;
  return summaryItemToObject(out.Item);
}

async function putSprintSummary(s) {
  const item = {
    pk: { S: PK_SPRINT_SUM },
    dateKey: { S: String(s.sprintId) },
    pts: { N: String(quantize(s.pts)) },
    days: { N: String(s.days) },
    goalPoints: { N: String(quantize(s.goalPoints != null ? s.goalPoints : DEFAULT_GOAL_POINTS)) },
    goalTotal: { N: String(quantize(s.goalTotal || 0)) },
    updatedAt: { S: nowIso() },
  };
  // Planning sprints have null dates; summary rows mirror sprint defs and only
  // write the date attributes when set.
  if (s.startDate) item.startDate = { S: s.startDate };
  if (s.endDate) item.endDate = { S: s.endDate };
  if (s.name) item.name = { S: String(s.name) };
  await client.send(new PutItemCommand({ TableName: ROWS_TABLE, Item: item }));
}

async function deleteSprintSummary(sprintId) {
  await client.send(
    new DeleteItemCommand({
      TableName: ROWS_TABLE,
      Key: { pk: { S: PK_SPRINT_SUM }, dateKey: { S: String(sprintId) } },
    }),
  );
}

async function queryAllSprintSummaries() {
  const out = new Map();
  let ExclusiveStartKey;
  do {
    const resp = await client.send(
      new QueryCommand({
        TableName: ROWS_TABLE,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'pk' },
        ExpressionAttributeValues: { ':p': { S: PK_SPRINT_SUM } },
        ExclusiveStartKey,
      }),
    );
    for (const it of resp.Items || []) {
      const sk = it.dateKey?.S;
      if (!sk) continue;
      const s = summaryItemToObject(it);
      out.set(s.sprintId, s);
    }
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function computeSprintSummary(sprint) {
  const { queryEntriesBetween } = require('./entries');
  const goalPoints = Number(sprint.goalPoints) || DEFAULT_GOAL_POINTS;
  const name = sprint.name || '';
  // Planning sprints (null dates) yield an empty summary — no aggregated data
  // until the first entry transitions them to started.
  if (!sprint.startDate || !sprint.endDate) {
    return {
      sprintId: sprint.id,
      startDate: null,
      endDate: null,
      pts: 0,
      days: 0,
      goalPoints,
      goalTotal: 0,
      name,
    };
  }
  const from = sprint.startDate;
  const to = clampToToday(sprint.endDate);
  if (from > to) {
    return {
      sprintId: sprint.id,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      pts: 0,
      days: 0,
      goalPoints,
      goalTotal: 0,
      name,
    };
  }
  const entries = await queryEntriesBetween(from, to);
  let pts = 0;
  for (const dk of Object.keys(entries)) pts += pointsForEntry(entries[dk].habitValuesById, sprint);
  const days = daysBetweenInclusive(from, to);
  const goalTotal = goalPoints * days;
  return {
    sprintId: sprint.id,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    pts,
    days,
    goalPoints,
    goalTotal,
    name,
  };
}

// ── Trends helpers + handlers ─────────────────────────────────────────

async function buildDailyBuckets(from, to, sprints) {
  const { queryEntriesBetween } = require('./entries');
  if (from > to) return [];
  const entries = await queryEntriesBetween(from, to);
  const buckets = [];
  let dk = from;
  while (dk <= to) {
    const cov = findCovering(sprints, dk);
    const goal = cov ? Number(cov.goalPoints) || DEFAULT_GOAL_POINTS : 0;
    const e = entries[dk];
    const pts = e && cov ? pointsForEntry(e.habitValuesById, cov) : 0;
    buckets.push({ key: dk, pts: quantize(pts), goal: quantize(goal), days: 1 });
    dk = addDays(dk, 1);
  }
  return buckets;
}

async function handleTrendSprintDetail(sprintId) {
  if (!isValidSprintId(sprintId)) return plainResponse(400, 'Invalid sprintId');
  const sprint = await getSprintDef(sprintId);
  if (!sprint) return plainResponse(404, 'Not Found');
  // Planning sprints have no entries to bucket; return empty buckets so the
  // client renders the Trends "not started yet" state.
  if (!sprint.startDate || !sprint.endDate) {
    return jsonResponse(200, { from: null, to: null, buckets: [] });
  }
  const from = sprint.startDate;
  const to = clampToToday(sprint.endDate);
  return jsonResponse(200, { from, to, buckets: await buildDailyBuckets(from, to, [sprint]) });
}

async function handleTrendSprintSummary() {
  const [sprints, cached] = await Promise.all([queryAllSprintDefs(), queryAllSprintSummaries()]);
  // Exclude planning sprints from the All-Time view — they have no data points.
  const realSprints = sprints.filter((s) => s && s.id != null && s.startDate && s.endDate);
  const missing = realSprints.filter((s) => !cached.has(s.id));
  const computed = await Promise.all(
    missing.map(async (s) => {
      const summary = await computeSprintSummary(s);
      await putSprintSummary(summary);
      return summary;
    }),
  );
  for (const s of computed) cached.set(s.sprintId, s);
  // Drop cached summaries for sprints that no longer exist (or have since
  // moved back to planning, though that shouldn't happen).
  const liveIds = new Set(realSprints.map((s) => s.id));
  const stale = [...cached.keys()].filter((id) => !liveIds.has(id));
  await Promise.all(stale.map(deleteSprintSummary));
  for (const id of stale) cached.delete(id);
  const out = [...cached.values()].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return jsonResponse(200, { summaries: out });
}

module.exports = {
  summaryItemToObject,
  getSprintSummary,
  putSprintSummary,
  deleteSprintSummary,
  queryAllSprintSummaries,
  computeSprintSummary,
  buildDailyBuckets,
  handleTrendSprintDetail,
  handleTrendSprintSummary,
};
