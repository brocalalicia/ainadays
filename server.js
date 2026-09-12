// AïnaDays — API mínima sobre PostgreSQL + servidor de la app estática.
//
//   GET  /api/health              -> { ok: true }
//   GET  /api/dias?desde=YYYY-MM-DD -> { dias: [{ fecha, doc, updated_at }] }
//   GET  /api/dias/:fecha         -> { fecha, doc } | 404
//   PUT  /api/dias/:fecha         -> guarda el documento del día (JSON) y responde { ok: true }
//   DELETE /api/dias/:fecha       -> borra el día
//
// Variables de entorno: DATABASE_URL (obligatoria), APP_KEY (contraseña de la app,
// muy recomendable), PORT (3000 por defecto).

import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const APP_KEY = (process.env.APP_KEY || '').trim();
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL (p. ej. postgres://usuario:clave@host:5432/ainadays)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dias (
      fecha      DATE PRIMARY KEY,
      doc        JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

// Autenticación: cabecera "Authorization: Bearer <APP_KEY>". Sin APP_KEY, abierto.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!APP_KEY) return next();
  const h = req.get('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (key && key === APP_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/dias', async (req, res) => {
  const desde = String(req.query.desde || '');
  const hasta = String(req.query.hasta || '');
  const where = [], params = [];
  if (FECHA.test(desde)) { params.push(desde); where.push(`fecha >= $${params.length}`); }
  if (FECHA.test(hasta)) { params.push(hasta); where.push(`fecha <= $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, doc, updated_at FROM dias ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fecha`,
    params,
  );
  res.json({ dias: rows });
});

app.get('/api/dias/:fecha', async (req, res) => {
  if (!FECHA.test(req.params.fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const { rows } = await pool.query(`SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, doc FROM dias WHERE fecha = $1`, [req.params.fecha]);
  if (!rows.length) return res.status(404).json({ error: 'no existe' });
  res.json(rows[0]);
});

app.put('/api/dias/:fecha', async (req, res) => {
  const { fecha } = req.params;
  if (!FECHA.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const doc = req.body;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ev)) return res.status(400).json({ error: 'el documento debe ser { fecha, ev: [...] }' });
  doc.fecha = fecha;
  await pool.query(
    `INSERT INTO dias (fecha, doc, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (fecha) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
    [fecha, JSON.stringify(doc)],
  );
  res.json({ ok: true });
});

app.delete('/api/dias/:fecha', async (req, res) => {
  if (!FECHA.test(req.params.fecha)) return res.status(400).json({ error: 'fecha inválida' });
  await pool.query('DELETE FROM dias WHERE fecha = $1', [req.params.fecha]);
  res.json({ ok: true });
});

// App estática
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Errores
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'error interno' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`AïnaDays escuchando en :${PORT}${APP_KEY ? ' (con contraseña)' : ' (SIN contraseña)'}`)))
  .catch(e => { console.error('No se pudo preparar la base de datos:', e); process.exit(1); });
