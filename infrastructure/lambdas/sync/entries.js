const {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { client } = require('./db');
const { ROWS_TABLE, PK_DAY } = require('./constants');
const { nowIso, safeJsonParseObject, isValidDateKey, jsonResponse, plainResponse } = require('./utils');
const { getMetaRowRaw, bumpBoundsOnPut, recomputeBoundsAfterDelete } = require('./meta');
const { queryAllSprintDefs, findCovering } = require('./sprints');
const { deleteSprintSummary } = require('./summaries');

// ── Item shape ────────────────────────────────────────────────────────

function entryItemToObject(item) {
  return {
    dateKey: item.dateKey.S,
    habitValuesById: safeJsonParseObject(item.valuesJson?.S),
    sprintId: item.sprintId ? Number(item.sprintId.N) : null,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────

async function getEntryRow(dateKey) {
  const out = await client.send(
    new GetItemCommand({
      TableName: ROWS_TABLE,
      Key: { pk: { S: PK_DAY }, dateKey: { S: dateKey } },
    }),
  );
  return out.Item ? entryItemToObject(out.Item) : null;
}

async function putEntryRow(dateKey, habitValuesById, sprintId) {
  const item = {
    pk: { S: PK_DAY },
    dateKey: { S: dateKey },
    valuesJson: { S: JSON.stringify(habitValuesById || {}) },
    updatedAt: { S: nowIso() },
  };
  if (sprintId != null) item.sprintId = { N: String(sprintId) };
  await client.send(new PutItemCommand({ TableName: ROWS_TABLE, Item: item }));
}

async function deleteEntryRow(dateKey) {
  await client.send(
    new DeleteItemCommand({
      TableName: ROWS_TABLE,
      Key: { pk: { S: PK_DAY }, dateKey: { S: dateKey } },
    }),
  );
}

async function queryEntriesBetween(from, to) {
  const out = {};
  if (!from || !to || from > to) return out;
  let ExclusiveStartKey;
  do {
    const resp = await client.send(
      new QueryCommand({
        TableName: ROWS_TABLE,
        KeyConditionExpression: '#p = :p AND #d BETWEEN :f AND :t',
        ExpressionAttributeNames: { '#p': 'pk', '#d': 'dateKey' },
        ExpressionAttributeValues: { ':p': { S: PK_DAY }, ':f': { S: from }, ':t': { S: to } },
        ProjectionExpression: 'dateKey, valuesJson, sprintId',
        ExclusiveStartKey,
      }),
    );
    for (const it of resp.Items || []) {
      const dk = it.dateKey?.S;
      if (!dk) continue;
      out[dk] = entryItemToObject(it);
    }
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function findBoundEntry(direction) {
  const resp = await client.send(
    new QueryCommand({
      TableName: ROWS_TABLE,
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'pk' },
      ExpressionAttributeValues: { ':p': { S: PK_DAY } },
      ProjectionExpression: 'dateKey',
      ScanIndexForward: direction === 'asc',
      Limit: 1,
    }),
  );
  const it = (resp.Items || [])[0];
  return it?.dateKey ? it.dateKey.S : null;
}

// ── Route handlers ────────────────────────────────────────────────────

async function handleGetEntry(dateKey) {
  if (!isValidDateKey(dateKey)) return plainResponse(400, 'Invalid dateKey');
  const row = await getEntryRow(dateKey);
  if (row && row.sprintId != null) {
    return jsonResponse(200, { dateKey, habitValuesById: row.habitValuesById, sprintId: row.sprintId });
  }
  // No row → look up the covering sprint so the client still gets a sprintId for boot.
  const sprints = await queryAllSprintDefs();
  const cov = findCovering(sprints, dateKey);
  return jsonResponse(200, {
    dateKey,
    habitValuesById: row ? row.habitValuesById : {},
    sprintId: cov ? cov.id : null,
  });
}

async function handlePutEntry(dateKey, body) {
  if (!isValidDateKey(dateKey)) return plainResponse(400, 'Invalid dateKey');
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  const values = body.habitValuesById && typeof body.habitValuesById === 'object' ? body.habitValuesById : {};
  // One read covers both the covering-sprint lookup and the bounds bump.
  const [sprints, metaRow] = await Promise.all([queryAllSprintDefs(), getMetaRowRaw()]);
  const cov = findCovering(sprints, dateKey);
  if (Object.keys(values).length === 0) {
    await deleteEntryRow(dateKey);
    await recomputeBoundsAfterDelete(
      dateKey,
      () => findBoundEntry('asc'),
      () => findBoundEntry('desc'),
    );
    if (cov) await deleteSprintSummary(cov.id);
    return jsonResponse(200, { ok: true, deleted: true });
  }
  await putEntryRow(dateKey, values, cov ? cov.id : null);
  await bumpBoundsOnPut(dateKey, metaRow);
  if (cov) await deleteSprintSummary(cov.id);
  return jsonResponse(200, { ok: true });
}

module.exports = {
  entryItemToObject,
  getEntryRow,
  putEntryRow,
  deleteEntryRow,
  queryEntriesBetween,
  findBoundEntry,
  handleGetEntry,
  handlePutEntry,
};
