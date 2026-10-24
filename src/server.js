'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const geo = require('./geo');
const { mailerFromEnv } = require('./mail');

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
  '/messages': 'member',
  '/nearby': 'member',
  '/admin': 'admin',
  '/notify': 'admin',
  '/email': 'public',
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

// The visitor's address, used for rate limits. Behind a reverse proxy the connection
// comes from the proxy, so the address must come from a header the proxy sets:
// - `header`: a header the host's proxy always sets itself (Fly.io: Fly-Client-IP).
// - `hops`: otherwise, each proxy appends the address it received the request from
//   to X-Forwarded-For, so with `hops` trusted proxies the visitor is the hops-th
//   entry from the end. Entries further left can be forged by the visitor.
function clientIp(req, { header, hops } = {}) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (header) return String(req.headers[header.toLowerCase()] || '').trim() || remote;
  if (!hops) return remote;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain.length ? chain[Math.max(chain.length - hops, 0)] : remote;
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
  proxy = { header: process.env.CLIENT_IP_HEADER, hops: Number(process.env.TRUST_PROXY_HOPS) || 0 },
  mailer = mailerFromEnv(),
  publicUrl = process.env.PUBLIC_URL,
  messageLimit = rateLimiter({ max: 60, windowMs: 60 * 60 * 1000 }),
  confirmationLimit = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 }),
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
      ? { ...member, unread_messages: store.unreadCount(db, member.id), email_available: Boolean(mailer) }
      : { ...member, vouch_count: store.vouchCount(db, member.id), vouches_required: vouchesRequired };
  }

  // Messaging needs a listing, so the other person can see who wrote and reply.
  function requireListed(ctx) {
    const m = requireVerified(ctx);
    if (m.number === null) throw new HttpError(403, 'Create your Caleb listing on the Account page first.');
    return m;
  }

  // The site's address, for links in emails.
  function siteUrl(ctx) {
    return (publicUrl || `${secureCookies ? 'https' : 'http'}://${ctx.req.headers.host}`).replace(/\/+$/, '');
  }

  function emailLink(ctx, action, token) {
    return `${siteUrl(ctx)}/email?action=${action}&t=${encodeURIComponent(token)}`;
  }

  async function sendConfirmation(ctx, member) {
    if (!mailer) return 'unavailable';
    if (!confirmationLimit(String(member.id))) throw new HttpError(429, 'Too many confirmation emails. Try again later.');
    await mailer.send({
      to: member.email,
      subject: 'Confirm your email for The Caleb Index',
      text:
        `Hi ${member.spelling || member.username},\n\n` +
        `Please confirm this address to get email notifications from The Caleb Index:\n\n` +
        `${emailLink(ctx, 'confirm', store.emailToken(db, member.id))}\n\n` +
        `If you didn't ask for this, you can ignore this email and you won't hear from us.`,
    });
    return 'sent';
  }

  // Emails an announcement to every confirmed, opted-in member, one at a time, and
  // records how many were delivered. Runs after the request has been answered.
  async function emailAnnouncement(ctx, id, { subject, body }) {
    let sent = 0;
    let failed = 0;
    for (const r of store.emailRecipients(db)) {
      const unsubscribeUrl = emailLink(ctx, 'unsubscribe', r.token);
      try {
        await mailer.send({
          to: r.email,
          subject,
          text:
            `${body}\n\n--\nYou're receiving this because you opted in to email notifications ` +
            `from The Caleb Index.\nUnsubscribe: ${unsubscribeUrl}`,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`Announcement ${id}: could not email member ${r.id}: ${err.message}`);
      }
      store.recordEmailResult(db, id, { sent, failed });
    }
  }

  function textField(value, name, max) {
    const s = String(value ?? '').trim();
    if (!s) throw new HttpError(422, 'Please fix the highlighted fields.', [`${name} is required.`]);
    if (s.length > max) throw new HttpError(422, 'Please fix the highlighted fields.', [`${name} must be at most ${max} characters.`]);
    return s;
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
      // A verified account without a listing (the owner, created from settings)
      // joins the index with the next Caleb Number once it adds its name.
      if (updated.status === 'verified' && updated.number === null && updated.spelling) {
        store.verify(db, m.id, updated.verification_method);
      }
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

    'PUT /api/me/email': async (ctx) => {
      const m = requireVerified(ctx);
      const email = String(ctx.body.email ?? '').trim();
      if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        throw new HttpError(422, 'Please fix the highlighted fields.', ['email must be a valid email address.']);
      }
      const { member, needsConfirmation } = store.setEmail(db, m.id, { email, optIn: ctx.body.opt_in === true });
      const confirmation = needsConfirmation ? await sendConfirmation(ctx, member) : 'not_needed';
      return { member: me(member), confirmation };
    },

    'POST /api/me/email/confirmation': async (ctx) => {
      const m = requireVerified(ctx);
      if (!m.email || !m.email_opt_in || m.email_confirmed) throw new HttpError(400, 'There is nothing to confirm.');
      return { confirmation: await sendConfirmation(ctx, m) };
    },

    // Links in emails land on /email, which posts the token here. No login needed.
    'POST /api/email/confirm': (ctx) => {
      const member = store.confirmEmail(db, ctx.body.token);
      if (!member) throw new HttpError(404, 'That confirmation link is no longer valid.');
      return { email: member.email };
    },

    'POST /api/email/unsubscribe': (ctx) => {
      const member = store.unsubscribe(db, ctx.body.token);
      if (!member) throw new HttpError(404, 'That unsubscribe link is no longer valid.');
      return { email: member.email };
    },

    'GET /api/messages': (ctx) => {
      const m = requireVerified(ctx);
      return { conversations: store.conversations(db, m.id), unread: store.unreadCount(db, m.id) };
    },

    'GET /api/messages/:n': (ctx) => {
      const m = requireVerified(ctx);
      const other = memberByNumber(ctx.param);
      return { with: store.get(db, other.number), messages: store.thread(db, m.id, other.id) };
    },

    'POST /api/messages/:n': (ctx) => {
      const m = requireListed(ctx);
      const other = memberByNumber(ctx.param);
      if (other.id === m.id) throw new HttpError(400, 'You cannot message yourself.');
      const body = textField(ctx.body.body, 'message', store.MESSAGE_LIMIT);
      if (!messageLimit(String(m.id))) throw new HttpError(429, 'You are sending messages too quickly. Try again later.');
      return new Reply(201, { message: { ...store.sendMessage(db, m.id, other.id, body), from_me: 1 } });
    },

    'GET /api/nearby': (ctx) => {
      const m = requireVerified(ctx);
      const radius = Number(ctx.url.searchParams.get('radius'));
      if (![5, 10, 25].includes(radius)) throw new HttpError(422, 'radius must be 5, 10 or 25 miles.');
      const here = store.location(db, m.id);
      if (!here) return { located: false, calebs: [] };
      const calebs = store
        .locatedMembers(db)
        .filter((c) => c.id !== m.id)
        .map(({ id, latitude, longitude, ...c }) => ({
          ...c,
          distance_miles: Math.round(geo.distanceMiles(here, { lat: latitude, lon: longitude }) * 10) / 10,
        }))
        .filter((c) => c.distance_miles <= radius)
        .sort((a, b) => a.distance_miles - b.distance_miles || a.number - b.number);
      return { located: true, calebs };
    },

    'GET /api/announcements': (ctx) => {
      requireVerified(ctx);
      return {
        announcements: store.announcements(db, { limit: 10 }).map(({ emailed, email_sent, email_failed, ...a }) => a),
      };
    },

    'GET /api/admin/announcements': (ctx) => {
      requireAdmin(ctx);
      return {
        announcements: store.announcements(db),
        email: { configured: Boolean(mailer), recipients: store.emailRecipients(db).length },
      };
    },

    'POST /api/admin/announcements': (ctx) => {
      const admin = requireAdmin(ctx);
      const subject = textField(ctx.body.subject, 'subject', 150);
      const body = textField(ctx.body.body, 'message', 5000);
      const emailed = ctx.body.send_email === true && Boolean(mailer);
      const id = store.createAnnouncement(db, { senderId: admin.id, subject, body, emailed });
      const recipients = emailed ? store.emailRecipients(db).length : 0;
      if (emailed) emailAnnouncement(ctx, id, { subject, body }).catch((err) => console.error(err));
      return new Reply(201, { id, emailing: recipients });
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
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('ok');
    }
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const ctx = {
        req,
        res,
        url,
        token,
        member: store.sessionMember(db, token),
        ip: clientIp(req, proxy),
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
      // A bad owner setting is logged, not fatal: the site keeps running and the
      // owner account is created on the next restart once the setting is fixed.
      try {
        const admin = await store.ensureAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
        console.log(`Admin account: ${admin.username}`);
      } catch (err) {
        console.error(`Could not set up the owner account "${process.env.ADMIN_USERNAME}": ${err.message}`);
      }
    } else {
      console.warn('ADMIN_USERNAME is not set: nobody will be able to verify new members.');
    }
    const server = createServer({ db }).listen(port, () => {
      console.log(`Caleb Index listening on http://localhost:${port}`);
    });
    // Hosts stop the old instance on every deploy (Render with SIGTERM, Fly.io with
    // SIGINT): finish in-flight requests and close the database cleanly.
    const shutdown = () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 4_000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createServer, rateLimiter, clientIp };
