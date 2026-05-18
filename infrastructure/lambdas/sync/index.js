const { CF_SECRET } = require('./constants');
const { jsonResponse, plainResponse, getBody, parseSprintIdParam } = require('./utils');
const { handleGetSprint, handlePutSprint, handlePostSprint } = require('./sprints');
const { handleGetEntry, handlePutEntry } = require('./entries');
const { handleTrendSprintDetail, handleTrendSprintSummary } = require('./summaries');

// ── Router ───────────────────────────────────────────────────────────

function matchPath(path) {
  if (!path) return null;
  if (path === '/api/trend/sprint-summary') return { kind: 'trend-summary' };
  let m = path.match(/^\/api\/trend\/sprint\/([^/]+)$/);
  if (m) return { kind: 'trend-sprint', sprintIdRaw: decodeURIComponent(m[1]) };
  if (path === '/api/sprint') return { kind: 'sprint-create' };
  m = path.match(/^\/api\/sprint\/([^/]+)$/);
  if (m) return { kind: 'sprint-item', sprintIdRaw: decodeURIComponent(m[1]) };
  m = path.match(/^\/api\/entry\/([^/]+)$/);
  if (m) return { kind: 'entry-item', dateKey: decodeURIComponent(m[1]) };
  return null;
}

// ── Lambda entrypoint ────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = event.headers || {};
  if (!CF_SECRET || headers['x-cf-secret'] !== CF_SECRET) return plainResponse(403, 'Forbidden');
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.requestContext?.http?.path || event.rawPath || '';
  const route = matchPath(path);
  if (!route) return plainResponse(404, 'Not Found');

  try {
    if (route.kind === 'sprint-create' && method === 'POST') return await handlePostSprint(getBody(event));
    if (route.kind === 'sprint-item') {
      const sid = parseSprintIdParam(route.sprintIdRaw);
      if (sid == null) return plainResponse(400, 'Invalid sprintId');
      if (method === 'GET') return await handleGetSprint(sid);
      if (method === 'PUT') return await handlePutSprint(sid, getBody(event));
    }
    if (route.kind === 'entry-item') {
      if (method === 'GET') return await handleGetEntry(route.dateKey);
      if (method === 'PUT') return await handlePutEntry(route.dateKey, getBody(event));
    }
    if (route.kind === 'trend-sprint' && method === 'GET') {
      const sid = parseSprintIdParam(route.sprintIdRaw);
      if (sid == null) return plainResponse(400, 'Invalid sprintId');
      return await handleTrendSprintDetail(sid);
    }
    if (route.kind === 'trend-summary' && method === 'GET') return await handleTrendSprintSummary();
    return plainResponse(405, 'Method Not Allowed');
  } catch (err) {
    return jsonResponse(500, { error: 'internal', message: String(err?.message || err) });
  }
};
