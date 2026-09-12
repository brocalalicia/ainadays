// AïnaDays — API mínima sobre PostgreSQL + servidor de la app estática.
//
//   GET  /api/health              -> { ok: true }
//   GET  /api/dias?desde=YYYY-MM-DD -> { dias: [{ fecha, doc, updated_at }] }
//   GET  /api/dias/:fecha         -> { fecha, doc } | 404
//   PUT  /api/dias/:fecha         -> fusiona el documento del día (evento a evento) y devuelve { ok, doc }
//                                    (?replace=1 sustituye el día entero, para importaciones)
//   DELETE /api/dias/:fecha       -> borra el día
//   POST /api/consejo             -> { lang, texto, contexto } → { fuente: 'claude'|'reglas', texto? }
//                                    (usa la API de Claude si hay ANTHROPIC_API_KEY; si no, la app responde con reglas)
//
// Variables de entorno: DATABASE_URL (obligatoria), APP_KEY (contraseña de la app,
// muy recomendable), ANTHROPIC_API_KEY (opcional, para el consejo con Claude), PORT (3000).

import express from 'express';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
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

// Fusión evento a evento: dos móviles pueden guardar el mismo día sin pisarse.
// Cada evento lleva `u` (última modificación, ms); gana el más reciente. Los
// borrados viajan en `del` (ids) para que no resuciten al fusionar.
function mergeDocs(existing, incoming, fecha) {
  const del = new Set([...(existing?.del || []), ...(incoming.del || [])]);
  const byId = new Map();
  for (const e of existing?.ev || []) byId.set(e.id, e);
  for (const e of incoming.ev || []) {
    const cur = byId.get(e.id);
    if (!cur || (e.u || 0) >= (cur.u || 0)) byId.set(e.id, e);
  }
  const ev = [...byId.values()].filter(e => !del.has(e.id)).sort((a, b) => a.ini - b.ini);
  return { fecha, ev, del: [...del].slice(-200) };
}

app.put('/api/dias/:fecha', async (req, res) => {
  const { fecha } = req.params;
  if (!FECHA.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const doc = req.body;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ev)) return res.status(400).json({ error: 'el documento debe ser { fecha, ev: [...] }' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT doc FROM dias WHERE fecha = $1 FOR UPDATE', [fecha]);
    const merged = req.query.replace === '1' ? { fecha, ev: doc.ev, del: doc.del || [] } : mergeDocs(rows[0]?.doc, doc, fecha);
    await client.query(
      `INSERT INTO dias (fecha, doc, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (fecha) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [fecha, JSON.stringify(merged)],
    );
    await client.query('COMMIT');
    res.json({ ok: true, doc: merged });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

app.delete('/api/dias/:fecha', async (req, res) => {
  if (!FECHA.test(req.params.fecha)) return res.status(400).json({ error: 'fecha inválida' });
  await pool.query('DELETE FROM dias WHERE fecha = $1', [req.params.fecha]);
  res.json({ ok: true });
});

// Consejo del momento: qué hacer ahora con lo que la madre describe + el contexto del día
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const CONSEJO_SYSTEM = {
  es: `Eres una asesora de lactancia y sueño infantil, cercana y muy concreta. Ayudas a una madre que da pecho en exclusiva a su hija Aïna, de 3 meses. Te describe lo que la niña hace ahora mismo y tú le dices qué hacer en los próximos minutos.
Responde en español, en segunda persona, máximo 90 palabras, sin títulos ni listas con viñetas: una frase de lectura (qué le pasa probablemente) y 2–3 pasos concretos en orden, con horas si ayudan. Referencias a los 3 meses: ventana de vigilia de 1 h – 2 h, señales de sueño (frotarse la cara, bostezar, mirada perdida, gruñir, tirarse de las orejas), señales de hambre (buscar, manos a la boca, chupar), siestas de un ciclo (30–45 min), tomas cada 2–3 h de día. Nunca propongas dejarla llorar ni quitar tomas de noche. Sin alarmismos; si algo requiere pediatra, dilo en una frase.`,
  fr: `Tu es une conseillère en allaitement et sommeil du nourrisson, proche et très concrète. Tu aides une mère qui allaite exclusivement sa fille Aïna, 3 mois. Elle te décrit ce que fait le bébé maintenant et tu lui dis quoi faire dans les prochaines minutes.
Réponds en français, à la deuxième personne, 90 mots maximum, sans titres ni listes à puces : une phrase de lecture (ce qui se passe probablement) puis 2–3 étapes concrètes dans l'ordre, avec des heures si utile. Repères à 3 mois : fenêtre d'éveil de 1 h à 2 h, signes de fatigue (se frotter le visage, bâiller, regard dans le vide, grogner, se tirer les oreilles), signes de faim (chercher le sein, mains à la bouche, succion), siestes d'un cycle (30–45 min), tétées toutes les 2–3 h le jour. Ne propose jamais de la laisser pleurer ni de supprimer des tétées de nuit. Sans alarmisme ; si quelque chose nécessite le pédiatre, dis-le en une phrase.`,
};

app.post('/api/consejo', async (req, res) => {
  const { lang = 'es', texto = '', contexto = '' } = req.body || {};
  if (!anthropic) return res.json({ fuente: 'reglas' });
  const t = String(texto).slice(0, 1000), c = String(contexto).slice(0, 4000);
  if (!t.trim()) return res.status(400).json({ error: 'falta el texto' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 600,
      system: [{ type: 'text', text: CONSEJO_SYSTEM[lang === 'fr' ? 'fr' : 'es'], cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `${lang === 'fr' ? 'Contexte du jour' : 'Contexto del día'}:\n${c}\n\n${lang === 'fr' ? 'Ce qu’elle fait maintenant' : 'Lo que hace ahora'}: ${t}` }],
    });
    if (response.stop_reason === 'refusal') return res.json({ fuente: 'reglas' });
    const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ fuente: 'claude', texto: out });
  } catch (e) {
    console.error('consejo:', e && e.message);
    res.json({ fuente: 'reglas' });
  }
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
