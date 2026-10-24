import { createHash } from 'node:crypto';
import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

const BUCKET = 'recetas';
const TIMEOUT_MS = 2500;

async function request(url, options, fetchImpl, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

function config(env) {
  if (!escrituraPrimariaActiva(env)) return null;
  return { root: String(env.SUPABASE_URL).replace(/\/$/, ''), key: env.SUPABASE_SERVICE_KEY };
}

async function rpc({ cfg, nombre, parametros, fetchImpl }) {
  const r = await request(`${cfg.root}/rest/v1/rpc/${nombre}`, { method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(parametros) }, fetchImpl);
  if (!r.ok) throw Object.assign(new Error('rpc'), { confirmado: r.status < 500 });
  return r.json();
}

function storageUrl(cfg, path) { return `${cfg.root}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`; }

export async function guardarRecetaSupabase({ fichaId, nombre, buffer, metadata = {}, env = process.env, fetchImpl = fetch, ahora = Date.now() }) {
  const cfg = config(env);
  if (!cfg) return { ruta: 'google', motivo: 'desactivado' };
  let attempted = false;
  let uploaded = false;
  try {
    const safe = String(nombre || 'receta.pdf').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'receta.pdf';
    const storagePath = `${fichaId}/${ahora}-${safe}`;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    attempted = true;
    const up = await request(storageUrl(cfg, storagePath), { method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: buffer }, fetchImpl);
    if (!up.ok) return up.status >= 500 || up.status === 408
      ? { ruta: 'incierta', motivo: 'ambiguo' }
      : { ruta: 'google', motivo: 'supabase_no_disponible' };
    uploaded = true;
    const row = { drive_file_id: null, ficha_id: fichaId, tipo: 'receta', nombre: safe, mime_type: 'application/pdf', bytes: buffer.length, sha256, storage_path: storagePath, drive_modified_time: null, copiado_en: new Date(ahora).toISOString(), metadata };
    const saved = await rpc({ cfg, nombre: 'consultorio_registrar_receta', parametros: { p_archivo: row }, fetchImpl });
    return { ruta: 'supabase', id: saved?.id || saved?.archivo_id || saved?.[0]?.id, storagePath };
  } catch (error) {
    return attempted || uploaded ? { ruta: 'incierta', motivo: 'ambiguo' } : { ruta: 'google', motivo: 'supabase_no_disponible' };
  }
}

export async function listarRecetasSupabase({ fichaId, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = config(env); if (!cfg) return { disponible: false };
  try {
    const data = await rpc({ cfg, nombre: 'consultorio_listar_recetas', parametros: { p_ficha_id: fichaId }, fetchImpl });
    return { disponible: true, recetas: (Array.isArray(data) ? data : []).map((x) => ({ id: x.id, descripcion: x.metadata?.descripcion || '', fecha: x.copiado_en, nombre: x.nombre })) };
  } catch { return { disponible: false }; }
}

export async function descargarRecetaSupabase({ id, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = config(env); if (!cfg) return { disponible: false };
  try {
    const data = await rpc({ cfg, nombre: 'consultorio_leer_receta', parametros: { p_id: id }, fetchImpl });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.storage_path || !row.storage_path.startsWith(`${row.ficha_id}/`)) return { disponible: true, error: 'not_found' };
    let r = await request(storageUrl(cfg, row.storage_path), { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }, fetchImpl);
    // Compatibilidad con copias antiguas del espejo previo al bucket `recetas`.
    if (!r.ok && row.storage_path.startsWith(`${row.ficha_id}/receta/`)) {
      const legacy = `${cfg.root}/storage/v1/object/pacientes-archivos/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`;
      r = await request(legacy, { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }, fetchImpl);
    }
    if (!r.ok) return { disponible: false };
    return { disponible: true, buffer: Buffer.from(await r.arrayBuffer()), mimeType: row.mime_type || 'application/pdf' };
  } catch { return { disponible: false }; }
}

export async function guardarTemporalReceta({ codigo, contenido, env = process.env, fetchImpl = fetch }) {
  const cfg = config(env); if (!cfg) return { disponible: false };
  try {
    const path = `_proceso/${codigo}.json`;
    const r = await request(storageUrl(cfg, path), { method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', 'x-upsert': 'false' }, body: JSON.stringify({ expira: Date.now() + 48 * 60 * 60 * 1000, contenido }) }, fetchImpl);
    return { disponible: r.ok, incierto: !r.ok && (r.status >= 500 || r.status === 408) };
  } catch { return { disponible: false, incierto: true }; }
}

export async function leerTemporalReceta({ codigo, env = process.env, fetchImpl = fetch }) {
  const cfg = config(env); if (!cfg) return { disponible: false };
  try {
    const r = await request(storageUrl(cfg, `_proceso/${codigo}.json`), { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }, fetchImpl);
    if (r.status === 404) return { disponible: true, contenido: null };
    if (!r.ok) return { disponible: false };
    const body = await r.json();
    if (body.expira < Date.now()) return { disponible: true, contenido: null };
    return { disponible: true, contenido: body.contenido };
  } catch { return { disponible: false }; }
}

export async function borrarTemporalReceta({ codigo, env = process.env, fetchImpl = fetch }) {
  const cfg = config(env); if (!cfg) return { disponible: false };
  try {
    const r = await request(storageUrl(cfg, `_proceso/${codigo}.json`), { method: 'DELETE', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }, fetchImpl);
    return { disponible: r.ok || r.status === 404 };
  } catch { return { disponible: false }; }
}
