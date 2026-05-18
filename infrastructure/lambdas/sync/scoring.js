/**
 * Compute earned points for one entry, using the sprint's habit definitions to
 * weight booleans + count habits. Mirrors `app/scripts/core.js → habitEarned`
 * so server-computed totals match the client.
 *
 * Count habits with `dailyLimit = 0` are unlimited (no upper clamp on units).
 */
function pointsForEntry(habitValuesById, sprint) {
  if (!habitValuesById) return 0;
  let pts = 0;
  for (const h of sprint.habitDefinitions || []) {
    if (!h || !h.scoring) continue;
    const v = habitValuesById[h.id];
    if (v == null) continue;
    if (h.kind === 'boolean') {
      if (v) pts += Number(h.scoring.points) || 0;
    } else {
      const limit = Number(h.scoring.dailyLimit) || 0;
      const ppu = Number(h.scoring.pointsPerUnit) || 0;
      const n = limit > 0 ? Math.max(0, Math.min(Number(v) || 0, limit)) : Math.max(0, Number(v) || 0);
      pts += n * ppu;
    }
  }
  return pts;
}

module.exports = { pointsForEntry };
