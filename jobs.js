// Motor de clips automáticos: toma un enlace (video o en vivo), lo graba y lo corta cada N segundos.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');

const DIR = process.env.CLIP_DIR || path.join(os.tmpdir(), 'clipmaker-jobs');
const MAX_RUNNING = parseInt(process.env.MAX_JOBS) || 2;
const KEEP_MS = 60 * 60 * 1000;           // los clips se borran 1 hora después
const jobs = new Map();
// Opcional: ayudas para plataformas que bloquean servidores (ver README en el chat)
const YT_PROXY = process.env.YTDLP_PROXY || '';                 // ej. http://usuario:clave@host:puerto
let COOKIES_FILE = '';
if (process.env.YTDLP_COOKIES) {                                 // contenido de un cookies.txt (formato Netscape)
  COOKIES_FILE = path.join(os.tmpdir(), 'cm-cookies.txt');
  fs.writeFileSync(COOKIES_FILE, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
}
fs.mkdirSync(DIR, { recursive: true });

/* ---------- Seguridad: solo direcciones públicas ---------- */
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:') && isPrivateIp(l.slice(7));
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enlace no válido'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se aceptan enlaces http o https');
  if (process.env.ALLOW_PRIVATE === '1') return u;      // solo para pruebas locales
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('No se pudo resolver el enlace');
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Enlace no permitido');
  return u;
}

/* ---------- Obtener la dirección directa del video ---------- */
const DIRECT = /\.(mp4|webm|mov|m4v|m3u8|mkv)(\?|$)/i;
// Devuelve una lista de 1 o 2 direcciones: [video] o [video, audio] (YouTube separa el audio del video)
const YT_ATTEMPTS = [          // se prueban en orden hasta que una funcione
  [],                                                     // normal
  ['--extractor-args', 'youtube:player_client=tv,web_safari'],
  ['--extractor-args', 'youtube:player_client=mweb'],
  ['--extractor-args', 'youtube:player_client=ios'],
];
const baseArgs = () => ['--no-playlist', '--no-warnings', '--js-runtimes', 'node',
  ...(YT_PROXY ? ['--proxy', YT_PROXY] : []), ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : [])];
const runYt = args => new Promise(resolve => execFile('yt-dlp', args, { timeout: 90000, maxBuffer: 4 << 20 },
  (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') })));

async function resolveMedia(url) {
  if (DIRECT.test(new URL(url).pathname + new URL(url).search)) return [url];
  let last = null;
  for (const extra of YT_ATTEMPTS) {
    // -S res:720 prefiere 720p o menos, pero no falla si no existe ese tamaño
    const r = await runYt(['-g', '-f', 'bv*+ba/b', '-S', 'res:720', ...baseArgs(), ...extra, url]);
    if (r.err && r.err.code === 'ENOENT') throw new Error('El servidor no tiene yt-dlp instalado');
    if (!r.err) {
      const urls = r.out.split('\n').map(x => x.trim()).filter(l => /^https?:\/\//.test(l)).slice(0, 2);
      if (urls.length) return urls;
    }
    last = r;
    console.error('[yt-dlp] intento fallido', JSON.stringify(extra), '->', r.errOut.split('\n').filter(Boolean).slice(-3).join(' | '));
    if (/not a bot|Sign in to confirm/i.test(r.errOut)) break;     // otros clientes no arreglan este bloqueo
  }
  // Diagnóstico: deja en los logs de Render los formatos que YouTube sí muestra
  const f = await runYt(['-F', ...baseArgs(), url]);
  console.error('[yt-dlp] formatos disponibles:\n' + f.out.split('\n').slice(0, 40).join('\n') + '\n' + f.errOut.split('\n').slice(-5).join('\n'));
  const msg = String(last && last.errOut || '').split('\n').find(l => l.includes('ERROR')) || 'No se pudo leer ese enlace';
  throw new Error(msg.replace(/^ERROR:\s*/, '').slice(0, 200));
}

/* ---------- Subtítulos (transcripción con Whisper de OpenAI) ---------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const canSubtitle = () => !!OPENAI_API_KEY;

function ff(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; p.stderr.on('data', d => { log = (log + d).slice(-500); });
    const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60 * 1000);
    p.on('error', e => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'El servidor no tiene ffmpeg instalado' : e.message)); });
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(log.split('\n').filter(Boolean).pop() || 'ffmpeg falló')); });
  });
}
async function transcribe(audioPath) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', TRANSCRIBE_MODEL);
  fd.append('response_format', 'srt');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI_API_KEY }, body: fd, signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error('transcripción ' + r.status);
  return (await r.text()).trim();
}

/* ---------- Trabajos ---------- */
const running = () => [...jobs.values()].filter(j => j.status === 'running' || j.status === 'starting').length;
const rawFiles = job => fs.readdirSync(path.join(job.dir, 'raw')).filter(f => /^seg_\d+\.mp4$/.test(f)).sort();
function view(job) {
  return { id: job.id, status: job.status, error: job.error || null, wanted: job.count, ready: job.finals.length,
    seconds: job.duration, subtitles: job.subtitles, vertical: job.vertical, warn: job.warn || null };
}

// Convierte un corte crudo en el clip final: subtítulos quemados y (opcional) formato vertical 9:16
async function finalize(job, i, rawName) {
  const out = `clip_${String(i).padStart(3, '0')}.mp4`;
  const filters = [];
  if (job.vertical) filters.push('crop=floor(ih*9/16/2)*2:ih', 'scale=720:1280');
  let withSubs = false;
  if (job.subtitles && canSubtitle()) {
    try {
      await ff(['-i', 'raw/' + rawName, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', `raw/a_${i}.mp3`], job.dir);
      const srt = await transcribe(path.join(job.dir, `raw/a_${i}.mp3`));
      if (srt) {
        fs.writeFileSync(path.join(job.dir, `raw/s_${i}.srt`), srt);
        const size = job.vertical ? 12 : 14, mv = job.vertical ? 80 : 28;
        filters.push(`subtitles=raw/s_${i}.srt:force_style='FontName=DejaVu Sans,Bold=1,FontSize=${size},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2.5,Shadow=0,Alignment=2,MarginV=${mv}'`);
        withSubs = true;
      }
    } catch (e) { job.warn = 'Algunos clips salieron sin subtítulos (' + e.message + ').'; }
  } else if (job.subtitles) job.warn = 'Subtítulos no disponibles en este servidor (falta OPENAI_API_KEY).';
  const args = ['-i', 'raw/' + rawName];
  if (filters.length) args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'copy');
  else args.push('-c', 'copy');
  args.push('-movflags', '+faststart', out);
  await ff(args, job.dir);
  job.finals.push(out);
  return withSubs;
}

function startJob({ url, duration, count, subtitles = true, vertical = false, onFinish }) {
  if (running() >= MAX_RUNNING) throw Object.assign(new Error('El servidor está ocupado con otros clips. Intenta en unos minutos.'), { status: 503 });
  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(DIR, id);
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  const job = { id, dir, status: 'starting', count, duration, subtitles: !!subtitles, vertical: !!vertical, finals: [], created: Date.now() };
  jobs.set(id, job);
  let cutting = true, next = 0, busy = false, ended = false;

  const pump = setInterval(async () => {
    if (busy || ended) return;
    busy = true;
    try {
      let raws = []; try { raws = rawFiles(job); } catch {}
      // un corte está completo si existe el siguiente, o si ffmpeg ya terminó
      while (next < Math.min(count, raws.length) && (next < raws.length - 1 || !cutting)) {
        await finalize(job, next, raws[next]); next++;
      }
      if (!cutting && next >= Math.min(count, raws.length)) {
        if (!job.finals.length && !job.error) job.error = 'El video no produjo clips';
        done(job.error || null);
      }
    } catch (e) { done(e.message); }
    busy = false;
  }, 1500);

  (async () => {
    try {
      const media = await resolveMedia(url);
      job.status = 'running';
      const total = duration * count;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        ...media.flatMap(m => [...(YT_PROXY && m !== url ? ['-http_proxy', YT_PROXY] : []), '-i', m]),
        ...(media.length === 2 ? ['-map', '0:v:0', '-map', '1:a:0'] : []),
        '-t', String(total),
        '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
        '-c:a', 'aac', '-b:a', '128k',
        '-force_key_frames', `expr:gte(t,n_forced*${duration})`,
        '-f', 'segment', '-segment_time', String(duration), '-reset_timestamps', '1',
        path.join(dir, 'raw', 'seg_%03d.mp4')];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let log = '';
      p.stderr.on('data', d => { log = (log + d).slice(-600); });
      const killer = setTimeout(() => p.kill('SIGKILL'), (total + 180) * 1000);
      p.on('error', e => { clearTimeout(killer); cutting = false; if (!ended) done(e.code === 'ENOENT' ? 'El servidor no tiene ffmpeg instalado' : e.message); });
      p.on('close', code => {
        clearTimeout(killer); cutting = false;
        let n = 0; try { n = rawFiles(job).length; } catch {}
        if (n === 0 && !ended) done(code === 0 ? 'El video no produjo clips' : 'No se pudo grabar ese enlace: ' + log.split('\n').filter(Boolean).pop());
      });
    } catch (e) { cutting = false; done(e.message); }
  })();

  function done(err) {
    if (ended) return;
    ended = true; clearInterval(pump);
    job.error = err; job.status = err && !job.finals.length ? 'error' : 'done';
    if (err && job.finals.length) job.warn = (job.warn ? job.warn + ' ' : '') + 'Se detuvo antes de terminar: ' + err;
    job.error = job.status === 'error' ? err : null;
    try { onFinish && onFinish(job.finals.length); } catch {}
  }
  return job;
}

const get = id => jobs.get(id);
function clipPath(job, n) {
  if (n < 0 || n >= job.finals.length) return null;
  return path.join(job.dir, job.finals[n]);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.created > KEEP_MS && j.status !== 'running') {
    fs.rm(j.dir, { recursive: true, force: true }, () => {}); jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { assertPublicUrl, startJob, view, get, clipPath, canSubtitle };
