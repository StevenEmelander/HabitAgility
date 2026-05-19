const crypto = require('node:crypto');

// Unlock hash is injected by CDK at deploy time (see infrastructure/lib/cert-stack.ts).
const UNLOCK_HASH = '__UNLOCK_HASH__';

// Constant-time hex-string compare. We're comparing 64-char SHA-256 hex outputs,
// so length is always equal and `crypto.timingSafeEqual` is well-defined.
// Network jitter dwarfs any timing signal in practice, but this is the right
// primitive and costs nothing.
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Reject anything that isn't a safe same-origin redirect target. CloudFront
// normalises `request.uri`, but defense-in-depth: only accept paths starting
// with a single `/`, no protocol-relative `//evil.com`.
function safeRedirectPath(uri) {
  if (typeof uri !== 'string') return '/';
  if (!uri.startsWith('/')) return '/';
  if (uri.startsWith('//')) return '/';
  if (uri.startsWith('/\\')) return '/';
  return uri;
}

function getCookies(request) {
  const raw = (request.headers.cookie || []).map((h) => h.value).join('; ');
  const result = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

/** CloudFront passes application/x-www-form-urlencoded style querystrings. URLSearchParams treats '+' as a space, which breaks base64-like unlock tokens that contain '+'. */
function getUnlockTokenRaw(querystring) {
  if (!querystring) return null;
  const needle = 'unlock=';
  const start = querystring.indexOf(needle);
  if (start === -1) return null;
  const i = start + needle.length;
  const amp = querystring.indexOf('&', i);
  const end = amp === -1 ? querystring.length : amp;
  const enc = querystring.slice(i, end);
  try {
    return decodeURIComponent(enc);
  } catch (_) {
    return enc;
  }
}

function removeUnlockParam(querystring) {
  if (!querystring) return '';
  return querystring
    .split('&')
    .filter((p) => {
      const eq = p.indexOf('=');
      const k = eq >= 0 ? p.slice(0, eq) : p;
      return k !== 'unlock';
    })
    .join('&');
}

// Cookie lifetime: 30 days (was 365). Shorter window bounds the impact of a
// leaked cookie; the user re-unlocks via bookmark/email URL after expiry.
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const cookies = getCookies(request);

  // Valid auth cookie — pass through (constant-time compare)
  if (safeEqualHex(cookies.htok, UNLOCK_HASH)) {
    if (request.querystring?.includes('unlock=')) {
      request.querystring = removeUnlockParam(request.querystring);
    }
    return request;
  }

  // Unlock via querystring: ?unlock=<token>
  const tok = getUnlockTokenRaw(request.querystring || '');
  if (tok) {
    const tokHash = crypto.createHash('sha256').update(tok).digest('hex');
    if (safeEqualHex(tokHash, UNLOCK_HASH)) {
      const qs = removeUnlockParam(request.querystring || '');
      const dest = safeRedirectPath(request.uri) + (qs ? '?' + qs : '');
      return {
        status: '302',
        statusDescription: 'Found',
        headers: {
          location: [{ key: 'Location', value: dest }],
          'set-cookie': [
            {
              key: 'Set-Cookie',
              value:
                'htok=' +
                UNLOCK_HASH +
                '; Path=/; Max-Age=' +
                COOKIE_MAX_AGE_SECONDS +
                '; HttpOnly; Secure; SameSite=Lax',
            },
          ],
          'cache-control': [{ key: 'Cache-Control', value: 'no-store, no-cache' }],
        },
      };
    }
  }

  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store, no-cache, private' }],
      'x-content-type-options': [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      'x-frame-options': [{ key: 'X-Frame-Options', value: 'DENY' }],
      'referrer-policy': [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    },
    body: '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>private</title><style>body{background:#0a0a0b;color:#4a4a55;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:13px;letter-spacing:0.1em}</style></head><body>private</body></html>',
  };
};
