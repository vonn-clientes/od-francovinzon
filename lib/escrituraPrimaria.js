import { aplicarAccion, fusionarFichas } from './fichaMotor.js';

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
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`);
      error.confirmado = true;
      throw error;
    }
    return Array.isArray(data) ? data[0] ?? null : data;
  } finally { clearTimeout(timer); }
}

export function escrituraPrimariaActiva(env = process.env) {
  return env.SUPABASE_WRITES_PRIMARY === '1' && Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

// Decide el fallback sin ocultar resultados inciertos: solo sin_snapshot permite Google.
export async function ejecutarEscrituraPrimaria({ activa, aplicar, escribirGoogle }) {
  if (!activa) return { ruta: 'google', resultado: await escribirGoogle() };
  const resultado = await aplicar();
  if (resultado?.ok) return { ruta: 'supabase', resultado };
  if (resultado?.motivo === 'sin_snapshot') return { ruta: 'google', resultado: await escribirGoogle() };
  return { ruta: 'rechazada', resultado };
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

// La fusión se calcula en JS (mismo motor que el resto) y la RPC la aplica atómicamente,
// verificando la versión de ambas fichas. Timeout/error de transporte es ambiguo:
// jamás se ejecuta Sheets después de que Supabase pudo haber confirmado.
export async function fusionarEnSupabase({ destino, origen, campos = null, ahora = new Date(), env = process.env, fetchImpl = fetch }) {
  if (!escrituraPrimariaActiva(env)) return { ok: false, motivo: 'sin_snapshot' };
  const config = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, fetchImpl };
  try {
    for (let intento = 0; intento < 3; intento += 1) {
      let d, o;
      try {
        [d, o] = await Promise.all([
          rpc({ ...config, nombre: 'consultorio_leer_ficha', parametros: { p_id: destino } }),
          rpc({ ...config, nombre: 'consultorio_leer_ficha', parametros: { p_id: origen } }),
        ]);
      } catch { return { ok: false, motivo: 'sin_snapshot' }; }
      const fd = d?.ficha ?? d?.ficha_json, fo = o?.ficha ?? o?.ficha_json;
      if (!fd || !fo) return { ok: false, motivo: 'sin_snapshot' };
      let fusion;
      try { fusion = fusionarFichas(fd, fo, campos || {}, { ahora }); }
      catch (error) { return { ok: false, motivo: 'invalido', mensaje: error?.message || 'Error de validación.' }; }
      let result;
      try {
        result = await rpc({ ...config, nombre: 'consultorio_fusionar_fichas', parametros: {
          p_destino: destino, p_origen: origen, p_ficha: fusion, p_version_destino: d.ficha_version, p_version_origen: o.ficha_version,
        } });
      } catch { return { ok: false, motivo: 'ambiguo' }; }
      if (result?.ok === true) return { ok: true, ficha: fusion, version: result.version };
      if (result?.motivo === 'conflicto') { if (intento < 2) continue; return { ok: false, motivo: 'conflicto' }; }
      if (result?.motivo === 'sin_ficha' || result?.motivo === 'ids_invalidos') return { ok: false, motivo: 'sin_snapshot' };
      return { ok: false, motivo: 'ambiguo' };
    }
  } catch { /* siempre responde con resultado */ }
  return { ok: false, motivo: 'ambiguo' };
}
