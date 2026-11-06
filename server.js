require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(cors({ origin: '' }));
app.use(express.json());
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'clipmaker-secreto-cambialo';
function auth(req, res, next) {
const token = (req.headers.authorization || '').replace('Bearer ', '');
if (!token) return res.status(401).json({ error: 'Sin token' });
try { req.user = jwt.verify(token, JWT_SECRET); next(); }
catch { return res.status(401).json({ error: 'Token invalido' }); }
}
app.get('/api/health', (req,res) => res.json({ ok: true, app: 'ClipMaker', time: new Date().toISOString() }));
app.post('/api/auth/register', async (req,res) => {
const { nombre, email, password, rol } = req.body;
if (!email || !password || !nombre) return res.status(400).json({ error: 'Faltan datos' });
const hash = await bcrypt.hash(password, 10);
const { data, error } = await supabase.from('users').insert([{ nombre, email: email.toLowerCase(), password_hash: hash, rol: rol === 'dueno' ? 'dueno' : 'suscriptor' }]).select('id,nombre,email,rol,created_at').single();
if (error) return res.status(400).json({ error: 'Ese correo ya existe', detail: error.message });
const token = jwt.sign({ id: data.id, email: data.email, rol: data.rol, nombre: data.nombre }, JWT_SECRET, { expiresIn: '30d' });
res.json({ user: data, token });
});
app.post('/api/auth/login', async (req,res) => {
const { email, password } = req.body;
const { data: user } = await supabase.from('users').select('').eq('email', email.toLowerCase()).single();
if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
const ok = await bcrypt.compare(password, user.password_hash);
if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
const token = jwt.sign({ id: user.id, email: user.email, rol: user.rol, nombre: user.nombre }, JWT_SECRET, { expiresIn: '30d' });
res.json({ user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }, token });
});
app.get('/api/me', auth, async (req,res) => {
const { data } = await supabase.from('users').select('id,nombre,email,rol,created_at').eq('id', req.user.id).single();
res.json(data);
});
app.get('/api/subscribers', auth, async (req,res) => {
if (req.user.rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño puede ver el panel' });
const { data } = await supabase.from('users').select('id,nombre,email,rol,created_at').eq('rol','suscriptor').order('created_at',{ascending:false});
const { data: actividad } = await supabase.from('activity').select('').order('created_at',{ascending:false}).limit(200);
res.json({ subscribers: data  [], activity: actividad  [] });
});
app.post('/api/activity', auth, async (req,res) => {
const { tipo, detalle, clip_titulo, libro_titulo } = req.body;
const { data, error } = await supabase.from('activity').insert([{ user_id: req.user.id, tipo, detalle, clip_titulo, libro_titulo }]).select().single();
if (error) return res.status(400).json({ error: error.message });
res.json(data);
});
app.post('/api/clips', auth, async (req,res) => {
const { titulo, duracion, estado, progreso, video_url } = req.body;
const { data, error } = await supabase.from('clips').insert([{ user_id: req.user.id, titulo, duracion, estado: estado||'procesando', progreso: progreso||0, video_url }]).select().single();
if (error) return res.status(400).json({ error: error.message });
res.json(data);
});
app.get('/api/clips', auth, async (req,res) => {
let q = supabase.from('clips').select(', users(nombre,email)').order('created_at',{ascending:false});
if (req.user.rol !== 'dueno') q = q.eq('user_id', req.user.id);
const { data } = await q;
res.json(data || []);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ClipMaker backend en puerto ' + PORT));
