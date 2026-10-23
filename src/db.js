'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Accepted spellings of the name, keyed by lowercase form.
const SPELLINGS = {
  caleb: 'Caleb',
  kaleb: 'Kaleb',
  calib: 'Calib',
  kalib: 'Kalib',
  cayleb: 'Cayleb',
  kayleb: 'Kayleb',
  caileb: 'Caileb',
  kaileb: 'Kaileb',
  calev: 'Calev',
  kalev: 'Kalev',
  calebe: 'Calebe',
};

const LIMITS = {
  surname: 60,
  location: 80,
  country: 60,
  occupation: 80,
  bio: 500,
  website: 200,
};

const PUBLIC_COLUMNS =
  'number, spelling, surname, location, country, birth_year, occupation, bio, website, created_at, updated_at';

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calebs (
      number      INTEGER PRIMARY KEY AUTOINCREMENT,
      spelling    TEXT NOT NULL,
      surname     TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      country     TEXT NOT NULL DEFAULT '',
      birth_year  INTEGER,
      occupation  TEXT NOT NULL DEFAULT '',
      bio         TEXT NOT NULL DEFAULT '',
      website     TEXT NOT NULL DEFAULT '',
      token_hash  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  return db;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokensMatch(token, hash) {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Validates and normalizes registration input. Returns { value } or { errors }.
// With partial = true, only the fields present in input are checked (for edits).
function validate(input, { partial = false } = {}) {
  const errors = [];
  const value = {};
  const has = (k) => input[k] !== undefined && input[k] !== null;

  if (!partial || has('first_name')) {
    const first = String(input.first_name ?? '').trim().toLowerCase();
    if (!SPELLINGS[first]) {
      errors.push('first_name must be Caleb (or a recognized spelling such as Kaleb or Calev).');
    } else {
      value.spelling = SPELLINGS[first];
    }
  }

  for (const [field, max] of Object.entries(LIMITS)) {
    if (!has(field)) continue;
    const s = String(input[field]).trim();
    if (s.length > max) errors.push(`${field} must be at most ${max} characters.`);
    value[field] = s;
  }

  if (value.website && !/^https?:\/\/[^\s]+$/i.test(value.website)) {
    errors.push('website must start with http:// or https://');
  }

  if (has('birth_year') && input.birth_year !== '') {
    const y = Number(input.birth_year);
    const now = new Date().getUTCFullYear();
    if (!Number.isInteger(y) || y < 1900 || y > now) {
      errors.push(`birth_year must be a year between 1900 and ${now}.`);
    } else {
      value.birth_year = y;
    }
  } else if (has('birth_year')) {
    value.birth_year = null;
  }

  return errors.length ? { errors } : { value };
}

function register(db, value) {
  const token = crypto.randomBytes(18).toString('base64url');
  const row = db
    .prepare(
      `INSERT INTO calebs (spelling, surname, location, country, birth_year, occupation, bio, website, token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${PUBLIC_COLUMNS}`
    )
    .get(
      value.spelling,
      value.surname ?? '',
      value.location ?? '',
      value.country ?? '',
      value.birth_year ?? null,
      value.occupation ?? '',
      value.bio ?? '',
      value.website ?? '',
      hashToken(token)
    );
  return { caleb: { ...row }, token };
}

function get(db, number) {
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM calebs WHERE number = ?`).get(number);
  return row ? { ...row } : null;
}

function list(db, { q = '', spelling = '', country = '', sort = 'number', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push(`(surname LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR country LIKE ? ESCAPE '\\'
                 OR occupation LIKE ? ESCAPE '\\' OR bio LIKE ? ESCAPE '\\')`);
    const like = `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like, like, like);
  }
  if (spelling) {
    where.push('spelling = ?');
    params.push(spelling);
  }
  if (country) {
    where.push('country = ? COLLATE NOCASE');
    params.push(country);
  }
  const order =
    {
      number: 'number ASC',
      newest: 'number DESC',
      surname: "surname = '' , surname COLLATE NOCASE ASC, number ASC",
      oldest: 'birth_year IS NULL, birth_year ASC, number ASC',
    }[sort] || 'number ASC';
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM calebs ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM calebs ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, calebs: rows.map((r) => ({ ...r })) };
}

function update(db, number, value) {
  const fields = Object.keys(value);
  if (!fields.length) return get(db, number);
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(
    `UPDATE calebs SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE number = ?`
  ).run(...fields.map((f) => value[f]), number);
  return get(db, number);
}

function remove(db, number) {
  return db.prepare('DELETE FROM calebs WHERE number = ?').run(number).changes > 0;
}

function tokenHash(db, number) {
  const row = db.prepare('SELECT token_hash FROM calebs WHERE number = ?').get(number);
  return row ? row.token_hash : null;
}

function stats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM calebs').get().n;
  const bySpelling = db
    .prepare('SELECT spelling AS label, COUNT(*) AS n FROM calebs GROUP BY spelling ORDER BY n DESC, label')
    .all();
  const byCountry = db
    .prepare(
      `SELECT country AS label, COUNT(*) AS n FROM calebs WHERE country != ''
       GROUP BY country COLLATE NOCASE ORDER BY n DESC, label LIMIT 10`
    )
    .all();
  const byDecade = db
    .prepare(
      `SELECT (birth_year / 10) * 10 AS label, COUNT(*) AS n FROM calebs
       WHERE birth_year IS NOT NULL GROUP BY label ORDER BY label`
    )
    .all();
  const latest = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM calebs ORDER BY number DESC LIMIT 5`).all();
  const plain = (rows) => rows.map((r) => ({ ...r }));
  return {
    total,
    bySpelling: plain(bySpelling),
    byCountry: plain(byCountry),
    byDecade: plain(byDecade),
    latest: plain(latest),
  };
}

module.exports = {
  SPELLINGS,
  open,
  validate,
  register,
  get,
  list,
  update,
  remove,
  tokenHash,
  tokensMatch,
  stats,
};
