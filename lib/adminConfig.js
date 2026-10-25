// Hoja de configuración del panel /admin — se auto-crea la primera vez que hace falta,
// mismo patrón que getOrCreateMapeoSheetId() en api/gestion/pacientes.js. Vive en la
// misma carpeta de Pacientes y usa el mismo cliente OAuth (lib/googleOAuthPacientes.js)
// — no suma una cuenta/credencial nueva.
//
// Tres pestañas:
//   Config       — clave/valor genérico (col A clave, col B valor JSON). Guarda horarios,
//                  textos, listas desplegables y radios: un blob por recurso, no una fila
//                  por dato — alcanza y evita modelar 4 hojas distintas.
//   ActividadLog — feed cronológico simple (fecha, tipo, detalle, actor), append-only.
//   AlertasLog   — espejo de los emails de avisarFallo() (lib/alertas.js), para que
//                  "Monitoreo técnico" en /admin pueda mostrar el detalle sin ir al mail.
//
// IMPORTANTE (ver decisions.md / incidente 2026-08-12): esto se usa desde disponibilidad.js
// y reservar.js, en el camino más transitado de todo el sitio. Por eso getConfig() cachea
// en memoria del proceso (60s) y, ante CUALQUIER error leyendo la hoja, devuelve el default
// sin tirar — un problema en esta hoja nunca puede tumbar la disponibilidad de turnos.
import { getPacientesSheetsClient, getPacientesDriveClient } from './googleOAuthPacientes.js';
import { conReintentos } from './retry.js';
import { PACIENTES_FOLDER_ID } from './pacientesSheet.js';
import { espejarConfig, guardarConfigSupabase, espejarActividad, espejarAlerta } from './espejoConfig.js';
import { rpcAdmin } from './adminSupabase.js';
import { WEEKLY_SCHEDULE, SLOT_MINUTES, SOBRETURNO_MINUTES } from './googleCalendar.js';
import { escrituraPrimariaActiva } from './escrituraPrimaria.js';

export const CONFIG_SHEET_NAME = 'Configuración del panel admin (no tocar)';
const TAB_CONFIG = 'Config';
const TAB_ACTIVIDAD = 'ActividadLog';
const TAB_ALERTAS = 'AlertasLog';

const TTL_MS = 60000;
let cacheSheetId = null;
const cacheValores = {}; // clave -> { valor, ts }

async function getOrCreateConfigSheetId() {
  if (cacheSheetId) return cacheSheetId;

  const drive = getPacientesDriveClient();

  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${CONFIG_SHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) {
    cacheSheetId = data.files[0].id;
    return cacheSheetId;
  }

  const sheets = getPacientesSheetsClient();
  const creada = await conReintentos(() => sheets.spreadsheets.create({
    requestBody: {
      properties: { title: CONFIG_SHEET_NAME },
      sheets: [
        { properties: { title: TAB_CONFIG } },
        { properties: { title: TAB_ACTIVIDAD } },
        { properties: { title: TAB_ALERTAS } },
      ],
    },
    fields: 'spreadsheetId',
  }));
  const id = creada.data.spreadsheetId;
  // Se cachea ACÁ, apenas se creó la hoja — si algo de lo que sigue (headers, mover
  // de carpeta) falla, no se pierde el id. Sin esto, un fallo parcial hacía que la
  // próxima llamada nunca encontrara esta hoja (no queda en PACIENTES_FOLDER_ID hasta
  // el addParents de abajo) y creara OTRA hoja nueva en cada intento — huérfanos
  // acumulándose en "Mi unidad" y ActividadLog/AlertasLog siempre vacíos porque nunca
  // se terminaba de escribir/leer la misma hoja dos veces seguidas.
  cacheSheetId = id;

  try {
    await conReintentos(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${TAB_CONFIG}!A1:C1`, values: [['clave', 'valor', 'actualizado']] },
          { range: `${TAB_ACTIVIDAD}!A1:D1`, values: [['fecha', 'tipo', 'detalle', 'actor']] },
          { range: `${TAB_ALERTAS}!A1:D1`, values: [['fecha', 'endpoint', 'detalle', 'mensaje']] },
        ],
      },
    }));
  } catch (err) {
    console.warn('[adminConfig] no se pudieron escribir los encabezados (no crítico):', err?.message || err);
  }
  try {
    await conReintentos(() => drive.files.update({ fileId: id, addParents: PACIENTES_FOLDER_ID, fields: 'id' }));
  } catch (err) {
    console.warn('[adminConfig] no se pudo mover la hoja a la carpeta de Pacientes (no crítico):', err?.message || err);
  }

  return id;
}

// Lee un valor de configuración con cache de 60s y fallback total ante error — nunca
// tira. `defaultValue` vuelve tal cual si la hoja no existe todavía, la clave no está
// guardada, o cualquier llamada a Sheets falla (transitorio o no).
export async function getConfig(clave, defaultValue) {
  const cacheada = cacheValores[clave];
  if (cacheada && Date.now() - cacheada.ts < TTL_MS) return cacheada.valor;

  // Supabase es la fuente principal. Si la clave está, no se toca Google.
  const rapido = await leerConfigVariasRapido([clave]);
  if (rapido && Object.prototype.hasOwnProperty.call(rapido, clave) && rapido[clave] !== null) {
    cacheValores[clave] = { valor: rapido[clave], ts: Date.now() };
    return rapido[clave];
  }

  // Transición: una clave que todavía no se migró a Supabase se LEE de Google (solo lectura,
  // nunca se crea la planilla) y se copia a Supabase; así 'horarios', 'reservaOnlinePausada',
  // 'listas' y 'radios' no vuelven a su default por no estar migradas. Si Google falla, default.
  // Cuando Supabase tenga todas las claves, esta lectura deja de ejecutarse sola.

  try {
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_CONFIG}!A2:C` }));
    const fila = (data.values || []).find((r) => r[0] === clave);
    const valor = fila && fila[1] != null ? JSON.parse(fila[1]) : defaultValue;
    // Migración perezosa: lo que solo existía en Google se copia a Supabase una vez.
    if (rapido && fila && fila[1] != null) await espejarConfig(clave, valor, { actualizado: fila[2] });
    cacheValores[clave] = { valor, ts: Date.now() };
    return valor;
  } catch (err) {
    console.warn(`[adminConfig] no se pudo leer "${clave}", uso default:`, err?.message || err);
    return defaultValue;
  }
}

export async function setConfig(clave, valor) {
  // Supabase primero: si guarda bien, Google ya no participa.
  const ahora = new Date().toISOString();
  if (await guardarConfigSupabase(clave, valor, ahora)) {
    cacheValores[clave] = { valor, ts: Date.now() };
    return;
  }
  if (escrituraPrimariaActiva()) throw new Error('No se pudo guardar configuración en Supabase');
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_CONFIG}!A2:C` }));
  const filas = data.values || [];
  const idx = filas.findIndex((r) => r[0] === clave);
  const fila = [clave, JSON.stringify(valor), new Date().toISOString()];

  if (idx === -1) {
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_CONFIG}!A:C`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    }));
  } else {
    const filaSheet = idx + 2;
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${TAB_CONFIG}!A${filaSheet}:C${filaSheet}`,
      valueInputOption: 'RAW',
      requestBody: { values: [fila] },
    }));
  }
  cacheValores[clave] = { valor, ts: Date.now() };
  await espejarConfig(clave, valor, { actualizado: fila[2] });
}

// Fire-and-forget: nunca tira, nunca bloquea a quien la llama. Se usa desde endpoints
// públicos y protegidos por igual (login, altas/bajas/cambios de turno).
export async function logActividad({ tipo, detalle = '', actor = '' }) {
  try {
    const fechaLog = new Date().toISOString();
    if (escrituraPrimariaActiva()) {
      await espejarActividad({ fecha: fechaLog, tipo, detalle, actor });
      return;
    }
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_ACTIVIDAD}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[fechaLog, tipo, detalle, actor]] },
    }));
    await espejarActividad({ fecha: fechaLog, tipo, detalle, actor });
  } catch (err) {
    console.warn('[adminConfig] no se pudo registrar actividad:', err?.message || err);
  }
}

// Idem, llamada desde avisarFallo() (lib/alertas.js) además del mail.
export async function logAlerta({ endpoint, detalle = '', mensaje = '' }) {
  try {
    const fechaLog = new Date().toISOString();
    if (escrituraPrimariaActiva()) {
      await espejarAlerta({ fecha: fechaLog, endpoint, detalle, mensaje: String(mensaje).slice(0, 500) });
      return;
    }
    const id = await getOrCreateConfigSheetId();
    const sheets = getPacientesSheetsClient();
    await conReintentos(() => sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: `${TAB_ALERTAS}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[fechaLog, endpoint, detalle, String(mensaje).slice(0, 500)]] },
    }));
    await espejarAlerta({ fecha: fechaLog, endpoint, detalle, mensaje: String(mensaje).slice(0, 500) });
  } catch (err) {
    console.warn('[adminConfig] no se pudo registrar alerta:', err?.message || err);
  }
}

// Único punto de lectura de horarios para todos los endpoints que calculan
// disponibilidad o crean turnos — default = lo de siempre (WEEKLY_SCHEDULE/
// SLOT_MINUTES/SOBRETURNO_MINUTES de lib/googleCalendar.js) si nunca se guardó nada
// desde /admin, o si la hoja de Config falla por lo que sea (ver getConfig).
export async function obtenerHorariosConfig() {
  const defaults = { schedule: WEEKLY_SCHEDULE, slotMinutes: SLOT_MINUTES, sobreturnoMinutes: SOBRETURNO_MINUTES };
  const guardado = await getConfig('horarios', null);
  if (!guardado) return defaults;
  return {
    schedule: guardado.schedule || defaults.schedule,
    slotMinutes: Number(guardado.slotMinutes) || defaults.slotMinutes,
    sobreturnoMinutes: Number(guardado.sobreturnoMinutes) || defaults.sobreturnoMinutes,
  };
}

// Interruptor de reserva online (ver el pedido, 2026-08-14) — default = pausada
// (true) desde el arranque, tanto si nunca se guardó nada como si getConfig falla por
// lo que sea (ver el comentario de arriba sobre CUALQUIER error): más seguro pausado
// por defecto que mostrar un flujo de reserva roto. Compartido por api/gestion/admin.js
// (lee/escribe con ADMIN_KEY) y api/disponibilidad.js (lo expone sin clave, ver
// ?modo=estado, para que /turnos y la home puedan leerlo siendo páginas públicas).
export async function obtenerReservaOnlinePausada() {
  return getConfig('reservaOnlinePausada', true);
}

// Lecturas rápidas desde Supabase (copia espejada): una sola llamada en vez de abrir la hoja
// de Google. Devuelve null si no está disponible → quien llama usa Sheets como antes.
export async function leerConfigVariasRapido(claves) {
  const r = await rpcAdmin('consultorio_config_leer_varias', { p_claves: claves });
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
}

export async function leerActividadReciente(limite = 100) {
  const rapida = await rpcAdmin('consultorio_actividad_recientes', { p_limite: limite });
  if (Array.isArray(rapida)) return rapida;
  if (escrituraPrimariaActiva()) return [];
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_ACTIVIDAD}!A2:D` }));
  return (data.values || [])
    .filter((r) => r[0])
    .map((r) => ({ fecha: r[0], tipo: r[1] || '', detalle: r[2] || '', actor: r[3] || '' }))
    .slice(-limite)
    .reverse();
}

export async function leerAlertasRecientes(limite = 50) {
  const rapida = await rpcAdmin('consultorio_alertas_recientes', { p_limite: limite });
  if (Array.isArray(rapida)) return rapida;
  if (escrituraPrimariaActiva()) return [];
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${TAB_ALERTAS}!A2:D` }));
  return (data.values || [])
    .filter((r) => r[0])
    .map((r) => ({ fecha: r[0], endpoint: r[1] || '', detalle: r[2] || '', mensaje: r[3] || '' }))
    .slice(-limite)
    .reverse();
}

// Para el backfill a Supabase (modo=sync-config en api/gestion/pacientes.js): devuelve
// TODO el contenido de las tres pestañas, sin tocar nada.
export async function leerTodoParaEspejo() {
  const id = await getOrCreateConfigSheetId();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: id,
    ranges: [`${TAB_CONFIG}!A2:C`, `${TAB_ACTIVIDAD}!A2:D`, `${TAB_ALERTAS}!A2:D`],
  }));
  const [c, a, l] = (data.valueRanges || []).map((r) => r.values || []);
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  return {
    configs: (c || []).filter((r) => r[0]).map((r) => ({ clave: r[0], valor: parse(r[1]), actualizado: r[2] || new Date().toISOString() })),
    actividad: (a || []).filter((r) => r[0]).map((r) => ({ fecha: r[0], tipo: r[1] || '', detalle: r[2] || '', actor: r[3] || '' })),
    alertas: (l || []).filter((r) => r[0]).map((r) => ({ fecha: r[0], endpoint: r[1] || '', detalle: r[2] || '', mensaje: r[3] || '' })),
  };
}
