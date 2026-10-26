'use strict';
// Secrets page for the node apps, served at https://secrets.<domain> (see deploy/setup-secrets.sh).
// Caddy only forwards a request here after Authelia's passkey login, and sets Remote-User. This server listens on a
// unix socket that only Caddy can open, so nothing else on the box can fake that header. All reads and writes go
// through the root helper app-secret, which can only touch /etc/apps/secrets/<app>.env and restart app@<app>.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SOCK = '/run/secrets-ui/http.sock';
const HELPER = '/usr/local/bin/app-secret';
const { OWNER, HOST } = process.env;
if (!OWNER || !HOST) throw new Error('OWNER and HOST must be set');
const ORIGIN = `https://${HOST}`;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const APP_JS = fs.readFileSync(path.join(__dirname, 'app.js'));

function helper(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('sudo', ['-n', HELPER, ...args], { timeout: 60000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().replace(/^app-secret: /, '')));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function loadApp(name) {
  const secrets = (await helper(['get', name])).split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('=');
    return { key: line.slice(0, i), value: line.slice(i + 1) };
  });
  return { name, secrets };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>App secrets</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--card:#fff;--line:#ddd;--muted:#777;--accent:#2457d6;--bad:#b3261e;--good:#1e7a3c}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--card:#1e1e1e;--line:#333;--muted:#999;--accent:#7aa2ff;--bad:#ff8a80;--good:#7bd88f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.1rem;margin:0}a{color:var(--accent)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:16px 0}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.rows{list-style:none;padding:0;margin:8px 0}
.rows li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 0;border-top:1px solid var(--line)}
.rows li:first-child{border-top:0}
.key{font-weight:600;overflow-wrap:anywhere}
.value{flex:1 1 140px;min-width:0;font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere;color:var(--muted)}
.value.shown{color:var(--fg)}
.actions{display:flex;gap:6px;margin-left:auto}
.edit li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px}
.edit .key-input{grid-column:1/-1}
@media (min-width:560px){.edit li{grid-template-columns:minmax(0,2fr) minmax(0,3fr) auto auto}.edit .key-input{grid-column:auto}}
input:not([type=checkbox]){width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:16px ui-monospace,Menlo,monospace}
.masked{-webkit-text-security:disc;text-security:disc}
button{padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.6}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.icon{background:transparent;color:var(--fg);border:1px solid var(--line);width:38px;height:38px;padding:0;display:inline-grid;place-items:center}
button.icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin-top:12px}
.footer .buttons{display:flex;gap:8px;margin-left:auto}
.muted{color:var(--muted)}.msg{margin:8px 0 0}.ok{color:var(--good)}.err{color:var(--bad)}
</style></head><body><main>
<h1>App secrets</h1>
<p class="muted">Signed in as ${esc(OWNER)} · <a href="/auth/logout">Sign out</a></p>
<div id="apps"><p class="muted">Loading…</p></div>
</main><script src="/app.js"></script></body></html>`;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json');

// Only the page itself may write: same origin, and JSON (which a cross-site form can't send).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return origin === ORIGIN;
  return req.headers['sec-fetch-site'] === 'same-origin';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 300000) { reject(new Error('request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

function validate(body) {
  if (typeof body?.app !== 'string' || !Array.isArray(body.secrets)) return 'bad request';
  const seen = new Set();
  for (const s of body.secrets) {
    if (typeof s?.key !== 'string' || typeof s.value !== 'string') return 'bad request';
    if (!KEY_RE.test(s.key)) return `bad key "${s.key}" (letters, digits, underscore; not starting with a digit)`;
    if (s.key === 'PORT') return 'PORT is assigned by the deploy';
    if (seen.has(s.key)) return `${s.key} appears twice`;
    if (/[\0\r\n]/.test(s.value)) return `the value of ${s.key} must be a single line`;
    if (s.value.length > 8192) return `the value of ${s.key} is longer than 8 KiB`;
    seen.add(s.key);
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers['remote-user'] !== OWNER) return send(res, 403, 'Forbidden', 'text/plain');
    const { pathname } = new URL(req.url, ORIGIN);
    if (req.method === 'GET' && pathname === '/') return send(res, 200, PAGE);
    if (req.method === 'GET' && pathname === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && pathname === '/api/apps') {
      const names = (await helper(['apps'])).split('\n').filter(Boolean);
      return json(res, 200, { apps: await Promise.all(names.map(loadApp)) });
    }
    if (req.method === 'POST' && pathname === '/api/save') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
      const body = await readJson(req);
      const problem = validate(body);
      if (problem) return json(res, 400, { error: problem });
      let message;
      try {
        message = (await helper(['put', body.app], body.secrets.map((s) => `${s.key}=${s.value}\n`).join(''))).trim();
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      let error = false;
      if (body.restart) {
        try { message += '; ' + (await helper(['restart', body.app])).trim(); }
        catch (e) { message += `, but the restart failed: ${e.message}`; error = true; }
      }
      return json(res, 200, { message, error, app: await loadApp(body.app) });
    }
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
});

fs.rmSync(SOCK, { force: true });
server.listen(SOCK, () => console.log(`listening on ${SOCK} for ${ORIGIN}`));
