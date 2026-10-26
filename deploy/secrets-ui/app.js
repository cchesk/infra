'use strict';
// Secrets page UI. Values come from /api/apps (behind the passkey login) and stay masked until the eye is tapped.
// Value fields are text inputs masked with CSS, not password fields, so password managers leave them alone.

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ICONS = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  remove: '<path d="M6 6l12 12M18 6L6 18"/>',
};
// Keeps password managers (iCloud Keychain, 1Password, LastPass, Bitwarden) from offering or saving these fields.
const NO_AUTOFILL = {
  autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
  'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '', 'data-form-type': 'other',
};

let apps = [];
const editing = new Map(); // app name -> { rows: [{ key, value }], restart }
const shown = new Set(); // "app\nKEY" pairs revealed in the list
const status = new Map(); // app name -> { text, error }

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

function iconButton(name, label, onclick) {
  return el('button', { type: 'button', class: 'icon', title: label, 'aria-label': label, onclick }, icon(name));
}

function setLabel(button, name, label) {
  button.replaceChildren(icon(name));
  button.title = label;
  button.setAttribute('aria-label', label);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el('textarea', { value: text, readonly: '', style: 'position:fixed;opacity:0' });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  setLabel(button, 'check', 'Copied');
  setTimeout(() => setLabel(button, 'copy', 'Copy'), 1200);
}

async function api(url, body) {
  const res = await fetch(url, body === undefined
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  // An expired sign-in shows up as a redirect to Authelia's login page.
  if (res.redirected || !(res.headers.get('content-type') || '').startsWith('application/json')) {
    throw new Error('Your sign-in has expired. Copy anything you typed, then reload the page to sign in again.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function setStatus(name, text, error) {
  status.set(name, { text, error });
  render();
}

function render() {
  const root = document.getElementById('apps');
  if (!apps.length) return root.replaceChildren(el('p', {}, 'No node apps on this server.'));
  root.replaceChildren(...apps.map(card));
}

function card(app) {
  const draft = editing.get(app.name);
  const st = status.get(app.name);
  return el('section', { 'data-app': app.name },
    el('div', { class: 'head' },
      el('h2', {}, app.name),
      draft ? null : el('button', { type: 'button', class: 'secondary', onclick: () => startEdit(app) }, 'Edit')),
    draft ? editView(app, draft) : listView(app),
    st ? el('p', { class: `msg ${st.error ? 'err' : 'ok'}` }, st.text) : null);
}

function listView(app) {
  if (!app.secrets.length) return el('p', { class: 'muted' }, 'No secrets yet. Tap Edit to add some.');
  return el('ul', { class: 'rows' }, app.secrets.map(({ key, value }) => {
    const id = `${app.name}\n${key}`;
    const visible = shown.has(id);
    const eye = iconButton(visible ? 'eyeOff' : 'eye', visible ? 'Hide' : 'Show', () => {
      if (visible) shown.delete(id); else shown.add(id);
      render();
    });
    const copy = iconButton('copy', 'Copy', () => copyText(value, copy));
    return el('li', {},
      el('code', { class: 'key' }, key),
      el('span', { class: visible ? 'value shown' : 'value' }, visible ? (value || '(empty)') : '••••••••'),
      el('span', { class: 'actions' }, eye, copy));
  }));
}

function editView(app, draft) {
  const rows = el('ul', { class: 'rows edit' }, draft.rows.map((row, i) => {
    const keyInput = el('input', {
      class: 'key-input', value: row.key, placeholder: 'KEY_NAME', 'aria-label': 'Key', autocapitalize: 'characters',
      ...NO_AUTOFILL, oninput: (e) => { row.key = e.target.value.trim(); },
    });
    const valueInput = el('input', {
      class: 'value-input masked', value: row.value, placeholder: 'value', 'aria-label': `Value of ${row.key || 'new key'}`,
      autocapitalize: 'off', ...NO_AUTOFILL, oninput: (e) => { row.value = e.target.value; },
    });
    const eye = iconButton('eye', 'Show', () => {
      const masked = valueInput.classList.toggle('masked');
      setLabel(eye, masked ? 'eye' : 'eyeOff', masked ? 'Show' : 'Hide');
    });
    const remove = iconButton('remove', 'Remove', () => { draft.rows.splice(i, 1); render(); });
    return el('li', {}, keyInput, valueInput, eye, remove);
  }));
  const add = () => {
    draft.rows.push({ key: '', value: '' });
    render();
    document.querySelector(`section[data-app="${CSS.escape(app.name)}"] .edit li:last-child .key-input`)?.focus();
  };
  const restart = el('input', { type: 'checkbox', checked: draft.restart, onchange: (e) => { draft.restart = e.target.checked; } });
  const saveButton = el('button', { type: 'button', onclick: () => save(app, draft, saveButton) }, 'Save changes');
  return el('div', {},
    rows,
    el('button', { type: 'button', class: 'secondary', onclick: add }, '+ Add secret'),
    el('div', { class: 'footer' },
      el('label', {}, restart, ' Save and restart app'),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', class: 'secondary', onclick: () => { editing.delete(app.name); status.delete(app.name); render(); } }, 'Cancel'),
        saveButton)));
}

function startEdit(app) {
  const rows = app.secrets.map(({ key, value }) => ({ key, value }));
  if (!rows.length) rows.push({ key: '', value: '' });
  editing.set(app.name, { rows, restart: true });
  status.delete(app.name);
  render();
}

async function save(app, draft, button) {
  const rows = draft.rows.filter((r) => r.key || r.value);
  const seen = new Set();
  for (const r of rows) {
    if (!KEY_RE.test(r.key)) return setStatus(app.name, `"${r.key}" isn't a valid key: use letters, digits and _, not starting with a digit.`, true);
    if (r.key === 'PORT') return setStatus(app.name, 'PORT is assigned by the deploy and can\'t be set here.', true);
    if (seen.has(r.key)) return setStatus(app.name, `${r.key} appears twice.`, true);
    seen.add(r.key);
  }
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const res = await api('/api/save', { app: app.name, secrets: rows.map(({ key, value }) => ({ key, value })), restart: draft.restart });
    app.secrets = res.app.secrets;
    editing.delete(app.name);
    setStatus(app.name, res.message, res.error);
  } catch (e) {
    setStatus(app.name, e.message, true);
  }
}

window.addEventListener('beforeunload', (e) => { if (editing.size) e.preventDefault(); });

api('/api/apps')
  .then((data) => { apps = data.apps; render(); })
  .catch((e) => document.getElementById('apps').replaceChildren(el('p', { class: 'msg err' }, e.message)));
