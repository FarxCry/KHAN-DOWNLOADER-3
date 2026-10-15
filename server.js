// Khan Downloader — Node.js backend v2 (streams directly, no npm packages)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 8765;
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const YTDLP = 'yt-dlp'; // fixed: ignore any YTDLP_PATH env var
const MAX_JOBS = 2;
const QUALITIES = ['best', '1080', '720', '480', '360', 'audio'];
let jobs = 0;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

// ── startup checks (visible in the platform's logs) ──────────
let extraArgs = [];
if (process.env.YT_COOKIES) {
  const cf = path.join(os.tmpdir(), 'cookies.txt');
  fs.writeFileSync(cf, process.env.YT_COOKIES);
  extraArgs.push('--cookies', cf);
}
try {
  const v = spawnSync(YTDLP, ['--version'], { encoding: 'utf8' });
  console.log('yt-dlp:', v.error ? 'MISSING (' + v.error.message + ')' : (v.stdout || v.stderr).trim());
  const f = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  console.log('ffmpeg:', f.error ? 'MISSING' : (f.stdout || '').split('\n')[0]);
  const h = spawnSync(YTDLP, ['--help'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if ((h.stdout || '').includes('--js-runtimes')) extraArgs.push('--js-runtimes', 'node');
} catch (e) { console.log('startup check failed:', e.message); }

// ── helpers ──────────────────────────────────────────────────
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function authorized(req) {
  if (!PASSWORD) return true;
  return crypto.timingSafeEqual(sha(req.headers['x-access-key'] || ''), sha(PASSWORD));
}
function sendJson(res, code, obj) {
  if (res.headersSent) return res.destroy();
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function sendText(res, code, text) {
  if (res.headersSent) return res.destroy();
  const b = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}
function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) { reject(new Error('Too big')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch (e) { return false; }
}
function safeName(n) {
  n = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 100);
  return n || 'khan-download';
}
function firstError(err, fallback) {
  const line = err.split('\n').find(l => l.includes('ERROR:'));
  return line ? line.trim() : (err.trim().split('\n').pop() || fallback);
}
function runYtDlp(args, timeoutMs = 120000) {
  return new Promise(resolve => {
    const p = spawn(YTDLP, args);
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); err += '\nERROR: Timed out reading the link.'; }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: 'ERROR: ' + e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// ── /api/info ────────────────────────────────────────────────
async function handleInfo(req, res) {
  try {
    const { url } = JSON.parse(await readBody(req));
    if (!url || !validUrl(url)) return sendJson(res, 400, { error: 'Invalid link.' });

    const r = await runYtDlp(['--no-playlist', '--dump-json', '--no-warnings', ...extraArgs, '--', url]);
    if (r.code !== 0) {
      console.error('INFO FAIL:', r.err.slice(-600));
      return sendJson(res, 400, { error: firstError(r.err, 'Could not read video info. Check the link and try again.') });
    }
    const info = JSON.parse(r.out.split('\n').filter(Boolean)[0]);
    sendJson(res, 200, {
      title: info.title || '',
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || '',
      duration: info.duration || 0,
      type: 'video'
    });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// ── /download (streams while yt-dlp downloads) ───────────────
function handleDownload(req, res, u) {
  const url = u.searchParams.get('url');
  const quality = u.searchParams.get('quality') || 'best';
  const name = safeName(u.searchParams.get('name'));
  if (!url || !validUrl(url)) return sendText(res, 400, 'Invalid link.');
  if (!QUALITIES.includes(quality)) return sendText(res, 400, 'Invalid quality.');
  if (jobs >= MAX_JOBS) return sendText(res, 429, 'Server busy — try again in a minute.');

  jobs++;
  let released = false;
  const release = () => { if (!released) { released = true; jobs--; } };

  const isAudio = quality === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  let fmt;
  if (isAudio) fmt = 'bestaudio[ext=m4a]/bestaudio/best';
  else if (quality === 'best') fmt = 'best[ext=mp4]/best';
  else fmt = `best[height<=${quality}][ext=mp4]/best[height<=${quality}]/best[ext=mp4]/best`;

  const yt = spawn(YTDLP, ['--no-playlist', '--no-warnings', '-f', fmt, ...extraArgs, '-o', '-', '--', url]);
  let ytErr = '', ffErr = '', ff = null, src = yt.stdout;
  yt.stderr.on('data', d => { ytErr += d; if (ytErr.length > 20000) ytErr = ytErr.slice(-20000); });

  if (isAudio) {
    ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
      '-codec:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3', 'pipe:1']);
    yt.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {});
    ff.stderr.on('data', d => { ffErr += d; });
    src = ff.stdout;
  }

  let started = false;
  const killAll = () => {
    try { yt.kill('SIGKILL'); } catch (e) {}
    if (ff) try { ff.kill('SIGKILL'); } catch (e) {}
  };
  const fail = msg => {
    console.error('DOWNLOAD FAIL:', msg);
    killAll();
    if (!started) sendText(res, 500, msg); else res.destroy();
  };

  src.once('data', chunk => {
    started = true;
    res.writeHead(200, {
      'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name + '.' + ext),
      'Cache-Control': 'no-store'
    });
    res.write(chunk);
    src.pipe(res);
  });

  yt.on('error', e => fail('yt-dlp error: ' + e.message));
  yt.on('close', code => {
    if (!ff) release();
    if (code !== 0) fail(firstError(ytErr, 'Download failed.'));
    else if (!ff && !started) fail('No data received from the site.');
  });
  if (ff) {
    ff.on('error', e => fail('ffmpeg error: ' + e.message));
    ff.on('close', code => {
      release();
      if (code !== 0 && !started) fail(firstError(ffErr, 'Audio conversion failed.'));
      else if (!started) fail('No audio data received.');
    });
  }
  res.on('close', () => { killAll(); release(); });
}

// ── server ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': INDEX_HTML.length });
    return res.end(INDEX_HTML);
  }
  if (req.method === 'GET' && p === '/health') return sendText(res, 200, 'ok');

  if (req.method === 'POST' && p === '/api/info') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'Wrong password.' });
    return handleInfo(req, res);
  }
  if (req.method === 'GET' && p === '/download') {
    if (!authorized(req)) return sendText(res, 401, 'Wrong password.');
    return handleDownload(req, res, u);
  }
  sendText(res, 404, 'Not found.');
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Khan Downloader running on port ' + PORT + (PASSWORD ? ' (password ON)' : ' (NO password set!)'));
});
