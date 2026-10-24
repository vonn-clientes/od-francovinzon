// RPC boundary for consultorio.consolidados. The schema is intentionally never
// accessed through PostgREST table endpoints.
export function consolidadosActivos(env = process.env) {
  return env.SUPABASE_WRITES_PRIMARY === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_KEY;
}

export async function rpcConsolidados(nombre, params = {}, { env = process.env, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!consolidadosActivos(env)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
      method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: controller.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function listarConsolidadosSupabase(opciones) {
  const r = await rpcConsolidados('consultorio_consolidados_listar', {}, opciones);
  return Array.isArray(r) ? r : null;
}

export async function saludSupabase(opciones) {
  const r = await rpcConsolidados('consultorio_tramo8_health', {}, opciones);
  return r && typeof r === 'object' ? r : null;
}

export async function upsertConsolidadoSupabase(fila, opciones) {
  // Once a request is sent, a missing response is ambiguous: never repeat it in Google.
  const r = await rpcConsolidados('consultorio_consolidados_upsert', { p_fila: fila }, opciones);
  return r?.ok === true ? r : { ok: false, motivo: r ? 'rechazada' : 'ambiguo' };
}

export async function guardarAsistenciaSupabase(p, opciones) {
  const r = await rpcConsolidados('consultorio_consolidados_asistencia', { p_fila: p }, opciones);
  return r?.ok === true ? r : { ok: false, motivo: r ? 'rechazada' : 'ambiguo' };
}
