// Mapeo teléfono↔ficha ("¿Es este paciente?") guardado en la configuración de Supabase
// (clave 'mapeosTelefonoFicha': lista de {telefono, dni, decision, fecha}). Es un volumen
// chico (decisiones de Ayelén), por eso no necesita tabla propia.
// Migración perezosa: la primera vez, si la clave no existe, se lee la planilla de Google
// UNA vez (`leerGoogle`), se copia a Supabase y de ahí en adelante Google no se usa.
import { getConfig, setConfig } from './adminConfig.js';

export const CLAVE_MAPEOS = 'mapeosTelefonoFicha';

export async function leerMapeosSupabase({ leerGoogle } = {}) {
  const guardado = await getConfig(CLAVE_MAPEOS, null);
  if (Array.isArray(guardado)) return guardado;
  if (typeof leerGoogle !== 'function') return [];
  let desdeGoogle;
  try { desdeGoogle = await leerGoogle(); } catch { return []; } // no se persiste: se reintenta
  if (!Array.isArray(desdeGoogle)) return [];
  try { await setConfig(CLAVE_MAPEOS, desdeGoogle); } catch { /* se vuelve a intentar en la próxima lectura */ }
  return desdeGoogle;
}

// Upsert por (teléfono, dni): si el par existe, actualiza decisión/fecha.
export async function guardarMapeoSupabase({ telefono, dni, decision }, { leerGoogle, ahora = new Date() } = {}) {
  const lista = [...await leerMapeosSupabase({ leerGoogle })];
  const fecha = ahora.toISOString();
  const i = lista.findIndex((m) => m.telefono === telefono && m.dni === dni);
  if (i === -1) lista.push({ telefono, dni, decision, fecha }); else lista[i] = { ...lista[i], decision, fecha };
  await setConfig(CLAVE_MAPEOS, lista);
  return lista;
}
