'use strict';
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
} = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({});
const CYCLES_TABLE = process.env.CYCLES_TABLE_NAME;
const ENTRIES_TABLE = process.env.ENTRIES_TABLE_NAME;
const CF_SECRET = process.env.CF_SECRET;

// ── User namespace ────────────────────────────────────────────────────
// Single-user today, but every DDB key is prefixed so multi-user is a one-line
// change: replace USER_ID with a per-request lookup of req.headers / auth context.
const USER_ID = 'main';
function userKey(suffix) { return `${USER_ID}#${suffix}`; }
const PK_DAY = userKey('DAY');
const PK_CYCLE_DEF = userKey('CYCLE_DEF');
const PK_CYCLE_SUM = userKey('CYCLE_SUM');
const META_ROW_ID = USER_ID; // cycles table row id == userId

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function todayKey() { return new Date().toISOString().slice(0, 10); }

function jsonResponse(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) };
}
function plainResponse(statusCode, text) {
  return { statusCode, headers: { 'Content-Type': 'text/plain' }, body: text };
}

function getBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function safeJsonParseObject(s) {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function isValidDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isValidYyyymm(s) { return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s); }
function isValidCycleId(v) { return Number.isInteger(v) && v >= 1; }
function parseCycleIdParam(s) { const n = Number(s); return isValidCycleId(n) ? n : null; }

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
function clampToToday(dateKey) { const t = todayKey(); return dateKey > t ? t : dateKey; }
function quantize(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// ── Meta row (per-user) ───────────────────────────────────────────────

async function getMetaRowRaw() {
  const out = await client.send(new GetItemCommand({ TableName: CYCLES_TABLE, Key: { id: { S: META_ROW_ID } } }));
  return out.Item || null;
}

function parseBounds(item) {
  return {
    min: item && item.entryDateMin ? item.entryDateMin.S : null,
    max: item && item.entryDateMax ? item.entryDateMax.S : null,
  };
}

function nextCycleIdFromRow(row) {
  const n = row && row.nextCycleId ? Number(row.nextCycleId.N) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function bumpNextCycleId() {
  // Atomic increment-and-fetch; returns the id that was just claimed.
  const out = await client.send(new UpdateItemCommand({
    TableName: CYCLES_TABLE,
    Key: { id: { S: META_ROW_ID } },
    UpdateExpression: 'SET nextCycleId = if_not_exists(nextCycleId, :start) + :one, updatedAt = :u',
    ExpressionAttributeValues: { ':one': { N: '1' }, ':start': { N: '0' }, ':u': { S: nowIso() } },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number(out.Attributes.nextCycleId.N); // already incremented; we want the value before — see callers
}

// We instead use a read-modify-write pattern that returns the id BEFORE incrementing:
async function claimNextCycleId() {
  const row = await getMetaRowRaw();
  const id = nextCycleIdFromRow(row);
  await client.send(new UpdateItemCommand({
    TableName: CYCLES_TABLE,
    Key: { id: { S: META_ROW_ID } },
    UpdateExpression: 'SET nextCycleId = :next, updatedAt = :u',
    ExpressionAttributeValues: { ':next': { N: String(id + 1) }, ':u': { S: nowIso() } },
  }));
  return id;
}

// ── Migration (idempotent, runs at most once per cold migration window) ─

let migrationDone = false;

async function ensureMigrated() {
  if (migrationDone) return;
  const row = await getMetaRowRaw();
  let needSplit = false;
  let needLegacyEntryRewrite = false;
  let needLegacySummaryRewrite = false;
  if (row && row.cyclesJson && row.cyclesJson.S) needSplit = true;
  // Detect legacy entry rows (no userId prefix).
  const legacyEntries = await client.send(new QueryCommand({
    TableName: ENTRIES_TABLE,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'pk' },
    ExpressionAttributeValues: { ':p': { S: 'DAY' } },
    Limit: 1,
  }));
  if (legacyEntries.Items && legacyEntries.Items.length) needLegacyEntryRewrite = true;
  const legacySummaries = await client.send(new QueryCommand({
    TableName: ENTRIES_TABLE,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'pk' },
    ExpressionAttributeValues: { ':p': { S: 'CYCLE' } },
    Limit: 1,
  }));
  if (legacySummaries.Items && legacySummaries.Items.length) needLegacySummaryRewrite = true;
  if (!needSplit && !needLegacyEntryRewrite && !needLegacySummaryRewrite) {
    migrationDone = true;
    return;
  }

  // ── Split cyclesJson blob into per-cycle CYCLE_DEF rows ──
  if (needSplit) {
    let cycles = [];
    try { cycles = JSON.parse(row.cyclesJson.S); } catch {}
    if (!Array.isArray(cycles)) cycles = [];
    cycles.sort((a, b) => String(a && a.startDate).localeCompare(String(b && b.startDate)));
    // Prior migration already assigned integer ids, but be defensive.
    const allIntIds = cycles.every((c) => c && Number.isInteger(c.id) && c.id >= 1);
    if (!allIntIds) for (let i = 0; i < cycles.length; i++) cycles[i].id = i + 1;
    const writes = cycles.map((c) => ({
      PutRequest: {
        Item: {
          pk: { S: PK_CYCLE_DEF },
          dateKey: { S: String(c.id) },
          startDate: { S: c.startDate },
          endDate: { S: c.endDate },
          lengthDays: { N: String(Number(c.lengthDays) || 0) },
          ...(c.pointStep != null ? { pointStep: { N: String(Number(c.pointStep) || 1) } } : {}),
          bodyJson: { S: JSON.stringify({ categories: c.categories || [], habitDefinitions: c.habitDefinitions || [] }) },
          updatedAt: { S: nowIso() },
        },
      },
    }));
    if (writes.length) await batchWrite(ENTRIES_TABLE, writes);
    // Strip cyclesJson; keep nextCycleId/bounds.
    const meta = {
      id: { S: META_ROW_ID },
      nextCycleId: { N: String(Math.max(cycles.length + 1, nextCycleIdFromRow(row))) },
      updatedAt: { S: nowIso() },
    };
    if (row.entryDateMin) meta.entryDateMin = row.entryDateMin;
    if (row.entryDateMax) meta.entryDateMax = row.entryDateMax;
    await client.send(new PutItemCommand({ TableName: CYCLES_TABLE, Item: meta }));
  }

  // ── Rewrite legacy DAY entries to userId-prefixed pk ──
  if (needLegacyEntryRewrite) {
    // Build cycleId lookup so each migrated entry gets stamped with its covering cycle.
    const defs = await queryAllCycleDefs();
    let ExclusiveStartKey;
    do {
      const resp = await client.send(new QueryCommand({
        TableName: ENTRIES_TABLE,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'pk' },
        ExpressionAttributeValues: { ':p': { S: 'DAY' } },
        ExclusiveStartKey,
      }));
      const reqs = [];
      for (const it of resp.Items || []) {
        const dk = it.dateKey && it.dateKey.S;
        if (!dk) continue;
        const raw = (it.valuesJson && it.valuesJson.S) || (it.habitValuesJson && it.habitValuesJson.S) || '';
        const cycle = findCovering(defs, dk);
        const item = {
          pk: { S: PK_DAY },
          dateKey: { S: dk },
          valuesJson: { S: raw || '{}' },
          updatedAt: { S: nowIso() },
        };
        if (cycle) item.cycleId = { N: String(cycle.id) };
        reqs.push({ PutRequest: { Item: item } });
        reqs.push({ DeleteRequest: { Key: { pk: { S: 'DAY' }, dateKey: { S: dk } } } });
      }
      if (reqs.length) await batchWrite(ENTRIES_TABLE, reqs);
      ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  // ── Rewrite legacy CYCLE summaries to userId-prefixed pk ──
  if (needLegacySummaryRewrite) {
    let ExclusiveStartKey;
    do {
      const resp = await client.send(new QueryCommand({
        TableName: ENTRIES_TABLE,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'pk' },
        ExpressionAttributeValues: { ':p': { S: 'CYCLE' } },
        ExclusiveStartKey,
      }));
      const reqs = [];
      for (const it of resp.Items || []) {
        const sk = it.dateKey && it.dateKey.S;
        if (!sk) continue;
        const item = {
          pk: { S: PK_CYCLE_SUM },
          dateKey: { S: sk },
          ...(it.startDate ? { startDate: it.startDate } : {}),
          ...(it.endDate ? { endDate: it.endDate } : {}),
          ...(it.pts ? { pts: it.pts } : {}),
          ...(it.max ? { max: it.max } : {}),
          ...(it.days ? { days: it.days } : {}),
          updatedAt: { S: nowIso() },
        };
        reqs.push({ PutRequest: { Item: item } });
        reqs.push({ DeleteRequest: { Key: { pk: { S: 'CYCLE' }, dateKey: { S: sk } } } });
      }
      if (reqs.length) await batchWrite(ENTRIES_TABLE, reqs);
      ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  migrationDone = true;
}

// ── Generic batch write ───────────────────────────────────────────────

async function batchWrite(tableName, requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let batch = requests.slice(i, i + 25);
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await client.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: batch } }));
      const un = res.UnprocessedItems && res.UnprocessedItems[tableName];
      if (!un || un.length === 0) break;
      batch = un;
      await sleep(40 * (attempt + 1));
    }
  }
}

// ── Cycle definitions (per-row) ──────────────────────────────────────

function cycleItemToObject(item) {
  const body = safeJsonParseObject(item.bodyJson && item.bodyJson.S);
  return {
    id: Number(item.dateKey.S),
    startDate: item.startDate ? item.startDate.S : null,
    endDate: item.endDate ? item.endDate.S : null,
    lengthDays: item.lengthDays ? Number(item.lengthDays.N) : 0,
    pointStep: item.pointStep ? Number(item.pointStep.N) : undefined,
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
  };
}

function cycleObjectToItem(c) {
  const item = {
    pk: { S: PK_CYCLE_DEF },
    dateKey: { S: String(c.id) },
    startDate: { S: c.startDate },
    endDate: { S: c.endDate },
    lengthDays: { N: String(Number(c.lengthDays) || 0) },
    bodyJson: { S: JSON.stringify({ categories: c.categories || [], habitDefinitions: c.habitDefinitions || [] }) },
    updatedAt: { S: nowIso() },
  };
  if (c.pointStep != null) item.pointStep = { N: String(Number(c.pointStep) || 1) };
  return item;
}

async function getCycleDef(cycleId) {
  const out = await client.send(new GetItemCommand({
    TableName: ENTRIES_TABLE,
    Key: { pk: { S: PK_CYCLE_DEF }, dateKey: { S: String(cycleId) } },
  }));
  return out.Item ? cycleItemToObject(out.Item) : null;
}

async function putCycleDef(cycle) {
  await client.send(new PutItemCommand({ TableName: ENTRIES_TABLE, Item: cycleObjectToItem(cycle) }));
}

async function queryAllCycleDefs() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const resp = await client.send(new QueryCommand({
      TableName: ENTRIES_TABLE,
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'pk' },
      ExpressionAttributeValues: { ':p': { S: PK_CYCLE_DEF } },
      ExclusiveStartKey,
    }));
    for (const it of resp.Items || []) out.push(cycleItemToObject(it));
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return out;
}

function findCovering(cycles, dateKey) {
  return cycles.find((c) => c && c.startDate <= dateKey && dateKey <= c.endDate) || null;
}

// ── Entries (per-day) ─────────────────────────────────────────────────

function entryItemToObject(item) {
  const raw = (item.valuesJson && item.valuesJson.S) || (item.habitValuesJson && item.habitValuesJson.S) || '';
  return {
    dateKey: item.dateKey.S,
    habitValuesById: safeJsonParseObject(raw),
    cycleId: item.cycleId ? Number(item.cycleId.N) : null,
  };
}

async function getEntryRow(dateKey) {
  const out = await client.send(new GetItemCommand({
    TableName: ENTRIES_TABLE,
    Key: { pk: { S: PK_DAY }, dateKey: { S: dateKey } },
  }));
  return out.Item ? entryItemToObject(out.Item) : null;
}

async function putEntryRow(dateKey, habitValuesById, cycleId) {
  const item = {
    pk: { S: PK_DAY },
    dateKey: { S: dateKey },
    valuesJson: { S: JSON.stringify(habitValuesById || {}) },
    updatedAt: { S: nowIso() },
  };
  if (cycleId != null) item.cycleId = { N: String(cycleId) };
  await client.send(new PutItemCommand({ TableName: ENTRIES_TABLE, Item: item }));
}

async function deleteEntryRow(dateKey) {
  await client.send(new DeleteItemCommand({
    TableName: ENTRIES_TABLE,
    Key: { pk: { S: PK_DAY }, dateKey: { S: dateKey } },
  }));
}

async function queryEntriesBetween(from, to) {
  const out = {};
  if (!from || !to || from > to) return out;
  let ExclusiveStartKey;
  do {
    const resp = await client.send(new QueryCommand({
      TableName: ENTRIES_TABLE,
      KeyConditionExpression: '#p = :p AND #d BETWEEN :f AND :t',
      ExpressionAttributeNames: { '#p': 'pk', '#d': 'dateKey' },
      ExpressionAttributeValues: { ':p': { S: PK_DAY }, ':f': { S: from }, ':t': { S: to } },
      ProjectionExpression: 'dateKey, valuesJson, habitValuesJson, cycleId',
      ExclusiveStartKey,
    }));
    for (const it of resp.Items || []) {
      const dk = it.dateKey && it.dateKey.S;
      if (!dk) continue;
      out[dk] = entryItemToObject(it);
    }
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function findBoundEntry(direction) {
  const resp = await client.send(new QueryCommand({
    TableName: ENTRIES_TABLE,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'pk' },
    ExpressionAttributeValues: { ':p': { S: PK_DAY } },
    ProjectionExpression: 'dateKey',
    ScanIndexForward: direction === 'asc',
    Limit: 1,
  }));
  const it = (resp.Items || [])[0];
  return it && it.dateKey ? it.dateKey.S : null;
}

/** Single conditional UpdateItem that extends min/max in one round-trip. */
async function bumpBoundsOnPut(dateKey) {
  await client.send(new UpdateItemCommand({
    TableName: CYCLES_TABLE,
    Key: { id: { S: META_ROW_ID } },
    UpdateExpression:
      'SET entryDateMin = if_not_exists(entryDateMin, :d), entryDateMax = if_not_exists(entryDateMax, :d), updatedAt = :u',
    ExpressionAttributeValues: { ':d': { S: dateKey }, ':u': { S: nowIso() } },
  }));
  // Conditional extensions (run in parallel; failures = no-op when bound already wider).
  await Promise.all([
    client.send(new UpdateItemCommand({
      TableName: CYCLES_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression: 'SET entryDateMin = :d',
      ConditionExpression: ':d < entryDateMin',
      ExpressionAttributeValues: { ':d': { S: dateKey } },
    })).catch(() => {}),
    client.send(new UpdateItemCommand({
      TableName: CYCLES_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression: 'SET entryDateMax = :d',
      ConditionExpression: ':d > entryDateMax',
      ExpressionAttributeValues: { ':d': { S: dateKey } },
    })).catch(() => {}),
  ]);
}

async function recomputeBoundsAfterDelete(deletedDateKey) {
  const row = await getMetaRowRaw();
  const bounds = parseBounds(row);
  let { min, max } = bounds;
  let changed = false;
  if (deletedDateKey === min) { min = await findBoundEntry('asc'); changed = true; }
  if (deletedDateKey === max) { max = await findBoundEntry('desc'); changed = true; }
  if (!changed) return;
  const sets = []; const removes = [];
  const vals = { ':u': { S: nowIso() } };
  if (min) { sets.push('entryDateMin = :mn'); vals[':mn'] = { S: min }; } else removes.push('entryDateMin');
  if (max) { sets.push('entryDateMax = :mx'); vals[':mx'] = { S: max }; } else removes.push('entryDateMax');
  sets.push('updatedAt = :u');
  let UpdateExpression = 'SET ' + sets.join(', ');
  if (removes.length) UpdateExpression += ' REMOVE ' + removes.join(', ');
  await client.send(new UpdateItemCommand({ TableName: CYCLES_TABLE, Key: { id: { S: META_ROW_ID } }, UpdateExpression, ExpressionAttributeValues: vals }));
}

// ── Habit-points math ─────────────────────────────────────────────────

function maxPointsPerDay(cycle) {
  let m = 0;
  for (const h of (cycle.habitDefinitions || [])) {
    if (!h || !h.scoring) continue;
    if (h.kind === 'boolean') m += Number(h.scoring.points) || 0;
    else m += (Number(h.scoring.maxUnits) || 0) * (Number(h.scoring.pointsPerUnit) || 0);
  }
  return m;
}

function pointsForEntry(habitValuesById, cycle) {
  if (!habitValuesById) return 0;
  let pts = 0;
  for (const h of (cycle.habitDefinitions || [])) {
    if (!h || !h.scoring) continue;
    const v = habitValuesById[h.id];
    if (v == null) continue;
    if (h.kind === 'boolean') {
      if (v) pts += Number(h.scoring.points) || 0;
    } else {
      const n = Math.max(0, Math.min(Number(v) || 0, Number(h.scoring.maxUnits) || 0));
      pts += n * (Number(h.scoring.pointsPerUnit) || 0);
    }
  }
  return pts;
}

// ── Cycle summaries ───────────────────────────────────────────────────

async function getCycleSummary(cycleId) {
  const out = await client.send(new GetItemCommand({
    TableName: ENTRIES_TABLE,
    Key: { pk: { S: PK_CYCLE_SUM }, dateKey: { S: String(cycleId) } },
  }));
  if (!out.Item) return null;
  return summaryItemToObject(out.Item);
}

function summaryItemToObject(item) {
  return {
    cycleId: Number(item.dateKey.S),
    startDate: item.startDate ? item.startDate.S : null,
    endDate: item.endDate ? item.endDate.S : null,
    pts: item.pts ? Number(item.pts.N) : 0,
    max: item.max ? Number(item.max.N) : 0,
    days: item.days ? Number(item.days.N) : 0,
  };
}

async function putCycleSummary(s) {
  await client.send(new PutItemCommand({
    TableName: ENTRIES_TABLE,
    Item: {
      pk: { S: PK_CYCLE_SUM },
      dateKey: { S: String(s.cycleId) },
      startDate: { S: s.startDate },
      endDate: { S: s.endDate },
      pts: { N: String(quantize(s.pts)) },
      max: { N: String(quantize(s.max)) },
      days: { N: String(s.days) },
      updatedAt: { S: nowIso() },
    },
  }));
}

async function deleteCycleSummary(cycleId) {
  await client.send(new DeleteItemCommand({
    TableName: ENTRIES_TABLE,
    Key: { pk: { S: PK_CYCLE_SUM }, dateKey: { S: String(cycleId) } },
  }));
}

async function queryAllCycleSummaries() {
  const out = new Map();
  let ExclusiveStartKey;
  do {
    const resp = await client.send(new QueryCommand({
      TableName: ENTRIES_TABLE,
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'pk' },
      ExpressionAttributeValues: { ':p': { S: PK_CYCLE_SUM } },
      ExclusiveStartKey,
    }));
    for (const it of resp.Items || []) {
      const sk = it.dateKey && it.dateKey.S;
      if (!sk) continue;
      const s = summaryItemToObject(it);
      out.set(s.cycleId, s);
    }
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function computeCycleSummary(cycle) {
  const from = cycle.startDate;
  const to = clampToToday(cycle.endDate);
  if (from > to) {
    return { cycleId: cycle.id, startDate: cycle.startDate, endDate: cycle.endDate, pts: 0, max: 0, days: 0 };
  }
  const entries = await queryEntriesBetween(from, to);
  let pts = 0;
  for (const dk of Object.keys(entries)) pts += pointsForEntry(entries[dk].habitValuesById, cycle);
  const days = daysBetweenInclusive(from, to);
  const max = maxPointsPerDay(cycle) * days;
  return { cycleId: cycle.id, startDate: cycle.startDate, endDate: cycle.endDate, pts, max, days };
}

// ── Conditional orphan-habit sweep ───────────────────────────────────

/**
 * Strip habit ids from entries when those ids are orphaned (no cycle defines them).
 * Bounded query — only walks entries within the affected cycle's date range, and only
 * runs at all when `orphanIds` is non-empty. Returns the cycleIds whose summaries
 * should be invalidated (the affected cycle plus any whose entries got modified).
 */
async function sweepOrphanHabits(allCycles, orphanIds, scanFrom, scanTo) {
  if (!orphanIds || orphanIds.size === 0) return { removedHabitIds: [], affectedCycleIds: [] };
  const entries = await queryEntriesBetween(scanFrom, scanTo);
  const requests = [];
  const removedIds = new Set();
  const affectedCycleIds = new Set();
  let boundsDirty = false;
  for (const dk of Object.keys(entries)) {
    const e = entries[dk];
    let changed = false;
    for (const k of Object.keys(e.habitValuesById)) {
      if (orphanIds.has(k)) { delete e.habitValuesById[k]; changed = true; removedIds.add(k); }
    }
    if (!changed) continue;
    const cov = findCovering(allCycles, dk);
    if (cov) affectedCycleIds.add(cov.id);
    if (Object.keys(e.habitValuesById).length === 0) {
      requests.push({ DeleteRequest: { Key: { pk: { S: PK_DAY }, dateKey: { S: dk } } } });
      boundsDirty = true;
    } else {
      const item = {
        pk: { S: PK_DAY },
        dateKey: { S: dk },
        valuesJson: { S: JSON.stringify(e.habitValuesById) },
        updatedAt: { S: nowIso() },
      };
      if (e.cycleId != null) item.cycleId = { N: String(e.cycleId) };
      requests.push({ PutRequest: { Item: item } });
    }
  }
  if (requests.length) await batchWrite(ENTRIES_TABLE, requests);
  if (boundsDirty) {
    const min = await findBoundEntry('asc');
    const max = await findBoundEntry('desc');
    const sets = []; const removes = [];
    const vals = { ':u': { S: nowIso() } };
    if (min) { sets.push('entryDateMin = :mn'); vals[':mn'] = { S: min }; } else removes.push('entryDateMin');
    if (max) { sets.push('entryDateMax = :mx'); vals[':mx'] = { S: max }; } else removes.push('entryDateMax');
    sets.push('updatedAt = :u');
    let UpdateExpression = 'SET ' + sets.join(', ');
    if (removes.length) UpdateExpression += ' REMOVE ' + removes.join(', ');
    await client.send(new UpdateItemCommand({ TableName: CYCLES_TABLE, Key: { id: { S: META_ROW_ID } }, UpdateExpression, ExpressionAttributeValues: vals }));
  }
  return { removedHabitIds: [...removedIds], affectedCycleIds: [...affectedCycleIds] };
}

/**
 * Re-stamp cycleId on entries within a date-range delta (when a cycle's startDate or
 * endDate moved). Bounded — only walks entries in the symmetric difference of old and
 * new ranges.
 */
async function restampCycleIds(allCycles, from, to) {
  if (!from || !to || from > to) return;
  const entries = await queryEntriesBetween(from, to);
  const reqs = [];
  for (const dk of Object.keys(entries)) {
    const e = entries[dk];
    const cov = findCovering(allCycles, dk);
    const newCycleId = cov ? cov.id : null;
    if (e.cycleId === newCycleId) continue;
    const item = {
      pk: { S: PK_DAY },
      dateKey: { S: dk },
      valuesJson: { S: JSON.stringify(e.habitValuesById) },
      updatedAt: { S: nowIso() },
    };
    if (newCycleId != null) item.cycleId = { N: String(newCycleId) };
    reqs.push({ PutRequest: { Item: item } });
  }
  if (reqs.length) await batchWrite(ENTRIES_TABLE, reqs);
}

// ── Route handlers ───────────────────────────────────────────────────

async function handleGetCycle(cycleId) {
  if (!isValidCycleId(cycleId)) return plainResponse(400, 'Invalid cycleId');
  const cycle = await getCycleDef(cycleId);
  if (!cycle) return plainResponse(404, 'Not Found');
  return jsonResponse(200, cycle);
}

async function handlePutCycle(cycleId, body) {
  if (!isValidCycleId(cycleId)) return plainResponse(400, 'Invalid cycleId');
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  if (!isValidDateKey(body.startDate) || !isValidDateKey(body.endDate)) return plainResponse(400, 'Invalid dates');

  const oldCycle = await getCycleDef(cycleId);
  if (!oldCycle) return plainResponse(404, 'Cycle not found');

  const updated = {
    id: cycleId,
    startDate: body.startDate,
    endDate: body.endDate,
    lengthDays: body.lengthDays,
    pointStep: body.pointStep,
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
  };
  await putCycleDef(updated);

  // ── Conditional orphan sweep: only run when habit ids were actually removed AND
  // those ids aren't defined in any other cycle. Walks entries in the cycle's range only.
  const oldIds = new Set((oldCycle.habitDefinitions || []).map((h) => h && h.id).filter(Boolean));
  const newIds = new Set((updated.habitDefinitions || []).map((h) => h && h.id).filter(Boolean));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  let removedHabitIds = [];
  let affectedCycleIds = new Set([cycleId]);
  let allCycles = null;
  if (removed.length) {
    allCycles = await queryAllCycleDefs();
    const liveElsewhere = new Set();
    for (const c of allCycles) {
      if (c.id === cycleId) continue;
      for (const h of (c.habitDefinitions || [])) if (h && h.id) liveElsewhere.add(h.id);
    }
    const orphaned = new Set(removed.filter((id) => !liveElsewhere.has(id)));
    if (orphaned.size) {
      // Bound the sweep to the union of cycle ranges (all entries must fall within some
      // cycle's range, by construction). For typical edits this is the user's full data
      // window, but at least it isn't 1970..9999.
      const sweepFrom = allCycles[0] ? allCycles[0].startDate : updated.startDate;
      const sweepTo = allCycles[allCycles.length - 1] ? allCycles[allCycles.length - 1].endDate : updated.endDate;
      const sweep = await sweepOrphanHabits(allCycles, orphaned, sweepFrom, sweepTo);
      removedHabitIds = sweep.removedHabitIds;
      for (const id of sweep.affectedCycleIds) affectedCycleIds.add(id);
    }
  }

  // ── Re-stamp cycleId on entries whose covering cycle changed (date range moved). ──
  if (oldCycle.startDate !== updated.startDate || oldCycle.endDate !== updated.endDate) {
    if (!allCycles) allCycles = await queryAllCycleDefs();
    // Walk symmetric difference of [oldStart..oldEnd] and [newStart..newEnd].
    const oldF = oldCycle.startDate, oldT = oldCycle.endDate;
    const newF = updated.startDate, newT = updated.endDate;
    const lo = oldF < newF ? oldF : newF;
    const hi = oldT > newT ? oldT : newT;
    await restampCycleIds(allCycles, lo, hi);
  }

  await Promise.all([...affectedCycleIds].map(deleteCycleSummary));
  return jsonResponse(200, { ok: true, removedHabitIds });
}

async function handlePostCycle(body) {
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  if (!isValidDateKey(body.startDate) || !isValidDateKey(body.endDate)) return plainResponse(400, 'Invalid dates');
  const id = await claimNextCycleId();
  const cycle = {
    id,
    startDate: body.startDate,
    endDate: body.endDate,
    lengthDays: body.lengthDays,
    pointStep: body.pointStep,
    categories: body.categories || [],
    habitDefinitions: body.habitDefinitions || [],
  };
  await putCycleDef(cycle);
  // No entries yet reference this cycle, no sweep needed.
  return jsonResponse(201, cycle);
}

async function handleGetEntry(dateKey) {
  if (!isValidDateKey(dateKey)) return plainResponse(400, 'Invalid dateKey');
  const row = await getEntryRow(dateKey);
  if (row && row.cycleId != null) {
    return jsonResponse(200, { dateKey, habitValuesById: row.habitValuesById, cycleId: row.cycleId });
  }
  // No row, or row missing cycleId (legacy) → look up covering cycle.
  const cycles = await queryAllCycleDefs();
  const cov = findCovering(cycles, dateKey);
  return jsonResponse(200, {
    dateKey,
    habitValuesById: row ? row.habitValuesById : {},
    cycleId: cov ? cov.id : null,
  });
}

async function handlePutEntry(dateKey, body) {
  if (!isValidDateKey(dateKey)) return plainResponse(400, 'Invalid dateKey');
  if (!body || typeof body !== 'object') return plainResponse(400, 'Invalid body');
  const values = body.habitValuesById && typeof body.habitValuesById === 'object' ? body.habitValuesById : {};
  // Determine covering cycle so we can stamp it on the row and invalidate its summary.
  const cycles = await queryAllCycleDefs();
  const cov = findCovering(cycles, dateKey);
  if (Object.keys(values).length === 0) {
    await deleteEntryRow(dateKey);
    await recomputeBoundsAfterDelete(dateKey);
    if (cov) await deleteCycleSummary(cov.id);
    return jsonResponse(200, { ok: true, deleted: true });
  }
  await putEntryRow(dateKey, values, cov ? cov.id : null);
  await bumpBoundsOnPut(dateKey);
  if (cov) await deleteCycleSummary(cov.id);
  return jsonResponse(200, { ok: true });
}

async function handleTrendCycleDetail(cycleId) {
  if (!isValidCycleId(cycleId)) return plainResponse(400, 'Invalid cycleId');
  const cycle = await getCycleDef(cycleId);
  if (!cycle) return plainResponse(404, 'Not Found');
  const from = cycle.startDate;
  const to = clampToToday(cycle.endDate);
  // Pass a single-cycle list (sufficient: every entry in this range falls in this cycle).
  return jsonResponse(200, { from, to, buckets: await buildDailyBuckets(from, to, [cycle]) });
}

async function handleTrendMonth(yyyymm) {
  if (!isValidYyyymm(yyyymm)) return plainResponse(400, 'Invalid month');
  const [y, m] = yyyymm.split('-').map(Number);
  const first = `${yyyymm}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${yyyymm}-${String(lastDay).padStart(2, '0')}`;
  const from = first;
  const to = clampToToday(last);
  if (from > to) return jsonResponse(200, { from, to: from, buckets: [] });
  const cycles = await queryAllCycleDefs();
  return jsonResponse(200, { from, to, buckets: await buildDailyBuckets(from, to, cycles) });
}

async function buildDailyBuckets(from, to, cycles) {
  if (from > to) return [];
  const entries = await queryEntriesBetween(from, to);
  const buckets = [];
  let dk = from;
  while (dk <= to) {
    const cov = findCovering(cycles, dk);
    const max = cov ? maxPointsPerDay(cov) : 0;
    const e = entries[dk];
    const pts = (e && cov) ? pointsForEntry(e.habitValuesById, cov) : 0;
    buckets.push({ key: dk, pts: quantize(pts), max: quantize(max), days: 1 });
    dk = addDays(dk, 1);
  }
  return buckets;
}

async function handleTrendCycleSummary() {
  const [cycles, cached] = await Promise.all([queryAllCycleDefs(), queryAllCycleSummaries()]);
  // Compute missing summaries in parallel.
  const missing = cycles.filter((c) => c && c.id != null && !cached.has(c.id));
  const computed = await Promise.all(missing.map(async (c) => {
    const s = await computeCycleSummary(c);
    await putCycleSummary(s);
    return s;
  }));
  for (const s of computed) cached.set(s.cycleId, s);
  // Drop cached summaries for cycles that no longer exist.
  const liveIds = new Set(cycles.map((c) => c.id));
  const stale = [...cached.keys()].filter((id) => !liveIds.has(id));
  await Promise.all(stale.map(deleteCycleSummary));
  for (const id of stale) cached.delete(id);
  const out = [...cached.values()].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return jsonResponse(200, { summaries: out });
}

// ── Router ────────────────────────────────────────────────────────────

function matchPath(path) {
  if (!path) return null;
  if (path === '/api/trend/cycle-summary') return { kind: 'trend-summary' };
  let m = path.match(/^\/api\/trend\/cycle\/([^/]+)$/);
  if (m) return { kind: 'trend-cycle', cycleIdRaw: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/trend\/month\/(\d{4}-\d{2})$/);
  if (m) return { kind: 'trend-month', yyyymm: m[1] };
  if (path === '/api/cycle') return { kind: 'cycle-create' };
  m = path.match(/^\/api\/cycle\/([^/]+)$/);
  if (m) return { kind: 'cycle-item', cycleIdRaw: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/entry\/([^/]+)$/);
  if (m) return { kind: 'entry-item', dateKey: decodeURIComponent(m[1]) };
  return null;
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  if (!CF_SECRET || headers['x-cf-secret'] !== CF_SECRET) return plainResponse(403, 'Forbidden');
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
  const path = (event.requestContext && event.requestContext.http && event.requestContext.http.path) || event.rawPath || '';
  const route = matchPath(path);
  if (!route) return plainResponse(404, 'Not Found');

  try {
    await ensureMigrated();
    if (route.kind === 'cycle-create' && method === 'POST') return await handlePostCycle(getBody(event));
    if (route.kind === 'cycle-item') {
      const cid = parseCycleIdParam(route.cycleIdRaw);
      if (cid == null) return plainResponse(400, 'Invalid cycleId');
      if (method === 'GET') return await handleGetCycle(cid);
      if (method === 'PUT') return await handlePutCycle(cid, getBody(event));
    }
    if (route.kind === 'entry-item') {
      if (method === 'GET') return await handleGetEntry(route.dateKey);
      if (method === 'PUT') return await handlePutEntry(route.dateKey, getBody(event));
    }
    if (route.kind === 'trend-cycle' && method === 'GET') {
      const cid = parseCycleIdParam(route.cycleIdRaw);
      if (cid == null) return plainResponse(400, 'Invalid cycleId');
      return await handleTrendCycleDetail(cid);
    }
    if (route.kind === 'trend-month' && method === 'GET') return await handleTrendMonth(route.yyyymm);
    if (route.kind === 'trend-summary' && method === 'GET') return await handleTrendCycleSummary();
    return plainResponse(405, 'Method Not Allowed');
  } catch (err) {
    return jsonResponse(500, { error: 'internal', message: String(err && err.message || err) });
  }
};
