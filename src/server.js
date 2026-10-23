'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 16 * 1024;
const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Who may load each page. Assets not listed here (CSS, JS, icons) are open to all.
const PAGES = {
  '/login': 'guest',
  '/register': 'guest',
  '/pending': 'applicant',
  '/': 'member',
  '/stats': 'member',
  '/caleb': 'member',
  '/account': 'member',
  '/applicants': 'member',
  '/admin': 'admin',
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Returned by a route handler to reply with a status other than 200.
class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}

// Fixed-window limiter, per key.
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function parseNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'No such Caleb.');
  return n;
}

// Where a visitor should be sent instead of a page they may not see, or null if allowed.
function pageRedirect(access, member, pathname) {
  const verified = member && member.status === 'verified';
  switch (access) {
    case 'guest':
      return member ? (verified ? '/' : '/pending') : null;
    case 'applicant':
      return !member ? '/login' : verified ? '/' : null;
    case 'member':
      if (!member) return pathname === '/' ? '/login' : `/login?next=${encodeURIComponent(pathname)}`;
      return verified ? null : '/pending';
    case 'admin':
      if (!member) return '/login';
      if (!verified) return '/pending';
      return store.isAdmin(member) ? null : '/';
    default:
      return null;
  }
}

function serveStatic(req, res, pathname, member) {
  const access = PAGES[pathname];
  if (access) {
    const target = pageRedirect(access, member, pathname);
    if (target) return redirect(res, target);
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || (file.endsWith('.html') && !access)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      ...(file.endsWith('.html') ? { 'Cache-Control': 'no-store' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer({
  db,
  secureCookies = process.env.COOKIE_SECURE === '1',
  vouchesRequired = Number(process.env.VOUCHES_REQUIRED) || 2,
  registerLimit = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 }),
  loginLimit = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
} = {}) {
  function sessionCookie(token, maxAge) {
    return [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      secureCookies && 'Secure',
    ]
      .filter(Boolean)
      .join('; ');
  }

  function startSession(res, member) {
    res.setHeader('Set-Cookie', sessionCookie(store.createSession(db, member.id), SESSION_MAX_AGE));
  }

  function requireMember(ctx) {
    if (!ctx.member) throw new HttpError(401, 'Please log in.');
    return ctx.member;
  }

  function requireVerified(ctx) {
    const m = requireMember(ctx);
    if (m.status !== 'verified') throw new HttpError(403, 'Your account is waiting for name verification.');
    return m;
  }

  function requireAdmin(ctx) {
    const m = requireVerified(ctx);
    if (!store.isAdmin(m)) throw new HttpError(403, 'Admins only.');
    return m;
  }

  // An account as its owner sees it, with vouching progress while they wait.
  function me(member) {
    return member.status === 'verified'
      ? member
      : { ...member, vouch_count: store.vouchCount(db, member.id), vouches_required: vouchesRequired };
  }

  function memberByNumber(raw) {
    const id = store.idForNumber(db, parseNumber(raw));
    const member = id && store.account(db, id);
    if (!member || member.status !== 'verified') throw new HttpError(404, 'No such Caleb.');
    return member;
  }

  function validated({ value, errors }) {
    if (errors) throw new HttpError(422, 'Please fix the highlighted fields.', errors);
    return value;
  }

  const routes = {
    'GET /api/spellings': () => Object.values(store.SPELLINGS),

    'GET /api/config': () => ({ vouchesRequired }),

    'POST /api/auth/register': async (ctx) => {
      if (!registerLimit(ctx.ip)) throw new HttpError(429, 'Too many sign-ups from here. Try again later.');
      const body = ctx.body;
      if (body.website_confirm) throw new HttpError(400, 'Registration rejected.'); // honeypot field
      const credentials = validated(store.validateCredentials(body));
      const profile = validated(store.validateProfile(body));
      let member;
      try {
        member = await store.createMember(db, credentials, profile);
      } catch (err) {
        if (err instanceof store.DuplicateUsername) throw new HttpError(409, 'That username is taken.');
        throw err;
      }
      startSession(ctx.res, member);
      return new Reply(201, { member });
    },

    'POST /api/auth/login': async (ctx) => {
      const { username, password } = ctx.body;
      const key = `${ctx.ip}|${String(username ?? '').toLowerCase()}`;
      if (!loginLimit(key)) throw new HttpError(429, 'Too many login attempts. Try again in a few minutes.');
      const member = await store.authenticate(db, username, password);
      if (!member) throw new HttpError(401, 'Wrong username or password.');
      startSession(ctx.res, member);
      return { member };
    },

    'POST /api/auth/logout': (ctx) => {
      store.endSession(db, ctx.token);
      ctx.res.setHeader('Set-Cookie', sessionCookie('', 0));
      return { ok: true };
    },

    'GET /api/me': (ctx) => ({ member: me(requireMember(ctx)) }),

    'PATCH /api/me': (ctx) => {
      const m = requireMember(ctx);
      const value = validated(store.validateProfile(ctx.body, { partial: true }));
      const updated = store.updateProfile(db, m.id, value);
      if (m.status === 'rejected') store.resubmit(db, m.id);
      return { member: me(store.account(db, updated.id)) };
    },

    'POST /api/me/password': async (ctx) => {
      const m = requireMember(ctx);
      const { current_password, new_password } = ctx.body;
      const row = await store.authenticate(db, m.username, current_password);
      if (!row) throw new HttpError(403, 'Your current password is incorrect.');
      const problem = store.validatePassword(new_password);
      if (problem) throw new HttpError(422, 'Please fix the highlighted fields.', [problem.replace('password', 'new_password')]);
      await store.setPassword(db, m.id, new_password);
      store.endOtherSessions(db, m.id, ctx.token);
      return { ok: true };
    },

    'DELETE /api/me': async (ctx) => {
      const m = requireMember(ctx);
      if (!(await store.authenticate(db, m.username, ctx.body.password))) {
        throw new HttpError(403, 'Your password is incorrect.');
      }
      if (m.role === 'owner') throw new HttpError(400, 'The owner account cannot be deleted.');
      store.removeMember(db, m.id);
      ctx.res.setHeader('Set-Cookie', sessionCookie('', 0));
      return { ok: true };
    },

    'GET /api/calebs': (ctx) => {
      requireVerified(ctx);
      const p = ctx.url.searchParams;
      return store.list(db, {
        q: p.get('q') || '',
        spelling: p.get('spelling') || '',
        country: p.get('country') || '',
        sort: p.get('sort') || 'number',
        limit: Math.min(Math.max(parseInt(p.get('limit'), 10) || 50, 1), 200),
        offset: Math.max(parseInt(p.get('offset'), 10) || 0, 0),
      });
    },

    'GET /api/calebs/:n': (ctx) => {
      requireVerified(ctx);
      const caleb = store.get(db, parseNumber(ctx.param));
      if (!caleb) throw new HttpError(404, 'No such Caleb.');
      return caleb;
    },

    'DELETE /api/calebs/:n': (ctx) => {
      const admin = requireAdmin(ctx);
      const target = memberByNumber(ctx.param);
      if (target.id === admin.id) throw new HttpError(400, 'You cannot remove your own account here.');
      if (target.role === 'owner') throw new HttpError(403, 'The owner account cannot be removed.');
      store.removeMember(db, target.id);
      return new Reply(204);
    },

    'PUT /api/calebs/:n/admin': (ctx) => {
      const admin = requireAdmin(ctx);
      const target = memberByNumber(ctx.param);
      if (typeof ctx.body.admin !== 'boolean') throw new HttpError(422, 'admin must be true or false.');
      if (target.id === admin.id) throw new HttpError(400, 'You cannot change your own admin permission.');
      if (target.role === 'owner') throw new HttpError(403, "The owner's admin permission cannot be changed.");
      const updated = store.setAdmin(db, target.id, ctx.body.admin);
      return { number: updated.number, is_admin: store.isAdmin(updated) };
    },

    'GET /api/applicants': (ctx) => {
      const m = requireVerified(ctx);
      return { applicants: store.applicants(db, m.id), vouchesRequired };
    },

    'POST /api/applicants/:n/vouch': (ctx) => {
      const m = requireVerified(ctx);
      if (m.number === null) throw new HttpError(403, 'Only members with a Caleb listing can vouch.');
      const applicant = store.vouch(db, parseNumber(ctx.param), m.id, vouchesRequired);
      if (!applicant) throw new HttpError(404, 'No pending applicant with that id.');
      return { verified: applicant.status === 'verified', vouch_count: store.vouchCount(db, applicant.id) };
    },

    'DELETE /api/applicants/:n/vouch': (ctx) => {
      const m = requireVerified(ctx);
      const applicant = store.unvouch(db, parseNumber(ctx.param), m.id);
      if (!applicant) throw new HttpError(404, 'No pending applicant with that id.');
      return { vouch_count: store.vouchCount(db, applicant.id) };
    },

    'GET /api/stats': (ctx) => {
      requireVerified(ctx);
      return store.stats(db);
    },

    'GET /api/admin/pending': (ctx) => {
      requireAdmin(ctx);
      return { applicants: store.pending(db) };
    },

    'POST /api/admin/members/:n/verify': (ctx) => {
      requireAdmin(ctx);
      const member = store.verify(db, parseNumber(ctx.param));
      if (!member) throw new HttpError(404, 'No such applicant.');
      return { member };
    },

    'POST /api/admin/members/:n/reject': (ctx) => {
      requireAdmin(ctx);
      const member = store.reject(db, parseNumber(ctx.param), ctx.body.reason);
      if (!member) throw new HttpError(404, 'No pending applicant with that id.');
      return { member };
    },
  };

  function route(method, pathname) {
    const parts = pathname.split('/');
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const pp = pattern.split('/');
      if (pp.length !== parts.length) continue;
      let param;
      if (pp.every((seg, i) => (seg === ':n' ? ((param = parts[i]), true) : seg === parts[i]))) {
        return { handler, param };
      }
    }
    return null;
  }

  async function api(ctx) {
    const { req, res } = ctx;
    const found = route(req.method, ctx.url.pathname);
    if (!found) throw new HttpError(404, 'Not found.');
    ctx.param = found.param;
    if (req.method !== 'GET') {
      // Requiring a JSON content type blocks cross-site form posts (CSRF).
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        throw new HttpError(415, 'Requests must be sent as application/json.');
      }
      ctx.body = parseJson(await readBody(req));
    }
    const result = await found.handler(ctx);
    const { status, body } = result instanceof Reply ? result : new Reply(200, result);
    if (status === 204) {
      res.writeHead(204);
      return res.end();
    }
    return send(res, status, body);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const ctx = {
        req,
        res,
        url,
        token,
        member: store.sessionMember(db, token),
        ip: req.socket.remoteAddress || 'unknown',
      };
      if (url.pathname.startsWith('/api/')) return await api(ctx);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, url.pathname, ctx.member);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      const status = err instanceof HttpError ? err.status : 500;
      const body = { error: status === 500 ? 'Something went wrong.' : err.message };
      if (err.details) body.details = err.details;
      if (!res.headersSent) send(res, status, body);
    }
  });
}

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 3000;
    const db = store.open(process.env.DATABASE_PATH || path.join(__dirname, '..', 'calebs.db'));
    if (process.env.ADMIN_USERNAME) {
      const admin = await store.ensureAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
      console.log(`Admin account: ${admin.username}`);
    } else {
      console.warn('ADMIN_USERNAME is not set: nobody will be able to verify new members.');
    }
    createServer({ db }).listen(port, () => {
      console.log(`Caleb Index listening on http://localhost:${port}`);
    });
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createServer, rateLimiter };
