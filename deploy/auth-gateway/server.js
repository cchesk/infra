'use strict';
// Auth gateway: lets Caddy protect any app with an Ory Kratos sign-in, without giving apps the Kratos session cookie.
//
//   app host  GET /verify          Caddy's forward_auth check: a valid app cookie and a live Kratos session (re-checked
//                                  through the admin API) whose identity is in one of the app's groups -> 200 with
//                                  Remote-User / Remote-Email / Remote-Groups; no session -> 302 to the auth host
//             GET /.auth/callback  takes a one-time code from the auth host and sets this app's own cookie
//             GET /.auth/logout    drops the app cookie and signs out of Kratos
//   auth host GET /gateway/issue   with a Kratos session: issue a one-time code for the app named in ?rd= and send the
//                                  browser back there; without one: the login page first
//
// Each app gets its own host-only cookie (HMAC-signed session id + expiry), so an app on another subdomain never sees
// another app's session or the Kratos one. Config: /etc/auth-gateway/apps.json, e.g.
//   { "secrets.example.com": { "groups": ["secrets-admins"] } }
// Groups come from the identity's metadata_public.groups (set with deploy/setup-kratos.sh).
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const {
  AUTH_HOST, KRATOS_PUBLIC = 'http://127.0.0.1:4433', KRATOS_ADMIN_SOCKET = '/run/kratos/admin.sock',
  SECRET_FILE = '/etc/auth-gateway/secret', APPS_FILE = '/etc/auth-gateway/apps.json',
  SOCKET = '/run/auth-gateway/http.sock', SCHEME = 'https', COOKIE = '__Host-app_session',
} = process.env;
if (!AUTH_HOST) throw new Error('AUTH_HOST must be set');
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
if (SECRET.length < 32) throw new Error('secret too short');
const AUTH = `${SCHEME}://${AUTH_HOST}`;
const SECURE = SCHEME === 'https' ? '; Secure' : '';
let apps = {};
const loadApps = () => { apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8')); };
loadApps();
process.on('SIGHUP', loadApps);

// ---- signed tokens: base64url(JSON) "." base64url(HMAC-SHA256)
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function sign(payload) {
  const data = b64(JSON.stringify(payload));
  return `${data}.${mac(data)}`;
}
function verify(token, purpose) {
  if (typeof token !== 'string') return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const want = Buffer.from(mac(data)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    return p.purpose === purpose && p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// One-time codes: remember used nonces until they expire.
const usedNonces = new Map();
setInterval(() => { for (const [n, exp] of usedNonces) if (exp < Date.now()) usedNonces.delete(n); }, 60000).unref();

// ---- Kratos
async function whoami(cookieHeader) {
  const res = await fetch(`${KRATOS_PUBLIC}/sessions/whoami`, { headers: { Cookie: cookieHeader || '', Accept: 'application/json' } });
  return res.ok ? res.json() : null;
}
// Session lookups by id through the admin socket, cached briefly so every request doesn't hit Kratos.
const sessionCache = new Map();
function adminSession(id) {
  const hit = sessionCache.get(id);
  if (hit && hit.at > Date.now() - 30000) return Promise.resolve(hit.session);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: KRATOS_ADMIN_SOCKET, path: `/admin/sessions/${encodeURIComponent(id)}?expand=identity`, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const session = res.statusCode === 200 ? JSON.parse(body) : null;
        sessionCache.set(id, { at: Date.now(), session });
        resolve(session);
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const live = (s) => s && s.active && new Date(s.expires_at).getTime() > Date.now();
const groupsOf = (identity) => (Array.isArray(identity?.metadata_public?.groups) ? identity.metadata_public.groups : []);
const allowed = (host, identity) => {
  const app = apps[host];
  return Boolean(app) && groupsOf(identity).some((g) => (app.groups || []).includes(g));
};

// ---- HTTP helpers
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => {
  const i = c.indexOf('=');
  return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
}));
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}
function page(res, status, title, text, link) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;color:#1f2328"><h1 style="font-weight:400">${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a href="${esc(link.href)}">${esc(link.text)}</a></p>` : ''}</body>`);
}
// The app URL the browser asked for (from forward_auth's headers), only if it's a registered app.
function appUrl(host, uri) {
  if (!apps[host]) return null;
  const path = typeof uri === 'string' && uri.startsWith('/') && !uri.startsWith('//') ? uri : '/';
  return `${SCHEME}://${host}${path}`;
}
function parseAppUrl(rd) {
  try {
    const u = new URL(rd);
    return u.protocol === `${SCHEME}:` && apps[u.host] ? u : null;
  } catch { return null; }
}

// ---- endpoints
async function handle(req, res) {
  const host = req.headers.host || '';
  const url = new URL(req.url, `${SCHEME}://${host}`);
  // Caddy's forward_auth always asks with GET (the original method is in X-Forwarded-Method).
  if (req.method !== 'GET' && req.method !== 'HEAD') return page(res, 405, 'Not allowed', 'This address only answers GET.');

  if (host === AUTH_HOST && url.pathname === '/gateway/issue') {
    const target = parseAppUrl(url.searchParams.get('rd'));
    if (!target) return page(res, 400, 'Unknown app', 'That address isn\'t an app this sign-in protects.');
    const session = await whoami(req.headers.cookie);
    if (!live(session)) return redirect(res, `${AUTH}/login/?return_to=${encodeURIComponent(url.href)}`);
    if (!allowed(target.host, session.identity)) {
      return page(res, 403, 'No access', `You're signed in, but your account doesn't have access to ${target.host}.`, { href: `${AUTH}/login/?logout`, text: 'Sign in as someone else' });
    }
    const code = sign({ purpose: 'code', sid: session.id, host: target.host, rd: target.href, n: crypto.randomUUID(), exp: Date.now() + 60000 });
    return redirect(res, `${SCHEME}://${target.host}/.auth/callback?code=${encodeURIComponent(code)}`);
  }

  if (!apps[host]) return page(res, 404, 'Not found', 'Nothing here.');

  if (url.pathname === '/verify') {
    const token = verify(cookies(req)[COOKIE], 'app');
    const session = token && token.host === host ? await adminSession(token.sid) : null;
    if (live(session)) {
      if (!allowed(host, session.identity)) return page(res, 403, 'No access', `Your account doesn't have access to ${host}.`, { href: `${AUTH}/login/?logout`, text: 'Sign in as someone else' });
      const traits = session.identity.traits || {};
      res.writeHead(200, {
        'Remote-User': traits.username || traits.email || session.identity.id,
        'Remote-Email': traits.email || '',
        'Remote-Groups': groupsOf(session.identity).join(','),
        'Cache-Control': 'no-store',
      });
      return res.end();
    }
    const method = req.headers['x-forwarded-method'] || 'GET';
    const back = appUrl(host, req.headers['x-forwarded-uri']);
    if (method !== 'GET' && method !== 'HEAD') return page(res, 401, 'Signed out', 'Your session has ended. Reload the page to sign in again.');
    return redirect(res, `${AUTH}/gateway/issue?rd=${encodeURIComponent(back)}`);
  }

  if (url.pathname === '/.auth/callback') {
    const code = verify(url.searchParams.get('code'), 'code');
    if (!code || code.host !== host || usedNonces.has(code.n)) return page(res, 400, 'Sign-in link expired', 'Open the app again to sign in.', { href: `${SCHEME}://${host}/`, text: 'Open the app' });
    usedNonces.set(code.n, code.exp);
    const session = await adminSession(code.sid);
    if (!live(session) || !allowed(host, session.identity)) return page(res, 403, 'No access', 'Sign in again with an account that has access.', { href: `${AUTH}/login/?logout`, text: 'Sign in' });
    const exp = new Date(session.expires_at).getTime();
    const cookie = sign({ purpose: 'app', sid: session.id, host, exp });
    const back = parseAppUrl(code.rd);
    return redirect(res, back && back.host === host ? back.href : `${SCHEME}://${host}/`, {
      'Set-Cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${Math.max(0, Math.floor((exp - Date.now()) / 1000))}`,
    });
  }

  if (url.pathname === '/.auth/logout') {
    return redirect(res, `${AUTH}/login/?logout`, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=0` });
  }

  return page(res, 404, 'Not found', 'Nothing here.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) page(res, 502, 'Sign-in unavailable', 'The sign-in service didn\'t answer. Try again in a moment.');
  });
});
if (/^\d+$/.test(SOCKET)) {
  server.listen(Number(SOCKET), '127.0.0.1', () => console.log(`auth gateway on 127.0.0.1:${SOCKET} for ${AUTH}`));
} else {
  fs.rmSync(SOCKET, { force: true });
  server.listen(SOCKET, () => console.log(`auth gateway on ${SOCKET} for ${AUTH}`));
}
