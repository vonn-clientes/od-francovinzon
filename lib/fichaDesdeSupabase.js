import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

// La lectura es best-effort: si Supabase no tiene la ficha, el llamador puede usar Google.
export async function leerFichaSupabase(id, { env = process.env, fetchImpl = fetch } = {}) {
  if (!id || !escrituraPrimariaActiva(env)) return null;
  try {
    const r = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/consultorio_leer_ficha`, {
      method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: id }),
    });
    if (!r.ok) return null;
    const row = await r.json();
    const ficha = Array.isArray(row) ? row[0]?.ficha ?? row[0]?.ficha_json : row?.ficha ?? row?.ficha_json;
    return ficha && typeof ficha === 'object' && !Array.isArray(ficha) ? ficha : null;
  } catch { return null; }
}

// "d/m/aaaa" (formato de la ficha) -> "aaaa-mm-dd"
const aISO = (f) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(f || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(f || '').slice(0, 10); };

// Movimientos de la ficha (la ficha de Supabase es la fuente: no hay otra tabla que consultar).
// Con fechaISO devuelve solo los de ese día. null = no se pudo leer (usar Google).
export async function leerMovimientosSupabase(id, fechaISO, opciones = {}) {
  const ficha = await leerFichaSupabase(id, opciones);
  if (!ficha) return null;
  const movs = Array.isArray(ficha.movimientos) ? ficha.movimientos : [];
  return fechaISO ? movs.filter((m) => aISO(m.fecha) === fechaISO) : movs;
}
