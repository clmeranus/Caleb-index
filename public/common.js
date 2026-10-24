'use strict';

// Small DOM helper: el('a', { href: '/' }, 'text', childNode)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body || {});
  }
  const res = await fetch(path, init);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}

// Fills in the site navigation for the logged-in member and returns them.
async function initNav(current) {
  const nav = document.getElementById('nav');
  let member = null;
  try {
    member = (await api('/api/me')).member;
  } catch {
    return null;
  }
  if (!nav) return member;
  const links =
    member.status === 'verified'
      ? [
          ['/', 'Index'],
          ['/nearby', 'Near you'],
          ['/messages', 'Messages', member.unread_messages],
          ['/stats', 'Statistics'],
          ['/applicants', 'Applicants'],
          isAdmin(member) && ['/admin', 'Review'],
          isAdmin(member) && ['/notify', 'Notify'],
          ['/account', 'Account'],
        ]
      : [['/pending', 'Application']];
  nav.replaceChildren(
    ...links.filter(Boolean).map(([href, label, count]) =>
      el('a', { href, 'aria-current': href === current ? 'page' : null },
        label,
        count ? el('span', { class: 'count', 'aria-label': `${count} unread` }, count) : null)
    ),
    el('button', { class: 'link', type: 'button', onclick: logout }, 'Log out')
  );
  return member;
}

function isAdmin(member) {
  return member.role === 'admin' || member.role === 'owner';
}

function fullName(c) {
  return c.surname ? `${c.spelling} ${c.surname}` : c.spelling;
}

function place(c) {
  return [c.location, c.region, c.country].filter(Boolean).join(', ');
}

function calebNumber(n) {
  return `Caleb No. ${n}`;
}

function errorBox(err) {
  return el(
    'div',
    { class: 'errors', role: 'alert' },
    el('strong', {}, err.message),
    err.details && el('ul', {}, err.details.map((d) => el('li', {}, d)))
  );
}

function noticeBox(text) {
  return el('div', { class: 'panel success', role: 'status' }, text);
}

// A link to start or continue a conversation with a member.
function messageButton(c, { ghost = false } = {}) {
  return el('a', { class: ghost ? 'btn ghost small' : 'btn small', href: `/messages?to=${c.number}` }, 'Message');
}

function calebCard(c) {
  return el(
    'a',
    { class: 'card', href: `/caleb?n=${c.number}` },
    el('div', { class: 'num' }, `No. ${c.number}`),
    el('div', { class: 'name' }, fullName(c)),
    el('div', { class: 'meta' }, [place(c), c.occupation].filter(Boolean).join(' · ') || 'A Caleb of mystery')
  );
}

// Profile fields shared by the sign-up, application and account forms.
const PROFILE_FIELDS = [
  { name: 'first_name', label: 'First name *', hint: 'Caleb, Kaleb, Calev, Cayleb, and similar spellings are welcome.', attrs: { required: true, autocomplete: 'given-name' } },
  { name: 'surname', label: 'Surname', hint: 'Optional. An initial works too.', attrs: { maxlength: 60, autocomplete: 'family-name' } },
  { name: 'location', label: 'Town or city', attrs: { maxlength: 80, autocomplete: 'address-level2' } },
  { name: 'region', label: 'State / province', attrs: { maxlength: 60, autocomplete: 'address-level1' } },
  { name: 'postal_code', label: 'ZIP / postal code', hint: 'Private. Only used to find Calebs near you (US ZIP codes for now).', attrs: { maxlength: 12, autocomplete: 'postal-code' } },
  { name: 'country', label: 'Country', attrs: { maxlength: 60, autocomplete: 'country-name' } },
  { name: 'birth_year', label: 'Birth year', attrs: { inputmode: 'numeric', maxlength: 4, placeholder: 'e.g. 1996' } },
  { name: 'occupation', label: 'Occupation', attrs: { maxlength: 80 } },
  { name: 'bio', label: 'About you', textarea: true, attrs: { rows: 4, maxlength: 500, placeholder: "Anything you'd like other Calebs to know." } },
  { name: 'website', label: 'Website', attrs: { type: 'url', maxlength: 200, placeholder: 'https://' } },
];

const VERIFICATION_FIELD = {
  name: 'verification_note',
  label: 'Evidence for the reviewers',
  hint: 'Optional, and only admins see it. For example: a link to a public profile that shows your name (LinkedIn, a staff page, a club roster), or members who know you. Please do not paste ID numbers.',
  textarea: true,
  attrs: { rows: 3, maxlength: 500 },
};

function field({ name, label, hint, textarea, attrs = {} }, value = '') {
  const input = textarea
    ? el('textarea', { id: name, name, ...attrs }, value ?? '')
    : el('input', { id: name, name, value: value ?? '', ...attrs });
  return el('div', { class: 'field' }, el('label', { for: name }, label), input, hint && el('div', { class: 'hint' }, hint));
}

// Builds the profile inputs, pre-filled from a member when given.
function profileFields(member = {}) {
  const values = { ...member, first_name: member.spelling || 'Caleb' };
  const f = (name) => field(PROFILE_FIELDS.find((x) => x.name === name), values[name]);
  return [
    el('div', { class: 'row' }, f('first_name'), f('surname')),
    el('div', { class: 'row' }, f('location'), f('region')),
    el('div', { class: 'row' }, f('postal_code'), f('country')),
    el('div', { class: 'row' }, f('birth_year'), f('occupation')),
    f('bio'),
    f('website'),
  ];
}
