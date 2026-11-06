require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = 'clipmaker-secreto-cambialo';
}
function auth(req, res, next) {
  let authHeader = req.headers.authorization;
  if (!authHeader) {
    authHeader = '';
  }
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Sin token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalido' });
  }
}
app.get('/api/health', function (req, res) {
  res.json({ ok: true, app: 'ClipMaker', time: new Date().toISOString() });
});
app.post('/api/auth/register', async function (req, res) {
  const nombre = req.body.nombre;
  const email = req.body.email;
  const password = req.body.password;
  const rol = req.body.rol;
  if (!email || !password || !nombre) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  const hash = await bcrypt.hash(password, 10);
  let rolFinal = 'suscriptor';
  if (rol === 'dueno') {
    rolFinal = 'dueno';
  }
  const result = await supabase.from('users').insert([{ nombre: nombre, email: email.toLowerCase(), password_hash: hash, rol: rolFinal }]).select('id,nombre,email,rol,created_at').single();
  const data = result.data;
  const error = result.error;
  if (error) {
    return res.status(400).json({ error: 'Ese correo ya existe', detail: error.message });
  }
  const token = jwt.sign({ id: data.id, email: data.email, rol: data.rol, nombre: data.nombre }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ user: data, token: token });
});
app.post('/api/auth/login', async function (req, res) {
  const email = req.body.email;
  const password = req.body.password;
  const result = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
  const user = result.data;
  if (!user) {
    return res.status(401).json({ error: 'Correo o contrasena incorrectos' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Correo o contrasena incorrectos' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, rol: user.rol, nombre: user.nombre }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }, token: token });
});
app.get('/api/me', auth, async function (req, res) {
  const result = await supabase.from('users').select('id,nombre,email,rol,created_at').eq('id', req.user.id).single();
  res.json(result.data);
});
app.get('/api/subscribers', auth, async function (req, res) {
  if (req.user.rol !== 'dueno') {
    return res.status(403).json({ error: 'Solo el dueno puede ver el panel' });
  }
  const r1 = await supabase.from('users').select('id,nombre,email,rol,created_at').eq('rol', 'suscriptor').order('created_at', { ascending: false });
  const r2 = await supabase.from('activity').select('*').order('created_at', { ascending: false }).limit(200);
  let subs = r1.data;
  if (!subs) {
    subs = [];
  }
  let act = r2.data;
  if (!act) {
    act = [];
  }
  res.json({ subscribers: subs, activity: act });
});
app.post('/api/activity', auth, async function (req, res) {
  const result = await supabase.from('activity').insert([{ user_id: req.user.id, tipo: req.body.tipo, detalle: req.body.detalle, clip_titulo: req.body.clip_titulo, libro_titulo: req.body.libro_titulo }]).select().single();
  if (result.error) {
    return res.status(400).json({ error: result.error.message });
  }
  res.json(result.data);
});
app.post('/api/clips', auth, async function (req, res) {
  let estadoFinal = req.body.estado;
  if (!estadoFinal) {
    estadoFinal = 'procesando';
  }
  let progresoFinal = req.body.progreso;
  if (progresoFinal === undefined) {
    progresoFinal = 0;
  }
  const result = await supabase.from('clips').insert([{ user_id: req.user.id, titulo: req.body.titulo, duracion: req.body.duracion, estado: estadoFinal, progreso: progresoFinal, video_url: req.body.video_url }]).select().single();
  if (result.error) {
    return res.status(400).json({ error: result.error.message });
  }
  res.json(result.data);
});
app.get('/api/clips', auth, async function (req, res) {
  let q = supabase.from('clips').select('*, users(nombre,email)').order('created_at', { ascending: false });
  if (req.user.rol !== 'dueno') {
    q = q.eq('user_id', req.user.id);
  }
  const result = await q;
  let clips = result.data;
  if (!clips) {
    clips = [];
  }
  res.json(clips);
});
let PORT = process.env.PORT;
if (!PORT) {
  PORT = 3000;
}
app.listen(PORT, function () {
  console.log('ClipMaker backend en puerto ' + PORT);
});
