// Lecturas del panel /admin desde Supabase (en vez de abrir cada ficha de Google Sheets).
// Misma forma de salida que escanearFichasAdmin() de api/gestion/admin.js, así deuda,
// finanzas, ticket promedio y perfil de pacientes no cambian: solo cambia de dónde leen.
import { nombreArchivo } from './pacientesSheet.js';

function parsearMontoArgentino(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '');
  return parseFloat(limpio.replace(/\./g, '').replace(',', '.')) || 0;
}

export function debeUsarSupabaseAdmin(env = process.env) {
  return env.SUPABASE_READS === '1' && Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

export function filasAEscaneo(filas) {
  const fichas = filas.map((f) => {
    const diasRaw = parseInt(String(f.diasTexto || '').replace(/\D/g, ''), 10) || 0;
    return {
      id: f.id,
      archivo: nombreArchivo({ nombre: f.nombre, apellido: f.apellido, dni: f.dni }),
      fechaNacimiento: f.fechaNacimiento || '',
      localidad: f.localidad || '',
      obraSocial: f.obraSocial || '',
      planTratamiento: f.planTratamiento || '',
      saldo: parsearMontoArgentino(f.saldoTexto || '$0,00'),
      diasSinPago: diasRaw > 3650 ? 0 : diasRaw,
      movimientos: (f.movimientos || []).map((m) => ({
        fecha: m.fecha || '', tratamiento: m.tratamiento || '', debe: m.debe || '', haber: m.haber || '',
        saldo: m.saldo || '', formaPago: m.formaPago || '',
      })),
    };
  });
  return { fichas, total: fichas.length, fallidos: 0, ultimoError: '' };
}

export async function escanearFichasDesdeSupabase({ env = process.env, fetchImpl = fetch } = {}) {
  const base = String(env.SUPABASE_URL).replace(/\/$/, '');
  const r = await fetchImpl(`${base}/rest/v1/rpc/consultorio_admin_escaneo_fichas`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`Supabase respondió ${r.status}`);
  const filas = await r.json();
  if (!Array.isArray(filas) || !filas.length) throw new Error('Supabase devolvió 0 fichas');
  return { ...filasAEscaneo(filas), origen: 'supabase' };
}

// Llamada genérica a una función de Supabase, con límite de tiempo. Devuelve null si no hay
// credenciales/bandera o si falla (quien llama cae al camino viejo, nunca se rompe nada).
export async function rpcAdmin(nombre, cuerpo = {}, { env = process.env, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!debeUsarSupabaseAdmin(env)) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo), signal: controller.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
