'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/db');
const { createServer, rateLimiter, clientIp } = require('../src/server');
// Records emails instead of sending them.
const sentEmails = [];
const fakeMailer = { send: async (mail) => { sentEmails.push(mail); } };

let server;
let base;
let db;
let admin;

before(async () => {
  db = store.open();
  await store.ensureAdmin(db, 'admin', 'admin-password-123');
  server = createServer({
    db,
    registerLimit: () => true,
    loginLimit: () => true,
    vouchesRequired: 2,
    mailer: fakeMailer,
    publicUrl: 'https://calebs.test',
    messageLimit: () => true,
    confirmationLimit: () => true,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  admin = await login('admin', 'admin-password-123');
});

after(() => server.close());

// A minimal client that keeps the session cookie between requests.
function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      redirect: 'manual',
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, location: res.headers.get('location') };
  };
  return call;
}

let seq = 0;
async function apply(fields = {}) {
  const call = client();
  const username = fields.username || `caleb${++seq}`;
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'correct-horse-battery', first_name: 'Caleb', verification_note: 'linkedin.com/in/me', ...fields },
  });
  return { call, res, username };
}

async function login(username, password) {
  const call = client();
  const res = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, res.text);
  return call;
}

async function verified(fields) {
  const a = await apply(fields);
  const v = await admin(`/api/admin/members/${a.res.body.member.id}/verify`, { method: 'POST' });
  assert.equal(v.status, 200, v.text);
  return { ...a, number: v.body.member.number };
}

test('pages are locked to logged-in members', async () => {
  const guest = client();
  for (const page of ['/', '/stats', '/caleb?n=1', '/account', '/admin']) {
    const res = await guest(page);
    assert.equal(res.status, 303, page);
    assert.match(res.location, /^\/login/);
  }
  assert.equal((await guest('/login')).status, 200);
  assert.equal((await guest('/register')).status, 200);
  assert.equal((await guest('/style.css')).status, 200);
  assert.equal((await guest('/api/calebs')).status, 401);
  assert.equal((await guest('/api/stats')).status, 401);
  const spellings = await guest('/api/spellings');
  assert.equal(spellings.status, 200);
  assert.ok(spellings.body.includes('Kaleb'));
});

test('signing up creates a pending account that cannot see the index', async () => {
  const { call, res } = await apply({ surname: 'Pending' });
  assert.equal(res.status, 201);
  assert.equal(res.body.member.status, 'pending');
  assert.equal(res.body.member.number, null);
  assert.equal(res.body.member.password_hash, undefined);

  assert.equal((await call('/api/calebs')).status, 403);
  assert.equal((await call('/')).location, '/pending');
  assert.equal((await call('/pending')).status, 200);
  assert.equal((await call('/login')).location, '/pending');
});

test('sign-up validation', async () => {
  const notCaleb = await apply({ first_name: 'Joshua' });
  assert.equal(notCaleb.res.status, 422);

  const noEvidence = await apply({ verification_note: '' });
  assert.equal(noEvidence.res.status, 201, 'evidence is optional now that vouching exists');

  const weak = await apply({ password: 'short' });
  assert.equal(weak.res.status, 422);

  const badName = await apply({ username: 'no spaces!' });
  assert.equal(badName.res.status, 422);

  const honeypot = await apply({ website_confirm: 'spam' });
  assert.equal(honeypot.res.status, 400);

  await apply({ username: 'TakenName' });
  const dup = await apply({ username: 'takenname' });
  assert.equal(dup.res.status, 409);
});

test('login, logout and wrong passwords', async () => {
  const { username } = await apply();
  const call = client();
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username, password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'whatever' } })).status, 401);

  const res = await call('/api/auth/login', { method: 'POST', body: { username: username.toUpperCase(), password: 'correct-horse-battery' } });
  assert.equal(res.status, 200);
  assert.equal((await call('/api/me')).body.member.username, username);

  await call('/api/auth/logout', { method: 'POST' });
  assert.equal((await call('/api/me')).status, 401);
});

test('admin verifies applicants and Caleb Numbers follow approval order', async () => {
  const first = await apply({ surname: 'First' });
  const second = await apply({ surname: 'Second', first_name: 'Kaleb' });

  const queue = await admin('/api/admin/pending');
  assert.ok(queue.body.applicants.some((a) => a.username === first.username && a.verification_note));

  const v2 = await admin(`/api/admin/members/${second.res.body.member.id}/verify`, { method: 'POST' });
  const v1 = await admin(`/api/admin/members/${first.res.body.member.id}/verify`, { method: 'POST' });
  assert.equal(v1.body.member.number, v2.body.member.number + 1);

  const list = await second.call('/api/calebs?q=Second');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.calebs[0].spelling, 'Kaleb');
  assert.equal(list.body.calebs[0].username, undefined);
  assert.equal(list.body.calebs[0].verification_note, undefined);
  assert.equal((await second.call('/')).status, 200);
});

test('rejected applicants see the reason and can resubmit', async () => {
  const a = await apply({ verification_note: 'trust me' });
  const r = await admin(`/api/admin/members/${a.res.body.member.id}/reject`, { method: 'POST', body: { reason: 'Need a link' } });
  assert.equal(r.body.member.status, 'rejected');

  const me = await a.call('/api/me');
  assert.equal(me.body.member.review_note, 'Need a link');

  const resubmitted = await a.call('/api/me', { method: 'PATCH', body: { verification_note: 'https://example.com/me' } });
  assert.equal(resubmitted.body.member.status, 'pending');
  assert.equal(resubmitted.body.member.review_note, '');
});

test('only admins can review and remove members', async () => {
  const member = await verified();
  const applicant = await apply();
  assert.equal((await member.call('/api/admin/pending')).status, 403);
  assert.equal((await member.call(`/api/admin/members/${applicant.res.body.member.id}/verify`, { method: 'POST' })).status, 403);
  assert.equal((await member.call('/admin')).location, '/');
  assert.equal((await admin('/admin')).status, 200);

  const target = await verified();
  assert.equal((await member.call(`/api/calebs/${target.number}`, { method: 'DELETE' })).status, 403);
  assert.equal((await admin(`/api/calebs/${target.number}`, { method: 'DELETE' })).status, 204);
  assert.equal((await member.call(`/api/calebs/${target.number}`)).status, 404);
  assert.equal((await target.call('/api/me')).status, 401);
});

test('members edit their listing, change password and delete their account', async () => {
  const m = await verified({ occupation: 'Baker' });
  const edited = await m.call('/api/me', { method: 'PATCH', body: { occupation: 'Chef', birth_year: '' } });
  assert.equal(edited.body.member.occupation, 'Chef');
  assert.equal(edited.body.member.birth_year, null);
  assert.equal((await m.call('/api/me', { method: 'PATCH', body: { first_name: 'Bob' } })).status, 422);
  assert.equal((await m.call('/api/me', { method: 'PATCH', body: { status: 'verified', role: 'admin' } })).body.member.role, 'member');

  const otherDevice = await login(m.username, 'correct-horse-battery');
  assert.equal((await m.call('/api/me/password', { method: 'POST', body: { current_password: 'nope', new_password: 'another-long-pass' } })).status, 403);
  assert.equal((await m.call('/api/me/password', { method: 'POST', body: { current_password: 'correct-horse-battery', new_password: 'another-long-pass' } })).status, 200);
  assert.equal((await otherDevice('/api/me')).status, 401);
  assert.equal((await m.call('/api/me')).status, 200);

  assert.equal((await m.call('/api/me', { method: 'DELETE', body: { password: 'wrong' } })).status, 403);
  assert.equal((await m.call('/api/me', { method: 'DELETE', body: { password: 'another-long-pass' } })).status, 200);
  assert.equal((await client()('/api/auth/login', { method: 'POST', body: { username: m.username, password: 'another-long-pass' } })).status, 401);
});

test('search, filters and statistics only include verified members', async () => {
  await verified({ first_name: 'Calev', location: 'Haifa', country: 'Israel', birth_year: 1990 });
  await apply({ location: 'Haifa' });
  const search = await admin('/api/calebs?q=haifa');
  assert.equal(search.body.total, 1);
  assert.equal((await admin('/api/calebs?q=%25')).body.total, 0);

  const stats = await admin('/api/stats');
  assert.ok(stats.body.bySpelling.some((r) => r.label === 'Calev'));
  assert.deepEqual(stats.body.byDecade.find((r) => r.label === 1990), { label: 1990, n: 1 });
  assert.equal(stats.body.total, (await admin('/api/calebs')).body.total);
});

test('rejects non-JSON writes, unknown pages and path traversal', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin-password-123',
  });
  assert.equal(res.status, 415);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/nope')).status, 404);
});

test('rate limiter', () => {
  const allow = rateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), false);
  assert.equal(allow('other'), true);
});

test('two vouches from verified members approve an applicant', async () => {
  const a = await verified({ surname: 'VoucherA' });
  const b = await verified({ surname: 'VoucherB' });
  const applicant = await apply({ surname: 'Vouchee' });
  const id = applicant.res.body.member.id;

  // Pending applicants cannot vouch, and cannot see the applicant list.
  const other = await apply();
  assert.equal((await other.call(`/api/applicants/${id}/vouch`, { method: 'POST' })).status, 403);

  const list = await a.call('/api/applicants');
  const entry = list.body.applicants.find((x) => x.id === id);
  assert.equal(entry.surname, 'Vouchee');
  assert.equal(entry.username, undefined);
  assert.equal(entry.verification_note, undefined);

  const first = await a.call(`/api/applicants/${id}/vouch`, { method: 'POST' });
  assert.deepEqual(first.body, { verified: false, vouch_count: 1 });
  assert.equal((await a.call(`/api/applicants/${id}/vouch`, { method: 'POST' })).body.vouch_count, 1, 'vouching twice counts once');
  assert.equal((await applicant.call('/api/me')).body.member.vouch_count, 1);

  // Withdrawing and re-vouching works.
  assert.equal((await a.call(`/api/applicants/${id}/vouch`, { method: 'DELETE' })).body.vouch_count, 0);
  await a.call(`/api/applicants/${id}/vouch`, { method: 'POST' });

  const admin_view = await admin('/api/admin/pending');
  assert.equal(admin_view.body.applicants.find((x) => x.id === id).vouchers[0].surname, 'VoucherA');

  const second = await b.call(`/api/applicants/${id}/vouch`, { method: 'POST' });
  assert.equal(second.body.verified, true);
  const me = (await applicant.call('/api/me')).body.member;
  assert.equal(me.status, 'verified');
  assert.equal(me.verification_method, 'vouch');
  assert.ok(me.number);
});

test('the owner without a listing cannot vouch, and rejection clears vouches', async () => {
  const applicant = await apply();
  const id = applicant.res.body.member.id;
  assert.equal((await admin(`/api/applicants/${id}/vouch`, { method: 'POST' })).status, 403);

  const a = await verified();
  await a.call(`/api/applicants/${id}/vouch`, { method: 'POST' });
  await admin(`/api/admin/members/${id}/reject`, { method: 'POST', body: { reason: 'No' } });
  assert.equal((await a.call(`/api/applicants/${id}/vouch`, { method: 'POST' })).status, 404, 'cannot vouch for a rejected applicant');

  await applicant.call('/api/me', { method: 'PATCH', body: { verification_note: 'more detail' } });
  assert.equal((await applicant.call('/api/me')).body.member.vouch_count, 0);
});

test('admins grant and remove admin permission from a profile', async () => {
  const promoted = await verified({ surname: 'Promoted' });
  const target = await verified({ surname: 'Target' });
  const ownerNumber = null;

  // Ordinary members cannot change permissions.
  assert.equal((await promoted.call(`/api/calebs/${target.number}/admin`, { method: 'PUT', body: { admin: true } })).status, 403);

  const grant = await admin(`/api/calebs/${promoted.number}/admin`, { method: 'PUT', body: { admin: true } });
  assert.deepEqual(grant.body, { number: promoted.number, is_admin: true });
  assert.equal((await promoted.call(`/api/calebs/${promoted.number}`)).body.is_admin, 1);

  // The new admin can verify applicants and see the review page.
  const applicant = await apply();
  assert.equal((await promoted.call('/admin')).status, 200);
  const v = await promoted.call(`/api/admin/members/${applicant.res.body.member.id}/verify`, { method: 'POST' });
  assert.equal(v.body.member.status, 'verified');

  // ...and can manage other members' permission, but not their own or the owner's.
  assert.equal((await promoted.call(`/api/calebs/${target.number}/admin`, { method: 'PUT', body: { admin: true } })).status, 200);
  assert.equal((await promoted.call(`/api/calebs/${promoted.number}/admin`, { method: 'PUT', body: { admin: false } })).status, 400);
  assert.equal((await promoted.call(`/api/calebs/${target.number}/admin`, { method: 'PUT', body: { admin: 'yes' } })).status, 422);

  const ownerId = db.prepare("SELECT id FROM members WHERE role = 'owner'").get().id;
  db.prepare('UPDATE members SET spelling = ?, number = 9999 WHERE id = ?').run('Caleb', ownerId);
  assert.equal((await promoted.call('/api/calebs/9999/admin', { method: 'PUT', body: { admin: false } })).status, 403);
  assert.equal((await promoted.call('/api/calebs/9999', { method: 'DELETE' })).status, 403);
  assert.equal((await promoted.call('/api/calebs/9999')).body.is_owner, 1);
  db.prepare("UPDATE members SET spelling = '', number = ? WHERE id = ?").run(ownerNumber, ownerId);

  // Removing the permission takes effect immediately.
  await admin(`/api/calebs/${promoted.number}/admin`, { method: 'PUT', body: { admin: false } });
  assert.equal((await promoted.call('/api/admin/pending')).status, 403);
  assert.equal((await promoted.call('/admin')).location, '/');
});

test('config reports how many vouches are required', async () => {
  const res = await client()('/api/config');
  assert.deepEqual(res.body, { vouchesRequired: 2 });
});

test('client IP comes from the proxy header or the trusted end of X-Forwarded-For', () => {
  const req = (headers) => ({ socket: { remoteAddress: '10.0.0.1' }, headers });
  const xff = (v) => req({ 'x-forwarded-for': v });
  assert.equal(clientIp(xff('1.1.1.1')), '10.0.0.1', 'ignored unless a proxy is trusted');
  assert.equal(clientIp(xff('1.1.1.1, 172.64.0.9'), { hops: 2 }), '1.1.1.1');
  assert.equal(clientIp(xff('6.6.6.6, 1.1.1.1, 172.64.0.9'), { hops: 2 }), '1.1.1.1', 'a forged first entry is skipped');
  assert.equal(clientIp(xff('1.1.1.1'), { hops: 2 }), '1.1.1.1');
  assert.equal(clientIp(xff(''), { hops: 2 }), '10.0.0.1');

  const fly = { header: 'Fly-Client-IP' };
  assert.equal(clientIp(req({ 'fly-client-ip': '2.2.2.2', 'x-forwarded-for': '6.6.6.6' }), fly), '2.2.2.2');
  assert.equal(clientIp(req({}), fly), '10.0.0.1', 'falls back to the connection address');
});

test('health check', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('the owner can create a Caleb listing and joins the index', async () => {
  const owner = await login('admin', 'admin-password-123');
  const before = (await owner('/api/me')).body.member;
  assert.equal(before.number, null);

  // Saving other details alone does not create a listing.
  const noName = await owner('/api/me', { method: 'PATCH', body: { location: 'Boston' } });
  assert.equal(noName.body.member.number, null);

  const res = await owner('/api/me', { method: 'PATCH', body: { first_name: 'Caleb', surname: 'Owner' } });
  const after = res.body.member;
  assert.ok(after.number > 0);
  assert.equal(after.status, 'verified');
  assert.equal(after.role, 'owner');
  assert.equal(after.verification_method, 'owner');

  const listing = (await owner(`/api/calebs/${after.number}`)).body;
  assert.equal(listing.surname, 'Owner');
  assert.equal(listing.is_admin, 1);
  assert.equal(listing.is_owner, 1);

  // Later edits keep the same number.
  const edited = await owner('/api/me', { method: 'PATCH', body: { first_name: 'Kaleb' } });
  assert.equal(edited.body.member.number, after.number);

  // With a listing, the owner can vouch like any member.
  const applicant = await apply();
  assert.equal((await owner(`/api/applicants/${applicant.res.body.member.id}/vouch`, { method: 'POST' })).status, 200);
});

test('existing databases gain the new columns without losing data', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caleb-')), 'old.db');
  // The members table exactly as the first deployed version created it.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
      verification_note TEXT NOT NULL DEFAULT '', review_note TEXT NOT NULL DEFAULT '', verification_method TEXT NOT NULL DEFAULT '',
      number INTEGER UNIQUE, spelling TEXT NOT NULL DEFAULT '', surname TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '', birth_year INTEGER, occupation TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x', verified_at TEXT)`);
  old.prepare("INSERT INTO members (username, password_hash, role, status, number, spelling, surname) VALUES ('CalebMeranus', 'h', 'owner', 'verified', 1, 'Caleb', 'Meranus')").run();
  old.close();

  const migrated = store.open(file);
  const row = migrated.prepare('SELECT * FROM members WHERE number = 1').get();
  assert.equal(row.username, 'CalebMeranus');
  assert.equal(row.surname, 'Meranus');
  assert.equal(row.region, '');
  assert.equal(row.postal_code, '');
  assert.equal(row.email_opt_in, 0);
  migrated.close();
  // Opening again is a no-op.
  store.open(file).close();
});

test('postal codes are normalized and US ZIP codes are located', async () => {
  const m = await verified();
  const zip = await m.call('/api/me', { method: 'PATCH', body: { postal_code: '60601-1234', region: 'Illinois' } });
  assert.equal(zip.body.member.postal_code, '60601');
  assert.equal(zip.body.member.region, 'Illinois');
  assert.equal(zip.body.member.has_location, 1);
  const ca = await m.call('/api/me', { method: 'PATCH', body: { postal_code: 'm5v3l9', region: 'Ontario' } });
  assert.equal(ca.body.member.postal_code, 'M5V 3L9');
  assert.equal(ca.body.member.has_location, 0, 'only US ZIP codes have locations');
  const listing = (await m.call(`/api/calebs/${m.number}`)).body;
  assert.equal(listing.region, 'Ontario');
  assert.equal(listing.postal_code, undefined, 'the postal code is private');
});

test('members can be found by full name or Caleb Number', async () => {
  const m = await verified({ first_name: 'Kaleb', surname: 'Findable' });
  const byName = await m.call('/api/calebs?q=' + encodeURIComponent('Kaleb Findable'));
  assert.deepEqual(byName.body.calebs.map((c) => c.number), [m.number]);
  for (const q of [String(m.number), `#${m.number}`, `No. ${m.number}`]) {
    const res = await m.call('/api/calebs?q=' + encodeURIComponent(q));
    assert.ok(res.body.calebs.some((c) => c.number === m.number), q);
  }
});

test('members message each other', async () => {
  const a = await verified({ surname: 'Sender' });
  const b = await verified({ surname: 'Receiver' });

  const sent = await a.call(`/api/messages/${b.number}`, { method: 'POST', body: { body: '  Hello from one Caleb to another  ' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'Hello from one Caleb to another');
  await a.call(`/api/messages/${b.number}`, { method: 'POST', body: { body: 'Second message' } });

  assert.equal((await b.call('/api/me')).body.member.unread_messages, 2);
  const inbox = (await b.call('/api/messages')).body;
  assert.equal(inbox.unread, 2);
  assert.equal(inbox.conversations[0].number, a.number);
  assert.equal(inbox.conversations[0].last_body, 'Second message');
  assert.equal(inbox.conversations[0].unread, 2);

  const thread = (await b.call(`/api/messages/${a.number}`)).body;
  assert.equal(thread.with.surname, 'Sender');
  assert.deepEqual(thread.messages.map((x) => [x.body, x.from_me]), [['Hello from one Caleb to another', 0], ['Second message', 0]]);
  assert.equal((await b.call('/api/me')).body.member.unread_messages, 0, 'reading the thread marks it read');

  await b.call(`/api/messages/${a.number}`, { method: 'POST', body: { body: 'Reply' } });
  const aThread = (await a.call(`/api/messages/${b.number}`)).body.messages;
  assert.deepEqual(aThread.map((x) => x.from_me), [1, 1, 0]);

  // Not to yourself, not empty, not too long, not to unknown numbers, not by applicants.
  assert.equal((await a.call(`/api/messages/${a.number}`, { method: 'POST', body: { body: 'hi' } })).status, 400);
  assert.equal((await a.call(`/api/messages/${b.number}`, { method: 'POST', body: { body: '   ' } })).status, 422);
  assert.equal((await a.call(`/api/messages/${b.number}`, { method: 'POST', body: { body: 'x'.repeat(2001) } })).status, 422);
  assert.equal((await a.call('/api/messages/99999', { method: 'POST', body: { body: 'hi' } })).status, 404);
  const applicant = await apply();
  assert.equal((await applicant.call(`/api/messages/${b.number}`, { method: 'POST', body: { body: 'hi' } })).status, 403);
  // Other members can't read the conversation.
  const c = await verified();
  assert.equal((await c.call(`/api/messages/${a.number}`)).body.messages.length, 0);
});

test('Calebs near you within 5, 10 and 25 miles', async () => {
  const me = await verified({ surname: 'Loop', postal_code: '60601' }); // downtown Chicago
  const evanston = await verified({ surname: 'Evanston', postal_code: '60201' }); // about 12 miles
  const ohare = await verified({ surname: 'Ohare', postal_code: '60018' }); // Des Plaines, about 15 miles
  const la = await verified({ surname: 'Beverly', postal_code: '90210' });
  const nearby = async (r) => (await me.call(`/api/nearby?radius=${r}`)).body;

  const five = await nearby(5);
  assert.equal(five.located, true);
  assert.ok(!five.calebs.some((c) => [evanston.number, ohare.number, la.number].includes(c.number)));
  const ten = await nearby(10);
  assert.ok(!ten.calebs.some((c) => c.number === evanston.number));
  const twentyFive = (await nearby(25)).calebs;
  const ours = twentyFive.filter((c) => [evanston.number, ohare.number, la.number].includes(c.number));
  assert.deepEqual(ours.map((c) => c.surname), ['Evanston', 'Ohare'], 'sorted by distance, LA excluded');
  assert.ok(ours[0].distance_miles > 10 && ours[0].distance_miles < 15);
  assert.equal(ours[0].latitude, undefined, 'exact coordinates stay private');
  assert.ok(!twentyFive.some((c) => c.number === me.number), 'you are not near yourself');

  assert.equal((await me.call('/api/nearby?radius=50')).status, 422);
  const noZip = await verified();
  assert.deepEqual((await noZip.call('/api/nearby?radius=25')).body, { located: false, calebs: [] });
});

test('email opt-in needs confirmation, and unsubscribe links work', async () => {
  const m = await verified({ surname: 'Mailable' });
  sentEmails.length = 0;
  const bad = await m.call('/api/me/email', { method: 'PUT', body: { email: 'not-an-email', opt_in: true } });
  assert.equal(bad.status, 422);

  const res = await m.call('/api/me/email', { method: 'PUT', body: { email: 'caleb@example.com', opt_in: true } });
  assert.equal(res.body.confirmation, 'sent');
  assert.equal(res.body.member.email_confirmed, 0);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'caleb@example.com');
  const link = sentEmails[0].text.match(/https:\/\/calebs\.test\/email\?action=confirm&t=(\S+)/);
  assert.ok(link, sentEmails[0].text);

  assert.equal((await client()('/api/email/confirm', { method: 'POST', body: { token: 'wrong' } })).status, 404);
  const confirmed = await client()('/api/email/confirm', { method: 'POST', body: { token: decodeURIComponent(link[1]) } });
  assert.equal(confirmed.body.email, 'caleb@example.com');
  assert.equal((await m.call('/api/me')).body.member.email_confirmed, 1);

  // Saving again without changing the address doesn't send another confirmation.
  const same = await m.call('/api/me/email', { method: 'PUT', body: { email: 'caleb@example.com', opt_in: true } });
  assert.equal(same.body.confirmation, 'not_needed');

  // A new address must be confirmed again, and the old link stops working.
  await m.call('/api/me/email', { method: 'PUT', body: { email: 'new@example.com', opt_in: true } });
  assert.equal((await m.call('/api/me')).body.member.email_confirmed, 0);
  assert.equal((await client()('/api/email/confirm', { method: 'POST', body: { token: decodeURIComponent(link[1]) } })).status, 404);
  const newToken = decodeURIComponent(sentEmails.at(-1).text.match(/t=(\S+)/)[1]);
  await client()('/api/email/confirm', { method: 'POST', body: { token: newToken } });

  const unsub = await client()('/api/email/unsubscribe', { method: 'POST', body: { token: newToken } });
  assert.equal(unsub.body.email, 'new@example.com');
  assert.equal((await m.call('/api/me')).body.member.email_opt_in, 0);
});

test('admins send notifications by email to confirmed, opted-in members', async () => {
  const admin = await login('admin', 'admin-password-123');
  // Start from a clean slate: nobody opted in.
  db.prepare('UPDATE members SET email_opt_in = 0').run();

  const optedIn = await verified({ surname: 'OptedIn' });
  await optedIn.call('/api/me/email', { method: 'PUT', body: { email: 'in@example.com', opt_in: true } });
  const token = decodeURIComponent(sentEmails.at(-1).text.match(/t=(\S+)/)[1]);
  await client()('/api/email/confirm', { method: 'POST', body: { token } });
  const unconfirmed = await verified();
  await unconfirmed.call('/api/me/email', { method: 'PUT', body: { email: 'pending@example.com', opt_in: true } });
  const optedOut = await verified();
  await optedOut.call('/api/me/email', { method: 'PUT', body: { email: 'out@example.com', opt_in: false } });

  const member = await verified();
  assert.equal((await member.call('/api/admin/announcements')).status, 403);
  assert.equal((await member.call('/notify')).location, '/');
  assert.equal((await member.call('/api/admin/announcements', { method: 'POST', body: { subject: 'x', body: 'y' } })).status, 403);

  const info = (await admin('/api/admin/announcements')).body.email;
  assert.deepEqual(info, { configured: true, recipients: 1 });

  sentEmails.length = 0;
  const res = await admin('/api/admin/announcements', {
    method: 'POST',
    body: { subject: 'Caleb meetup', body: 'Join us on Saturday.', send_email: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.emailing, 1);
  for (let i = 0; i < 50 && sentEmails.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sentEmails.map((e) => e.to), ['in@example.com']);
  assert.equal(sentEmails[0].subject, 'Caleb meetup');
  assert.match(sentEmails[0].text, /Join us on Saturday\.[\s\S]*Unsubscribe: https:\/\/calebs\.test\/email\?action=unsubscribe&t=/);
  assert.match(sentEmails[0].headers['List-Unsubscribe'], /^<https:\/\/calebs\.test\/email\?action=unsubscribe/);

  const history = (await admin('/api/admin/announcements')).body.announcements[0];
  assert.equal(history.subject, 'Caleb meetup');
  assert.equal(history.email_sent, 1);

  // Every member sees it on the site, without the delivery numbers.
  const seen = (await member.call('/api/announcements')).body.announcements[0];
  assert.equal(seen.body, 'Join us on Saturday.');
  assert.equal(seen.email_sent, undefined);

  // A notification can be posted without emailing anyone.
  sentEmails.length = 0;
  const siteOnly = await admin('/api/admin/announcements', { method: 'POST', body: { subject: 'Site only', body: 'Hi', send_email: false } });
  assert.equal(siteOnly.body.emailing, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sentEmails.length, 0);
  assert.equal((await admin('/api/admin/announcements', { method: 'POST', body: { subject: '', body: 'Hi' } })).status, 422);
});
