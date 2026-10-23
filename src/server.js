'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 16 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Fixed-window limiter for registrations, per client address.
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

function send(res, status, body, headers = {}) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

function readJson(req) {
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
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function parseNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'No such Caleb.');
  return n;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(rel)) rel += '.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, { error: 'Not found.' });
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer({ db, adminToken = process.env.ADMIN_TOKEN, registerLimit } = {}) {
  const allowRegistration = registerLimit || rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

  // An edit is allowed with the entry's own edit token, or the admin token.
  function authorize(req, number) {
    const token = req.headers['x-edit-token'];
    if (!token) throw new HttpError(401, 'Missing X-Edit-Token header.');
    if (adminToken && token === adminToken) return;
    const hash = store.tokenHash(db, number);
    if (!hash) throw new HttpError(404, 'No such Caleb.');
    if (!store.tokensMatch(token, hash)) throw new HttpError(403, 'That edit token does not match this entry.');
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'calebs', ':n']
    const method = req.method;

    if (parts[1] === 'stats' && parts.length === 2 && method === 'GET') {
      return send(res, 200, store.stats(db));
    }

    if (parts[1] === 'spellings' && parts.length === 2 && method === 'GET') {
      return send(res, 200, Object.values(store.SPELLINGS));
    }

    if (parts[1] !== 'calebs' || parts.length > 3) throw new HttpError(404, 'Not found.');

    if (parts.length === 2) {
      if (method === 'GET') {
        const p = url.searchParams;
        const limit = Math.min(Math.max(parseInt(p.get('limit'), 10) || 50, 1), 200);
        const offset = Math.max(parseInt(p.get('offset'), 10) || 0, 0);
        return send(
          res,
          200,
          store.list(db, {
            q: p.get('q') || '',
            spelling: p.get('spelling') || '',
            country: p.get('country') || '',
            sort: p.get('sort') || 'number',
            limit,
            offset,
          })
        );
      }
      if (method === 'POST') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!allowRegistration(ip)) throw new HttpError(429, 'Too many registrations from here. Try again later.');
        const body = await readJson(req);
        if (body.website_confirm) throw new HttpError(400, 'Registration rejected.'); // honeypot field
        const { value, errors } = store.validate(body);
        if (errors) throw new HttpError(422, 'Please fix the highlighted fields.', errors);
        const { caleb, token } = store.register(db, value);
        return send(res, 201, { caleb, token }, { Location: `/api/calebs/${caleb.number}` });
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    const number = parseNumber(parts[2]);
    if (method === 'GET') {
      const caleb = store.get(db, number);
      if (!caleb) throw new HttpError(404, 'No such Caleb.');
      return send(res, 200, caleb);
    }
    if (method === 'PATCH') {
      authorize(req, number);
      const body = await readJson(req);
      const { value, errors } = store.validate(body, { partial: true });
      if (errors) throw new HttpError(422, 'Please fix the highlighted fields.', errors);
      return send(res, 200, store.update(db, number, value));
    }
    if (method === 'DELETE') {
      authorize(req, number);
      if (!store.remove(db, number)) throw new HttpError(404, 'No such Caleb.');
      res.writeHead(204);
      return res.end();
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(req, res, url.pathname);
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
  const port = Number(process.env.PORT) || 3000;
  const db = store.open(process.env.DATABASE_PATH || path.join(__dirname, '..', 'calebs.db'));
  createServer({ db }).listen(port, () => {
    console.log(`Caleb Index listening on http://localhost:${port}`);
  });
}

module.exports = { createServer, rateLimiter };
