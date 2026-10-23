'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

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
  verification_note: 500,
};

const SESSION_DAYS = 30;
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Fields any verified member may see in the directory.
const PUBLIC_COLUMNS =
  'number, spelling, surname, location, country, birth_year, occupation, bio, website, verified_at AS created_at, updated_at';

// Fields a member sees about their own account (and admins see when reviewing).
const ACCOUNT_COLUMNS =
  'id, username, role, status, review_note, verification_note, number, spelling, surname, location, country, birth_year, occupation, bio, website, created_at, updated_at, verified_at';

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash     TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
      verification_note TEXT NOT NULL DEFAULT '',
      review_note       TEXT NOT NULL DEFAULT '',
      number            INTEGER UNIQUE,
      spelling          TEXT NOT NULL DEFAULT '',
      surname           TEXT NOT NULL DEFAULT '',
      location          TEXT NOT NULL DEFAULT '',
      country           TEXT NOT NULL DEFAULT '',
      birth_year        INTEGER,
      occupation        TEXT NOT NULL DEFAULT '',
      bio               TEXT NOT NULL DEFAULT '',
      website           TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL DEFAULT (${NOW}),
      updated_at        TEXT NOT NULL DEFAULT (${NOW}),
      verified_at       TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL
    );
  `);
  return db;
}

const plain = (row) => (row ? { ...row } : null);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// --- Passwords -------------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [, salt, key] = String(stored).split('$');
  const expected = Buffer.from(key || '', 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt || '', 'base64'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Used when a username doesn't exist, so failed logins take the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// --- Validation ------------------------------------------------------------

function validateCredentials({ username, password }) {
  const errors = [];
  const u = String(username ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(u)) {
    errors.push('username must be 3–30 characters: letters, numbers, dots, dashes or underscores.');
  }
  const passwordError = validatePassword(password);
  if (passwordError) errors.push(passwordError);
  return errors.length ? { errors } : { value: { username: u, password: String(password) } };
}

function validatePassword(password) {
  const p = String(password ?? '');
  if (p.length < 10 || p.length > 200) return 'password must be between 10 and 200 characters.';
  return null;
}

// Validates and normalizes profile input. Returns { value } or { errors }.
// With partial = true, only the fields present in input are checked (for edits).
function validateProfile(input, { partial = false } = {}) {
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

  if (!partial && !value.verification_note) {
    errors.push('verification_note is required: tell us how we can confirm your name.');
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

// --- Members ---------------------------------------------------------------

class DuplicateUsername extends Error {}

async function createMember(db, { username, password }, profile = {}, { role = 'member' } = {}) {
  if (db.prepare('SELECT 1 FROM members WHERE username = ?').get(username)) throw new DuplicateUsername();
  const fields = { ...profile, username, password_hash: await hashPassword(password), role };
  const cols = Object.keys(fields);
  try {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO members (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => fields[c]));
    return account(db, Number(lastInsertRowid));
  } catch (err) {
    // Two sign-ups racing for the same name.
    if (/UNIQUE constraint failed: members.username/.test(err.message)) throw new DuplicateUsername();
    throw err;
  }
}

async function authenticate(db, username, password) {
  const row = db.prepare('SELECT id, password_hash FROM members WHERE username = ?').get(String(username ?? ''));
  const ok = await checkPassword(password, row ? row.password_hash : await DUMMY_HASH);
  return row && ok ? account(db, row.id) : null;
}

async function setPassword(db, id, password) {
  db.prepare(`UPDATE members SET password_hash = ?, updated_at = ${NOW} WHERE id = ?`).run(
    await hashPassword(password),
    id
  );
}

function account(db, id) {
  return plain(db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM members WHERE id = ?`).get(id));
}

function updateProfile(db, id, value) {
  const fields = Object.keys(value);
  if (fields.length) {
    db.prepare(`UPDATE members SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`).run(
      ...fields.map((f) => value[f]),
      id
    );
  }
  return account(db, id);
}

// A rejected applicant who updates their details goes back into the review queue.
function resubmit(db, id) {
  db.prepare("UPDATE members SET status = 'pending', review_note = '' WHERE id = ? AND status = 'rejected'").run(id);
}

function removeMember(db, id) {
  return db.prepare('DELETE FROM members WHERE id = ?').run(id).changes > 0;
}

// Creates the admin account from configuration, or promotes an existing account.
async function ensureAdmin(db, username, password) {
  const existing = db.prepare('SELECT id FROM members WHERE username = ?').get(username);
  if (existing) {
    db.prepare("UPDATE members SET role = 'admin' WHERE id = ?").run(existing.id);
    if (account(db, existing.id).status !== 'verified') verify(db, existing.id);
    return account(db, existing.id);
  }
  if (!password) throw new Error('ADMIN_PASSWORD is required to create the admin account.');
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`ADMIN_PASSWORD: ${passwordError}`);
  const admin = await createMember(db, { username, password }, {}, { role: 'admin' });
  db.prepare(`UPDATE members SET status = 'verified', verified_at = ${NOW} WHERE id = ?`).run(admin.id);
  return account(db, admin.id);
}

// --- Verification ----------------------------------------------------------

function pending(db) {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM members WHERE status = 'pending' ORDER BY created_at, id`)
    .all()
    .map(plain);
}

// Approves a member. Only accounts with a Caleb profile get a Caleb Number,
// handed out in order of approval.
function verify(db, id) {
  const m = account(db, id);
  if (!m) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = m.spelling && m.number === null
      ? db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM members').get().n
      : m.number;
    db.prepare(
      `UPDATE members SET status = 'verified', review_note = '', number = ?,
         verified_at = COALESCE(verified_at, ${NOW}) WHERE id = ?`
    ).run(next, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return account(db, id);
}

function reject(db, id, reason) {
  const changes = db
    .prepare("UPDATE members SET status = 'rejected', review_note = ? WHERE id = ? AND status = 'pending'")
    .run(String(reason ?? '').trim().slice(0, 500), id).changes;
  return changes ? account(db, id) : null;
}

// --- Sessions --------------------------------------------------------------

function createSession(db, memberId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`DELETE FROM sessions WHERE expires_at < ${NOW}`).run();
  db.prepare(
    `INSERT INTO sessions (token_hash, member_id, expires_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+${SESSION_DAYS} days'))`
  ).run(sha256(token), memberId);
  return token;
}

function sessionMember(db, token) {
  if (!token) return null;
  const row = db
    .prepare(`SELECT member_id FROM sessions WHERE token_hash = ? AND expires_at >= ${NOW}`)
    .get(sha256(token));
  return row ? account(db, row.member_id) : null;
}

function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function endOtherSessions(db, memberId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE member_id = ? AND token_hash != ?').run(memberId, sha256(keepToken ?? ''));
}

// --- Directory -------------------------------------------------------------

const LISTED = "status = 'verified' AND number IS NOT NULL";

function get(db, number) {
  return plain(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM members WHERE number = ? AND ${LISTED}`).get(number));
}

function idForNumber(db, number) {
  const row = db.prepare('SELECT id FROM members WHERE number = ?').get(number);
  return row ? row.id : null;
}

function list(db, { q = '', spelling = '', country = '', sort = 'number', limit = 50, offset = 0 } = {}) {
  const where = [LISTED];
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
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM members ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM members ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, calebs: rows.map(plain) };
}

function stats(db) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM members WHERE ${LISTED}`).get().n;
  const bySpelling = db
    .prepare(`SELECT spelling AS label, COUNT(*) AS n FROM members WHERE ${LISTED} GROUP BY spelling ORDER BY n DESC, label`)
    .all();
  const byCountry = db
    .prepare(
      `SELECT country AS label, COUNT(*) AS n FROM members WHERE ${LISTED} AND country != ''
       GROUP BY country COLLATE NOCASE ORDER BY n DESC, label LIMIT 10`
    )
    .all();
  const byDecade = db
    .prepare(
      `SELECT (birth_year / 10) * 10 AS label, COUNT(*) AS n FROM members
       WHERE ${LISTED} AND birth_year IS NOT NULL GROUP BY label ORDER BY label`
    )
    .all();
  const latest = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM members WHERE ${LISTED} ORDER BY number DESC LIMIT 5`).all();
  return {
    total,
    bySpelling: bySpelling.map(plain),
    byCountry: byCountry.map(plain),
    byDecade: byDecade.map(plain),
    latest: latest.map(plain),
  };
}

module.exports = {
  SPELLINGS,
  DuplicateUsername,
  open,
  validateCredentials,
  validatePassword,
  validateProfile,
  createMember,
  authenticate,
  checkPassword,
  setPassword,
  account,
  updateProfile,
  resubmit,
  removeMember,
  ensureAdmin,
  pending,
  verify,
  reject,
  createSession,
  sessionMember,
  endSession,
  endOtherSessions,
  get,
  idForNumber,
  list,
  stats,
};
