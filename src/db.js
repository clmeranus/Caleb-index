'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const geo = require('./geo');

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
  region: 60,
  postal_code: 12,
  country: 60,
  occupation: 80,
  bio: 500,
  website: 200,
  verification_note: 500,
};

const SESSION_DAYS = 30;
const MESSAGE_LIMIT = 2000;
const ADMIN_ROLES = ['admin', 'owner'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Fields any verified member may see in the directory.
const PUBLIC_COLUMNS =
  "number, spelling, surname, location, region, country, birth_year, occupation, bio, website, verified_at AS created_at, updated_at, " +
  "role IN ('admin', 'owner') AS is_admin, role = 'owner' AS is_owner";

// Fields verified members see about applicants, so they can decide whether to vouch.
const APPLICANT_COLUMNS = 'id, spelling, surname, location, region, country, birth_year, occupation, bio, website, created_at';

// Fields a member sees about their own account (and admins see when reviewing).
const ACCOUNT_COLUMNS =
  'id, username, role, status, review_note, verification_note, verification_method, number, spelling, surname, location, region, postal_code, ' +
  'country, birth_year, occupation, bio, website, created_at, updated_at, verified_at, latitude IS NOT NULL AS has_location, ' +
  'email, email_opt_in, email_confirmed';

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash     TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
      verification_note TEXT NOT NULL DEFAULT '',
      review_note       TEXT NOT NULL DEFAULT '',
      verification_method TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS vouches (
      applicant_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      voucher_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (applicant_id, voucher_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      recipient_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      body          TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (${NOW}),
      read_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages (recipient_id, read_at);
    CREATE INDEX IF NOT EXISTS messages_by_pair ON messages (sender_id, recipient_id, id);
    CREATE TABLE IF NOT EXISTS announcements (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id     INTEGER REFERENCES members(id) ON DELETE SET NULL,
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      emailed       INTEGER NOT NULL DEFAULT 0,
      email_sent    INTEGER NOT NULL DEFAULT 0,
      email_failed  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (${NOW})
    );
  `);
  migrate(db);
  return db;
}

// Columns added after the first release. Existing databases gain them the next
// time the app starts; values already stored are left untouched.
const ADDED_COLUMNS = {
  region: "TEXT NOT NULL DEFAULT ''",
  postal_code: "TEXT NOT NULL DEFAULT ''",
  latitude: 'REAL',
  longitude: 'REAL',
  email: "TEXT NOT NULL DEFAULT ''",
  email_opt_in: 'INTEGER NOT NULL DEFAULT 0',
  email_confirmed: 'INTEGER NOT NULL DEFAULT 0',
  email_token: 'TEXT',
};

function migrate(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(members)').all().map((c) => c.name));
  for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE members ADD COLUMN ${column} ${definition}`);
  }
}

const plain = (row) => (row ? { ...row } : null);
const isAdmin = (m) => Boolean(m && ADMIN_ROLES.includes(m.role));
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

  if (value.postal_code !== undefined) {
    value.postal_code = geo.normalizePostalCode(value.postal_code);
    const place = value.postal_code ? geo.locate(value.postal_code) : null;
    value.latitude = place ? place.lat : null;
    value.longitude = place ? place.lon : null;
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

// Grants or removes admin permission. The owner's role never changes here.
function setAdmin(db, id, admin) {
  db.prepare("UPDATE members SET role = ? WHERE id = ? AND role != 'owner'").run(admin ? 'admin' : 'member', id);
  return account(db, id);
}

function removeMember(db, id) {
  return db.prepare('DELETE FROM members WHERE id = ?').run(id).changes > 0;
}

// Creates the owner account from configuration, or promotes an existing account.
// The owner is an admin who cannot be demoted or removed by other admins.
async function ensureAdmin(db, username, password) {
  const existing = db.prepare('SELECT id FROM members WHERE username = ?').get(username);
  if (existing) {
    db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").run(existing.id);
    if (account(db, existing.id).status !== 'verified') verify(db, existing.id, 'owner');
    return account(db, existing.id);
  }
  if (!password) throw new Error('ADMIN_PASSWORD is required to create the admin account.');
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`ADMIN_PASSWORD: ${passwordError}`);
  const admin = await createMember(db, { username, password }, {}, { role: 'owner' });
  db.prepare(`UPDATE members SET status = 'verified', verification_method = 'owner', verified_at = ${NOW} WHERE id = ?`).run(admin.id);
  return account(db, admin.id);
}

// --- Verification ----------------------------------------------------------

function pending(db) {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM members WHERE status = 'pending' ORDER BY created_at, id`)
    .all()
    .map((row) => ({ ...row, vouchers: vouchers(db, row.id) }));
}

// Approves a member. Only accounts with a Caleb profile get a Caleb Number,
// handed out in order of approval.
function verify(db, id, method = 'admin') {
  const m = account(db, id);
  if (!m) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = m.spelling && m.number === null
      ? db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM members').get().n
      : m.number;
    db.prepare(
      `UPDATE members SET status = 'verified', review_note = '', number = ?, verification_method = ?,
         verified_at = COALESCE(verified_at, ${NOW}) WHERE id = ?`
    ).run(next, method, id);
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
  if (!changes) return null;
  // A rejection resets vouching, so earlier vouches cannot outvote it.
  db.prepare('DELETE FROM vouches WHERE applicant_id = ?').run(id);
  return account(db, id);
}

// --- Vouching --------------------------------------------------------------

function vouchers(db, applicantId) {
  return db
    .prepare(
      `SELECT m.number, m.spelling, m.surname FROM vouches v JOIN members m ON m.id = v.voucher_id
       WHERE v.applicant_id = ? ORDER BY v.created_at`
    )
    .all(applicantId)
    .map(plain);
}

function vouchCount(db, applicantId) {
  return db.prepare('SELECT COUNT(*) AS n FROM vouches WHERE applicant_id = ?').get(applicantId).n;
}

// Pending applicants as a verified member sees them, with their vouching state.
function applicants(db, viewerId) {
  return db
    .prepare(
      `SELECT ${APPLICANT_COLUMNS},
         (SELECT COUNT(*) FROM vouches v WHERE v.applicant_id = members.id) AS vouch_count,
         EXISTS (SELECT 1 FROM vouches v WHERE v.applicant_id = members.id AND v.voucher_id = ?) AS vouched_by_me
       FROM members WHERE status = 'pending' AND spelling != '' ORDER BY created_at, id`
    )
    .all(viewerId)
    .map(plain);
}

// Records a vouch, and verifies the applicant once enough members have vouched.
// Returns the applicant's account, or null if they are not a pending applicant.
function vouch(db, applicantId, voucherId, required) {
  const applicant = account(db, applicantId);
  if (!applicant || applicant.status !== 'pending' || applicantId === voucherId) return null;
  db.prepare('INSERT OR IGNORE INTO vouches (applicant_id, voucher_id) VALUES (?, ?)').run(applicantId, voucherId);
  if (vouchCount(db, applicantId) >= required) return verify(db, applicantId, 'vouch');
  return account(db, applicantId);
}

function unvouch(db, applicantId, voucherId) {
  const applicant = account(db, applicantId);
  if (!applicant || applicant.status !== 'pending') return null;
  db.prepare('DELETE FROM vouches WHERE applicant_id = ? AND voucher_id = ?').run(applicantId, voucherId);
  return applicant;
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
    const number = String(q).trim().match(/^(?:no\.?\s*|#)?(\d+)$/i);
    where.push(`(spelling || ' ' || surname LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR region LIKE ? ESCAPE '\\'
                 OR country LIKE ? ESCAPE '\\' OR occupation LIKE ? ESCAPE '\\' OR bio LIKE ? ESCAPE '\\' OR number = ?)`);
    const like = `%${String(q).trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like, like, like, like, number ? Number(number[1]) : -1);
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

// --- Messages --------------------------------------------------------------

// The other member in a conversation, as the directory shows them.
const PARTNER_COLUMNS = 'm.id, m.number, m.spelling, m.surname, m.location, m.region, m.country';

function sendMessage(db, senderId, recipientId, body) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)')
    .run(senderId, recipientId, body);
  return plain(db.prepare('SELECT id, sender_id, recipient_id, body, created_at, read_at FROM messages WHERE id = ?').get(lastInsertRowid));
}

// One row per person the member has exchanged messages with, newest first.
function conversations(db, memberId) {
  return db
    .prepare(
      `WITH mine AS (
         SELECT id, body, created_at, sender_id, read_at, recipient_id,
                CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id
         FROM messages WHERE sender_id = ? OR recipient_id = ?
       ), latest AS (SELECT other_id, MAX(id) AS last_id FROM mine GROUP BY other_id)
       SELECT ${PARTNER_COLUMNS}, last.body AS last_body, last.created_at AS last_at, last.sender_id = ? AS last_from_me,
              (SELECT COUNT(*) FROM mine u WHERE u.other_id = latest.other_id AND u.recipient_id = ? AND u.read_at IS NULL) AS unread
       FROM latest
       JOIN mine last ON last.id = latest.last_id
       JOIN members m ON m.id = latest.other_id
       ORDER BY latest.last_id DESC`
    )
    .all(memberId, memberId, memberId, memberId, memberId)
    .map(plain);
}

// Messages between two members, oldest first. Marks the ones sent to the reader as read.
function thread(db, memberId, otherId, { limit = 200 } = {}) {
  db.prepare(`UPDATE messages SET read_at = ${NOW} WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL`).run(memberId, otherId);
  return db
    .prepare(
      `SELECT * FROM (
         SELECT id, body, created_at, read_at, sender_id = ? AS from_me FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY id DESC LIMIT ?
       ) ORDER BY id`
    )
    .all(memberId, memberId, otherId, otherId, memberId, limit)
    .map(plain);
}

function unreadCount(db, memberId) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(memberId).n;
}

// --- Calebs near you -------------------------------------------------------

// Listed members who have a known location, with their coordinates.
function locatedMembers(db) {
  return db
    .prepare(`SELECT id, latitude, longitude, ${PUBLIC_COLUMNS} FROM members WHERE ${LISTED} AND latitude IS NOT NULL`)
    .all()
    .map(plain);
}

function location(db, id) {
  const row = db.prepare('SELECT latitude AS lat, longitude AS lon FROM members WHERE id = ? AND latitude IS NOT NULL').get(id);
  return row ? { lat: row.lat, lon: row.lon } : null;
}

// --- Email -----------------------------------------------------------------

// Saves a member's email settings. A new address must be confirmed again, so it
// gets a fresh token; the result says whether a confirmation email is needed.
function setEmail(db, id, { email, optIn }) {
  const current = account(db, id);
  const changed = email !== current.email;
  if (changed) {
    db.prepare(
      `UPDATE members SET email = ?, email_confirmed = 0, email_token = ?, updated_at = ${NOW} WHERE id = ?`
    ).run(email, email ? crypto.randomBytes(24).toString('base64url') : null, id);
  }
  db.prepare('UPDATE members SET email_opt_in = ? WHERE id = ?').run(optIn && email ? 1 : 0, id);
  const updated = account(db, id);
  return { member: updated, needsConfirmation: Boolean(updated.email && updated.email_opt_in && !updated.email_confirmed) };
}

function emailToken(db, id) {
  const row = db.prepare('SELECT email_token FROM members WHERE id = ?').get(id);
  return row ? row.email_token : null;
}

// Confirms the address the token was issued for. Returns the member, or null.
function confirmEmail(db, token) {
  const row = db.prepare("SELECT id FROM members WHERE email_token = ? AND email != ''").get(String(token ?? ''));
  if (!row) return null;
  db.prepare('UPDATE members SET email_confirmed = 1 WHERE id = ?').run(row.id);
  return account(db, row.id);
}

function unsubscribe(db, token) {
  const row = db.prepare('SELECT id FROM members WHERE email_token = ?').get(String(token ?? ''));
  if (!row) return null;
  db.prepare('UPDATE members SET email_opt_in = 0 WHERE id = ?').run(row.id);
  return account(db, row.id);
}

// Verified members who opted in and confirmed their address.
function emailRecipients(db) {
  return db
    .prepare(
      `SELECT id, email, email_token AS token, spelling FROM members
       WHERE status = 'verified' AND email != '' AND email_opt_in = 1 AND email_confirmed = 1 AND email_token IS NOT NULL`
    )
    .all()
    .map(plain);
}

// --- Announcements ---------------------------------------------------------

function createAnnouncement(db, { senderId, subject, body, emailed }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO announcements (sender_id, subject, body, emailed) VALUES (?, ?, ?, ?)')
    .run(senderId, subject, body, emailed ? 1 : 0);
  return Number(lastInsertRowid);
}

function recordEmailResult(db, announcementId, { sent, failed }) {
  db.prepare('UPDATE announcements SET email_sent = ?, email_failed = ? WHERE id = ?').run(sent, failed, announcementId);
}

function announcements(db, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT a.id, a.subject, a.body, a.created_at, a.emailed, a.email_sent, a.email_failed,
              m.number AS sender_number, m.spelling AS sender_spelling, m.surname AS sender_surname
       FROM announcements a LEFT JOIN members m ON m.id = a.sender_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(limit)
    .map(plain);
}

module.exports = {
  SPELLINGS,
  isAdmin,
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
  setAdmin,
  vouchers,
  vouchCount,
  applicants,
  vouch,
  unvouch,
  createSession,
  sessionMember,
  endSession,
  endOtherSessions,
  get,
  idForNumber,
  list,
  stats,
  MESSAGE_LIMIT,
  sendMessage,
  conversations,
  thread,
  unreadCount,
  locatedMembers,
  location,
  setEmail,
  emailToken,
  confirmEmail,
  unsubscribe,
  emailRecipients,
  createAnnouncement,
  recordEmailResult,
  announcements,
};
