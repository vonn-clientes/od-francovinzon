import { aplicarAccion } from './fichaMotor.js';
import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

const fichaVacia = () => ({
  campos: {},
  financiero: { total: '$0,00', pagado: '$0,00', saldo: '$0,00', alDiaTexto: '✅ AL DÍA', diasSinPagoTexto: '' },
  movimientos: [], prestacionesObraSocial: [],
});

// RPC transaccional. Falla cerrada y nunca propaga errores: sin_snapshot habilita
// el camino Google existente; las respuestas de negocio (incluido DNI duplicado) no.
export async function crearFichaSupabase({ nombre, apellido, campos = {}, env = process.env, fetchImpl = fetch, ahora = new Date() } = {}) {
  if (!escrituraPrimariaActiva(env)) return { ok: false, motivo: 'sin_snapshot' };
  let ficha;
  try {
    ficha = fichaVacia();
    for (const [campo, valor] of Object.entries({ ...campos, nombre, apellido })) {
      if (valor == null || String(valor).trim() === '') continue;
      ficha = aplicarAccion(ficha, 'actualizar-campo', { campo, valor }, { ahora }).ficha;
    }
  } catch (error) {
    return { ok: false, motivo: 'invalido', mensaje: error?.message || 'Datos inválidos.' };
  }
  try {
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/consultorio_crear_ficha`, {
          method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_ficha: ficha }), signal: controller.signal,
        })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 3000); }),
      ]);
      let data;
      try { data = await response.json(); } catch { return { ok: false, motivo: 'sin_snapshot' }; }
      if (!response.ok) return { ok: false, motivo: 'sin_snapshot' };
      if (Array.isArray(data)) data = data[0];
      return data && typeof data === 'object' ? data : { ok: false, motivo: 'sin_snapshot' };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { ok: false, motivo: 'sin_snapshot' };
  }
}
