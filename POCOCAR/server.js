/**
 * POCOCAR - Servidor con base de datos SQLite integrada.
 *
 * Sirve la app (carpeta /public) y guarda TODOS los datos en un único
 * fichero SQLite (data/pococar.db), de modo que cualquier dispositivo que
 * entre en la web ve la misma información.
 */
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];

// Contadores iniciales (hoja "Contador" de Turnos.xlsx).
// Solo se usan la PRIMERA vez que arranca el servidor con la base de datos vacía.
const DEFAULT_COUNTERS = {
  'Aris': 10, 'Dani': 13, 'Jesus S': 11, 'Javi': 12, 'Lino': 10, 'Miguel': 10,
  'Montero': 12, 'Nico': 12, 'Peri': 12, 'Pedro': 12, 'Roberto': 10, 'Susi': 10, 'Toni': 12
};
const DEFAULT_CREDENTIALS = {
  teamPin: process.env.TEAM_PIN || '1234',
  adminKey: process.env.ADMIN_KEY || 'admin'
};

// ---------------------------------------------------------------- Base de datos
const db = new Database(path.join(DATA_DIR, 'pococar.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    role       TEXT NOT NULL,
    user       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const qGet = db.prepare('SELECT value FROM kv WHERE key = ?');
const qSet = db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
const qDel = db.prepare('DELETE FROM kv WHERE key = ?');
const qAll = db.prepare('SELECT key, value FROM kv');

if (!qGet.get('driverCounters')) qSet.run('driverCounters', JSON.stringify(DEFAULT_COUNTERS));
if (!qGet.get('appCredentials')) qSet.run('appCredentials', JSON.stringify(DEFAULT_CREDENTIALS));
db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-30 days')").run();

const getJSON = (key, fallback) => {
  const row = qGet.get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
};
const getUsers = () => Object.keys(getJSON('driverCounters', {}));

// ---------------------------------------------------------------- Utilidades
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// Limitador sencillo de intentos de login fallidos por IP
const failures = new Map();
const MAX_FAILS = 10, WINDOW_MS = 10 * 60 * 1000;
function tooManyFails(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) { failures.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}
function addFail(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() > f.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else f.count++;
}

const NAME_OK = (n) => typeof n === 'string' && n.trim() === n && n.length > 0 && n.length <= 30 && !/[<>&"'`\\]/.test(n);

// Qué puede leer / escribir cada rol
const ADMIN_ONLY_KEYS = new Set(['currentSchedule', 'scheduleDate', 'scheduleHistory', 'canceledSchedule', 'driverCounters', 'appCredentials']);
const WORKER_READABLE = new Set(['driverCounters', 'currentSchedule', 'scheduleDate', 'canceledSchedule']);

function userKeyOf(key) {
  const m = /^(availability|notWorking)_(.+)$/.exec(key);
  return m ? { kind: m[1], user: m[2] } : null;
}

function canRead(session, key) {
  if (session.role === 'admin') return true;
  if (WORKER_READABLE.has(key)) return true;
  const uk = userKeyOf(key);
  return !!uk && uk.user === session.user;
}

function validateWrite(session, op) {
  const { key } = op;
  if (typeof key !== 'string' || key.length > 100) return 'Clave no válida';
  const uk = userKeyOf(key);
  const isAdmin = session.role === 'admin';

  if (uk) {
    if (!isAdmin && uk.user !== session.user) return 'No puedes modificar datos de otro usuario';
    if (!NAME_OK(uk.user)) return 'Nombre no válido';
    if (op.op === 'set') {
      if (uk.kind === 'notWorking') {
        if (op.value !== 'true') return 'Valor no válido';
      } else {
        let arr;
        try { arr = JSON.parse(op.value); } catch { return 'Disponibilidad no válida'; }
        if (!Array.isArray(arr) || arr.some((d) => !DAYS.includes(d))) return 'Disponibilidad no válida';
      }
    }
    return null;
  }

  if (!ADMIN_ONLY_KEYS.has(key)) return 'Clave no permitida';
  if (!isAdmin) return 'Solo el administrador puede hacer esto';

  if (op.op === 'set') {
    if (typeof op.value !== 'string' || op.value.length > 1_000_000) return 'Valor demasiado grande';
    if (key === 'scheduleDate' || key === 'canceledSchedule') return null;
    let parsed;
    try { parsed = JSON.parse(op.value); } catch { return 'JSON no válido'; }
    if (key === 'driverCounters') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Contadores no válidos';
      for (const [n, v] of Object.entries(parsed)) {
        if (!NAME_OK(n)) return `Nombre no válido: ${n}`;
        if (!Number.isFinite(v)) return 'Contador no válido';
      }
    }
    if (key === 'appCredentials') {
      if (!parsed || !/^\d{4}$/.test(parsed.teamPin || '')) return 'El PIN debe tener 4 dígitos';
      if (typeof parsed.adminKey !== 'string' || parsed.adminKey.length < 4) return 'La clave admin debe tener al menos 4 caracteres';
    }
  } else if (key === 'driverCounters' || key === 'appCredentials') {
    return 'No se puede borrar esta clave';
  }
  return null;
}

// ---------------------------------------------------------------- App
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Lista de nombres para el desplegable de login (solo nombres)
app.get('/api/users', (req, res) => {
  res.json({ users: getUsers().sort((a, b) => a.localeCompare(b, 'es')) });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyFails(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

  const { pin, admin, user, adminKey } = req.body || {};
  const creds = getJSON('appCredentials', DEFAULT_CREDENTIALS);
  const fail = (msg, code = 401) => { addFail(ip); return res.status(code).json({ error: msg }); };

  if (typeof pin !== 'string' || !safeEqual(pin, creds.teamPin)) return fail('PIN del equipo incorrecto');

  let role, name = null;
  if (admin) {
    if (typeof adminKey !== 'string' || !safeEqual(adminKey, creds.adminKey)) return fail('Clave de administrador incorrecta');
    role = 'admin';
  } else {
    if (!user || !getUsers().includes(user)) return fail('Selecciona tu nombre', 400);
    role = 'worker';
    name = user;
  }

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, role, user) VALUES (?, ?, ?)').run(token, role, name);
  failures.delete(ip);
  res.json({ token, role, user: name });
});

function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  const s = m && db.prepare('SELECT role, user FROM sessions WHERE token = ?').get(m[1]);
  if (!s) return res.status(401).json({ error: 'Sesión caducada. Vuelve a entrar.' });
  req.session = s;
  req._token = m[1];
  next();
}
const adminOnly = (req, res, next) =>
  req.session.role === 'admin' ? next() : res.status(403).json({ error: 'Solo el administrador' });

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req._token);
  res.json({ ok: true });
});

// Estado completo visible para el rol (?history=0 para omitir el historial, más ligero)
app.get('/api/state', auth, (req, res) => {
  const skipHistory = req.query.history === '0';
  const kv = {};
  for (const { key, value } of qAll.all()) {
    if (skipHistory && key === 'scheduleHistory') continue;
    if (canRead(req.session, key)) kv[key] = value;
  }
  res.json({ kv });
});

// Varias escrituras en UNA transacción (todo o nada)
app.post('/api/batch', auth, (req, res) => {
  const ops = req.body && req.body.ops;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 200) return res.status(400).json({ error: 'Operaciones no válidas' });

  for (const op of ops) {
    if (!op || (op.op !== 'set' && op.op !== 'remove')) return res.status(400).json({ error: 'Operación no válida' });
    const err = validateWrite(req.session, op);
    if (err) return res.status(403).json({ error: err });
  }

  db.transaction(() => {
    for (const op of ops) {
      if (op.op === 'set') qSet.run(op.key, op.value);
      else qDel.run(op.key);
    }
  })();
  res.json({ ok: true });
});

// Copia de seguridad en JSON (solo admin)
app.get('/api/backup', auth, adminOnly, (req, res) => {
  const data = {};
  for (const { key, value } of qAll.all()) data[key] = value;
  res.setHeader('Content-Disposition', `attachment; filename="pococar-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), kv: data });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
});

app.listen(PORT, () => console.log(`POCOCAR funcionando en http://localhost:${PORT}  (datos en ${path.join(DATA_DIR, 'pococar.db')})`));
