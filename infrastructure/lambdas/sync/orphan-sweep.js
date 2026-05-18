const { batchWrite } = require('./db');
const { ROWS_TABLE, PK_DAY } = require('./constants');
const { nowIso } = require('./utils');
const { findCovering } = require('./sprints');
const { queryEntriesBetween, findBoundEntry } = require('./entries');
const { writeBoundsExplicit } = require('./meta');

/**
 * Strip orphaned habit ids from entries within a date range, then update bounds if any
 * entries were deleted. Idempotent: if `orphanIds` is empty, returns immediately.
 *
 * @param {Array} allSprints — full list of sprint defs (used to attribute affected sprints)
 * @param {Set<string>} orphanIds — habit ids that no live sprint defines
 * @param {string} scanFrom / scanTo — date range to walk (inclusive)
 * @returns {Promise<{ removedHabitIds: string[], affectedSprintIds: number[] }>}
 */
async function sweepOrphanHabits(allSprints, orphanIds, scanFrom, scanTo) {
  if (!orphanIds || orphanIds.size === 0) {
    return { removedHabitIds: [], affectedSprintIds: [] };
  }
  const entries = await queryEntriesBetween(scanFrom, scanTo);
  const requests = [];
  const removedIds = new Set();
  const affectedSprintIds = new Set();
  let boundsDirty = false;
  for (const dk of Object.keys(entries)) {
    const e = entries[dk];
    let changed = false;
    for (const k of Object.keys(e.habitValuesById)) {
      if (orphanIds.has(k)) {
        delete e.habitValuesById[k];
        changed = true;
        removedIds.add(k);
      }
    }
    if (!changed) continue;
    const cov = findCovering(allSprints, dk);
    if (cov) affectedSprintIds.add(cov.id);
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
      if (e.sprintId != null) item.sprintId = { N: String(e.sprintId) };
      requests.push({ PutRequest: { Item: item } });
    }
  }
  if (requests.length) await batchWrite(ROWS_TABLE, requests);
  if (boundsDirty) {
    const min = await findBoundEntry('asc');
    const max = await findBoundEntry('desc');
    await writeBoundsExplicit(min, max);
  }
  return { removedHabitIds: [...removedIds], affectedSprintIds: [...affectedSprintIds] };
}

/** Re-stamp sprintId on entries inside a date range when a sprint's range moved. */
async function restampSprintIds(allSprints, from, to) {
  if (!from || !to || from > to) return;
  const entries = await queryEntriesBetween(from, to);
  const reqs = [];
  for (const dk of Object.keys(entries)) {
    const e = entries[dk];
    const cov = findCovering(allSprints, dk);
    const newSprintId = cov ? cov.id : null;
    if (e.sprintId === newSprintId) continue;
    const item = {
      pk: { S: PK_DAY },
      dateKey: { S: dk },
      valuesJson: { S: JSON.stringify(e.habitValuesById) },
      updatedAt: { S: nowIso() },
    };
    if (newSprintId != null) item.sprintId = { N: String(newSprintId) };
    reqs.push({ PutRequest: { Item: item } });
  }
  if (reqs.length) await batchWrite(ROWS_TABLE, reqs);
}

module.exports = { sweepOrphanHabits, restampSprintIds };
