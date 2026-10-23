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

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Edit-Token'] = token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.details = data && data.details;
    throw err;
  }
  return data;
}

function fullName(c) {
  return c.surname ? `${c.spelling} ${c.surname}` : c.spelling;
}

function place(c) {
  return [c.location, c.country].filter(Boolean).join(', ');
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

function calebCard(c) {
  return el(
    'a',
    { class: 'card', href: `/caleb?n=${c.number}` },
    el('div', { class: 'num' }, `No. ${c.number}`),
    el('div', { class: 'name' }, fullName(c)),
    el('div', { class: 'meta' }, [place(c), c.occupation].filter(Boolean).join(' · ') || 'A Caleb of mystery')
  );
}
