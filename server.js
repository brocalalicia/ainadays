// AïnaDays — API mínima sobre PostgreSQL + servidor de la app estática.
//
//   GET  /api/health              -> { ok: true }
//   GET  /api/dias?desde=YYYY-MM-DD -> { dias: [{ fecha, doc, updated_at }] }
//   GET  /api/dias/:fecha         -> { fecha, doc } | 404
//   PUT  /api/dias/:fecha         -> fusiona el documento del día (evento a evento) y devuelve { ok, doc }
//                                    (?replace=1 sustituye el día entero, para importaciones)
//   DELETE /api/dias/:fecha       -> borra el día
//   GET  /api/momentos?desde=ISO  -> { momentos: [{ id, ts, nota, bytes }] }   (InstAïna)
//   GET  /api/momentos/:id/img    -> la imagen (JPEG)
//   POST /api/momentos            -> { nota, data: 'data:image/jpeg;base64,...' } → { ok, id }
//   DELETE /api/momentos/:id
//   POST /api/interpretar         -> { lang, texto, ahora } → { fuente, eventos: [...], resumen }   (registro por voz)
//   POST /api/consejo             -> { lang, contexto, mensajes: [{role, texto}] } → { fuente: 'claude'|'reglas', texto?, traduccion? }
//                                    (usa la API de Claude si hay ANTHROPIC_API_KEY; si no, la app responde con reglas)
//
// Variables de entorno: DATABASE_URL (obligatoria), APP_KEY (contraseña de la app,
// muy recomendable), ANTHROPIC_API_KEY (opcional, para el consejo con Claude), PORT (3000),
// N8N_WEBHOOK_URL (opcional: cada foto de InstAïna se envía ahí, p. ej. para WhatsApp), PUBLIC_URL.

import express from 'express';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const APP_KEY = (process.env.APP_KEY || '').trim();
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://ainadays.aliciabrocal.cloud').replace(/\/$/, '');
const N8N_WEBHOOK_URL = (process.env.N8N_WEBHOOK_URL || '').trim();

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
  // InstAïna: fotos del día (comprimidas en el móvil, ~200 KB cada una)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS momentos (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
      nota       TEXT NOT NULL DEFAULT '',
      mime       TEXT NOT NULL DEFAULT 'image/jpeg',
      img        BYTEA NOT NULL
    );
    CREATE INDEX IF NOT EXISTS momentos_ts ON momentos (ts DESC);
  `);
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

// Enlace firmado a una foto (para WhatsApp / n8n): /api/momentos/:id/img?s=<firma>
const signImg = id => crypto.createHmac('sha256', APP_KEY || 'sin-clave').update('img:' + id).digest('hex').slice(0, 32);
const imgLink = id => `${PUBLIC_URL}/api/momentos/${id}/img?s=${signImg(id)}`;

// Autenticación: cabecera "Authorization: Bearer <APP_KEY>". Sin APP_KEY, abierto.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!APP_KEY) return next();
  const m = /^\/momentos\/(\d+)\/img$/.exec(req.path);
  if (m && typeof req.query.s === 'string' && req.query.s.length === 32 && crypto.timingSafeEqual(Buffer.from(req.query.s), Buffer.from(signImg(m[1])))) return next();
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

// ---------- InstAïna ----------
app.get('/api/momentos', async (req, res) => {
  const desde = req.query.desde ? new Date(String(req.query.desde)) : new Date(Date.now() - 35 * 86400000);
  const { rows } = await pool.query(
    `SELECT id, ts, nota, octet_length(img) AS bytes FROM momentos WHERE ts >= $1 ORDER BY ts DESC LIMIT 200`,
    [isNaN(desde) ? new Date(0) : desde],
  );
  res.json({ momentos: rows });
});

app.get('/api/momentos/:id/img', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).end();
  const { rows } = await pool.query('SELECT mime, img FROM momentos WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(rows[0].img);
});

app.post('/api/momentos', async (req, res) => {
  const { nota = '', data = '' } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
  if (!m) return res.status(400).json({ error: 'imagen inválida' });
  const img = Buffer.from(m[2], 'base64');
  if (img.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'imagen demasiado grande (máx. 2 MB)' });
  const { rows } = await pool.query('INSERT INTO momentos (nota, mime, img) VALUES ($1, $2, $3) RETURNING id, ts', [String(nota).slice(0, 300), m[1], img]);
  res.json({ ok: true, id: rows[0].id, ts: rows[0].ts });
  // Aviso a n8n (sin bloquear la respuesta): { id, ts, nota, url } — url es un enlace firmado a la imagen
  if (N8N_WEBHOOK_URL) {
    fetch(N8N_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rows[0].id, ts: rows[0].ts, nota: String(nota).slice(0, 300), url: imgLink(rows[0].id), bytes: img.length }),
    }).then(r => { if (!r.ok) console.error('n8n webhook:', r.status); }).catch(e => console.error('n8n webhook:', e.message));
  }
});

app.delete('/api/momentos/:id', async (req, res) => {
  await pool.query('DELETE FROM momentos WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Registro por voz: convierte una frase en eventos estructurados
const INTERPRETAR_SCHEMA = {
  type: 'object',
  properties: {
    eventos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['toma', 'sueno', 'despertar', 'panal', 'nota'] },
          hace_min: { type: 'integer', description: 'Minutos transcurridos desde que el evento terminó (toma), empezó (sueno), ocurrió (despertar, panal, nota). 0 = ahora mismo.' },
          lado: { type: 'string', enum: ['I', 'D', 'A', ''], description: 'Solo tomas: I izquierdo, D derecho, A ambos, vacío si no se dice' },
          duracion: { type: 'string', enum: ['corta', 'larga', ''], description: 'Solo tomas; vacío si no se dice' },
          panal: { type: 'string', enum: ['pipi', 'caca', 'ambos', ''], description: 'Solo pañal; pipi por defecto si no se dice' },
          texto: { type: 'string', description: 'Solo notas: el texto de la nota' },
        },
        required: ['tipo', 'hace_min', 'lado', 'duracion', 'panal', 'texto'],
        additionalProperties: false,
      },
    },
    resumen: { type: 'string', description: 'Una línea que resume lo registrado, en el idioma de la madre' },
  },
  required: ['eventos', 'resumen'],
  additionalProperties: false,
};
const INTERPRETAR_SYSTEM = `Conviertes frases de una madre (en español o francés) sobre su bebé Aïna en registros para una app de tomas, sueño y pañales. Devuelve solo los eventos que la frase afirma que han ocurrido, en orden cronológico (el más antiguo primero), estimando hace_min con sentido común: "se acaba de dormir" = 0; "después de una toma" = la toma terminó unos 5 minutos antes de dormirse; "hace media hora" = 30. Una toma es un evento único aunque sean los dos pechos (lado A). "Se ha despertado" es tipo despertar. "Cambiar el pañal" es tipo panal (pipi salvo que se diga caca). Lo que no encaje en toma/sueno/despertar/panal va como nota. No inventes eventos que no se mencionan.`;

app.post('/api/interpretar', async (req, res) => {
  const { lang = 'es', texto = '', ahora = '' } = req.body || {};
  if (!anthropic) return res.json({ fuente: 'reglas' });
  const t = String(texto).slice(0, 800);
  if (!t.trim()) return res.status(400).json({ error: 'falta el texto' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 800,
      system: [{ type: 'text', text: INTERPRETAR_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INTERPRETAR_SCHEMA } },
      messages: [{ role: 'user', content: `Idioma de la madre: ${lang === 'fr' ? 'francés' : 'español'}. Hora actual: ${String(ahora).slice(0, 40)}.\nFrase: ${t}` }],
    });
    if (response.stop_reason === 'refusal') return res.json({ fuente: 'reglas' });
    const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const parsed = JSON.parse(out);
    res.json({ fuente: 'claude', ...parsed });
  } catch (e) {
    console.error('interpretar:', e && e.message);
    res.json({ fuente: 'reglas' });
  }
});

// Consejo del momento: qué hacer ahora con lo que la madre describe + el contexto del día
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const CONSEJO_SYSTEM = {
  es: `Eres una asesora de lactancia y sueño infantil, cercana y muy concreta. Ayudas a una madre que da pecho en exclusiva a su hija Aïna, de 3 meses. Te describe lo que la niña hace ahora mismo y tú le dices qué hacer en los próximos minutos. Es una conversación: si te precisa o corrige algo, ajusta tu consejo a lo nuevo sin repetir lo ya dicho.
Responde en español, en segunda persona, máximo 90 palabras, sin títulos ni listas con viñetas: una frase de lectura (qué le pasa probablemente) y 2–3 pasos concretos en orden, con horas si ayudan. Después de la respuesta escribe una línea que contenga solo ===== y a continuación la misma respuesta traducida al francés (para el padre, que lee en francés). Referencias a los 3 meses: ventana de vigilia de 1 h – 2 h, señales de sueño (frotarse la cara, bostezar, mirada perdida, gruñir, tirarse de las orejas), señales de hambre (buscar, manos a la boca, chupar), siestas de un ciclo (30–45 min), tomas cada 2–3 h de día. Nunca propongas dejarla llorar ni quitar tomas de noche. Sin alarmismos; si algo requiere pediatra, dilo en una frase.`,
  fr: `Tu es une conseillère en allaitement et sommeil du nourrisson, proche et très concrète. Tu aides une mère qui allaite exclusivement sa fille Aïna, 3 mois. Elle te décrit ce que fait le bébé maintenant et tu lui dis quoi faire dans les prochaines minutes. C'est une conversation : si elle précise ou corrige quelque chose, ajuste ton conseil sans répéter ce qui a déjà été dit.
Réponds en français, à la deuxième personne, 90 mots maximum, sans titres ni listes à puces : une phrase de lecture (ce qui se passe probablement) puis 2–3 étapes concrètes dans l'ordre, avec des heures si utile. Après la réponse, écris une ligne contenant uniquement ===== puis la même réponse traduite en espagnol (pour la mère, qui lit en espagnol). Repères à 3 mois : fenêtre d'éveil de 1 h à 2 h, signes de fatigue (se frotter le visage, bâiller, regard dans le vide, grogner, se tirer les oreilles), signes de faim (chercher le sein, mains à la bouche, succion), siestes d'un cycle (30–45 min), tétées toutes les 2–3 h le jour. Ne propose jamais de la laisser pleurer ni de supprimer des tétées de nuit. Sans alarmisme ; si quelque chose nécessite le pédiatre, dis-le en une phrase.`,
};

app.post('/api/consejo', async (req, res) => {
  const { lang = 'es', texto = '', contexto = '', mensajes } = req.body || {};
  if (!anthropic) return res.json({ fuente: 'reglas' });
  const c = String(contexto).slice(0, 4000);
  // Historial de chat: [{ role: 'user'|'assistant', texto }], el último es de la madre.
  // Sin historial, se usa `texto` como único turno.
  let turns = Array.isArray(mensajes) && mensajes.length ? mensajes : [{ role: 'user', texto }];
  turns = turns.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.texto || '').slice(0, 1000) })).filter(m => m.text.trim());
  if (!turns.length || turns[turns.length - 1].role !== 'user') return res.status(400).json({ error: 'falta el texto' });
  if (turns[0].role !== 'user') turns.shift();
  const fr = lang === 'fr';
  const messages = turns.map((m, i) => ({
    role: m.role,
    content: i === 0 ? `${fr ? 'Contexte du jour' : 'Contexto del día'}:\n${c}\n\n${fr ? 'Ce qu’elle fait maintenant' : 'Lo que hace ahora'}: ${m.text}` : m.text,
  }));
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 600,
      system: [{ type: 'text', text: CONSEJO_SYSTEM[fr ? 'fr' : 'es'], cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low' },
      messages,
    });
    if (response.stop_reason === 'refusal') return res.json({ fuente: 'reglas' });
    const out = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const [texto, otro] = out.split(/\n\s*=====\s*\n/);
    res.json({ fuente: 'claude', texto: (texto || out).trim(), traduccion: otro ? otro.trim() : null });
  } catch (e) {
    console.error('consejo:', e && e.message);
    res.json({ fuente: 'reglas' });
  }
});

// App estática
// La página nunca se cachea (para que cada despliegue llegue al móvil al instante); icono y manifest, 1 día.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, filePath) => { res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'); },
}));
app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Errores
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'error interno' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`AïnaDays escuchando en :${PORT}${APP_KEY ? ' (con contraseña)' : ' (SIN contraseña)'}`)))
  .catch(e => { console.error('No se pudo preparar la base de datos:', e); process.exit(1); });
