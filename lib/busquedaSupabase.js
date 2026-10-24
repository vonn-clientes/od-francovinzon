import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

async function rpcBusqueda(nombre, parametros, { env = process.env, fetchImpl = fetch } = {}) {
  if (!escrituraPrimariaActiva(env)) return null;
  try {
    const response = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parametros),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data?.pacientes) ? data.pacientes : data ? [data] : [];
    return rows.map((p) => ({
      id: p.ficha_sheet_id ?? p.id_ficha ?? p.id ?? '',
      nombre: p.nombre || '', apellido: p.apellido || '', dni: p.dni || '',
      telefono: p.telefono ?? p.telefono_e164 ?? '', obra_social: p.obra_social ?? p.obraSocial ?? '',
      ficha_json: p.ficha_json && typeof p.ficha_json === 'object' ? p.ficha_json : null,
    }));
  } catch { return null; }
}

export async function buscarPacientesSupabase(q, opciones = {}) {
  return rpcBusqueda('consultorio_buscar_pacientes', { p_q: String(q || ''), p_limite: opciones.limite || 500 }, opciones);
}

export async function listarPacientesSupabase(opciones = {}) {
  return rpcBusqueda('consultorio_listar_pacientes', {}, opciones);
}
