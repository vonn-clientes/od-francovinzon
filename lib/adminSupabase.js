// Lecturas del panel /admin desde Supabase (en vez de abrir cada ficha de Google Sheets).
// Misma forma de salida que escanearFichasAdmin() de api/gestion/admin.js, así deuda,
// finanzas, ticket promedio y perfil de pacientes no cambian: solo cambia de dónde leen.
import { nombreArchivo } from './pacientesSheet.js';

function parsearMontoArgentino(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '');
  return parseFloat(limpio.replace(/\./g, '').replace(',', '.')) || 0;
}

export function debeUsarSupabaseAdmin(env = process.env) {
  return (env.SUPABASE_READS === '1' || env.SUPABASE_WRITES_PRIMARY === '1') && Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

export function filasAEscaneo(filas) {
  const fichas = filas.map((f) => {
    const ficha = f.ficha_json && typeof f.ficha_json === 'object' ? f.ficha_json : f;
    const campos = ficha.campos || {};
    const financiero = ficha.financiero || {};
    const movimientos = Array.isArray(ficha.movimientos) ? ficha.movimientos : (f.movimientos || []);
    const nombre = campos.nombre ?? f.nombre ?? '';
    const apellido = campos.apellido ?? f.apellido ?? '';
    const dni = campos.dni ?? f.dni ?? '';
    const saldoTexto = financiero.saldo ?? f.saldoTexto ?? f.saldo ?? '$0,00';
    const diasTexto = financiero.diasSinPagoTexto ?? f.diasTexto ?? '';
    const diasRaw = parseInt(String(diasTexto).replace(/\D/g, ''), 10) || 0;
    return {
      id: f.id,
      archivo: nombreArchivo({ nombre, apellido, dni }),
      fechaNacimiento: campos.fechaNacimiento ?? f.fechaNacimiento ?? '',
      localidad: campos.localidad ?? f.localidad ?? '',
      obraSocial: campos.obraSocial ?? f.obraSocial ?? '',
      planTratamiento: campos.planTratamiento ?? f.planTratamiento ?? '',
      saldo: parsearMontoArgentino(saldoTexto),
      diasSinPago: diasRaw > 3650 ? 0 : diasRaw,
      movimientos: movimientos.map((m) => ({
        fecha: m.fecha || '', tratamiento: m.tratamiento || '', debe: m.debe || '', haber: m.haber || '',
        saldo: m.saldo || '', formaPago: m.formaPago || '',
        monedaDebe: m.monedaDebe || '', monedaHaber: m.monedaHaber || '', aplicaA: m.aplicaA || '', cotizacion: m.cotizacion || '',
      })),
    };
  });
  return { fichas, total: fichas.length, fallidos: 0, ultimoError: '' };
}

export async function escanearFichasDesdeSupabase({ env = process.env, fetchImpl = fetch } = {}) {
  const filas = await rpcAdmin('consultorio_admin_pacientes_fichas', {}, { env, fetchImpl, timeoutMs: 3000 });
  if (!Array.isArray(filas) || !filas.length) return null;
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
