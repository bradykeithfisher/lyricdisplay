// FBC Lyrics - online relay
// Receives slides from the church computer and shows them live at fbclyrics.org.
// Runs on Render (or any host with Node.js 18+). No dependencies.
//
// Settings (environment variables):
//   LYRICS_KEY      required. Secret shared with the church computer's config.json.
//   ADMIN_PASSWORD  optional. Password for the /config page (defaults to LYRICS_KEY).
//   PORT            set automatically by Render.

const http = require('http');
const fs = require('fs');
const path = require('path');

const KEY = process.env.LYRICS_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || KEY;
const PORT = Number(process.env.PORT || 10000);
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_SECONDS || 150) * 1000; // no word from the church computer for 2.5 min => show "waiting"
const MAX_TEXT = 5000;

if (!KEY) console.warn('WARNING: LYRICS_KEY is not set. Slide updates will be refused until it is.');

let state = { connected: false, current: '', next: '', updated: Date.now() };
let lastPush = 0;
const clients = new Set();

// ---------- display settings (edited on /config) ----------
// Render's free plan forgets files on restart, so the church computer keeps a
// copy: we return the settings on every /update, and it sends them back to us.
const DEFAULTS = {
  bg: '#111111', fg: '#f5f5f5', font: 'sans', bold: true, size: 100,
  position: 'center', textAlign: 'center', uppercase: false, showNext: false,
  idleText: 'Lyrics will appear here during worship.', title: 'Lyrics',
  savedAt: 0,
};
let settings = { ...DEFAULTS };

function cleanSettings(input, base = DEFAULTS) {
  const s = { ...base };
  const color = v => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v.toLowerCase() : undefined;
  const pick = (v, list) => list.includes(v) ? v : undefined;
  const set = (k, v) => { if (v !== undefined) s[k] = v; };
  if (!input || typeof input !== 'object') return s;
  set('bg', color(input.bg));
  set('fg', color(input.fg));
  set('font', pick(input.font, ['sans', 'serif', 'rounded', 'condensed']));
  set('position', pick(input.position, ['center', 'top', 'bottom']));
  set('textAlign', pick(input.textAlign, ['center', 'left']));
  for (const k of ['bold', 'uppercase', 'showNext']) if (typeof input[k] === 'boolean') s[k] = input[k];
  const n = Number(input.size);
  if (Number.isFinite(n)) s.size = Math.round(Math.min(250, Math.max(40, n)));
  if (typeof input.idleText === 'string') s.idleText = input.idleText.slice(0, 200);
  if (typeof input.title === 'string') s.title = input.title.slice(0, 60) || 'Lyrics';
  if (Number.isFinite(Number(input.savedAt))) s.savedAt = Number(input.savedAt);
  return s;
}

const json = () => JSON.stringify({
  connected: state.connected,
  current: state.current,
  next: settings.showNext ? state.next : '',
  updated: state.updated,
  settings,
});
function broadcast() {
  const msg = `data: ${json()}\n\n`;
  for (const res of clients) res.write(msg);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && require('crypto').timingSafeEqual(A, B);
}

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
                '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // Church computer sends slides here
  if (url.pathname === '/update' && req.method === 'POST') {
    if (!KEY || !safeEqual(req.headers['x-lyrics-key'] || '', KEY)) {
      res.writeHead(401); return res.end('bad key');
    }
    try {
      const d = JSON.parse(await readBody(req));
      const s = v => String(v || '').slice(0, MAX_TEXT);
      const next = { connected: d.connected !== false, current: s(d.current), next: s(d.next) };
      lastPush = Date.now();
      let changed = false;
      // Restore saved settings after a restart (the church computer's copy is newer)
      if (d.settings && Number(d.settings.savedAt) > settings.savedAt) {
        settings = cleanSettings(d.settings);
        console.log('Restored display settings from the church computer');
        changed = true;
      }
      if (next.connected !== state.connected || next.current !== state.current || next.next !== state.next) {
        state = { ...next, updated: Date.now() };
        changed = true;
      }
      if (changed) broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ settings }));
    } catch {
      res.writeHead(400); return res.end('bad request');
    }
  }

  // Display settings
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // synced: the church computer has checked in since the last save, so it has a copy
      return res.end(JSON.stringify({ ...settings, synced: lastPush > settings.savedAt }));
    }
    if (req.method === 'POST') {
      if (!ADMIN_PASSWORD || !safeEqual(req.headers['x-admin-password'] || '', ADMIN_PASSWORD)) {
        res.writeHead(401); return res.end('wrong password');
      }
      try {
        const input = JSON.parse(await readBody(req));
        if (input.reset) settings = { ...DEFAULTS, savedAt: Date.now() };
        else settings = { ...cleanSettings(input, settings), savedAt: Date.now() };
        broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(settings));
      } catch {
        res.writeHead(400); return res.end('bad request');
      }
    }
  }
  if (url.pathname === '/config' || url.pathname === '/config/') {
    req.url = '/config.html';
    url.pathname = '/config.html';
  }

  // Viewers listen here
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${json()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/current') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(json());
  }

  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

// If the church computer goes quiet (service over, computer off), switch viewers to the waiting screen.
setInterval(() => {
  if (state.connected && Date.now() - lastPush > OFFLINE_AFTER_MS) {
    state = { connected: false, current: '', next: '', updated: Date.now() };
    broadcast();
  }
}, 10000);

// Keep viewer connections open through proxies
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

server.listen(PORT, () => console.log(`FBC Lyrics relay listening on port ${PORT}`));
