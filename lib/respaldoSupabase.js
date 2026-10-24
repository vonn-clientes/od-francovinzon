import { gzipSync } from 'node:zlib';
import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

const BUCKET = 'respaldos';
const ROOT = (env) => String(env.SUPABASE_URL || '').replace(/\/$/, '');
const headers = (key, extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });

function fechaArgentina(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(date);
}

export async function crearRespaldoDiario({ env = process.env, fetchImpl = fetch, ahora = new Date() } = {}) {
  if (!escrituraPrimariaActiva(env)) return { ok: false, motivo: 'desactivado' };
  const root = ROOT(env), key = env.SUPABASE_SERVICE_KEY;
  const call = async (url, options) => {
    const r = await fetchImpl(url, options);
    if (!r.ok) throw new Error(`Supabase Storage/RPC HTTP ${r.status}`);
    return r;
  };
  const data = await (await call(`${root}/rest/v1/rpc/consultorio_exportar_respaldo`, {
    method: 'POST', headers: headers(key, { 'Content-Type': 'application/json' }), body: '{}',
  })).json();
  const name = `${fechaArgentina(ahora)}.json.gz`;
  const bytes = gzipSync(Buffer.from(JSON.stringify(data)));
  await call(`${root}/storage/v1/object/${BUCKET}/${name}`, {
    method: 'POST', headers: headers(key, { 'Content-Type': 'application/gzip', 'x-upsert': 'true' }), body: bytes,
  });
  const listed = await (await call(`${root}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST', headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'desc' } }),
  })).json();
  const names = (Array.isArray(listed) ? listed : []).map((x) => x.name).filter((x) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(x)).sort().reverse();
  const viejos = names.slice(14);
  if (viejos.length) await call(`${root}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: headers(key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: viejos }),
  });
  return { ok: true, archivo: name, eliminados: viejos.length };
}
