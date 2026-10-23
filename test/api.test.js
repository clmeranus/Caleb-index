'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/db');
const { createServer } = require('../src/server');

let server;
let base;

before(async () => {
  server = createServer({ db: store.open(), adminToken: 'admin-secret', registerLimit: () => true });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Edit-Token'] = token;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('registers a Caleb and assigns sequential numbers', async () => {
  const a = await call('/api/calebs', { method: 'POST', body: { first_name: 'caleb', surname: 'Smith', country: 'USA' } });
  assert.equal(a.status, 201);
  assert.equal(a.body.caleb.spelling, 'Caleb');
  assert.equal(a.body.caleb.surname, 'Smith');
  assert.ok(a.body.token);
  assert.equal(a.body.caleb.token_hash, undefined);

  const b = await call('/api/calebs', { method: 'POST', body: { first_name: 'Kaleb', birth_year: 1990 } });
  assert.equal(b.body.caleb.number, a.body.caleb.number + 1);
  assert.equal(b.body.caleb.spelling, 'Kaleb');
});

test('rejects people who are not named Caleb', async () => {
  const res = await call('/api/calebs', { method: 'POST', body: { first_name: 'Joshua' } });
  assert.equal(res.status, 422);
  assert.match(res.body.details[0], /first_name/);
});

test('validates field lengths, years and websites', async () => {
  const res = await call('/api/calebs', {
    method: 'POST',
    body: { first_name: 'Caleb', bio: 'x'.repeat(501), birth_year: 1800, website: 'javascript:alert(1)' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.details.length, 3);
});

test('rejects the honeypot field', async () => {
  const res = await call('/api/calebs', { method: 'POST', body: { first_name: 'Caleb', website_confirm: 'spam' } });
  assert.equal(res.status, 400);
});

test('lists, searches and filters', async () => {
  await call('/api/calebs', { method: 'POST', body: { first_name: 'Calev', location: 'Haifa', country: 'Israel' } });
  const all = await call('/api/calebs');
  assert.ok(all.body.total >= 3);

  const search = await call('/api/calebs?q=haifa');
  assert.equal(search.body.total, 1);
  assert.equal(search.body.calebs[0].spelling, 'Calev');

  const bySpelling = await call('/api/calebs?spelling=Kaleb');
  assert.ok(bySpelling.body.calebs.every((c) => c.spelling === 'Kaleb'));

  const wildcard = await call('/api/calebs?q=%25');
  assert.equal(wildcard.body.total, 0);
});

test('edits and deletes with the edit token only', async () => {
  const { body } = await call('/api/calebs', { method: 'POST', body: { first_name: 'Caleb', occupation: 'Baker' } });
  const n = body.caleb.number;

  assert.equal((await call(`/api/calebs/${n}`, { method: 'PATCH', body: { occupation: 'Chef' } })).status, 401);
  assert.equal((await call(`/api/calebs/${n}`, { method: 'PATCH', body: { occupation: 'Chef' }, token: 'wrong' })).status, 403);

  const edited = await call(`/api/calebs/${n}`, { method: 'PATCH', body: { occupation: 'Chef', birth_year: '' }, token: body.token });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.occupation, 'Chef');
  assert.equal(edited.body.birth_year, null);

  const badRename = await call(`/api/calebs/${n}`, { method: 'PATCH', body: { first_name: 'Bob' }, token: body.token });
  assert.equal(badRename.status, 422);

  assert.equal((await call(`/api/calebs/${n}`, { method: 'DELETE', token: body.token })).status, 204);
  assert.equal((await call(`/api/calebs/${n}`)).status, 404);
});

test('admin token can remove any entry', async () => {
  const { body } = await call('/api/calebs', { method: 'POST', body: { first_name: 'Caleb' } });
  const res = await call(`/api/calebs/${body.caleb.number}`, { method: 'DELETE', token: 'admin-secret' });
  assert.equal(res.status, 204);
});

test('reports statistics', async () => {
  const res = await call('/api/stats');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 3);
  assert.ok(res.body.bySpelling.some((r) => r.label === 'Calev'));
  assert.deepEqual(res.body.byDecade.find((r) => r.label === 1990), { label: 1990, n: 1 });
});

test('serves pages and blocks path traversal', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /The Caleb Index/);
  assert.equal((await fetch(base + '/register')).status, 200);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
});

test('rate limits registrations', async () => {
  const { rateLimiter } = require('../src/server');
  const allow = rateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), false);
  assert.equal(allow('other'), true);
});
