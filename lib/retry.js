// Reintentos automáticos ante fallas transitorias de la API de Google (Calendar,
// Sheets, Drive) — para que un timeout o un 5xx pasajero no le muestre un error al
// paciente/secretaria si el segundo o tercer intento hubiera andado bien. Nunca
// reintenta errores "de verdad" (401, 403, 400, 404, etc.) — esos se propagan de
// inmediato, tal como antes.
//
// Uso: envolver cada llamada individual a la API, call site por call site —
// `await conReintentos(() => calendar.events.list({...}))`. NO existe (a propósito) una
// versión que envuelva el cliente entero: se probó con un Proxy recursivo y tiró
// producción entera abajo (ver decisions.md, incidente 2026-08-12 — las clases internas
// de googleapis/google-auth-library usan campos privados nativos `#campo`, que se rompen
// si un método corre con `this` = un Proxy en vez de la instancia real).

const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);

function esErrorTransitorio(err) {
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  if (CODIGOS_REINTENTABLES.has(status)) return true;

  // Google APIs a veces indican la cuota agotada como 403, no como 429.
  const razones = [
    ...(err?.errors || []),
    ...(err?.response?.data?.error?.errors || []),
  ].map((e) => String(e?.reason || '').toLowerCase());
  if (razones.some((r) => ['ratelimitexceeded', 'userratelimitexceeded'].includes(r))) return true;

  const codigoRed = err?.code;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(codigoRed)) return true;

  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('per minute per user') || msg.includes('userratelimitexceeded') || msg.includes('ratelimitexceeded')) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('socket hang up')) return true;

  return false;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fn: función sin argumentos que devuelve una Promise (ej. () => calendar.events.insert({...})).
export async function conReintentos(fn, { intentos = 3, esperaBaseMs = 350 } = {}) {
  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      const esUltimoIntento = intento === intentos;
      if (esUltimoIntento || !esErrorTransitorio(err)) throw err;
      console.warn(`[retry] intento ${intento}/${intentos} falló (transitorio), reintentando…`, err?.message || err);
      const status = Number(err?.code ?? err?.response?.status ?? err?.status);
      const razones = [...(err?.errors || []), ...(err?.response?.data?.error?.errors || [])]
        .map((e) => String(e?.reason || '').toLowerCase());
      const msg = String(err?.message || '').toLowerCase();
      const cuotaPorMinuto = razones.includes('userratelimitexceeded') || msg.includes('per minute per user') || msg.includes('userratelimitexceeded');
      const limiteRitmo = status === 429 || razones.includes('ratelimitexceeded') || razones.includes('userratelimitexceeded');
      const retryAfterRaw = err?.response?.headers?.['retry-after'] || err?.response?.headers?.get?.('retry-after');
      const retryAfter = retryAfterRaw ? (Number(retryAfterRaw) * 1000 || Math.max(0, Date.parse(retryAfterRaw) - Date.now())) : 0;
      const backoff = cuotaPorMinuto ? 60000 : Math.min(30000, Math.max(esperaBaseMs * (2 ** (intento - 1)), limiteRitmo ? 1000 : 0));
      await esperar(Math.max(backoff, retryAfter));
    }
  }
  throw ultimoError; // inalcanzable en la práctica, solo para que TS/lectores no se confundan
}
