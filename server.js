require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const jobs = require('./jobs');
const { MONGODB_URI, JWT_SECRET, OWNER_EMAIL, OWNER_PIN, ALLOWED_ORIGIN, RESEND_API_KEY, MAIL_FROM } = process.env;
for (const [k, v] of Object.entries({ MONGODB_URI, JWT_SECRET, OWNER_EMAIL, OWNER_PIN })) {
  if (!v) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}
const OWNER = OWNER_EMAIL.trim().toLowerCase();

const PLANS = {
  gratis:  { clips: 2,   max: 30,  price: 0 },
  basico:  { clips: 30,  max: 60,  price: 5 },
  premium: { clips: 100, max: 120, price: 10 },
  vip:     { clips: 300, max: 180, price: 20 }
};
const COINS = ['BTC', 'USDT', 'ETH', 'USDC'];
const month = () => new Date().toISOString().slice(0, 7);

/* ---------- Modelos ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  name: String,
  hash: String,
  plan: { type: String, default: 'gratis' },
  used: { type: Number, default: 0 },
  month: { type: String, default: month },
  totalClips: { type: Number, default: 0 },
  resetHash: String, resetExp: Date, resetTries: { type: Number, default: 0 }, resetCodeForOwner: String,
  acceptedTerms: Date
}, { timestamps: true }));

const Payment = mongoose.model('Payment', new mongoose.Schema({
  email: String, plan: String, coin: String, txid: { type: String, unique: true },
  refund: String, amount: Number, status: { type: String, default: 'pendiente' }
}, { timestamps: true }));

const Config = mongoose.model('Config', new mongoose.Schema({
  key: { type: String, unique: true },
  wallets: { type: Map, of: String }
}));
const DEFAULT_WALLETS = {
  BTC: 'bc1q-clipmaker-ejemplo-pon-tu-wallet-real-aqui',
  USDT: 'T-ClipMaker-ejemplo-TRC20-pon-tu-wallet-real',
  ETH: '0xClipMakerEjemploPonTuWalletRealAqui',
  USDC: '0xClipMakerEjemploUSDC-PonTuWalletReal'
};
async function getWallets() {
  let c = await Config.findOne({ key: 'main' });
  if (!c) c = await Config.create({ key: 'main', wallets: DEFAULT_WALLETS });
  return Object.fromEntries(c.wallets);
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(s => s.trim()) : false }));
app.use(express.json({ limit: '20kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, message: { error: 'Demasiados intentos. Espera 15 minutos.' } });

const jobLimit = rateLimit({ windowMs: 60 * 60_000, max: 20, message: { error: 'Demasiadas solicitudes. Intenta más tarde.' } });

const sign = (u, extra = {}) => jwt.sign({ id: u._id, email: u.email, ...extra }, JWT_SECRET, { expiresIn: '7d' });
const isOwner = u => u.email === OWNER;
const planOf = u => isOwner(u) ? { clips: 100000, max: 180, price: 0 } : PLANS[u.plan];   // el dueño prueba sin límites
const clean = s => String(s || '').trim();
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const publicUser = u => ({ email: u.email, name: u.name, plan: u.plan, used: u.used, owner: isOwner(u),
  limit: planOf(u).clips, maxDuration: planOf(u).max });

async function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const p = jwt.verify(t, JWT_SECRET);
    const u = await User.findById(p.id);
    if (!u) return res.status(401).json({ error: 'Sesión inválida' });
    if (u.month !== month()) { u.month = month(); u.used = 0; await u.save(); }
    req.user = u; req.tok = p; next();
  } catch { res.status(401).json({ error: 'Inicia sesión de nuevo' }); }
}
function ownerOnly(req, res, next) {
  if (!isOwner(req.user) || !req.tok.pin) return res.status(403).json({ error: 'Solo el dueño' });
  next();
}

/* ---------- Rutas públicas ---------- */
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/wallets', async (_, res) => res.json(await getWallets()));

app.post('/api/register', authLimit, async (req, res) => {
  const email = clean(req.body.email).toLowerCase(), pass = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Correo no válido' });
  if (pass.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
  if (req.body.terms !== true) return res.status(400).json({ error: 'Debes aceptar los términos de uso' });
  if (await User.findOne({ email })) return res.status(409).json({ error: 'Ese correo ya tiene cuenta' });
  const u = await User.create({ acceptedTerms: new Date(), email, name: clean(req.body.name).slice(0, 40) || email.split('@')[0], hash: await bcrypt.hash(pass, 12) });
  res.json({ token: sign(u), user: publicUser(u) });
});

app.post('/api/login', authLimit, async (req, res) => {
  const u = await User.findOne({ email: clean(req.body.email).toLowerCase() });
  const ok = u && await bcrypt.compare(String(req.body.password || ''), u.hash);
  if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  res.json({ token: sign(u), user: publicUser(u) });
});

/* ---------- Rutas de suscriptor ---------- */
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// Descuenta clips en el servidor (el navegador no puede saltarse el límite)
app.post('/api/clips/reserve', auth, async (req, res) => {
  const u = req.user, p = planOf(u);
  const want = Math.min(10, Math.max(1, parseInt(req.body.count) || 1));
  const dur = Math.min(p.max, Math.max(10, parseInt(req.body.duration) || 30));
  const left = p.clips - u.used;
  if (left <= 0) return res.status(402).json({ error: 'Se acabaron tus clips del mes. Ve a Suscripción.' });
  const n = Math.min(want, left);
  u.used += n; u.totalClips += n; await u.save();
  res.json({ allowed: n, duration: dur, user: publicUser(u) });
});

/* ---------- Clips automáticos desde un enlace ---------- */
app.post('/api/jobs', auth, jobLimit, async (req, res) => {
  try {
    if (req.body.rights !== true) return res.status(400).json({ error: 'Debes confirmar que el contenido es tuyo o tienes permiso para usarlo.' });
    const u = req.user, p = planOf(u);
    await jobs.assertPublicUrl(clean(req.body.url));
    const want = Math.min(10, Math.max(1, parseInt(req.body.count) || 1));
    const dur = Math.min(p.max, Math.max(10, parseInt(req.body.duration) || 30));
    const left = p.clips - u.used;
    if (left <= 0) return res.status(402).json({ error: 'Se acabaron tus clips del mes. Ve a Suscripción.' });
    const n = Math.min(want, left);
    u.used += n; u.totalClips += n; await u.save();
    const userId = String(u._id);
    let job;
    try {
      job = jobs.startJob({ url: clean(req.body.url), duration: dur, count: n, subtitles: req.body.subtitles !== false, vertical: req.body.vertical === true, onFinish: async produced => {
        const back = n - produced;                       // devuelve los clips que no se lograron
        if (back > 0) await User.updateOne({ _id: userId }, { $inc: { used: -back, totalClips: -back } });
      } });
    } catch (e) {
      await User.updateOne({ _id: userId }, { $inc: { used: -n, totalClips: -n } });
      return res.status(e.status || 400).json({ error: e.message });
    }
    job.userId = userId;
    res.json({ job: jobs.view(job), user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: e.message || 'No se pudo iniciar' }); }
});

function ownJob(req, res) {
  const job = jobs.get(String(req.params.id));
  if (!job || job.userId !== String(req.user._id)) { res.status(404).json({ error: 'Trabajo no encontrado' }); return null; }
  return job;
}
app.get('/api/jobs/:id', auth, (req, res) => { const j = ownJob(req, res); if (j) res.json({ job: jobs.view(j) }); });
app.get('/api/jobs/:id/clip/:n', auth, (req, res) => {
  const j = ownJob(req, res); if (!j) return;
  const f = jobs.clipPath(j, parseInt(req.params.n));
  if (!f) return res.status(404).json({ error: 'Ese clip aún no está listo' });
  res.type('video/mp4'); res.sendFile(f);
});

/* ---------- Recuperar contraseña ---------- */
// Envía el código por correo con Resend (RESEND_API_KEY + MAIL_FROM). Sin eso, el dueño ve el código en su panel.
async function sendMail(to, subject, text) {
  if (!RESEND_API_KEY || !MAIL_FROM) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, text })
  });
  return r.ok;
}
app.post('/api/forgot', authLimit, async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const u = await User.findOne({ email });
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    u.resetHash = crypto.createHash('sha256').update(code).digest('hex');
    u.resetExp = new Date(Date.now() + 15 * 60_000); u.resetTries = 0; await u.save();
    const sent = await sendMail(email, 'Tu código de ClipMaker', `Tu código para cambiar la contraseña es ${code}. Vence en 15 minutos. Si no fuiste tú, ignora este mensaje.`).catch(() => false);
    if (!sent) { u.resetCodeForOwner = code; await u.save(); }
  }
  res.json({ ok: true, msg: 'Si el correo existe, se envió un código. Si no te llega, pídeselo al administrador.' });
});
app.post('/api/reset', authLimit, async (req, res) => {
  const email = clean(req.body.email).toLowerCase(), pass = String(req.body.password || '');
  if (pass.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
  const u = await User.findOne({ email });
  const bad = () => res.status(400).json({ error: 'Código incorrecto o vencido' });
  if (!u || !u.resetHash || !u.resetExp || u.resetExp < new Date() || u.resetTries >= 5) return bad();
  const h = crypto.createHash('sha256').update(clean(req.body.code)).digest('hex');
  if (!safeEq(h, u.resetHash)) { u.resetTries += 1; await u.save(); return bad(); }
  u.hash = await bcrypt.hash(pass, 12);
  u.resetHash = u.resetExp = u.resetCodeForOwner = undefined; u.resetTries = 0; await u.save();
  res.json({ ok: true });
});

app.post('/api/payments', auth, async (req, res) => {
  const plan = clean(req.body.plan), coin = clean(req.body.coin), txid = clean(req.body.txid);
  if (!PLANS[plan] || !PLANS[plan].price) return res.status(400).json({ error: 'Plan no válido' });
  if (!COINS.includes(coin)) return res.status(400).json({ error: 'Moneda no válida' });
  if (txid.length < 8 || txid.length > 200) return res.status(400).json({ error: 'TXID no válido' });
  if (await Payment.findOne({ txid })) return res.status(409).json({ error: 'Ese TXID ya fue enviado' });
  await Payment.create({ email: req.user.email, plan, coin, txid, refund: clean(req.body.refund).slice(0, 200), amount: PLANS[plan].price });
  res.json({ ok: true });
});

/* ---------- Rutas del dueño (requieren sesión + PIN) ---------- */
app.post('/api/owner/unlock', authLimit, auth, (req, res) => {
  if (!isOwner(req.user) || !safeEq(req.body.pin, OWNER_PIN)) return res.status(403).json({ error: 'PIN incorrecto' });
  const token = jwt.sign({ id: req.user._id, email: req.user.email, pin: true }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

app.get('/api/owner/summary', auth, ownerOnly, async (req, res) => {
  const [users, payments, wallets] = await Promise.all([
    User.find({ email: { $ne: OWNER } }).select('-hash -resetHash').sort('-createdAt'),
    Payment.find().sort('-createdAt'), getWallets()
  ]);
  const all = await User.find();
  res.json({
    stats: {
      subscribers: users.length, payments: payments.length,
      clips: all.reduce((a, u) => a + u.totalClips, 0),
      pendingMoney: payments.filter(p => p.status === 'pendiente').reduce((a, p) => a + p.amount, 0)
    }, users, payments, wallets
  });
});

app.post('/api/owner/payments/:id/approve', auth, ownerOnly, async (req, res) => {
  const p = await Payment.findById(req.params.id);
  if (!p || p.status !== 'pendiente') return res.status(404).json({ error: 'Pago no encontrado o ya aprobado' });
  const u = await User.findOne({ email: p.email });
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  u.plan = p.plan; u.used = 0; await u.save();
  p.status = 'aprobado'; await p.save();
  res.json({ ok: true });
});

app.put('/api/owner/wallets', auth, ownerOnly, async (req, res) => {
  const w = {};
  for (const c of COINS) w[c] = clean(req.body[c]).slice(0, 200) || DEFAULT_WALLETS[c];
  await Config.findOneAndUpdate({ key: 'main' }, { wallets: w }, { upsert: true });
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'No existe' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error del servidor' }); });

mongoose.connect(MONGODB_URI).then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('ClipMaker backend listo en puerto ' + port));
}).catch(e => { console.error('No se pudo conectar a MongoDB:', e.message); process.exit(1); });
