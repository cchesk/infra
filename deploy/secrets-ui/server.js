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

// Static files, read once at startup. Everything here is behind the passkey login like the rest of the page.
const STATIC = Object.fromEntries([
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/app.css', 'app.css', 'text/css; charset=utf-8'],
  ['/favicon.ico', 'assets/favicon.ico', 'image/x-icon'],
  ['/apple-touch-icon.png', 'assets/apple-touch-icon.png', 'image/png'],
  ['/assets/logo.svg', 'assets/logo.svg', 'image/svg+xml'],
  ['/assets/mask.woff2', 'assets/mask.woff2', 'font/woff2'],
].map(([url, file, type]) => [url, { body: fs.readFileSync(path.join(__dirname, file)), type }]));

const DOMAIN = HOST.replace(/^secrets\./, '');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0d1117">
<title>Secrets · ${esc(DOMAIN)}</title>
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="alternate icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/assets/mask.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app.css">
</head><body>
<header class="topbar"><div class="wrap topbar-inner">
  <a class="brand" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28">Secrets</a>
  <span class="crumb">${esc(DOMAIN)}</span>
  <span class="spacer"></span>
  <span class="user"><span class="avatar" aria-hidden="true">${esc(OWNER.slice(0, 1))}</span><span class="user-name">${esc(OWNER)}</span></span>
  <a class="btn btn-header" href="/auth/logout">Sign out</a>
</div></header>
<main class="wrap">
  <div class="page-head">
    <h1>Applications</h1>
    <p class="lead">Environment secrets for the node apps on this server. An app reads them when it starts, so save with a restart for a change to take effect.</p>
  </div>
  <div id="apps" aria-live="polite"><div class="box empty">Loading…</div></div>
</main>
<footer class="foot">Stored root-only on this server. Never committed, never sent to GitHub.</footer>
<script src="/app.js"></script>
</body></html>`;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
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
    if (req.method === 'GET' && STATIC[pathname]) return send(res, 200, STATIC[pathname].body, STATIC[pathname].type);
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
