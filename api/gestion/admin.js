// Panel /admin — TODAS las secciones en un solo archivo a propósito, mismo motivo que
// api/gestion/pacientes.js: no pasarse del límite de 12 funciones serverless del plan
// Hobby (ver CLAUDE.md). Lecturas por GET con `recurso` (+ `modo` cuando hace falta),
// escrituras por POST con `recurso` + `accion`. Clave propia: ADMIN_KEY
// (lib/adminAuth.js), nunca GESTION_KEY — Ayelen no tiene acceso acá.
import zlib from 'node:zlib';
import { isValidAdminKey } from '../../lib/adminAuth.js';
import { isValidGestionKey } from '../../lib/googleCalendar.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, TIME_ZONE, WEEKLY_SCHEDULE,
  SLOT_MINUTES, pad2, toArgDate, eventBounds, formatArgDay, formatArgTime, extraerTelefono, extraerConfirmado,
  extraerEsNuevoPaciente, extraerMotivo, getHorariosLibresDia, extraerDni,
} from '../../lib/googleCalendar.js';
import { getPacientesDriveClient, getPacientesSheetsClient } from '../../lib/googleOAuthPacientes.js';
import {
  PACIENTES_FOLDER_ID, FICHA_TEMPLATE_ID, SHEET_NAME, parsearNombreArchivo, rangoMovimientos, rangoPrestacionesObraSocial,
} from '../../lib/pacientesSheet.js';
import { avisarFallo } from '../../lib/alertas.js';
import { espejarTurnosBestEffort } from '../../lib/espejoTurnos.js';
import { conReintentos } from '../../lib/retry.js';
import { debeUsarSupabaseAdmin, escanearFichasDesdeSupabase, rpcAdmin } from '../../lib/adminSupabase.js';
import { calcularCuentas } from '../../lib/cuentaSaldo.js';
import {
  getConfig, setConfig, obtenerHorariosConfig, obtenerReservaOnlinePausada, logActividad,
  leerActividadReciente, leerAlertasRecientes, leerConfigVariasRapido,
} from '../../lib/adminConfig.js';
import { listarPacientesConsolidados, upsertPacienteConsolidado, asignarFilaAFicha, asignarCoincidenciasExactas, sugerenciasPorNombre, candidatasParaFicha, desasignarFila } from '../../lib/pacientesConsolidados.js';
import { normalizarTelefonoMapeo, normalizarDni } from '../../lib/pacientesSheet.js';
import { construirPerfil, perfilACsv } from '../../lib/perfilPacientes.js';
import { armarHojas, crearXlsx, crearMarkdown } from '../../lib/exportPacientesCompleto.js';
import { escrituraPrimariaActiva } from '../../lib/escrituraPrimaria.js';
import { leerFichaSupabase, leerMovimientosSupabase } from '../../lib/fichaDesdeSupabase.js';

// Config de solo-lectura que también necesita /pacientes y /gestion (listas
// desplegables, radios, plantilla de WhatsApp) — no son datos sensibles, así que
// además de ADMIN_KEY aceptan GESTION_KEY para leerlos (nunca para escribirlos: los
// POST de estos recursos siguen exigiendo ADMIN_KEY más abajo, ver `recurso` en POST).
const RECURSOS_LECTURA_COMPARTIDA = new Set(['listas', 'radios', 'textos']);

async function conError(fn, req, res) {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: req.query?.recurso || '', error: err });
    if (!res.headersSent) res.status(200).json({ success: false, error: err?.message || String(err) });
  }
}

export default async function handler(req, res) {
  try {
    const key = req.method === 'GET' ? req.query.key : req.body.key;
    const recurso = req.method === 'GET' ? req.query.recurso : req.body.recurso;

    // Actualización diaria de métricas (cron de Vercel, 2:00 AM Argentina, ver vercel.json):
    // se autentica con CRON_SECRET (header Authorization) o, a mano, con ADMIN_KEY.
    if (req.method === 'GET' && recurso === 'metricas-cron') {
      const secreto = process.env.CRON_SECRET;
      const viaCron = !!secreto && (req.headers.authorization || '') === `Bearer ${secreto}`;
      if (!viaCron && !isValidAdminKey(key)) return res.status(401).json({ success: false, error: 'unauthorized' });
      return await conError((rq, rs) => metricasCron(rq, rs, viaCron), req, res);
    }

    // login-log: registro de actividad ("quién entró a /gestion" del pedido, sección 7)
    // — cualquiera de las dos claves puede escribir ahí, no expone ni cambia nada.
    const esLoginLog = req.method === 'POST' && recurso === 'login-log';
    const autorizado = (req.method === 'GET' && RECURSOS_LECTURA_COMPARTIDA.has(recurso)) || esLoginLog
      ? isValidAdminKey(key) || isValidGestionKey(key)
      : isValidAdminKey(key);
    if (!autorizado) return res.status(401).json({ success: false, error: 'unauthorized' });

    if (esLoginLog) {
      await logActividad({ tipo: 'login', detalle: req.body.panel || '', actor: isValidAdminKey(key) ? 'admin' : 'gestión (Ayelen)' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'GET') {
      if (recurso === 'horarios') return await getHorarios(req, res);
      if (recurso === 'reserva-online') return await getReservaOnline(req, res);
      if (recurso === 'textos') return await getTextos(req, res);
      if (recurso === 'listas') return await getListas(req, res);
      if (recurso === 'radios') return await getRadios(req, res);
      if (recurso === 'actividad') return await getActividad(req, res);
      if (recurso === 'monitoreo') return await getMonitoreo(req, res);
      if (recurso === 'metricas') return await servirMetricas('basicas', getMetricas, req, res);
      if (recurso === 'deuda') return await conError(getMetricasDeuda, req, res);
      if (recurso === 'metricas-avanzadas') return await servirMetricas('avanzadas', getMetricasAvanzadas, req, res);
      if (recurso === 'publico-objetivo') return await servirMetricas('perfil', calcularPerfilJson, req, res);
      if (recurso === 'pacientes-totales') return await conError(getPacientesTotales, req, res);
      // Los export-* devuelven un archivo (PDF/CSV), no JSON — si algo dentro tira,
      // el catch de más abajo los mandaría igual por el camino genérico de
      // "Error inesperado." sin ninguna pista. Acá sí se envuelve cada uno para
      // devolver el mensaje real (encontrado en producción, 2026-08-13: un fallo en
      // exportFichaPdf era indistinguible de cualquier otro error del panel).
      if (recurso === 'export-financiero') return await conError(exportFinancieroPdf, req, res);
      if (recurso === 'export-ficha') return await conError(exportFichaPdf, req, res);
      if (recurso === 'export-pacientes-csv') return await conError(exportPacientesCsv, req, res);
      if (recurso === 'export-turnos') return await conError(exportTurnos, req, res);
      if (recurso === 'export-perfil-anonimo') return await conError(exportPerfilPacientes, req, res);
      if (recurso === 'export-pacientes-completo') return await conError(exportPacientesCompleto, req, res);
      if (recurso === 'sin-ficha') return await conError(getSinFicha, req, res);
      if (recurso === 'seguimiento') return await conError(getSeguimiento, req, res);
      return res.status(400).json({ success: false, error: 'recurso inválido' });
    }

    if (req.method === 'POST') {
      if (recurso === 'horarios') return await postHorarios(req, res);
      if (recurso === 'reserva-online') return await postReservaOnline(req, res);
      if (recurso === 'textos') return await postTextos(req, res);
      if (recurso === 'listas') return await postListas(req, res);
      if (recurso === 'radios') return await postRadios(req, res);
      if (recurso === 'accesos') return await postAccesos(req, res);
      if (recurso === 'asignar-ficha') return await postAsignarFicha(req, res);
      if (recurso === 'desasignar-ficha') return await postDesasignarFicha(req, res);
      return res.status(400).json({ success: false, error: 'recurso inválido' });
    }

    res.status(405).json({ success: false, error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: `${req.method} ${req.query?.recurso || req.body?.recurso || ''}`, error: err });
    res.status(500).json({ success: false, error: 'Error inesperado.' });
  }
}

// ---------- 1. Horarios y agenda ----------

async function getHorarios(req, res) {
  const config = await obtenerHorariosConfig();
  const calendar = getCalendarClient();

  const desde = toArgDate(formatArgDay(new Date()), '00:00');
  const hasta = new Date(desde.getTime() + 120 * 24 * 60 * 60000);
  const { data } = await conReintentos(() => calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: true,
    q: BLOCK_MARKER,
  }));
  const bloqueos = (data.items || [])
    .filter((ev) => (ev.description || '').includes(BLOCK_MARKER))
    .map((ev) => {
      const { start, end } = eventBounds(ev);
      const diaCompleto = !ev.start.dateTime;
      return {
        id: ev.id,
        motivo: ev.summary || '',
        diaCompleto,
        fecha: formatArgDay(start),
        horaInicio: diaCompleto ? null : formatArgTime(start),
        horaFin: diaCompleto ? null : formatArgTime(end),
      };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  res.status(200).json({ ...config, bloqueos });
}

async function postHorarios(req, res) {
  const { accion } = req.body;
  const calendar = getCalendarClient();

  if (accion === 'guardar') {
    const { schedule, slotMinutes, sobreturnoMinutes } = req.body;
    if (!schedule || !slotMinutes || !sobreturnoMinutes) {
      return res.status(400).json({ success: false, message: 'Faltan datos del horario.' });
    }
    await setConfig('horarios', { schedule, slotMinutes: Number(slotMinutes), sobreturnoMinutes: Number(sobreturnoMinutes) });
    await logActividad({ tipo: 'config_horarios', detalle: 'Horarios/duración de turnos actualizados', actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'bloquear-dia') {
    const { date, motivo } = req.body;
    await conReintentos(() => calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { date },
        end: { date: nextDayStr(date) },
      },
    }));
    await espejarTurnosBestEffort();
    await logActividad({ tipo: 'dia_bloqueado', detalle: `${date}${motivo ? ` — ${motivo}` : ''}`, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'bloquear-horario') {
    const { date, horaInicio, horaFin, motivo } = req.body;
    const start = toArgDate(date, horaInicio);
    const end = toArgDate(date, horaFin);
    if (!(end > start)) return res.status(200).json({ success: false, message: 'La hora de fin tiene que ser posterior a la de inicio.' });
    await conReintentos(() => calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: motivo ? `No atiende - ${motivo}` : 'No atiende',
        description: BLOCK_MARKER,
        start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      },
    }));
    await espejarTurnosBestEffort();
    await logActividad({ tipo: 'horario_bloqueado', detalle: `${date} ${horaInicio}-${horaFin}${motivo ? ` — ${motivo}` : ''}`, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  if (accion === 'desbloquear') {
    const { eventId } = req.body;
    await conReintentos(() => calendar.events.delete({ calendarId: CALENDAR_ID, eventId }));
    await espejarTurnosBestEffort();
    await logActividad({ tipo: 'bloqueo_eliminado', detalle: eventId, actor: 'admin' });
    return res.status(200).json({ success: true });
  }

  res.status(400).json({ success: false, message: 'Acción inválida.' });
}

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// ---------- 1.5 Interruptor de reserva online ----------
// Default = pausada desde el arranque (obtenerReservaOnlinePausada, lib/adminConfig.js)
// — no es una demo, es la configuración real desde el día uno. Mientras esté pausada,
// /turnos y la home dejan de mostrar el flujo de reserva online y muestran un cartel de
// WhatsApp en su lugar (ver api/disponibilidad.js?modo=estado, que es de donde esas
// páginas públicas leen este mismo valor sin necesitar ninguna clave). /gestion no se
// ve afectado: Ayelen y Franco siguen cargando turnos a mano sin restricción nueva.
async function getReservaOnline(req, res) {
  const pausada = await obtenerReservaOnlinePausada();
  res.status(200).json({ pausada });
}

async function postReservaOnline(req, res) {
  const { pausada } = req.body;
  await setConfig('reservaOnlinePausada', !!pausada);
  await logActividad({ tipo: 'config_reserva_online', detalle: pausada ? 'Reserva online pausada' : 'Reserva online activada', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 2. Textos y plantillas ----------

const TEXTOS_DEFAULT = {
  // Placeholders: {{saludo}} {{nombre}} {{cuando}} {{hora}} {{tipo}} {{link}}
  // {{link}} = link que confirma el turno al abrirlo (2026-10-23). Si un turno no tiene
  // código, /gestion saca la línea del link y pide responder por el chat.
  whatsappTemplate:
    '¡Hola, {{saludo}}!!! Te quería recordar el siguiente {{tipo}}:\n\n{{nombre}}\n{{cuando}} a las {{hora}}hs\n\n' +
    'Tocá este link para confirmar que vas a venir:\n{{link}}\n\nSi no podés venir, avisanos por acá. Te esperamos.',
  direccion: 'Ameghino 410, E3260 Concepción del Uruguay, Entre Ríos, Argentina',
  bienvenidaNuevoPaciente: '¡Bienvenido/a! Te esperamos con gusto en tu primera visita.',
};

async function getTextos(req, res) {
  const textos = await getConfig('textos', TEXTOS_DEFAULT);
  res.status(200).json(textos);
}

async function postTextos(req, res) {
  const { whatsappTemplate, direccion, bienvenidaNuevoPaciente, mensajeDeuda, mensajeReactivar } = req.body;
  const actual = await getConfig('textos', TEXTOS_DEFAULT);
  await setConfig('textos', {
    whatsappTemplate: whatsappTemplate ?? actual.whatsappTemplate,
    direccion: direccion ?? actual.direccion,
    bienvenidaNuevoPaciente: bienvenidaNuevoPaciente ?? actual.bienvenidaNuevoPaciente,
    mensajeDeuda: mensajeDeuda ?? actual.mensajeDeuda,
    mensajeReactivar: mensajeReactivar ?? actual.mensajeReactivar,
  });
  await logActividad({ tipo: 'config_textos', detalle: 'Textos/plantilla de WhatsApp actualizados', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 3. Listas desplegables ----------

const LISTAS_DEFAULT = {
  obrasSociales: ['Particular', 'Ospe', 'Oser', 'Iosper', 'Sancor Salud', 'Sancor Salud (IVA gravado)', 'Sancor Salud (IVA no gravado)', 'Pami', 'Unión Personal', 'Osseg', 'Dasuten', 'Medicus', 'Jerárquicos Salud', 'Ospia', 'Municipal', 'Osalara', 'Ospim', 'Osecac', 'Osuner', 'Osde', 'Poder Judicial', 'Unimédica', 'Osfatlyf', 'Swiss Medical', 'Amebpba', 'Federada Salud', 'Iosfa', 'Osplad'],
  planes: ['Particular'],
  tratamientos: [
    'Escaneo 3D', 'Ortodoncia', 'Blanqueamiento dental', 'Odontopediatría',
    'Endodoncia mecanizada', 'Reconstrucciones estéticas', 'Carillas dentales',
    'Implantes', 'Limpieza dental', 'Urgencias',
  ],
};

async function getListas(req, res) {
  const listas = await getConfig('listas', LISTAS_DEFAULT);
  res.status(200).json(listas);
}

async function postListas(req, res) {
  const { obrasSociales, planes, tratamientos } = req.body;
  const actual = await getConfig('listas', LISTAS_DEFAULT);
  await setConfig('listas', {
    obrasSociales: Array.isArray(obrasSociales) ? obrasSociales : actual.obrasSociales,
    planes: Array.isArray(planes) ? planes : actual.planes,
    tratamientos: Array.isArray(tratamientos) ? tratamientos : actual.tratamientos,
  });
  await logActividad({ tipo: 'config_listas', detalle: 'Listas desplegables actualizadas', actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 4. Radios ----------

const RADIOS_DEFAULT = {
  estaciones: [
    { nombre: 'Radio Mitre', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/AM790_56AAC.aac' },
    { nombre: 'La 100', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/FM999_56.mp3' },
    { nombre: 'Aspen', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ASPENAAC.aac' },
    { nombre: 'Radio Rivadavia', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RIVADAVIA.mp3' },
    { nombre: 'Jazz 24hs — Blackie FM', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/BLACKIE_89_1.mp3' },
  ],
};

async function getRadios(req, res) {
  const radios = await getConfig('radios', RADIOS_DEFAULT);
  res.status(200).json(radios);
}

async function postRadios(req, res) {
  const { estaciones } = req.body;
  if (!Array.isArray(estaciones)) return res.status(400).json({ success: false, message: 'Lista de estaciones inválida.' });
  await setConfig('radios', { estaciones });
  await logActividad({ tipo: 'config_radios', detalle: `${estaciones.length} estaciones`, actor: 'admin' });
  res.status(200).json({ success: true });
}

// ---------- 6. Accesos: rotar GESTION_KEY vía API de Vercel ----------
// Requiere VERCEL_API_TOKEN (Vercel → Account Settings → Tokens, scope del proyecto),
// nueva variable de entorno que hay que agregar a mano UNA vez — no hay forma de que
// el propio sitio se la genere sola. process.env.VERCEL_PROJECT_ID lo agrega Vercel
// automáticamente a todo deployment, no hace falta configurarlo.
async function postAccesos(req, res) {
  const { accion, nuevaClave } = req.body;
  if (accion !== 'rotar-gestion-key') return res.status(400).json({ success: false, message: 'Acción inválida.' });
  if (!nuevaClave || nuevaClave.trim().length < 6) {
    return res.status(200).json({ success: false, message: 'La nueva clave tiene que tener al menos 6 caracteres.' });
  }

  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return res.status(200).json({
      success: false,
      message: 'Falta configurar VERCEL_API_TOKEN en Vercel (Account Settings → Tokens) para poder cambiar la clave desde acá. Mientras tanto, cambiala a mano en Vercel → Settings → Environment Variables → GESTION_KEY.',
    });
  }

  try {
    const listResp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = await listResp.json();
    if (!listResp.ok) throw new Error(listData?.error?.message || 'No se pudo leer las variables de entorno.');

    const existentes = (listData.envs || []).filter((e) => e.key === 'GESTION_KEY');
    if (!existentes.length) {
      return res.status(200).json({ success: false, message: 'No se encontró GESTION_KEY en Vercel. Creala primero a mano una vez.' });
    }

    for (const env of existentes) {
      const updResp = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env/${env.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: nuevaClave.trim() }),
      });
      if (!updResp.ok) {
        const updData = await updResp.json().catch(() => ({}));
        throw new Error(updData?.error?.message || 'No se pudo actualizar GESTION_KEY.');
      }
    }

    await logActividad({ tipo: 'clave_gestion_rotada', detalle: 'GESTION_KEY cambiada desde /admin', actor: 'admin' });

    const redeploy = await intentarRedeploy(token, projectId);

    res.status(200).json({
      success: true,
      message: redeploy.ok
        ? 'Clave actualizada. Se disparó un redeploy — en 1-2 minutos ya queda en producción.'
        : `Clave actualizada en Vercel, pero no se pudo disparar el redeploy automático (${redeploy.error}). Entrá a Vercel → Deployments y tocá "Redeploy" en el último deploy de producción para que tome efecto.`,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: 'rotar-gestion-key', error: err });
    res.status(200).json({ success: false, message: `No se pudo cambiar la clave: ${err.message}` });
  }
}

// Un cambio de env var por API no se aplica solo — Vercel necesita un deploy nuevo
// (mismo criterio que un cambio a mano en el dashboard). Se busca el último
// deployment READY de producción y se vuelve a desplegar tal cual (mismo código,
// variables de entorno ya actualizadas). Nunca hace fallar la respuesta principal —
// la clave YA quedó cambiada en Vercel aunque esto falle, ver postAccesos().
async function intentarRedeploy(token, projectId) {
  try {
    const listResp = await fetch(
      `https://api.vercel.com/v7/deployments?projectId=${projectId}&target=production&state=READY&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listResp.json();
    if (!listResp.ok) throw new Error(listData?.error?.message || 'No se pudo buscar el último deploy.');
    const ultimo = (listData.deployments || [])[0];
    if (!ultimo) throw new Error('No se encontró ningún deploy de producción.');

    const redeployResp = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ultimo.name, project: projectId, deploymentId: ultimo.uid, target: 'production' }),
    });
    const redeployData = await redeployResp.json();
    if (!redeployResp.ok) throw new Error(redeployData?.error?.message || 'No se pudo disparar el redeploy.');

    return { ok: true };
  } catch (err) {
    console.warn('[admin.js] no se pudo redesplegar automáticamente:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------- 7. Registro de actividad ----------

async function getActividad(req, res) {
  try {
    const eventos = await leerActividadReciente(200);
    res.status(200).json({ eventos });
  } catch (err) {
    console.error(err);
    res.status(200).json({ eventos: [], error: err?.message || String(err) });
  }
}

// ---------- 8. Monitoreo técnico ----------

async function getMonitoreo(req, res) {
  const resultados = {};

  try {
    const calendar = getCalendarClient();
    await getHorariosLibresDia(calendar, formatArgDay(new Date()));
    resultados.calendar = 'ok';
  } catch (err) {
    resultados.calendar = 'error';
    resultados.calendarError = err?.message || String(err);
  }

  try {
    if (escrituraPrimariaActiva(process.env)) {
      const estado = await rpcAdmin('consultorio_monitoreo', {}, { timeoutMs: 4000 });
      if (!estado) throw new Error('No se pudo consultar el estado de Supabase');
      resultados.pacientes = 'ok';
      resultados.supabase = { fichas: estado.fichas, fichasConJson: estado.fichas_con_json, movimientos: estado.movimientos, ultimaSincronizacion: estado.ultima_sincronizacion, pendientesDeEspejo: estado.outbox_pendiente };
    } else {
    const drive = getPacientesDriveClient();
    await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    }));
    resultados.pacientes = 'ok';
    }
  } catch (err) {
    resultados.pacientes = 'error';
    resultados.pacientesError = err?.message || String(err);
  }

  resultados.resendConfigurado = !!process.env.RESEND_API_KEY;
  try {
    resultados.alertasRecientes = await leerAlertasRecientes(15);
  } catch (err) {
    resultados.alertasRecientes = [];
    resultados.alertasError = err?.message || String(err);
  }
  resultados.ok = resultados.calendar === 'ok' && resultados.pacientes === 'ok';

  res.status(200).json(resultados);
}

// ---------- 9.0 Snapshot diario de métricas ----------
// Las métricas se precalculan una vez por día (cron de las 2:00 AM Argentina) y se
// guardan en la hoja de configuración del panel. Al abrir el dashboard se sirve ese
// último snapshot al instante; el botón "Actualizar" (forzar=1) recalcula en vivo y
// además refresca el snapshot. Una celda de Sheets admite 50.000 caracteres, así que el
// JSON se comprime (gzip + base64) y se parte en tramos de 40.000.
const TRAMO_SNAPSHOT = 40000;

async function guardarSnapshot(nombre, data) {
  const comprimido = zlib.gzipSync(JSON.stringify({ generadoEn: new Date().toISOString(), data })).toString('base64');
  const tramos = [];
  for (let i = 0; i < comprimido.length; i += TRAMO_SNAPSHOT) tramos.push(comprimido.slice(i, i + TRAMO_SNAPSHOT));
  for (let i = 0; i < tramos.length; i++) await setConfig(`snap-${nombre}-${i}`, tramos[i]);
  await setConfig(`snap-${nombre}-n`, tramos.length); // al final: recién ahí el snapshot nuevo "cuenta"
}

async function leerSnapshot(nombre) {
  // Rápido: el snapshot está espejado en Supabase (todos los tramos en una sola llamada).
  const nRapido = await leerConfigVariasRapido([`snap-${nombre}-n`]);
  if (nRapido && Number(nRapido[`snap-${nombre}-n`]) > 0) {
    const cantidad = Number(nRapido[`snap-${nombre}-n`]);
    const claves = Array.from({ length: cantidad }, (_, i) => `snap-${nombre}-${i}`);
    const tramos = await leerConfigVariasRapido(claves);
    if (tramos && claves.every((c) => typeof tramos[c] === 'string')) {
      try {
        const { generadoEn, data } = JSON.parse(zlib.gunzipSync(Buffer.from(claves.map((c) => tramos[c]).join(''), 'base64')).toString());
        if (data) return { data, generadoEn };
      } catch { /* snapshot ilegible en Supabase: se lee de Sheets */ }
    }
  }
  const n = await getConfig(`snap-${nombre}-n`, 0);
  if (!n) return null;
  let comprimido = '';
  for (let i = 0; i < n; i++) {
    const tramo = await getConfig(`snap-${nombre}-${i}`, null);
    if (tramo == null) return null;
    comprimido += tramo;
  }
  return JSON.parse(zlib.gunzipSync(Buffer.from(comprimido, 'base64')).toString('utf8'));
}

function snapshotCompleto(nombre, data) {
  if (nombre === 'avanzadas') {
    if (data?.fichasFallidas == null) return false;
    if (!Number.isFinite(Number(data?.fichasFallidas))) return false;
    if (Number(data?.fichasFallidas) > 0) return false;
    if (data?.totalFichasEscaneadas == null) return false;
    if (!Number.isFinite(Number(data?.totalFichasEscaneadas))) return false;
    if (data?.pacientesTotales?.total == null) return false;
    if (!data?.deuda || data.deuda.success === false) return false;
    if (!data?.publico || !snapshotCompleto('perfil', data.publico)) return false;
  }
  if (nombre === 'perfil') {
    const fallidas = (data?.filas || []).find((f) => f[0] === 'Resumen' && f[1] === 'Fichas que no se pudieron leer');
    if (Number(fallidas?.[3]) > 0 || (data?.filas || []).some((f) => f[0] === 'Resumen' && String(f[1]).startsWith('Aviso:'))) return false;
  }
  return data?.success !== false && !data?.errores?.length;
}

function limpiarMetricasParaPanel(nombre, data) {
  if (nombre !== 'avanzadas') return data;
  const limpio = { ...data, pacientesTotales: resumirPacientesTotales(data?.pacientesTotales) };
  delete limpio.fichasIdentidad;
  return limpio;
}

// Corre un handler existente (que responde con res.status().json()) y devuelve el JSON.
function capturarJson(fn, req) {
  return new Promise((resolve, reject) => {
    const falsoRes = { status() { return falsoRes; }, json(d) { resolve(d); return falsoRes; } };
    Promise.resolve(fn(req, falsoRes)).catch(reject);
  });
}

async function servirMetricas(nombre, calcular, req, res) {
  const dias = Number(req.query.dias) || 30;
  if (dias === 30 && !req.query.forzar) {
    const snap = await leerSnapshot(nombre).catch(() => null);
    if (snap && snapshotCompleto(nombre, snap.data)) return res.status(200).json({ ...limpiarMetricasParaPanel(nombre, snap.data), generadoEn: snap.generadoEn, desdeCache: true });
  }
  const data = limpiarMetricasParaPanel(nombre, await capturarJson(calcular, req));
  if (dias === 30 && snapshotCompleto(nombre, data)) await guardarSnapshot(nombre, data).catch((err) => console.warn('[admin.js] no se pudo guardar el snapshot:', err?.message || err));
  return res.status(200).json({ ...data, generadoEn: new Date().toISOString(), desdeCache: false });
}

// Perfil de pacientes (buyer persona) en JSON: reutiliza el export anónimo (12 meses).
function calcularPerfilJson(req, res) {
  return exportPerfilPacientes({ query: { meses: 12, formato: 'json', forzar: req.query?.forzar } }, res);
}

const PARTES_METRICAS = {
  basicas: () => capturarJson(getMetricas, { query: { dias: 30, forzar: 1 } }),
  avanzadas: () => capturarJson(getMetricasAvanzadas, { query: { dias: 30 } }),
  perfil: () => capturarJson(calcularPerfilJson, {}),
};

async function calcularYGuardarParte(nombre) {
  try {
    const data = limpiarMetricasParaPanel(nombre, await PARTES_METRICAS[nombre]());
    if (!snapshotCompleto(nombre, data)) return `no se guardó: lectura incompleta${data.errorLectura ? ` (${data.errorLectura})` : ''}`;
    await guardarSnapshot(nombre, data);
    return 'ok';
  } catch (err) {
    await avisarFallo({ endpoint: 'api/gestion/admin.js', detalle: `metricas-cron ${nombre}`, error: err });
    return `error: ${err?.message || err}`;
  }
}

// La tarea diaria ejecuta las métricas en una sola invocación para reutilizar el escaneo
// de fichas y no triplicar las llamadas a Sheets.
async function metricasCron(req, res, viaCron) {
  const parte = req.query.parte;
  if (parte) {
    if (!PARTES_METRICAS[parte]) return res.status(400).json({ success: false, error: 'parte inválida' });
    return res.status(200).json({ success: true, parte, resultado: await calcularYGuardarParte(parte) });
  }
  const resultado = {};
  const host = req.headers?.host;
  const secreto = process.env.CRON_SECRET;
  const headers = secreto ? { authorization: `Bearer ${secreto}` } : {};
  // Las partes comparten el escaneo de fichas en memoria. Ejecutarlas en paralelo
  // triplica las llamadas a Sheets y supera la cuota cuando hay cientos de pacientes.
  for (const nombre of Object.keys(PARTES_METRICAS)) {
    resultado[nombre] = await calcularYGuardarParte(nombre);
  }
  // Vercel Hobby permite solo 2 crons: este reemplaza al del chequeo de salud, así que lo
  // dispara acá mismo (mejor esfuerzo, no cambia el resultado de las métricas).
  if (viaCron && secreto && host) {
    try {
      await fetch(`https://${host}/api/gestion/pacientes?modo=healthcheck`, { headers });
      resultado.healthcheck = 'ok';
    } catch (err) { resultado.healthcheck = `error: ${err?.message || err}`; }
  }
  return res.status(200).json({ success: true, generadoEn: new Date().toISOString(), resultado });
}

// ---------- 9. Dashboard de métricas ----------
// Todo calculado en vivo desde Calendar (rango pedido) — sin caché ni tabla propia,
// "con los datos que ya existen" (ver el pedido). Cancelaciones/reprogramaciones no
// tienen historial retroactivo (Calendar no guarda turnos borrados) — esas dos métricas
// se alimentan desde ahora en adelante vía ActividadLog (lib/adminConfig.js).
//
// Formato argentino: "$" opcional, "." como separador de miles, "," como decimal
// (ej. "$900.000,00" = 900000). parseFloat solo no alcanza — hay que sacar los
// puntos de miles ANTES de convertir la coma decimal a punto, si no
// "900.000,00" -> "900.000.00" -> parseFloat corta en el segundo punto y da 900
// en vez de 900000 (bug real, encontrado en el dashboard el 2026-08-13).
function parsearMontoArgentino(texto) {
  const limpio = String(texto || '').replace(/[^\d,.-]/g, '');
  const sinMiles = limpio.replace(/\./g, '');
  return parseFloat(sinMiles.replace(',', '.')) || 0;
}

// El rango mira `dias` para atrás Y 60 días para adelante (no solo hacia atrás):
// este es un sistema de reserva de turnos, así que en cualquier momento buena parte
// (a veces casi toda, en un sitio recién lanzado) de la actividad real vive en turnos
// ya cargados para fechas futuras, no en el pasado. Un rango solo retroactivo dejaba
// el dashboard vacío incluso con turnos reales cargados. `DIAS_FUTURO_FIJO` no es
// configurable desde la UI a propósito, para no sumar otro control — 60 días cubre el
// horizonte típico de reserva de este consultorio.
const DIAS_FUTURO_FIJO = 60;
// Turnos/sobreturnos del rango + agregados simples (online vs Ayelen, confirmados,
// nuevos vs recurrentes) — independiente de deuda/actividad, se corre en paralelo
// con esas dos (ver getMetricas). Antes corría todo en serie: con muchos pacientes,
// la suma de Calendar + deuda + actividad pasaba largo el límite de 10s de las
// funciones serverless en el plan Hobby y el dashboard quedaba colgado sin ningún
// error visible (encontrado en producción, 2026-08-13). `maxDuration: 60` en
// vercel.json para este archivo da margen extra además de la paralelización.
// Turnos/bloqueos desde el espejo de Supabase (RPC consultorio_admin_turnos). Devuelve
// null si el flag está apagado o falla, y el llamador cae a Google Calendar.
async function turnosDesdeSupabase(desde, hasta) {
  if (!debeUsarSupabaseAdmin()) return null;
  const r = await rpcAdmin('consultorio_admin_turnos', { p_desde: desde.toISOString(), p_hasta: hasta.toISOString() });
  if (!r || !Array.isArray(r.turnos)) return null;
  return { turnos: r.turnos, bloqueos: Array.isArray(r.bloqueos) ? r.bloqueos : [] };
}

async function calcularTurnos(desde, hasta) {
  const sb = await turnosDesdeSupabase(desde, hasta);
  if (sb) {
    const porDia = {};
    let online = 0, cargadoAyelen = 0, confirmados = 0, nuevos = 0, recurrentes = 0;
    sb.turnos.forEach((t) => {
      const dia = formatArgDay(new Date(t.inicio));
      porDia[dia] = (porDia[dia] || 0) + 1;
      if (t.manual) cargadoAyelen++; else online++;
      if (t.confirmado) confirmados++;
      if (t.nuevo) nuevos++; else recurrentes++;
    });
    return { eventos: sb.turnos, porDia, online, cargadoAyelen, confirmados, nuevos, recurrentes, total: sb.turnos.length || 1 };
  }
  const calendar = getCalendarClient();
  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 2500 })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: true, maxResults: 2500 })),
  ]);

  const eventos = [
    ...(principal.data.items || []).map((ev) => ({ ev, tipo: 'turno' })),
    ...(sobreturnos.data.items || []).map((ev) => ({ ev, tipo: 'sobreturno' })),
  ].filter(({ ev }) => !(ev.description || '').includes(BLOCK_MARKER));

  const porDia = {};
  let online = 0, cargadoAyelen = 0, confirmados = 0, nuevos = 0, recurrentes = 0;

  eventos.forEach(({ ev }) => {
    const { start } = eventBounds(ev);
    const dia = formatArgDay(start);
    porDia[dia] = (porDia[dia] || 0) + 1;

    const desc = ev.description || '';
    if (desc.includes('Cargado manualmente desde el panel de gestión')) cargadoAyelen++;
    else online++;

    if (extraerConfirmado(desc)) confirmados++;
    if (extraerEsNuevoPaciente(desc)) nuevos++; else recurrentes++;
  });

  const total = eventos.length || 1;
  return { eventos, porDia, online, cargadoAyelen, confirmados, nuevos, recurrentes, total };
}

// Un solo escaneo compartido por las métricas, deuda y buyer persona. Antes cada tarjeta
// recorría cientos de spreadsheets por separado y el dashboard disparaba esas lecturas a
// la vez: la cuota de Sheets se agotaba y los snapshots guardaban resultados parciales.
// Se piden solo campos anónimos y financieros en un batchGet por ficha y se comparte el
// resultado en memoria. Nunca se descargan nombre, DNI, teléfono ni domicilio.
let cacheEscaneoFichas = null; // { valor, ts }
const TTL_ESCANEO_FICHAS_MS = 5 * 60 * 1000;
const LOTE_ESCANEO_FICHAS = 3;

const esperarAdmin = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function escanearFichasAdmin(forzar = false) {
  // Si ya hay un escaneo en curso, que las otras tarjetas esperen ese mismo resultado.
  if (cacheEscaneoFichas?.promesa) return cacheEscaneoFichas.promesa;
  if (!forzar && cacheEscaneoFichas?.valor && Date.now() - cacheEscaneoFichas.ts < TTL_ESCANEO_FICHAS_MS) {
    return cacheEscaneoFichas.valor;
  }
  cacheDeuda = null;
  cacheFinanzas = null;

  const promesa = (async () => {
    // Rápido: las fichas ya están copiadas en Supabase (se actualizan en cada edición y
    // todas las noches). Si falla o viene vacío, se cae al camino viejo (leer Google).
    if (debeUsarSupabaseAdmin()) {
      try { return await escanearFichasDesdeSupabase(); }
      catch (err) { console.warn('[admin.js] escaneo desde Supabase falló, uso Google:', err?.message || err); }
    }
    const drive = getPacientesDriveClient();
    const sheets = getPacientesSheetsClient();
    let archivos = [];
    let pageToken;
    do {
      const { data } = await conReintentos(() => drive.files.list({
        q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id, name), nextPageToken', pageSize: 250, pageToken,
      }));
      archivos = archivos.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    archivos = archivos.filter((f) => !/^⭐/.test(f.name));

    const fichas = [];
    let fallidos = 0;
    let ultimoError = '';
    for (let i = 0; i < archivos.length; i += LOTE_ESCANEO_FICHAS) {
      const lote = archivos.slice(i, i + LOTE_ESCANEO_FICHAS);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
            spreadsheetId: f.id,
            ranges: [`${SHEET_NAME}!C8`, `${SHEET_NAME}!C10:C11`, `${SHEET_NAME}!C15`, `${SHEET_NAME}!E6:F11`, rangoMovimientos()],
          }));
          const [nacRaw, locOsRaw, planRaw, finRaw, movRaw] = data.valueRanges || [];
          const celda = (r, i = 0) => (r?.values?.[i]?.[0] != null ? String(r.values[i][0]) : '');
          const fin = finRaw?.values || [];
          const filasMovimiento = (movRaw?.values || []).map((row) => ({
            fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '',
            saldo: row[4] || '', formaPago: row[6] || '',
          }));
          const saldoTexto = fin[2]?.[1] || '$0,00';
          const diasRaw = parseInt(String(fin[5]?.[1] || '').replace(/\D/g, ''), 10) || 0;
          return {
            id: f.id, archivo: f.name,
            fechaNacimiento: celda(nacRaw), localidad: celda(locOsRaw, 0), obraSocial: celda(locOsRaw, 1),
            planTratamiento: celda(planRaw),
            saldo: parsearMontoArgentino(saldoTexto), diasSinPago: diasRaw > 3650 ? 0 : diasRaw,
            movimientos: filasMovimiento,
          };
        } catch (err) {
          ultimoError = err?.message || String(err);
          console.warn(`[admin.js] no se pudo leer la ficha ${f.name} para métricas:`, ultimoError);
          return null;
        }
      }));
      resultados.forEach((r) => { if (r) fichas.push(r); else fallidos++; });
      // Evita ráfagas entre lotes sin ralentizar en exceso las lecturas normales.
      if (i + LOTE_ESCANEO_FICHAS < archivos.length) await esperarAdmin(600);
    }
    return { fichas, total: archivos.length, fallidos, ultimoError };
  })();

  cacheEscaneoFichas = { promesa, ts: Date.now(), valor: null };
  try {
    const valor = await promesa;
    cacheEscaneoFichas = { valor, ts: Date.now() };
    return valor;
  } catch (err) {
    cacheEscaneoFichas = null;
    throw err;
  }
}

// Deuda se deriva del mismo escaneo que finanzas y buyer persona.
let cacheDeuda = null; // { valor, ts }
const TTL_DEUDA_MS = 120000;
async function calcularDeuda(forzar) {
  if (!forzar && cacheDeuda && Date.now() - cacheDeuda.ts < TTL_DEUDA_MS) return cacheDeuda.valor;
  const escaneo = await escanearFichasAdmin(forzar);
  // Saldos separados: pesos y dólares (cada movimiento tiene su moneda). Si la fuente no trae
  // monedas (camino viejo de Google), todo el saldo cuenta como pesos.
  const fichas = escaneo.fichas.map((f) => {
    let saldoArs = f.saldo, saldoUsd = 0;
    if (escaneo.origen === 'supabase') {
      const c = calcularCuentas(f.movimientos);
      saldoArs = Math.round(c.ARS.saldo * 100) / 100;
      saldoUsd = Math.round(c.USD.saldo * 100) / 100;
    }
    return { nombre: `${parsearNombreArchivo(f.archivo).nombre} ${parsearNombreArchivo(f.archivo).apellido}`.trim(), saldo: saldoArs, saldoUsd, dias: f.diasSinPago };
  });
  const debe = (f) => f.saldo > 0 || f.saldoUsd > 0;
  const conDeuda = fichas.filter(debe).length;
  const totalPacientesConSaldo = fichas.length;
  const fallidos = escaneo.fallidos;
  // Para ordenar, el dólar se pasa a pesos con la cotización blue más reciente (solo ordena).
  let cotOrden = 0;
  try { const h = await obtenerHistoricoDolarBlue(); cotOrden = h.porFecha.get(h.fechasOrdenadas[h.fechasOrdenadas.length - 1]) || 0; } catch { /* ordena solo por pesos */ }
  const equivalente = (f) => Math.max(f.saldo, 0) + Math.max(f.saldoUsd, 0) * cotOrden;
  const topDeudoresMonto = fichas.filter(debe);
  const topDeudoresAntiguedad = fichas.filter((f) => debe(f) && f.dias > 0);
  topDeudoresMonto.sort((a, b) => equivalente(b) - equivalente(a));
  topDeudoresAntiguedad.sort((a, b) => b.dias - a.dias);
  const valor = { conDeuda, totalPacientesConSaldo, totalFichas: escaneo.total, fallidos, topDeudoresMonto, topDeudoresAntiguedad,
    ...(fallidos ? { errorLectura: escaneo.ultimoError } : {}) };
  cacheDeuda = { valor, ts: Date.now() };
  return valor;
}

// Cancelados/reprogramados: Calendar no guarda turnos borrados, así que no hay forma
// de calcularlos en vivo como confirmados/nuevos — se cuentan desde ActividadLog (ver
// lib/adminConfig.js), que solo tiene datos desde que se agregó este logging
// (2026-08-13 en adelante). Se muestran como cantidad, no %: no hay un denominador
// común honesto entre "turnos vigentes ahora en Calendar" y "eventos de cancelación
// ya registrados en el log".
async function calcularCancelacionesYReprogramaciones(desde, hasta) {
  let cancelados = 0, reprogramados = 0;
  try {
    const actividad = await leerActividadReciente(500);
    actividad.forEach((ev) => {
      const fechaEv = new Date(ev.fecha);
      if (fechaEv < desde || fechaEv > hasta) return;
      if (ev.tipo === 'turno_cancelado') cancelados++;
      else if (ev.tipo === 'turno_reprogramado') reprogramados++;
    });
  } catch (err) {
    console.warn('[admin.js] no se pudo leer cancelados/reprogramados:', err?.message || err);
  }
  return { cancelados, reprogramados };
}

const TURNOS_VACIO = { eventos: [], porDia: {}, online: 0, cargadoAyelen: 0, confirmados: 0, nuevos: 0, recurrentes: 0, total: 1 };

async function getMetricas(req, res) {
  const dias = Math.min(Number(req.query.dias) || 30, 90);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60000);
  const hasta = new Date(Date.now() + DIAS_FUTURO_FIJO * 24 * 60 * 60000);

  // Ninguno de los tres cálculos puede tumbar el dashboard entero — cada uno
  // degrada a "sin datos" por su cuenta y el error real queda visible en
  // `errores` para poder diagnosticar sin depender de los logs de Vercel
  // (encontrado en producción, 2026-08-13: un error acá se mostraba como
  // "No se pudieron cargar las métricas" sin ninguna pista de la causa real).
  const errores = [];
  const [
    { eventos, porDia, online, cargadoAyelen, confirmados, nuevos, recurrentes, total },
    { cancelados, reprogramados },
  ] = await Promise.all([
    calcularTurnos(desde, hasta).catch((err) => {
      console.error('[admin.js] calcularTurnos falló:', err);
      errores.push(`turnos: ${err?.message || err}`);
      return TURNOS_VACIO;
    }),
    calcularCancelacionesYReprogramaciones(desde, hasta),
  ]);

  res.status(200).json({
    ...(errores.length ? { errores } : {}),
    rangoDias: dias,
    volumenPorDia: Object.entries(porDia).sort(([a], [b]) => a.localeCompare(b)).map(([fecha, cantidad]) => ({ fecha, cantidad })),
    porcentajeOnline: Math.round((online / total) * 100),
    porcentajeCargadoAyelen: Math.round((cargadoAyelen / total) * 100),
    porcentajeConfirmados: Math.round((confirmados / total) * 100),
    porcentajeNuevos: Math.round((nuevos / total) * 100),
    porcentajeRecurrentes: Math.round((recurrentes / total) * 100),
    totalTurnos: eventos.length,
    cancelados,
    reprogramados,
    porcentajeConDeuda: null,
    topDeudoresMonto: [],
    topDeudoresAntiguedad: [],
    totalPacientesConSaldo: null,
    totalFichas: null,
    fichasFallidas: null,
  });
}

// Los datos de turnos y deuda se sirven por separado para que el dashboard principal
// no quede bloqueado por la lectura individual de cientos de hojas de cálculo.
async function getMetricasDeuda(req, res) {
  const deuda = await calcularDeuda(!!req.query.forzar);
  res.status(200).json({ success: true, ...deuda, fichasFallidas: deuda.fallidos });
}

// ---------- 9b. Métricas avanzadas (ocupación, inasistencia, ingresos, pacientes, ticket) ----------
// Aparte de getMetricas() (recurso=metricas) a propósito: acá adentro está el escaneo
// más pesado de todo el panel (movimientos de CADA ficha, no solo un par de celdas como
// calcularDeuda), así que separarlo en su propio recurso deja que el dashboard "rápido"
// cargue y se pinte sin esperar esto, y que este pedazo tenga su propio spinner/caché.

// ---- (a) Ocupación mensual ----
// Capacidad nominal = slots de slotMinutes según el horario configurado (WEEKLY_SCHEDULE
// o lo guardado en /admin), menos los minutos bloqueados ese mes (día completo o
// parcial). Los sobreturnos NO restan de la capacidad nominal (son turnos extra fuera de
// la grilla habitual) — por eso la ocupación puede superar el 100%, a propósito.
async function calcularOcupacionMes(calendar, year, month, schedule, slotMinutes) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = toArgDate(`${year}-${pad2(month)}-01`, '00:00');
  const lastDayStr = `${year}-${pad2(month)}-${pad2(daysInMonth)}`;
  const monthEnd = new Date(toArgDate(lastDayStr, '00:00').getTime() + 24 * 60 * 60000);

  let turnosReservados, sobreturnosReservados, minutosBloqueados;
  const sb = await turnosDesdeSupabase(monthStart, monthEnd);
  if (sb) {
    turnosReservados = sb.turnos.filter((t) => t.tipo !== 'sobreturno').length;
    sobreturnosReservados = sb.turnos.filter((t) => t.tipo === 'sobreturno').length;
    minutosBloqueados = sb.bloqueos.reduce((acc, b) => acc + (new Date(b.fin) - new Date(b.inicio)) / 60000, 0);
  } else {
    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin: monthStart.toISOString(), timeMax: monthEnd.toISOString(), singleEvents: true, maxResults: 2500 })),
      conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin: monthStart.toISOString(), timeMax: monthEnd.toISOString(), singleEvents: true, maxResults: 2500 })),
    ]);
    const eventosPrincipal = principal.data.items || [];
    const bloqueos = eventosPrincipal.filter((ev) => (ev.description || '').includes(BLOCK_MARKER));
    turnosReservados = eventosPrincipal.length - bloqueos.length;
    sobreturnosReservados = (sobreturnos.data.items || []).length;
    minutosBloqueados = bloqueos.reduce((acc, ev) => {
      const { start, end } = eventBounds(ev);
      return acc + (end - start) / 60000;
    }, 0);
  }

  let capacidad = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    const ranges = schedule[dayOfWeek] || [];
    ranges.forEach(([ini, fin]) => {
      const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
      const mins = (toArgDate(dateStr, fin) - toArgDate(dateStr, ini)) / 60000;
      capacidad += Math.floor(mins / slotMinutes);
    });
  }
  capacidad = Math.max(0, capacidad - Math.round(minutosBloqueados / slotMinutes));

  return {
    anio: year,
    mes: month,
    turnosReservados,
    sobreturnosReservados,
    capacidad,
    porcentaje: capacidad > 0 ? Math.round((turnosReservados / capacidad) * 100) : null,
  };
}

// ---- (b) % de inasistencia mensual ----
// Solo se cuenta desde INASISTENCIA_DESDE en adelante (pedido explícito): antes de esa
// fecha el estado "confirmado" no era un dato confiable para todos los turnos viejos.
// "Inasistencia" acá = turno YA PASADO sin confirmar — no distingue si el paciente avisó
// o no, mismo criterio simple que el resto de las métricas de este dashboard.
const INASISTENCIA_DESDE = '2026-08-13';
async function calcularInasistenciaMensual(calendar) {
  const desde = toArgDate(INASISTENCIA_DESDE, '00:00');
  const ahora = new Date();
  if (ahora <= desde) return [];

  const sb = await turnosDesdeSupabase(desde, ahora);
  if (sb) {
    const porMesSb = {};
    sb.turnos.forEach((t) => {
      if (t.tipo === 'sobreturno') return;
      const key = formatArgDay(new Date(t.inicio)).slice(0, 7);
      (porMesSb[key] ||= { mes: key, total: 0, inasistencias: 0 });
      porMesSb[key].total++;
      if (!t.confirmado) porMesSb[key].inasistencias++;
    });
    return Object.values(porMesSb)
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map((m) => ({ ...m, porcentaje: m.total ? Math.round((m.inasistencias / m.total) * 100) : 0 }));
  }

  let eventos = [];
  let pageToken;
  do {
    const { data } = await conReintentos(() => calendar.events.list({
      calendarId: CALENDAR_ID, timeMin: desde.toISOString(), timeMax: ahora.toISOString(),
      singleEvents: true, maxResults: 2500, pageToken,
    }));
    eventos = eventos.concat(data.items || []);
    pageToken = data.nextPageToken;
  } while (pageToken);

  const porMes = {};
  eventos.forEach((ev) => {
    if ((ev.description || '').includes(BLOCK_MARKER)) return;
    const { start } = eventBounds(ev);
    if (start > ahora) return;
    const key = formatArgDay(start).slice(0, 7);
    (porMes[key] ||= { mes: key, total: 0, inasistencias: 0 });
    porMes[key].total++;
    if (!extraerConfirmado(ev.description)) porMes[key].inasistencias++;
  });

  return Object.values(porMes)
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .map((m) => ({ ...m, porcentaje: m.total ? Math.round((m.inasistencias / m.total) * 100) : 0 }));
}

// ---- Cotización histórica del dólar blue (ArgentinaDatos, sin auth) ----
// Se trae el HISTÓRICO COMPLETO de una sola vez (un solo fetch, ~5700 filas, liviano)
// en vez de una llamada por cada pago cobrado — con cientos de movimientos guardados,
// eso hubiera sido cientos de fetches a una API externa solo para armar el ticket
// promedio en USD. Cacheado 6hs en memoria del proceso (la cotización de un día que ya
// pasó no cambia más).
let cacheDolarBlue = null; // { porFecha: Map, fechasOrdenadas: string[], ts }
const TTL_DOLAR_MS = 6 * 60 * 60 * 1000;
async function obtenerHistoricoDolarBlue() {
  if (cacheDolarBlue && Date.now() - cacheDolarBlue.ts < TTL_DOLAR_MS) return cacheDolarBlue;
  const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/blue');
  if (!r.ok) throw new Error(`ArgentinaDatos respondió ${r.status}`);
  const data = await r.json();
  const porFecha = new Map();
  (data || []).forEach((d) => { if (d.fecha && d.venta) porFecha.set(d.fecha, d.venta); });
  const fechasOrdenadas = [...porFecha.keys()].sort();
  cacheDolarBlue = { porFecha, fechasOrdenadas, ts: Date.now() };
  return cacheDolarBlue;
}

// Si el día exacto no tiene cotización (fin de semana/feriado, ver el pedido), se usa la
// fecha disponible más cercana ANTERIOR — búsqueda binaria porque `fechasOrdenadas` puede
// tener miles de entradas y esto se llama una vez por cada pago cobrado.
function dolarBlueEnFecha(cache, fechaISO) {
  if (cache.porFecha.has(fechaISO)) return cache.porFecha.get(fechaISO);
  const { fechasOrdenadas } = cache;
  let lo = 0, hi = fechasOrdenadas.length - 1, resultado = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fechasOrdenadas[mid] <= fechaISO) { resultado = fechasOrdenadas[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return resultado ? cache.porFecha.get(resultado) : null;
}

// "D/M/AAAA" (ver fechaInputASheet en pacientes/index.html) -> "YYYY-MM-DD". Devuelve
// null si no matchea el formato esperado (fila vieja/mal cargada a mano) en vez de
// reventar todo el cálculo por una sola fila rara.
function fechaSheetAIso(fechaStr) {
  const m = String(fechaStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ---- (c)+(d)+(e) Escaneo combinado de fichas: ingresos, ticket promedio y pacientes ----
// Un solo recorrido de todas las fichas (batchGet de 2 rangos por archivo: identidad +
// movimientos) en vez de tres escaneos separados — ya es la operación más cara del
// panel con uno solo. Mismo patrón de lotes de 25 en paralelo que calcularDeuda(), con
// paginado completo de Drive (ver el bug real de "no se están tomando valores más altos"
// del 2026-08-13 — cortar en la primera página deja fichas afuera en silencio).
let cacheFinanzas = null; // { valor, ts }
const TTL_FINANZAS_MS = 300000;
async function calcularFinanzasPacientes(forzar) {
  if (!forzar && cacheFinanzas && Date.now() - cacheFinanzas.ts < TTL_FINANZAS_MS) return cacheFinanzas.valor;

  const ingresosPorDia = {};
  const pagos = []; // { fechaISO, monto }
  const cobrosMes = {};
  const escaneo = await escanearFichasAdmin(forzar);
  escaneo.fichas.forEach((f) => f.movimientos
    .filter((m) => m.fecha && m.haber && !/^\[ANULADO\]/.test(m.tratamiento))
    .forEach((m) => {
      const fechaISO = fechaSheetAIso(m.fecha);
      if (!fechaISO) return;
      const monto = parsearMontoArgentino(m.haber);
      if (monto <= 0) return;
      ingresosPorDia[fechaISO] = (ingresosPorDia[fechaISO] || 0) + monto;
      pagos.push({ fechaISO, monto });
      // Cobros por forma de pago (efectivo / transferencias por titular / otras / sin dato)
      const fp = String(m.formaPago || '').trim();
      const mesK = fechaISO.slice(0, 7);
      const fila = (cobrosMes[mesK] ||= { mes: mesK, efectivo: 0, transferencia: 0, otras: 0, sinDato: 0, total: 0, cuentas: {} });
      fila.total += monto;
      if (!fp) fila.sinDato += monto;
      else if (/^(ef|efvo|efectivo)\.?$/i.test(fp)) fila.efectivo += monto;
      else if (/^transf/i.test(fp)) {
        fila.transferencia += monto;
        const t = fp.match(/\(([^)]+)\)/);
        const cuenta = t ? t[1].trim() : 'Sin especificar';
        fila.cuentas[cuenta] = (fila.cuentas[cuenta] || 0) + monto;
      } else fila.otras += monto;
    }));

  // (e) Ticket promedio en $ y USD, agrupado por mes y por año — cada pago se convierte
  // con la cotización blue REAL del día que se cobró (pedido explícito), no la de hoy.
  let dolarCache = null;
  let dolarError = null;
  try {
    dolarCache = await obtenerHistoricoDolarBlue();
  } catch (err) {
    console.warn('[admin.js] no se pudo obtener el histórico del dólar blue:', err?.message || err);
    dolarError = err?.message || String(err);
  }

  const acumPorMes = {};
  const acumPorAnio = {};
  pagos.forEach((p) => {
    const mesKey = p.fechaISO.slice(0, 7);
    const anioKey = p.fechaISO.slice(0, 4);
    const cotizacion = dolarCache ? dolarBlueEnFecha(dolarCache, p.fechaISO) : null;
    const montoUsd = cotizacion ? p.monto / cotizacion : null;

    (acumPorMes[mesKey] ||= { mes: mesKey, cantidad: 0, sumaArs: 0, sumaUsd: 0, pagosConUsd: 0 });
    acumPorMes[mesKey].cantidad++;
    acumPorMes[mesKey].sumaArs += p.monto;
    if (montoUsd != null) { acumPorMes[mesKey].sumaUsd += montoUsd; acumPorMes[mesKey].pagosConUsd++; }

    (acumPorAnio[anioKey] ||= { anio: anioKey, cantidad: 0, sumaArs: 0, sumaUsd: 0, pagosConUsd: 0 });
    acumPorAnio[anioKey].cantidad++;
    acumPorAnio[anioKey].sumaArs += p.monto;
    if (montoUsd != null) { acumPorAnio[anioKey].sumaUsd += montoUsd; acumPorAnio[anioKey].pagosConUsd++; }
  });
  const armarPromedio = (acum) => ({
    ...acum,
    promedioArs: acum.cantidad ? Math.round(acum.sumaArs / acum.cantidad) : 0,
    promedioUsd: acum.pagosConUsd ? Math.round((acum.sumaUsd / acum.pagosConUsd) * 100) / 100 : null,
  });
  const ticketPorMes = Object.values(acumPorMes).sort((a, b) => a.mes.localeCompare(b.mes)).map(armarPromedio);
  const ticketPorAnio = Object.values(acumPorAnio).sort((a, b) => a.anio.localeCompare(b.anio)).map(armarPromedio);

  // (c) Ingresos: serie diaria completa (la usa el frontend para armar tanto la vista
  // diaria del mes actual como los totales mensual/anual, sumando sobre esta misma serie
  // en vez de mandar tres formatos distintos desde el back).
  const ingresosDiarios = Object.entries(ingresosPorDia)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, monto]) => ({ fecha, monto: Math.round(monto * 100) / 100 }));

  const redondear = (n) => Math.round(n * 100) / 100;
  const cobrosPorFormaPago = Object.values(cobrosMes).sort((a, b) => a.mes.localeCompare(b.mes)).map((f) => ({
    mes: f.mes, efectivo: redondear(f.efectivo), transferencia: redondear(f.transferencia), otras: redondear(f.otras),
    sinDato: redondear(f.sinDato), total: redondear(f.total),
    cuentas: Object.fromEntries(Object.entries(f.cuentas).map(([k, v]) => [k, redondear(v)])),
  }));

  const valor = {
    ingresosDiarios,
    cobrosPorFormaPago,
    ticketPorMes,
    ticketPorAnio,
    dolarError,
    fichasFallidas: escaneo.fallidos,
    totalFichasEscaneadas: escaneo.total,
    ...(escaneo.fallidos ? { errorLectura: escaneo.ultimoError } : {}),
  };
  cacheFinanzas = { valor, ts: Date.now() };
  return valor;
}

// ---- (d) Pacientes totales: fichas + turnos sin ficha, sin duplicar ----
// Ya no escanea Calendar en vivo (ver el pedido, 2026-08-14) — lee directo de la
// planilla "Pacientes consolidados" (lib/pacientesConsolidados.js), la misma fuente
// única que ahora usa también el autocompletado de /gestion, mantenida al día con
// escrituras puntuales en vez de un escaneo completo por request. Mismo criterio de
// matching "ya establecido en el proyecto" (mismo teléfono) que antes, solo que
// resuelto de antemano en vez de en cada carga del dashboard.
async function calcularPacientesTotales() {
  let filas = [];
  try {
    filas = await listarPacientesConsolidados({ cache: true });
  } catch (err) {
    console.warn('[admin.js] no se pudo leer la planilla consolidada para pacientes totales:', err?.message || err);
    return { total: null, totalFichas: null, totalSoloTurno: null, fichas: [], soloTurno: [], error: err?.message || String(err) };
  }

  // Un mismo fichaId puede estar en 2 filas (la de la ficha y la de un teléfono de turno
  // asignado a mano): se cuenta una sola vez.
  const vistosFicha = new Set();
  const fichas = filas
    .filter((f) => f.fichaId && !vistosFicha.has(f.fichaId) && vistosFicha.add(f.fichaId))
    .map((f) => ({ id: f.fichaId, nombre: f.nombre, apellido: f.apellido, dni: f.dni, telefono: f.telefono }));
  const soloTurno = filas
    .filter((f) => !f.fichaId)
    .map((f) => ({ nombre: `${f.nombre} ${f.apellido}`.trim(), dni: f.dni, telefono: f.telefono }));

  return {
    total: fichas.length + soloTurno.length,
    totalFichas: fichas.length,
    totalSoloTurno: soloTurno.length,
    fichas,
    soloTurno: soloTurno.slice(0, 500),
  };
}

async function getPacientesTotales(_req, res) {
  const pacientesTotales = await calcularPacientesTotales();
  const salida = _req.query.listado === '1' ? pacientesTotales : resumirPacientesTotales(pacientesTotales);
  res.status(200).json({ success: pacientesTotales.total != null, pacientesTotales: salida });
}

function resumirPacientesTotales(pacientes = {}) {
  const { total, totalFichas, totalSoloTurno, error } = pacientes;
  return { total: total ?? null, totalFichas: totalFichas ?? null, totalSoloTurno: totalSoloTurno ?? null, ...(error ? { error } : {}) };
}


// Personas con turno en los próximos `dias` días (ambos calendarios, sin bloqueos),
// una por DNI/teléfono, con el turno más cercano. Para el panel "sin ficha".
async function leerProximosTurnosPersonas(dias) {
  const calendar = getCalendarClient();
  // Desde las 00:00 de HOY (hora Argentina), para incluir también los turnos de hoy ya pasados.
  const hoyArg = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const inicio = toArgDate(hoyArg, '00:00');
  const timeMin = inicio.toISOString();
  const timeMax = new Date(inicio.getTime() + dias * 86400000).toISOString();
  const [a, b] = await Promise.all([CALENDAR_ID, SOBRETURNOS_CALENDAR_ID].map((calendarId) =>
    conReintentos(() => calendar.events.list({ calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500 }))));
  const evs = [...(a.data.items || []), ...(b.data.items || [])]
    .filter((ev) => ev.start?.dateTime && !(ev.description || '').includes(BLOCK_MARKER) && (ev.summary || '').trim())
    .sort((x, y) => x.start.dateTime.localeCompare(y.start.dateTime));
  const out = [];
  for (const ev of evs) {
    const dni = extraerDni(ev.description);
    const telefono = extraerTelefono(ev.description);
    const nombre = (ev.summary || '').trim();
    const ya = out.find((t) => (dni && t.dni ? normalizarDni(t.dni) === normalizarDni(dni)
      : (telefono && normalizarTelefonoMapeo(t.telefono) === normalizarTelefonoMapeo(telefono) && t.nombre === nombre) || (!dni && !telefono && t.nombre === nombre)));
    if (ya) continue;
    out.push({ nombre, dni, telefono, start: new Date(ev.start.dateTime).toISOString() });
  }
  return out;
}

// ---------- Pacientes con turnos pero sin ficha ----------
// Son las filas de "Pacientes consolidados" sin fichaId. Se lee en vivo (sin snapshot).
async function getSinFicha(req, res) {
  const filas = await listarPacientesConsolidados();
  // El índice consolidado puede estar incompleto: las fichas antiguas no siempre
  // pasaron por una edición que las sincronice. Completar sus identidades desde los
  // nombres de archivo de Drive (sin leer las hojas) para no ocultar coincidencias.
  let archivos = [];
  try {
    const drive = getPacientesDriveClient();
    let pageToken;
    do {
      const { data } = await conReintentos(() => drive.files.list({
        q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'files(id, name), nextPageToken', pageSize: 250, pageToken,
      }));
      archivos = archivos.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.warn('[admin.js] no se pudo completar el índice de fichas desde Drive:', err?.message || err);
  }
  const fichasPorId = new Map(filas.filter((f) => f.fichaId).map((f) => [f.fichaId, f]));
  for (const archivo of archivos) {
    if (archivo.id === FICHA_TEMPLATE_ID || /^⭐/.test(archivo.name) || /\(no tocar\)\s*$/i.test(archivo.name)) continue;
    const identidad = parsearNombreArchivo(archivo.name);
    const ficha = fichasPorId.get(archivo.id) || { fichaId: archivo.id };
    fichasPorId.set(archivo.id, {
      ...ficha,
      nombre: ficha.nombre || identidad.nombre,
      apellido: ficha.apellido || identidad.apellido,
      dni: ficha.dni || identidad.dni,
    });
  }
  const filasConFichasDeDrive = [...filas, ...fichasPorId.values()];
  const sug = sugerenciasPorNombre(filasConFichasDeDrive);
  const nombreFicha = new Map([...fichasPorId].map(([id, f]) => [id, `${f.nombre} ${f.apellido}`.trim()]));
  // Próximos turnos (21 días): sirven para ordenar por fecha de turno y para mostrar
  // a quienes tienen turno pero todavía no figuran en la planilla consolidada.
  const proximos = await leerProximosTurnosPersonas(21).catch((err) => {
    console.warn('[admin.js] sin-ficha: no se pudieron leer los próximos turnos:', err?.message || err);
    return [];
  });
  const claveDni = (v) => normalizarDni(v);
  const claveTel = (v) => normalizarTelefonoMapeo(v);
  // Identidad: el DNI manda. El teléfono solo cuenta si alguno de los dos no tiene DNI
  // (familiares comparten teléfono: no son la misma persona si los DNI son distintos).
  const mismaPersona = (a, b) => {
    const da = claveDni(a.dni), db = claveDni(b.dni);
    if (da && db) return da === db;
    return !!claveTel(a.telefono) && claveTel(a.telefono) === claveTel(b.telefono);
  };
  const turnoDe = (dni, tel) => proximos.find((t) => mismaPersona({ dni, telefono: tel }, t));
  const sinFicha = filas
    .filter((f) => !f.fichaId)
    .map((f) => ({
      sugerida: sug.has(f.fila) ? { id: sug.get(f.fila), nombre: nombreFicha.get(sug.get(f.fila)) } : null,
      candidatas: candidatasParaFicha(f, filasConFichasDeDrive),
      fila: f.fila, nombre: `${f.nombre} ${f.apellido}`.trim(), dni: f.dni, telefono: f.telefono,
      turnosPasados: f.turnosPasados || 0, ultimaVisita: f.ultimaVisita || '',
      proximoTurno: turnoDe(f.dni, f.telefono)?.start || '',
    }));
  // Personas con turno próximo que NO están en la planilla (o están con ficha → se omiten).
  const enPlanilla = (t) => filas.some((f) => mismaPersona(t, f));
  const conFicha = (t) => filas.some((f) => f.fichaId && mismaPersona(t, f));
  const virtuales = [];
  let sinDatosClave = 0;
  for (const t of proximos) {
    if (!claveDni(t.dni) && !claveTel(t.telefono)) { sinDatosClave += 1; continue; }
    if (conFicha(t) || enPlanilla(t)) continue;
    if (virtuales.some((v) => mismaPersona(t, v))) continue;
    const persona = { nombre: t.nombre, apellido: '', dni: t.dni, telefono: t.telefono };
    virtuales.push({
      virtual: true, fila: 0, nombre: t.nombre, dni: t.dni, telefono: t.telefono,
      sugerida: null, candidatas: candidatasParaFicha(persona, filasConFichasDeDrive),
      turnosPasados: 0, ultimaVisita: '', proximoTurno: t.start,
    });
  }
  const sinFichaTodos = [...sinFicha, ...virtuales].sort((a, b) => {
    if (a.proximoTurno && b.proximoTurno) return a.proximoTurno.localeCompare(b.proximoTurno) || a.nombre.localeCompare(b.nombre, 'es');
    if (a.proximoTurno) return -1;
    if (b.proximoTurno) return 1;
    return a.nombre.localeCompare(b.nombre, 'es');
  });
  const vistos = new Set();
  const fichas = [...fichasPorId]
    .filter(([id]) => !vistos.has(id) && vistos.add(id))
    .map(([id, f]) => ({ id, nombre: `${f.nombre} ${f.apellido}`.trim(), dni: f.dni }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.status(200).json({ success: true, sinFicha: sinFichaTodos, sinDatosClave, fichas: [] });
}

// Asigna a mano una persona de turnos a una ficha existente (o, con lote:true, todas las
// coincidencias exactas por nombre, de a 25 por llamada).
async function postAsignarFicha(req, res) {
  if (req.body.lote) {
    const r = await asignarCoincidenciasExactas(25);
    await logActividad({ tipo: 'asignar_ficha', detalle: `Asignación por nombre exacto: ${r.asignadas} personas`, actor: 'admin' });
    return res.status(200).json({ success: true, ...r });
  }
  let fila = req.body.fila;
  const v = req.body.virtual;
  if (v && (v.dni || v.telefono)) {
    // Persona con turno que aún no está en la planilla: se crea la fila y se asigna.
    const previas = await listarPacientesConsolidados();
    const dniV = normalizarDni(v.dni), telV = normalizarTelefonoMapeo(v.telefono);
    if (dniV && previas.some((f) => f.fichaId && f.fichaId !== req.body.fichaId && normalizarDni(f.dni) === dniV)) {
      return res.status(400).json({ success: false, error: 'El DNI de esta persona ya pertenece a otra ficha.' });
    }
    // Si el teléfono ya es de otra persona (otro DNI, p. ej. un familiar), no se usa:
    // el upsert fusionaría las dos filas y pisaría el DNI de la otra.
    const telOcupado = dniV && telV && previas.some((f) => normalizarTelefonoMapeo(f.telefono) === telV && normalizarDni(f.dni) !== dniV);
    // Un solo paso (rápido): se crea la fila ya con su ficha.
    await upsertPacienteConsolidado({ telefono: telOcupado ? '' : v.telefono, nombre: v.nombre, apellido: '', dni: v.dni, fichaId: req.body.fichaId, origen: 'ficha' });
    await logActividad({ tipo: 'asignar_ficha', detalle: `Turno de ${v.nombre} asignado a ficha ${req.body.fichaId}`, actor: 'admin' });
    // La fila hace falta para poder "Cancelar asignación".
    const despues = await listarPacientesConsolidados();
    const creada = dniV ? despues.find((f) => normalizarDni(f.dni) === dniV) : despues.find((f) => telV && normalizarTelefonoMapeo(f.telefono) === telV);
    if (!creada || creada.fichaId !== req.body.fichaId) return res.status(500).json({ success: false, error: 'No se pudo confirmar la asignación. Probá de nuevo.' });
    return res.status(200).json({ success: true, fila: creada.fila });
  }
  const r = await asignarFilaAFicha(fila, req.body.fichaId);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  await logActividad({ tipo: 'asignar_ficha', detalle: `Turno de ${r.nombre} asignado a ficha ${req.body.fichaId}`, actor: 'admin' });
  res.status(200).json({ success: true, fila });
}

async function postDesasignarFicha(req, res) {
  const r = await desasignarFila(req.body.fila);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  await logActividad({ tipo: 'desasignar_ficha', detalle: `Asignación cancelada: ${r.nombre}`, actor: 'admin' });
  res.status(200).json({ success: true });
}

// Pacientes a contactar: con deuda reciente y sin turno futuro, y los que hace tiempo no vienen.
// Sale de Supabase (fichas + turnos espejados); no toca Google.
async function getSeguimiento(req, res) {
  const meses = Math.min(Math.max(parseInt(req.query.meses, 10) || 3, 1), 24);
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 60, 7), 365);
  const r = await rpcAdmin('consultorio_admin_seguimiento', { p_meses_inactivo: meses, p_dias_deuda: dias }, { timeoutMs: 8000 });
  if (!r) return res.status(200).json({ success: false, error: 'No se pudo consultar Supabase.' });
  res.status(200).json({ success: true, meses, dias, deudaSinTurno: r.deudaSinTurno || [], paraReactivar: r.paraReactivar || [] });
}

async function getMetricasAvanzadas(req, res) {
  const calendar = getCalendarClient();
  const config = await obtenerHorariosConfig();
  const hoy = new Date();
  const anioActual = hoy.getFullYear();
  const mesActual = hoy.getMonth() + 1;
  const anioSiguiente = mesActual === 12 ? anioActual + 1 : anioActual;
  const mesSiguiente = mesActual === 12 ? 1 : mesActual + 1;

  const errores = [];
  const [ocupacionActual, ocupacionSiguiente, inasistenciaMensual, finanzas] = await Promise.all([
    calcularOcupacionMes(calendar, anioActual, mesActual, config.schedule, config.slotMinutes).catch((err) => {
      errores.push(`ocupación: ${err?.message || err}`);
      return null;
    }),
    calcularOcupacionMes(calendar, anioSiguiente, mesSiguiente, config.schedule, config.slotMinutes).catch((err) => {
      errores.push(`ocupación próximo mes: ${err?.message || err}`);
      return null;
    }),
    calcularInasistenciaMensual(calendar).catch((err) => {
      errores.push(`inasistencia: ${err?.message || err}`);
      return [];
    }),
    calcularFinanzasPacientes(!!req.query.forzar).catch((err) => {
      errores.push(`finanzas: ${err?.message || err}`);
      return { ingresosDiarios: [], ticketPorMes: [], ticketPorAnio: [], fichasFallidas: 0 };
    }),
  ]);

  const pacientesTotales = await calcularPacientesTotales().catch((err) => {
    errores.push(`pacientes totales: ${err?.message || err}`);
    return { total: null, totalFichas: null, totalSoloTurno: null, fichas: [], soloTurno: [], error: err?.message || String(err) };
  });

  // Deuda, finanzas y público objetivo comparten el escaneo iniciado por
  // calcularFinanzasPacientes. Mantenerlos en esta misma invocación evita que el
  // navegador abra tres recorridos independientes por cientos de planillas.
  let deuda;
  try {
    deuda = { success: true, ...(await calcularDeuda(false)), fichasFallidas: (await escanearFichasAdmin()).fallidos };
  } catch (err) {
    errores.push(`deuda: ${err?.message || err}`);
    deuda = { success: false, error: err?.message || String(err) };
  }
  let publico;
  try {
    publico = await new Promise((resolve, reject) => {
      const falsoRes = { status() { return falsoRes; }, json(data) { resolve(data); return falsoRes; } };
      Promise.resolve(calcularPerfilJson({ query: {} }, falsoRes)).catch(reject);
    });
  } catch (err) {
    errores.push(`público objetivo: ${err?.message || err}`);
    publico = { success: false, error: err?.message || String(err), filas: [] };
  }

  res.status(200).json({
    ...(errores.length ? { errores } : {}),
    ocupacion: { actual: ocupacionActual, siguiente: ocupacionSiguiente },
    inasistenciaMensual,
    ingresosDiarios: finanzas.ingresosDiarios,
    ticketPorMes: finanzas.ticketPorMes,
    ticketPorAnio: finanzas.ticketPorAnio,
    cobrosPorFormaPago: finanzas.cobrosPorFormaPago || [],
    dolarError: finanzas.dolarError || null,
    pacientesTotales,
    deuda,
    publico,
    fichasFallidas: finanzas.fichasFallidas,
    totalFichasEscaneadas: finanzas.totalFichasEscaneadas,
  });
}

// ---------- 5. Exportaciones ----------

async function exportPacientesCsv(req, res) {
  const drive = getPacientesDriveClient();
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  }));
  const archivos = (data.files || []).filter((f) => !/^⭐/.test(f.name));
  const filas = archivos
    .map((f) => {
      const { nombre, apellido, dni } = parsearNombreArchivo(f.name);
      return [nombre, apellido, dni];
    })
    .sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`, 'es'));

  const csv = ['Nombre,Apellido,DNI', ...filas.map((f) => f.map(csvEscape).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pacientes.csv"');
  res.status(200).send('﻿' + csv);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Un Content-Disposition con tildes/ñ sin encodear (ej. "José" o "Núñez", nombres
// reales comunes acá) hace que Node tire ERR_INVALID_CHAR al setear el header — bug
// real encontrado en producción, 2026-08-13 ("Error inesperado" al exportar la ficha
// de un paciente con nombre acentuado). Se sacan los diacríticos para el filename
// (solo afecta el nombre de archivo sugerido, no el contenido del PDF).
function nombreArchivoSeguro(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim() || 'archivo';
}

async function exportTurnos(req, res) {
  const { desde, hasta, formato } = req.query;
  const calendar = getCalendarClient();
  const timeMin = toArgDate(desde, '00:00').toISOString();
  const timeMax = new Date(toArgDate(hasta, '00:00').getTime() + 24 * 60 * 60000).toISOString();

  const [principal, sobreturnos] = await Promise.all([
    conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, maxResults: 2500 })),
    conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, timeMin, timeMax, singleEvents: true, maxResults: 2500 })),
  ]);

  const filas = [
    ...(principal.data.items || []).map((ev) => ({ ev, tipo: 'Turno' })),
    ...(sobreturnos.data.items || []).map((ev) => ({ ev, tipo: 'Sobreturno' })),
  ]
    .filter(({ ev }) => !(ev.description || '').includes(BLOCK_MARKER))
    .map(({ ev, tipo }) => {
      const { start } = eventBounds(ev);
      return {
        fecha: formatArgDay(start),
        hora: formatArgTime(start),
        paciente: ev.summary || '',
        tipo,
        telefono: extraerTelefono(ev.description),
        confirmado: extraerConfirmado(ev.description) ? 'Sí' : 'No',
      };
    })
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));

  if (formato === 'pdf') {
    const { generarPdfTabla } = await import('../../lib/pdfExport.js');
    const buffer = await generarPdfTabla({
      titulo: `Turnos ${desde} a ${hasta}`,
      columnas: ['Fecha', 'Hora', 'Paciente', 'Tipo', 'Teléfono', 'Confirmado'],
      filas: filas.map((f) => [f.fecha, f.hora, f.paciente, f.tipo, f.telefono, f.confirmado]),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="turnos_${desde}_${hasta}.pdf"`);
    return res.status(200).send(buffer);
  }

  const csv = [
    'Fecha,Hora,Paciente,Tipo,Teléfono,Confirmado',
    ...filas.map((f) => [f.fecha, f.hora, f.paciente, f.tipo, f.telefono, f.confirmado].map(csvEscape).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="turnos_${desde}_${hasta}.csv"`);
  res.status(200).send('﻿' + csv);
}

// Ficha completa (datos + movimientos + prestaciones) en PDF.
async function exportFichaPdf(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });

  const ficha = await leerFichaSupabase(id);
  if (ficha) {
    const movimientosDb = await leerMovimientosSupabase(id);
    const movimientos = (movimientosDb || ficha.movimientos || []).map((m) => ({ fecha: m.fecha || '', tratamiento: m.tratamiento || '', debe: m.debe || '', haber: m.haber || '', saldo: m.saldo || '', formaPago: m.formaPago || m.forma_pago || '' })).filter((m) => m.fecha || m.tratamiento);
    const campos = Object.fromEntries(['nombre','apellido','dni','fechaNacimiento','domicilio','localidad','obraSocial','nAfiliado','plan','telefono','planTratamiento'].map((k) => [k, ficha.campos?.[k] || '']));
    const { generarPdfFicha } = await import('../../lib/pdfExport.js');
    const buffer = await generarPdfFicha({ campos, financiero: ficha.financiero || {}, movimientos, mostrarFormaPago: true });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(campos.nombre)}_${nombreArchivoSeguro(campos.apellido)}_ficha.pdf"`);
    return res.status(200).send(buffer);
  }
  const sheets = getPacientesSheetsClient();
  const [campos, financiero, movRaw] = await Promise.all([
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C15` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!E6:F11` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B18:H2000` })),
  ]);

  const c = (campos.data.values || []).map((r) => r[0] || '');
  const [nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento] = c;
  const f = financiero.data.values || [];
  const movimientos = (movRaw.data.values || [])
    .map((row) => ({ fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '', formaPago: row[6] || '' }))
    .filter((m) => m.fecha || m.tratamiento);

  const { generarPdfFicha } = await import('../../lib/pdfExport.js');
  const buffer = await generarPdfFicha({
    campos: { nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento },
    financiero: { total: f[0]?.[1] || '$0,00', pagado: f[1]?.[1] || '$0,00', saldo: f[2]?.[1] || '$0,00' },
    movimientos,
    mostrarFormaPago: true,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(nombre)}_${nombreArchivoSeguro(apellido)}_ficha.pdf"`);
  res.status(200).send(buffer);
}

// Estado de cuenta SIN método de pago — para cuando un paciente reclama que ya pagó
// (ver el pedido, sección 5): fecha, tratamiento, debe, haber, saldo nada más.
async function exportFinancieroPdf(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false, message: 'Falta id.' });

  const ficha = await leerFichaSupabase(id);
  if (ficha) {
    const movimientosDb = await leerMovimientosSupabase(id);
    const movimientos = (movimientosDb || ficha.movimientos || []).map((m) => ({ fecha: m.fecha || '', tratamiento: m.tratamiento || '', debe: m.debe || '', haber: m.haber || '', saldo: m.saldo || '' })).filter((m) => m.fecha || m.tratamiento);
    const { generarPdfFicha } = await import('../../lib/pdfExport.js');
    const buffer = await generarPdfFicha({ campos: { nombre: ficha.campos?.nombre || '', apellido: ficha.campos?.apellido || '' }, movimientos, mostrarFormaPago: false, soloFinanciero: true });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(ficha.campos?.nombre)}_${nombreArchivoSeguro(ficha.campos?.apellido)}_estado_cuenta.pdf"`);
    return res.status(200).send(buffer);
  }
  const sheets = getPacientesSheetsClient();
  const [campos, movRaw] = await Promise.all([
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!C5:C6` })),
    conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${SHEET_NAME}!B18:F2000` })),
  ]);
  const [nombre, apellido] = (campos.data.values || []).map((r) => r[0] || '');
  const movimientos = (movRaw.data.values || [])
    .map((row) => ({ fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '' }))
    .filter((m) => m.fecha || m.tratamiento);

  const { generarPdfFicha } = await import('../../lib/pdfExport.js');
  const buffer = await generarPdfFicha({
    campos: { nombre, apellido },
    movimientos,
    mostrarFormaPago: false,
    soloFinanciero: true,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoSeguro(nombre)}_${nombreArchivoSeguro(apellido)}_estado_cuenta.pdf"`);
  res.status(200).send(buffer);
}

// ---------- 5b. Perfil ANÓNIMO de pacientes (2026-09-24) ----------
// Para el trabajo de Buyer Persona de la facu: solo conteos y porcentajes, nunca una fila
// por paciente. La agregación está en lib/perfilPacientes.js (funciones puras); acá solo
// se lee lo mínimo y NO identificable:
//   - Fichas: C8 (fecha de nacimiento), C10:C11 (localidad, obra social), C15 (plan de
//     tratamiento) y los movimientos. Nombre/apellido/DNI (C5:C7), domicilio (C9), Nº de
//     afiliado (C12) y teléfono (C14) NO se piden a la API. El escaneo compartido
//     agrega además los saldos y movimientos que usan las métricas financieras.
//   - Calendar: fecha/hora y la description (marca de paciente nuevo, carga manual,
//     motivo → solo su categoría). El título del evento (= nombre del paciente) no se usa.
//   - Planilla consolidada: solo las columnas numéricas de asistencia/visitas.
// No modifica fichas ni turnos: solo lee (la planilla consolidada se lee con la misma
// función que usa el dashboard de métricas). Las fichas comparten el escaneo acotado
// de admin para evitar recorridos repetidos.
async function exportPerfilPacientes(req, res) {
  const meses = Math.min(Math.max(Number(req.query.meses) || 12, 1), 36);
  const errores = [];

  // ---- Fichas ----
  let escaneo;
  try {
    escaneo = await escanearFichasAdmin(!!req.query.forzar);
  } catch (err) {
    errores.push(`fichas: ${err?.message || err}`);
    escaneo = { fichas: [], total: 0, fallidos: 0 };
  }
  // La salida anónima recibe solo los campos permitidos por lib/perfilPacientes.js;
  // nombres, DNI, contacto y domicilio se descartan antes de construir el perfil.
  const fichas = escaneo.fichas.map((f) => ({
    fechaNacimiento: f.fechaNacimiento, localidad: f.localidad, obraSocial: f.obraSocial,
    planTratamiento: f.planTratamiento,
    movimientos: f.movimientos.map((m) => ({ fecha: m.fecha, tratamiento: m.tratamiento, debe: m.debe, haber: m.haber, formaPago: m.formaPago })),
  }));
  const fichasFallidas = escaneo.fallidos;

  // ---- Turnos ----
  const turnos = [];
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - meses * 30.44 * 24 * 60 * 60000);
  try {
    const calendar = getCalendarClient();
    const listarTodo = async (calendarId) => {
      let items = [];
      let pageToken;
      do {
        const { data } = await conReintentos(() => calendar.events.list({
          calendarId, timeMin: desde.toISOString(), timeMax: hasta.toISOString(),
          singleEvents: true, maxResults: 2500, pageToken,
          fields: 'items(start,end,description),nextPageToken',
        }));
        items = items.concat(data.items || []);
        pageToken = data.nextPageToken;
      } while (pageToken);
      return items;
    };
    const [principal, sobre] = await Promise.all([listarTodo(CALENDAR_ID), listarTodo(SOBRETURNOS_CALENDAR_ID)]);
    const diaSemanaArg = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' });
    const DIA_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    [...principal.map((ev) => ({ ev, tipo: 'turno' })), ...sobre.map((ev) => ({ ev, tipo: 'sobreturno' }))]
      .filter(({ ev }) => ev.start?.dateTime && !(ev.description || '').includes(BLOCK_MARKER))
      .forEach(({ ev, tipo }) => {
        const { start } = eventBounds(ev);
        const desc = ev.description || '';
        turnos.push({
          inicio: {
            dia: DIA_IDX[diaSemanaArg.format(start)],
            hora: Number(formatArgTime(start).slice(0, 2)),
            fechaISO: formatArgDay(start),
          },
          tipo,
          esNuevo: extraerEsNuevoPaciente(desc),
          cargadoManual: desc.includes('Cargado manualmente desde el panel de gestión'),
          motivo: extraerMotivo(desc),
        });
      });
  } catch (err) {
    errores.push(`turnos: ${err?.message || err}`);
  }

  // ---- Visitas / asistencia ----
  let consolidados = [];
  try {
    consolidados = (await listarPacientesConsolidados({ cache: true }))
      .map((c) => ({ visitas: c.visitas, turnosPasados: c.turnosPasados, turnosAsistidos: c.turnosAsistidos }));
  } catch (err) {
    errores.push(`consolidados: ${err?.message || err}`);
  }

  if (!fichas.length && !turnos.length) {
    return res.status(200).json({ success: false, error: `No se pudieron leer datos. ${errores.join(' · ')}` });
  }

  const { filas } = construirPerfil({
    fichas, turnos, consolidados,
    meta: { fichasFallidas, rangoTurnos: `${formatArgDay(desde)} a ${formatArgDay(hasta)} (últimos ${meses} meses)` },
  });
  errores.forEach((e) => filas.unshift(['Resumen', 'Aviso: parte de los datos no se pudo leer', e, 0, null]));

  if (req.query.formato === 'json') return res.status(200).json({ success: true, filas });

  const hoyStr = formatArgDay(new Date());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="perfil_pacientes_anonimo_${hoyStr}.csv"`);
  res.status(200).send('﻿' + perfilACsv(filas));
}

// ---------- 5c. Export COMPLETO de pacientes: Excel (.xlsx) y Markdown (.md) (2026-09-24) ----------
// Botón "Exportar todos los datos" de /admin → Datos de pacientes. Una fila por paciente
// con TODOS los campos de la ficha (incluye datos personales: solo ADMIN_KEY, nunca
// GESTION_KEY), más hojas de movimientos y prestaciones a obra social, y los pacientes
// que solo sacaron turno (planilla consolidada). Armado del archivo en
// lib/exportPacientesCompleto.js. Solo lectura: no llama a intentarRecuperarRespaldos()
// ni escribe nada en las fichas. Lotes de 25 como el resto de los escaneos de fichas.
async function exportPacientesCompleto(req, res) {
  const formato = req.query.formato === 'md' ? 'md' : 'xlsx';
  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();

  let archivos = [];
  let pageToken;
  do {
    const { data } = await conReintentos(() => drive.files.list({
      q: `'${PACIENTES_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id, name), nextPageToken',
      pageSize: 250,
      pageToken,
    }));
    archivos = archivos.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  archivos = archivos.filter((f) => !/^⭐/.test(f.name));

  const fichas = [];
  const fallidas = [];
  const limpia = (v) => (v === true || v === false || v === 'TRUE' || v === 'FALSE' ? '' : (v ?? ''));
  const LOTE = 25;
  for (let i = 0; i < archivos.length; i += LOTE) {
    const lote = archivos.slice(i, i + LOTE);
    const resultados = await Promise.all(lote.map(async (f) => {
      try {
        const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: f.id,
          ranges: [`${SHEET_NAME}!C5:C15`, `${SHEET_NAME}!E6:F11`, rangoMovimientos(), rangoPrestacionesObraSocial()],
        }));
        const [camposRaw, finRaw, movRaw, presRaw] = data.valueRanges || [];
        const c = (camposRaw?.values || []).map((r) => (r[0] != null ? String(r[0]) : ''));
        while (c.length < 11) c.push('');
        const [nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento] = c;
        const fin = finRaw?.values || [];
        return {
          id: f.id,
          campos: { nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento },
          // Mismas celdas que obtenerFicha() de pacientes.js: total/pagado/saldo en F6:F8,
          // "AL DÍA"/"DEBE $X" en la celda ancla E9.
          financiero: { total: fin[0]?.[1] || '', pagado: fin[1]?.[1] || '', saldo: fin[2]?.[1] || '', estado: fin[3]?.[0] || '' },
          movimientos: (movRaw?.values || []).map((row) => ({
            fecha: row[0] || '', tratamiento: limpia(row[1]), debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '', formaPago: limpia(row[6]),
          })),
          prestaciones: (presRaw?.values || []).map((row) => ({
            fecha: row[0] || '', tratamiento: limpia(row[1]), codigo: limpia(row[2]), autorizado: row[3] === true || row[3] === 'TRUE',
          })),
        };
      } catch (err) {
        console.warn(`[admin.js] export completo: no se pudo leer la ficha ${f.name}:`, err?.message || err);
        return { fallida: f.name };
      }
    }));
    resultados.forEach((r) => { if (r.fallida) fallidas.push(r.fallida); else fichas.push(r); });
  }

  let consolidados = [];
  try {
    consolidados = await listarPacientesConsolidados({ cache: true });
  } catch (err) {
    console.warn('[admin.js] export completo: no se pudo leer la planilla consolidada:', err?.message || err);
  }

  const hojas = armarHojas({ fichas, consolidados });
  if (fallidas.length) {
    hojas.push({
      nombre: 'Fichas no leídas',
      columnas: [{ titulo: 'Archivo de la ficha (reintentar el export)', tipo: 'texto', ancho: 50 }],
      filas: fallidas.map((n) => [n]),
    });
  }

  const hoyStr = formatArgDay(new Date());
  res.setHeader('Cache-Control', 'no-store');
  if (formato === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pacientes_${hoyStr}.md"`);
    return res.status(200).send(crearMarkdown(hojas, { generado: hoyStr }));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pacientes_${hoyStr}.xlsx"`);
  res.status(200).send(Buffer.from(crearXlsx(hojas)));
}
