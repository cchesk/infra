'use strict';
// Secrets page UI. Values come from /api/apps (behind the passkey login) and stay masked until the eye is tapped.
// Value fields are text inputs masked with a dots-only font (app.css), not password fields, so password managers
// neither offer nor save anything.

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ICONS = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
// Keeps password managers (iCloud Keychain, 1Password, LastPass, Bitwarden) away from these fields.
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
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

function iconButton(name, label, onclick, extra = '') {
  return el('button', { type: 'button', class: `btn-icon ${extra}`.trim(), title: label, 'aria-label': label, onclick }, icon(name));
}

function setIcon(button, name, label) {
  button.replaceChildren(icon(name));
  button.title = label;
  button.setAttribute('aria-label', label);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el('textarea', { value: text, readonly: '', class: 'offscreen', 'aria-hidden': 'true' });
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  setIcon(button, 'check', 'Copied');
  button.classList.add('done');
  setTimeout(() => { setIcon(button, 'copy', 'Copy'); button.classList.remove('done'); }, 1200);
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
  if (!apps.length) {
    return root.replaceChildren(el('div', { class: 'box empty' }, icon('server'), el('strong', {}, 'No node apps yet'),
      'Apps appear here after their first deploy.'));
  }
  root.replaceChildren(...apps.map(card));
}

function card(app) {
  const draft = editing.get(app.name);
  const st = status.get(app.name);
  const n = app.secrets.length;
  return el('section', { class: 'box', 'data-app': app.name },
    el('div', { class: 'box-head' },
      el('span', { class: 'app-icon' }, icon('server')),
      el('h2', { class: 'app-name' }, app.name),
      el('span', { class: 'counter' }, `${n} ${n === 1 ? 'secret' : 'secrets'}`),
      draft ? null : el('button', { type: 'button', class: 'btn', onclick: () => startEdit(app) }, icon('pencil'), 'Edit')),
    st ? el('p', { class: `flash ${st.error ? 'err' : 'ok'}`, role: 'status' }, st.text) : null,
    draft ? editView(app, draft) : listView(app));
}

function listView(app) {
  if (!app.secrets.length) {
    return el('div', { class: 'empty' }, icon('lock'), el('strong', {}, 'No secrets yet'), 'Click Edit to add the first one.');
  }
  return el('ul', { class: 'rows' }, app.secrets.map(({ key, value }) => {
    const id = `${app.name}\n${key}`;
    const visible = shown.has(id);
    const eye = iconButton(visible ? 'eyeOff' : 'eye', visible ? 'Hide value' : 'Show value', () => {
      if (visible) shown.delete(id); else shown.add(id);
      render();
    });
    const copy = iconButton('copy', 'Copy', () => copyText(value, copy));
    return el('li', { class: 'row' },
      el('code', { class: 'key' }, key),
      el('span', { class: visible ? 'value shown' : 'value' }, visible ? (value || '(empty)') : '••••••••••••'),
      el('span', { class: 'actions' }, eye, copy));
  }));
}

function editView(app, draft) {
  const rows = el('ul', { class: 'rows' }, draft.rows.map((row, i) => {
    const keyInput = el('input', {
      class: 'input key-input', value: row.key, placeholder: 'KEY_NAME', 'aria-label': 'Key', autocapitalize: 'characters',
      ...NO_AUTOFILL, oninput: (e) => { row.key = e.target.value.trim(); },
    });
    const valueInput = el('input', {
      class: 'input value-input masked', value: row.value, placeholder: 'Value', 'aria-label': `Value of ${row.key || 'new key'}`,
      autocapitalize: 'off', ...NO_AUTOFILL, oninput: (e) => { row.value = e.target.value; },
    });
    const eye = iconButton('eye', 'Show value', () => {
      const masked = valueInput.classList.toggle('masked');
      setIcon(eye, masked ? 'eye' : 'eyeOff', masked ? 'Show value' : 'Hide value');
    });
    const remove = iconButton('trash', 'Remove', () => { draft.rows.splice(i, 1); render(); }, 'danger');
    return el('li', { class: 'row edit-row' }, keyInput, valueInput, eye, remove);
  }));
  const add = () => {
    draft.rows.push({ key: '', value: '' });
    render();
    document.querySelector(`section[data-app="${CSS.escape(app.name)}"] .edit-row:last-child .key-input`)?.focus();
  };
  const restart = el('input', { type: 'checkbox', checked: draft.restart, onchange: (e) => { draft.restart = e.target.checked; } });
  const saveButton = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => save(app, draft, saveButton) }, 'Save changes');
  const cancel = () => { editing.delete(app.name); status.delete(app.name); render(); };
  return el('div', {},
    rows,
    el('div', { class: 'add-row' }, el('button', { type: 'button', class: 'btn btn-invisible', onclick: add }, icon('plus'), 'Add secret')),
    el('div', { class: 'box-foot' },
      el('label', { class: 'check' }, restart, 'Save and restart app'),
      el('div', { class: 'buttons' }, el('button', { type: 'button', class: 'btn', onclick: cancel }, 'Cancel'), saveButton)));
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
  .catch((e) => document.getElementById('apps').replaceChildren(el('div', { class: 'box' }, el('p', { class: 'flash err' }, e.message))));
