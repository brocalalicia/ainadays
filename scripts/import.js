// Sube a la API los días guardados en uno o varios ficheros JSON
// (formato { fecha: 'YYYY-MM-DD', ev: [...] } o un objeto { 'YYYY-MM-DD': {...}, ... }).
//
//   API_URL=https://ainadays.tudominio.com APP_KEY=... node scripts/import.js datos/*.json
//
// También sirve para migrar la copia local del móvil: en la app, abre la consola del
// navegador y ejecuta  copy(localStorage.getItem('ritmo.dias'))  → pega en un .json.

import fs from 'node:fs';

const API_URL = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_KEY = process.env.APP_KEY || '';
const files = process.argv.slice(2);
if (!files.length) { console.error('Uso: API_URL=... APP_KEY=... node scripts/import.js fichero.json [...]'); process.exit(1); }

const docs = {};
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (j && Array.isArray(j.ev) && j.fecha) docs[j.fecha] = j;
  else for (const k in j) if (j[k] && Array.isArray(j[k].ev)) docs[k] = { ...j[k], fecha: k };
}
for (const fecha of Object.keys(docs).sort()) {
  const r = await fetch(`${API_URL}/api/dias/${fecha}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(APP_KEY ? { Authorization: `Bearer ${APP_KEY}` } : {}) },
    body: JSON.stringify(docs[fecha]),
  });
  console.log(fecha, r.ok ? 'ok' : `error ${r.status}`);
}
