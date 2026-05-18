const { GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { client } = require('./db');
const { META_TABLE, META_ROW_ID } = require('./constants');
const { nowIso } = require('./utils');

// ── Meta row (per user) ──────────────────────────────────────────────
// One row in the META_TABLE per user holds:
//   - nextSprintId (atomic id allocator for sprint creation)
//   - entryDateMin / entryDateMax (extent of the user's entry range)
//   - updatedAt

async function getMetaRowRaw() {
  const out = await client.send(
    new GetItemCommand({
      TableName: META_TABLE,
      Key: { id: { S: META_ROW_ID } },
    }),
  );
  return out.Item || null;
}

function parseBounds(item) {
  return {
    min: item?.entryDateMin ? item.entryDateMin.S : null,
    max: item?.entryDateMax ? item.entryDateMax.S : null,
  };
}

function nextSprintIdFromRow(row) {
  const n = row?.nextSprintId ? Number(row.nextSprintId.N) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Read-modify-write that returns the id BEFORE incrementing nextSprintId. */
async function claimNextSprintId() {
  const row = await getMetaRowRaw();
  const id = nextSprintIdFromRow(row);
  await client.send(
    new UpdateItemCommand({
      TableName: META_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression: 'SET nextSprintId = :next, updatedAt = :u',
      ExpressionAttributeValues: { ':next': { N: String(id + 1) }, ':u': { S: nowIso() } },
    }),
  );
  return id;
}

/**
 * Extend entryDateMin / entryDateMax so they cover `dateKey`. Single conditional
 * UpdateItem (read-modify-write); caller may pass a pre-fetched meta row to skip
 * the read.
 */
async function bumpBoundsOnPut(dateKey, metaRow) {
  const row = metaRow || (await getMetaRowRaw());
  const currentMin = row?.entryDateMin ? row.entryDateMin.S : null;
  const currentMax = row?.entryDateMax ? row.entryDateMax.S : null;
  const nextMin = currentMin == null || dateKey < currentMin ? dateKey : currentMin;
  const nextMax = currentMax == null || dateKey > currentMax ? dateKey : currentMax;
  if (nextMin === currentMin && nextMax === currentMax) return; // already covered
  await client.send(
    new UpdateItemCommand({
      TableName: META_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression: 'SET entryDateMin = :mn, entryDateMax = :mx, updatedAt = :u',
      ExpressionAttributeValues: { ':mn': { S: nextMin }, ':mx': { S: nextMax }, ':u': { S: nowIso() } },
    }),
  );
}

/**
 * After deleting an entry, recompute bounds if the deleted date was at the min or max
 * edge. The actual min/max lookup is delegated to the caller (they have access to the
 * entries-table query helpers). Pass `lookupMin` / `lookupMax` as zero-arg async fns.
 */
async function recomputeBoundsAfterDelete(deletedDateKey, lookupMin, lookupMax) {
  const row = await getMetaRowRaw();
  const bounds = parseBounds(row);
  let { min, max } = bounds;
  let changed = false;
  if (deletedDateKey === min) {
    min = await lookupMin();
    changed = true;
  }
  if (deletedDateKey === max) {
    max = await lookupMax();
    changed = true;
  }
  if (!changed) return;
  const sets = [];
  const removes = [];
  const vals = { ':u': { S: nowIso() } };
  if (min) {
    sets.push('entryDateMin = :mn');
    vals[':mn'] = { S: min };
  } else removes.push('entryDateMin');
  if (max) {
    sets.push('entryDateMax = :mx');
    vals[':mx'] = { S: max };
  } else removes.push('entryDateMax');
  sets.push('updatedAt = :u');
  let UpdateExpression = 'SET ' + sets.join(', ');
  if (removes.length) UpdateExpression += ' REMOVE ' + removes.join(', ');
  await client.send(
    new UpdateItemCommand({
      TableName: META_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression,
      ExpressionAttributeValues: vals,
    }),
  );
}

/** Same shape as recomputeBoundsAfterDelete but takes an already-resolved {min, max}. */
async function writeBoundsExplicit(min, max) {
  const sets = [];
  const removes = [];
  const vals = { ':u': { S: nowIso() } };
  if (min) {
    sets.push('entryDateMin = :mn');
    vals[':mn'] = { S: min };
  } else removes.push('entryDateMin');
  if (max) {
    sets.push('entryDateMax = :mx');
    vals[':mx'] = { S: max };
  } else removes.push('entryDateMax');
  sets.push('updatedAt = :u');
  let UpdateExpression = 'SET ' + sets.join(', ');
  if (removes.length) UpdateExpression += ' REMOVE ' + removes.join(', ');
  await client.send(
    new UpdateItemCommand({
      TableName: META_TABLE,
      Key: { id: { S: META_ROW_ID } },
      UpdateExpression,
      ExpressionAttributeValues: vals,
    }),
  );
}

module.exports = {
  getMetaRowRaw,
  parseBounds,
  claimNextSprintId,
  bumpBoundsOnPut,
  recomputeBoundsAfterDelete,
  writeBoundsExplicit,
};
