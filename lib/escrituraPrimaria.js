import { aplicarAccion } from './fichaMotor.js';

async function rpc({ nombre, parametros, url, serviceKey, fetchImpl, ms = 3000 }) {
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
        method: 'POST',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parametros),
        signal: controller.signal,
      })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms); }),
    ]);
    let data;
    try { data = await response.json(); } catch { throw new Error('Respuesta JSON inválida de Supabase'); }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`);
    return Array.isArray(data) ? data[0] ?? null : data;
  } finally { clearTimeout(timer); }
}

export function escrituraPrimariaActiva(env = {}) {
  return env.SUPABASE_WRITES_PRIMARY === '1' && Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

export async function aplicarEnSupabase({ id, accion, body, ahora, env = process.env, fetchImpl = fetch }) {
  if (!escrituraPrimariaActiva(env)) return { ok: false, motivo: 'sin_snapshot' };
  const config = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, fetchImpl };
  try {
    for (let intento = 0; intento < 4; intento += 1) {
      let row;
      try { row = await rpc({ ...config, nombre: 'consultorio_leer_ficha', parametros: { p_id: id } }); }
      catch { return { ok: false, motivo: 'sin_snapshot' }; }
      const fichaBase = row?.ficha ?? row?.ficha_json;
      if (!fichaBase || typeof fichaBase !== 'object' || Array.isArray(fichaBase)) return { ok: false, motivo: 'sin_snapshot' };
      let resultado;
      try { resultado = aplicarAccion(fichaBase, accion, body, { ahora }); }
      catch (error) { return { ok: false, motivo: 'invalido', mensaje: error?.message || 'Error de validación.' }; }
      let guardado;
      try {
        guardado = await rpc({ ...config, nombre: 'consultorio_aplicar_ficha', parametros: {
          p_id: id, p_version_esperada: row.ficha_version, p_ficha: resultado.ficha, p_accion: accion, p_body: body,
        } });
      } catch { return { ok: false, motivo: 'ambiguo' }; }
      if (guardado?.ok === true) return { ok: true, version: guardado.version, ficha: resultado.ficha, cambios: resultado.cambios };
      if (guardado?.motivo === 'conflicto') {
        if (intento < 3) continue;
        return { ok: false, motivo: 'conflicto', version: guardado.version };
      }
      if (guardado?.motivo === 'sin_ficha') return { ok: false, motivo: 'sin_snapshot' };
      return { ok: false, motivo: 'ambiguo' };
    }
  } catch { /* La API siempre responde con un resultado, también ante fallas inesperadas. */ }
  return { ok: false, motivo: 'ambiguo' };
}
