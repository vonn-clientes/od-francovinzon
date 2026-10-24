import { aplicarEnSupabase, escrituraPrimariaActiva } from './escrituraPrimaria.js';

export async function actualizarContactoSupabase({ fichaId, campo, valor, env = process.env, fetchImpl = fetch } = {}) {
  if (!fichaId || !escrituraPrimariaActiva(env)) return { intentado: false, resultado: null };
  try {
    const resultado = await aplicarEnSupabase({ id: fichaId, accion: 'actualizar-campo', body: { campo, valor }, env, fetchImpl });
    return { intentado: true, resultado };
  } catch { return { intentado: true, resultado: { ok: false, motivo: 'ambiguo' } }; }
}

// Conserva consolidado Google si no hay ficha vinculada o Supabase no pudo guardar.
// Para IDs sb-* nunca intenta representar la ficha como un Sheet de Google.
export async function guardarContacto({ fichaId, campo, valor, upsertGoogle, env = process.env, fetchImpl = fetch } = {}) {
  const guardado = await actualizarContactoSupabase({ fichaId, campo, valor, env, fetchImpl });
  if (guardado.resultado?.ok) return { ruta: 'supabase', resultado: guardado.resultado };
  if (escrituraPrimariaActiva(env) && String(fichaId || '').startsWith('sb-')) return { ruta: 'rechazada', resultado: guardado.resultado };
  const resultado = await upsertGoogle?.();
  return { ruta: 'google', resultado };
}
