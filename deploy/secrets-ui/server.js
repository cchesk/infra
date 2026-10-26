'use strict';
// Write-only web UI for app secrets, served at https://secrets.<domain> (see deploy/setup-secrets.sh).
// Caddy only forwards a request here after Authelia's passkey login, and sets Remote-User. This server listens on a
// unix socket that only Caddy can open, so nothing else on the box can fake that header. Values are never shown;
// all changes go through the root helper app-secret, which can only write /etc/apps/secrets/<app>.env.
const http = require('node:http');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const SOCK = '/run/secrets-ui/http.sock';
const HELPER = '/usr/local/bin/app-secret';
const { OWNER, HOST } = process.env;
if (!OWNER || !HOST) throw new Error('OWNER and HOST must be set');
const ORIGIN = `https://${HOST}`;

function helper(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('sudo', ['-n', HELPER, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(apps, msg, isError) {
  const cards = apps.map(({ name, keys }) => `
<section>
  <h2>${esc(name)}</h2>
  ${keys.length ? `<ul>${keys.map((k) => `
    <li><code>${esc(k)}</code> <span class="muted">set</span>
      <details><summary>remove</summary>
        <form method="post" action="/unset"><input type="hidden" name="app" value="${esc(name)}">
          <input type="hidden" name="key" value="${esc(k)}"><button>Remove ${esc(k)}</button></form>
      </details></li>`).join('')}</ul>` : '<p class="muted">No secrets set here yet.</p>'}
  <form method="post" action="/set" autocomplete="off">
    <input type="hidden" name="app" value="${esc(name)}">
    <input name="key" placeholder="KEY_NAME" required pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" autocapitalize="characters" spellcheck="false">
    <input name="value" type="password" placeholder="value" required autocomplete="new-password">
    <label><input type="checkbox" name="restart" value="1" checked> restart app</label>
    <button>Save</button>
  </form>
  <form method="post" action="/restart"><input type="hidden" name="app" value="${esc(name)}"><button class="secondary">Restart app@${esc(name)}</button></form>
</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>App secrets</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--card:#fff;--line:#ddd;--muted:#777;--accent:#2457d6;--bad:#b3261e;--good:#1e7a3c}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--card:#1e1e1e;--line:#333;--muted:#999;--accent:#7aa2ff;--bad:#ff8a80;--good:#7bd88f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:16px 0}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin:.2rem 0}
ul{padding-left:1.2rem}li{margin:.3rem 0}details{display:inline}summary{cursor:pointer;color:var(--muted);display:inline}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
input[name=key],input[name=value]{flex:1 1 180px;min-width:0;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
.muted{color:var(--muted)}.msg{padding:8px 12px;border-radius:6px;border:1px solid}.ok{color:var(--good)}.err{color:var(--bad)}
</style></head><body><main>
<h1>App secrets</h1>
<p class="muted">Signed in as ${esc(OWNER)}. Values are write-only: saving replaces a key, nothing is ever shown.
<a href="/auth/logout">Sign out</a></p>
${msg ? `<p class="msg ${isError ? 'err' : 'ok'}">${esc(msg)}</p>` : ''}
${cards || '<p>No node apps on this server.</p>'}
</main></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(body);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 20000) { reject(new Error('form too large')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

const back = (res, msg, err) => send(res, 303, '', { Location: `/?${new URLSearchParams(err ? { err: msg } : { msg })}` });

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers['remote-user'] !== OWNER) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, ORIGIN);
    if (req.method === 'GET' && url.pathname === '/') {
      const apps = (await helper(['list'])).split('\n').filter(Boolean).map((line) => {
        const [name, keys = ''] = line.split('\t');
        return { name, keys: keys.split(' ').filter(Boolean) };
      });
      const err = url.searchParams.get('err');
      return send(res, 200, page(apps, err || url.searchParams.get('msg'), Boolean(err)));
    }
    if (req.method !== 'POST') return send(res, 404, 'Not found');
    // Cross-site form posts: only accept the browser's own same-origin submissions.
    if (req.headers.origin !== ORIGIN) return send(res, 403, 'Bad origin');
    const f = await readForm(req);
    const app = f.get('app') || '', key = f.get('key') || '';
    try {
      if (url.pathname === '/set') {
        let msg = await helper(['set', app, key], f.get('value') || '');
        if (f.get('restart')) msg += '; ' + await helper(['restart', app]);
        return back(res, msg);
      }
      if (url.pathname === '/unset') return back(res, await helper(['unset', app, key]));
      if (url.pathname === '/restart') return back(res, await helper(['restart', app]));
    } catch (e) {
      return back(res, e.message, true);
    }
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    send(res, 500, 'Error');
  }
});

fs.rmSync(SOCK, { force: true });
server.listen(SOCK, () => console.log(`listening on ${SOCK} for ${ORIGIN}`));
