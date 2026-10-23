const TIMEOUT_MS = 2500;

function config(options = {}) {
  return {
    url: options.url ?? process.env.SUPABASE_URL,
    serviceKey: options.serviceKey ?? process.env.SUPABASE_SERVICE_KEY,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

async function postRpc(nombre, payload, options = {}) {
  const { url, serviceKey, fetchImpl } = config(options);
  if (process.env.SUPABASE_SYNC_ON_WRITE !== '1' || !url || !serviceKey || typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: payload }),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error('HTTP error');
    return true;
  } catch {
    console.warn(`[espejoConfig] fallo en ${nombre}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function espejarConfig(clave, valor, { actualizado = new Date().toISOString(), ...options } = {}) {
  try { await postRpc('consultorio_config_set', { clave, valor, actualizado }, options); }
  catch { console.warn('[espejoConfig] fallo al espejar configuración'); }
}

// Escribe la configuración en Supabase y avisa si salió bien (true/false). Se usa cuando
// Supabase es la fuente principal: si devuelve false, quien llama cae a Google.
export async function guardarConfigSupabase(clave, valor, actualizado = new Date().toISOString(), options = {}) {
  try { return await postRpc('consultorio_config_set', { clave, valor, actualizado }, options); }
  catch { return false; }
}

export async function espejarActividad(entrada, options = {}) {
  try { await postRpc('consultorio_log_actividad', entrada, options); }
  catch { console.warn('[espejoConfig] fallo al espejar actividad'); }
}

export async function espejarAlerta(entrada, options = {}) {
  try { await postRpc('consultorio_log_alerta', entrada, options); }
  catch { console.warn('[espejoConfig] fallo al espejar alerta'); }
}

export async function espejarLote({ configs = [], actividad = [], alertas = [], tamanoLote = 200 } = {}, options = {}) {
  const resultado = { configs: 0, actividad: 0, alertas: 0, errores: 0 };
  const lotes = [
    ['configs', 'consultorio_config_set', configs],
    ['actividad', 'consultorio_log_actividad', actividad],
    ['alertas', 'consultorio_log_alerta', alertas],
  ];
  const size = Number.isInteger(tamanoLote) && tamanoLote > 0 ? tamanoLote : 200;
  for (const [campo, rpc, filas] of lotes) {
    for (let i = 0; i < filas.length; i += size) {
      const lote = filas.slice(i, i + size);
      if (await postRpc(rpc, lote, options)) resultado[campo] += lote.length;
      else resultado.errores += lote.length;
    }
  }
  return resultado;
}
