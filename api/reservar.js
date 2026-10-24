import { formatearDniConPuntos } from '../lib/dni.js';
import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, SLOT_MINUTES, TIME_ZONE,
  toArgDate, eventBounds, crearTurno, formatArgDay, formatArgTime,
  extraerTelefono, extraerMotivo, extraerEsNuevoPaciente, extraerConfirmado, escribirConfirmado,
  extraerConfirmacionSolicitada, extraerCodigoCorto, asegurarCodigoCorto, extraerDni, extraerEmail, generarCodigoCorto,
  telefonoParaWhatsApp,
} from '../lib/googleCalendar.js';
import { avisarFallo } from '../lib/alertas.js';
import { rpcAdmin } from '../lib/adminSupabase.js';
import { firmarToken, secretoAutoficha } from '../lib/autoficha.js';
import { conReintentos } from '../lib/retry.js';
import { obtenerHorariosConfig, logActividad } from '../lib/adminConfig.js';
import { espejarTurnosBestEffort } from '../lib/espejoTurnos.js';
import { agendaPrimariaActiva, escribirAgendaRpc, leerAgendaRpc } from '../lib/agendaSupabase.js';
import { aTituloCase } from '../lib/pacientesSheet.js';

// El ticket térmico imprime un QR también para sobreturnos (ver gestion/index.html),
// así que "obtener"/"cancelar" tienen que poder apuntar a SOBRETURNOS_CALENDAR_ID —
// nunca a un calendario arbitrario que mande el cliente: whitelist de los dos ids
// válidos, cualquier otra cosa cae al default de siempre (CALENDAR_ID).
function resolverCalendarId(calendarId) {
  return calendarId === SOBRETURNOS_CALENDAR_ID ? SOBRETURNOS_CALENDAR_ID : CALENDAR_ID;
}

export default async function handler(req, res) {
  // Link corto /t/CODIGO (rewrite en vercel.json, "/t/:codigo" -> "/api/reservar?codigo=:codigo")
  // — público, GET, sin key. Ver resolverCodigoCorto más abajo.
  if (req.method === 'GET' && req.query.codigo) {
    return resolverCodigoCorto(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { accion } = req.body;
  // Mover/cancelar/consultar el turno, sin key: solo alcanza con el eventId — mismo
  // modelo de seguridad para las tres (ver decisions.md, "Modificar turno desde la
  // confirmación"). El nuevo horario de "mover" siempre sale del calendario/duración
  // normal (CALENDAR_ID, 30 min) — si el eventId que se mueve es un sobreturno
  // (calendarId = SOBRETURNOS_CALENDAR_ID), esto convierte el sobreturno en turno
  // común en vez de solo reprogramarlo (ver moverPropio). "obtener"/"cancelar" ya
  // aceptaban un calendarId whitelisteado para poder mostrar/cancelar sobreturnos.
  if (accion === 'cancelar') return cancelarPropio(req, res);
  if (accion === 'mover') return moverPropio(req, res);
  if (accion === 'obtener') return obtenerPropio(req, res);
  if (accion === 'confirmar') return confirmarPropio(req, res);
  if (accion === 'buscar-email') return buscarEmailGuardado(req, res);

  try {
    const { date, time, nombre, apellido, telefono, dni, email, motivo, esNuevo } = req.body;
    const { slotMinutes } = await obtenerHorariosConfig();
    if (agendaPrimariaActiva()) {
      if (!telefono || !telefono.trim()) return res.status(200).json({ success: false, message: 'El teléfono es obligatorio.' });
      const tel = telefonoParaWhatsApp(telefono);
      if (!tel) return res.status(200).json({ success: false, message: 'Ese teléfono no parece válido. Revisalo e intentá de nuevo.' });
      const title = `${aTituloCase(nombre)} ${aTituloCase(apellido) || ''}`.trim();
      const start = toArgDate(date, time);
      const payload = { inicio: start.toISOString(), fin: new Date(start.getTime() + slotMinutes * 60000).toISOString(), tipo: 'turno', paciente_nombre: title,
        dni: String(dni || '').replace(/\D/g, ''), telefono: tel, email, motivo, paciente_nuevo: !!esNuevo, telefono_verificado: true,
        confirmado: false, confirmacion_solicitada: false, codigo_corto: generarCodigoCorto(), ubicacion: 'Ameghino 410, E3260 Concepción del Uruguay, Entre Ríos, Argentina',
        description_original: `Teléfono: ${tel}\nTeléfono verificado: Sí\nDNI: ${formatearDniConPuntos(dni) || '-'}\nEmail: ${email || '-'}\nMotivo: ${motivo || '-'}\nPaciente nuevo: ${esNuevo ? 'Sí' : 'No'}`, calendar_id: CALENDAR_ID };
      const data = await escribirAgendaRpc('consultorio_agenda_crear_turno', payload);
      if (!data.ok) return res.status(200).json({ success: false, message: data.message || 'Justo se ocupó ese horario. Por favor elegí otro disponible.' });
      await logActividad({ tipo: 'turno_creado', detalle: `${nombre} ${apellido} — ${date} ${time}`, actor: 'paciente (/turnos)' });
      if (!data.repetido) await espejarTurnoNuevo(data.id, payload);
      return res.status(200).json({ success: true, message: `Turno confirmado para el ${date} a las ${time} hs (hora Argentina).`, eventId: data.id, codigoCorto: payload.codigo_corto });
    }
    const calendar = getCalendarClient();
    // Misma lógica de creación de turnos que usa el panel de /gestion — ver lib/googleCalendar.js.
    const resultado = await crearTurno(calendar, { date, time, nombre, apellido, telefono, dni, email, motivo, esNuevo, slotMinutes });
    if (resultado.success) {
      await logActividad({ tipo: 'turno_creado', detalle: `${nombre} ${apellido} — ${date} ${time}`, actor: 'paciente (/turnos)' });
    }
    if (resultado.success) await espejarTurnosBestEffort();
    res.status(200).json(resultado);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'crear turno', error: err });
    res.status(500).json({ success: false, message: 'Hubo un error al confirmar el turno. Probá de nuevo.' });
  }
}

async function espejarTurnoNuevo(id, turno) {
  if (process.env.AGENDA_ESPEJAR_CALENDAR === '0') return;
  try {
    const calendar = getCalendarClient();
    const requestBody = { id: String(id).replace(/-/g, ''),
      summary: turno.paciente_nombre, location: turno.ubicacion, description: `${turno.description_original}\nCódigo corto: ${turno.codigo_corto}`,
      start: { dateTime: turno.inicio, timeZone: TIME_ZONE }, end: { dateTime: turno.fin, timeZone: TIME_ZONE },
    };
    let data;
    try { ({ data } = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody })); }
    catch (e) { if (e?.code !== 409 && e?.response?.status !== 409) throw e; ({ data } = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: requestBody.id })); }
    await escribirAgendaRpc('consultorio_agenda_guardar_calendar_id', { id, calendar_event_id: data.id });
  } catch (e) { console.error('No se pudo espejar turno en Calendar:', e?.message || e); }
}

async function borrarEspejo(calendarId, eventId) {
  if (!eventId || process.env.AGENDA_ESPEJAR_CALENDAR === '0') return;
  try { await getCalendarClient().events.delete({ calendarId: resolverCalendarId(calendarId), eventId }); }
  catch (e) { console.error('No se pudo borrar espejo de Calendar:', e?.message || e); }
}

async function espejarEventoActualizado(turno, cambios) {
  if (process.env.AGENDA_ESPEJAR_CALENDAR === '0') return;
  try {
    const calendar = getCalendarClient();
    if (cambios.calendar_id && cambios.calendar_id !== turno.calendar_id && turno.id) {
      const requestBody = { id: String(turno.id).replace(/-/g, ''),
        summary: turno.paciente_nombre || '', location: turno.ubicacion || '', description: turno.description_original || '',
        start: { dateTime: cambios.inicio, timeZone: TIME_ZONE }, end: { dateTime: cambios.fin, timeZone: TIME_ZONE },
      };
      let nuevo;
      try { ({ data: nuevo } = await calendar.events.insert({ calendarId: cambios.calendar_id, requestBody })); }
      catch (e) { if (e?.code !== 409 && e?.response?.status !== 409) throw e; ({ data: nuevo } = await calendar.events.get({ calendarId: cambios.calendar_id, eventId: requestBody.id })); }
      await escribirAgendaRpc('consultorio_agenda_guardar_calendar_id', { id: turno.id, calendar_event_id: nuevo.id });
      if (turno.calendar_event_id) try { await calendar.events.delete({ calendarId: resolverCalendarId(turno.calendar_id), eventId: turno.calendar_event_id }); } catch { /* el evento nuevo ya quedó creado */ }
      return;
    }
    if (!turno.calendar_event_id) return;
    const requestBody = {};
    if (cambios.inicio) { requestBody.start = { dateTime: cambios.inicio, timeZone: TIME_ZONE }; requestBody.end = { dateTime: cambios.fin, timeZone: TIME_ZONE }; }
    if (typeof cambios.confirmado === 'boolean') {
      const { data } = await calendar.events.get({ calendarId: resolverCalendarId(turno.calendar_id), eventId: turno.calendar_event_id });
      requestBody.description = escribirConfirmado(data.description || '', cambios.confirmado);
    }
    if (Object.keys(requestBody).length) await calendar.events.patch({ calendarId: resolverCalendarId(turno.calendar_id), eventId: turno.calendar_event_id, requestBody });
  } catch (e) { console.error('No se pudo actualizar espejo de Calendar:', e?.message || e); }
}

// Email condicional (ver el pedido): si ya hay un email guardado de un turno
// anterior con el mismo DNI+teléfono, /turnos no vuelve a pedirlo. Búsqueda por
// texto (`q`) del DNI en los dos calendarios, sin límite de fecha (mismo criterio
// que resolverCodigoCorto), confirmando DNI Y teléfono exactos antes de devolver
// nada — `q` es difusa, podría traer falsos positivos.
async function buscarEmailGuardado(req, res) {
  try {
    const { dni, telefono } = req.body;
    const dniNorm = String(dni || '').replace(/\D/g, '');
    if (!dniNorm || !telefono) return res.status(200).json({ email: null });

    const calendar = getCalendarClient();
    const [principal, principalPuntos, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, q: dniNorm, maxResults: 50, singleEvents: true })),
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, q: formatearDniConPuntos(dniNorm), maxResults: 50, singleEvents: true })),
      conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, q: dniNorm, maxResults: 50, singleEvents: true })),
    ]);
    const candidatos = [...(principal.data.items || []), ...(principalPuntos.data.items || []), ...(sobreturnos.data.items || [])];

    for (const ev of candidatos) {
      const desc = ev.description || '';
      if (extraerDni(desc).replace(/\D/g, '') !== dniNorm) continue;
      if (extraerTelefono(desc) !== telefono && normalizarComparacionTelefono(extraerTelefono(desc)) !== normalizarComparacionTelefono(telefono)) continue;
      const email = extraerEmail(desc);
      if (email) return res.status(200).json({ email });
    }
    res.status(200).json({ email: null });
  } catch (err) {
    console.error(err);
    res.status(200).json({ email: null }); // nunca bloquear el formulario de /turnos por esto
  }
}

// Últimos 10 dígitos, para que un teléfono guardado con o sin código de país siga
// matcheando (mismo criterio que normalizarTelefonoMapeo en lib/pacientesSheet.js).
function normalizarComparacionTelefono(tel) {
  return (tel || '').replace(/\D/g, '').slice(-10);
}

// Punto de entrada del QR del ticket térmico (ver gestion/index.html): dado un
// eventId, devuelve nombre/fecha/hora para que /turnos pueda mostrar "Tu turno" y
// habilitar Cambiar día y horario / Cancelar sin haber pasado por la reserva en esa
// misma carga de página. Mismo modelo de seguridad que mover/cancelar (conocer el
// id alcanza) — no expone teléfono ni nada más de la description.
async function obtenerPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a consultar.' });
    }
    if (agendaPrimariaActiva()) {
      const resultado = await leerAgendaRpc('consultorio_agenda_por_id', { p_id: eventId }, { timeoutMs: 2200 });
      let ev = Array.isArray(resultado) ? resultado[0] : resultado;
      if (resultado !== null) {
        if (!ev || ev.estado === 'cancelado') return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
        if (!ev.codigo_corto) {
          const actualizado = await escribirAgendaRpc('consultorio_agenda_asegurar_codigo', { id: eventId, codigo_corto: generarCodigoCorto() });
          ev = actualizado.turno || ev;
        }
        const start = new Date(ev.inicio);
        return res.status(200).json({ success: true, nombre: ev.paciente_nombre || '', date: formatArgDay(start), time: formatArgTime(start), confirmado: !!ev.confirmado,
          confirmacionSolicitada: !!ev.confirmacion_solicitada, codigoCorto: ev.codigo_corto || '' });
      }
    }
    const calendar = getCalendarClient();
    const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId: resolverCalendarId(calendarId), eventId }));
    // Un turno recién cancelado no siempre tira error en events.get de entrada —
    // Google Calendar puede devolver el recurso igual con status: 'cancelled'
    // (tombstone) en vez de un 404 inmediato. Bug real encontrado probando el QR
    // de punta a punta: sin este chequeo, un turno ya cancelado seguía
    // mostrándose como válido (con botones de Cambiar/Cancelar de nuevo).
    if (ev.status === 'cancelled') {
      return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
    }
    const { start } = eventBounds(ev);
    // Asegura el código corto acá también (turnos viejos, creados antes de este
    // cambio, podrían no tenerlo todavía) — así /turnos puede armar el link corto
    // para "Guardar acceso a mi turno" sin importar por dónde se llegó a esta pantalla.
    const codigoCorto = await asegurarCodigoCorto(calendar, resolverCalendarId(calendarId), eventId, ev.description || '');
    res.status(200).json({
      success: true,
      nombre: ev.summary || '',
      date: formatArgDay(start),
      time: formatArgTime(start),
      confirmado: extraerConfirmado(ev.description || ''),
      confirmacionSolicitada: extraerConfirmacionSolicitada(ev.description || ''),
      codigoCorto,
    });
  } catch (err) {
    // events.get tira si el turno ya no existe (cancelado, o id inválido/de otro
    // calendario) — se trata como "no encontrado" sin filtrar el motivo exacto.
    console.error(err);
    res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
  }
}

// Resuelve el link corto /t/CODIGO -> redirige (302) al link largo real
// (/turno?eventId=...&calendarId=...&tipo=...). Público, sin key: el código de 6
// caracteres cumple el mismo rol que el eventId largo (conocerlo alcanza), ver
// decisions.md sobre el modelo de seguridad de mover/cancelar/obtener/confirmar.
// Busca por texto (`q`) en los dos calendarios, sin límite de fecha — mismo criterio
// que telefonoDesdeTurnos en api/gestion/pacientes.js — y confirma el match EXACTO
// contra la description antes de redirigir, porque `q` es búsqueda difusa (podría
// devolver falsos positivos si el código apareciera suelto en otro campo).
async function resolverCodigoCorto(req, res) {
  const codigo = (req.query.codigo || '').toString().trim().toUpperCase();
  if (!codigo) return paginaLinkInvalido(res);

  try {
    if (agendaPrimariaActiva()) {
      const encontrado = await leerAgendaRpc('consultorio_agenda_por_codigo', { p_codigo: codigo }, { timeoutMs: 2200 });
      if (encontrado !== null) {
        const row = Array.isArray(encontrado) ? encontrado[0] : encontrado;
        if (!row) return paginaLinkInvalido(res);
        if (req.query.confirmar) {
          const ua = String(req.headers['user-agent'] || '');
          const esRobot = req.method === 'HEAD' || /bot|crawl|spider|preview|whatsapp|facebookexternalhit|slack|telegram|embedly|curl|wget|python|node-fetch/i.test(ua);
          const start = new Date(row.inicio);
          const detalle = `${row.paciente_nombre || 'tu turno'} — ${formatArgDay(start)} a las ${formatArgTime(start)}hs`;
          if (esRobot) return paginaConfirmacion(res, { confirmado: false, detalle });
          const confirmado = await escribirAgendaRpc('consultorio_agenda_confirmar', { id: row.id, confirmado: true });
          await espejarEventoActualizado(confirmado.turno || row, { confirmado: true });
          await logActividad({ tipo: 'turno_confirmado', detalle: `${row.paciente_nombre || 'paciente'} — ${formatArgDay(start)} ${formatArgTime(start)}hs`, actor: 'paciente (link)' });
          return paginaConfirmacion(res, { confirmado: true, detalle });
        }
        const params = new URLSearchParams({ eventId: row.id });
        return res.redirect(302, `/turno?${params.toString()}`);
      }
    }
    const calendar = getCalendarClient();
    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({ calendarId: CALENDAR_ID, q: codigo, maxResults: 50, singleEvents: true })),
      conReintentos(() => calendar.events.list({ calendarId: SOBRETURNOS_CALENDAR_ID, q: codigo, maxResults: 50, singleEvents: true })),
    ]);

    const candidatos = [
      ...(principal.data.items || []).map((ev) => ({ ev, calendarId: CALENDAR_ID })),
      ...(sobreturnos.data.items || []).map((ev) => ({ ev, calendarId: SOBRETURNOS_CALENDAR_ID })),
    ];
    const match = candidatos.find(({ ev }) => ev.status !== 'cancelled' && extraerCodigoCorto(ev.description) === codigo);
    if (!match) return paginaLinkInvalido(res);

    // Link de confirmación (/c/CODIGO): al abrirlo el turno queda confirmado, sin tocar
    // ningún botón. Los "robots" que arman la vista previa del link (WhatsApp, etc.) NO
    // confirman: solo ven una página neutra. Confirmar de nuevo no hace daño (idempotente).
    if (req.query.confirmar) {
      const ua = String(req.headers['user-agent'] || '');
      const esRobot = req.method === 'HEAD' || /bot|crawl|spider|preview|whatsapp|facebookexternalhit|slack|telegram|embedly|curl|wget|python|node-fetch/i.test(ua);
      const { start } = eventBounds(match.ev);
      const detalle = `${match.ev.summary || 'tu turno'} — ${formatArgDay(start)} a las ${formatArgTime(start)}hs`;
      if (esRobot) return paginaConfirmacion(res, { confirmado: false, detalle });
      if (!extraerConfirmado(match.ev.description)) {
        await conReintentos(() => calendar.events.patch({
          calendarId: match.calendarId, eventId: match.ev.id,
          requestBody: { description: escribirConfirmado(match.ev.description || '', true) },
        }));
        await logActividad({ tipo: 'turno_confirmado', detalle: `${match.ev.summary || 'paciente'} — ${formatArgDay(start)} ${formatArgTime(start)}hs`, actor: 'paciente (link)' });
        await espejarTurnosBestEffort();
      }
      // Botón "Revisar mis datos": lleva al mismo formulario del QR, con un acceso de 1 hora a
      // SU ficha. Solo si se la identifica sin dudas (DNI; o teléfono único si no hay DNI).
      let datos = '';
      try {
        const desc = match.ev.description || '';
        const fichaId = await rpcAdmin('consultorio_ficha_por_identidad', { p_dni: extraerDni(desc) || '', p_telefono: extraerTelefono(desc) || '' });
        if (typeof fichaId === 'string' && fichaId && process.env.GESTION_KEY) {
          datos = `/mis-datos/?t=${firmarToken({ fichaId, ttlMs: 3600 * 1000, secreto: secretoAutoficha(process.env.GESTION_KEY) })}`;
        }
      } catch { /* sin botón de datos, el turno igual quedó confirmado */ }
      return paginaConfirmacion(res, { confirmado: true, detalle, datos });
    }

    const params = new URLSearchParams({ eventId: match.ev.id });
    if (match.calendarId === SOBRETURNOS_CALENDAR_ID) {
      params.set('calendarId', match.calendarId);
      params.set('tipo', 'sobreturno');
    }
    res.redirect(302, `/turno?${params.toString()}`);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'resolver código corto', error: err });
    paginaLinkInvalido(res);
  }
}

function escaparHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function paginaConfirmacion(res, { confirmado, detalle, datos }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Confirmación de turno | Franco Vinzón Odontólogo</title>
<meta property="og:title" content="Confirmá tu turno"><meta property="og:description" content="Franco Vinzón Odontólogo">
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #FAF9F6; color: #2A2A2A; margin: 0; padding: 40px 20px; text-align: center; }
  .box { max-width: 380px; margin: 60px auto 0; background: #FFFFFF; border-radius: 22px; padding: 32px 24px; box-shadow: 0 2px 18px rgba(30,58,95,.08); }
  .ok { font-size: 44px; margin-bottom: 6px; }
  h1 { font-size: 20px; color: #1E3A5F; margin: 0 0 10px; font-family: Georgia, serif; }
  p { font-size: 14.5px; line-height: 1.5; color: #6B6656; margin: 0 0 16px; }
  a.btn { display: inline-block; background: #1E3A5F; color: #fff; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 22px; border-radius: 12px; }
</style></head>
<body><div class="box">
  <div class="ok">${confirmado ? '✅' : '🦷'}</div>
  <h1>${confirmado ? '¡Turno confirmado!' : 'Franco Vinzón Odontólogo'}</h1>
  <p>${escaparHtml(detalle)}</p>
  <p>${confirmado ? 'Gracias por avisarnos. ¡Te esperamos!' : 'Abrí este link desde tu celular para confirmar el turno.'}</p>
  ${confirmado && datos ? `<p style="margin-bottom:10px">¿Querés corroborar que tus datos estén bien?</p><a class="btn" href="${escaparHtml(datos)}">Revisar mis datos</a>` : ''}
  ${confirmado ? '<p style="margin:18px 0 0;font-size:12.5px">Si necesitás cancelar o cambiar el turno, escribile a la secretaria.</p>' : ''}
</div></body></html>`);
}

// Página simple (sin depender de ningún archivo estático) para un código corto
// inválido o vencido (turno cancelado, o alguien tipeó mal el link) — mismo número de
// WhatsApp del consultorio que usa el resto del sitio.
function paginaLinkInvalido(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(404).send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Link no válido | Franco Vinzón Odontólogo</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #FAF9F6; color: #2A2A2A; margin: 0; padding: 40px 20px; text-align: center; }
  .box { max-width: 380px; margin: 60px auto 0; background: #FFFFFF; border-radius: 22px; padding: 32px 24px; box-shadow: 0 2px 18px rgba(30,58,95,.08); }
  h1 { font-size: 19px; color: #1E3A5F; margin: 0 0 10px; font-family: Georgia, serif; }
  p { font-size: 14px; line-height: 1.5; color: #6B6656; margin: 0 0 20px; }
  a.wa { display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: #25D366; color: #fff; text-decoration: none; font-weight: 600; font-size: 13.5px; padding: 11px 20px; border-radius: 100px; }
</style></head>
<body>
  <div class="box">
    <h1>Este link ya no es válido</h1>
    <p>Puede que el turno haya sido cancelado o que el link haya vencido. Escribinos y te ayudamos.</p>
    <a class="wa" href="https://wa.me/5403442457764">Escribinos por WhatsApp</a>
  </div>
</body></html>`);
}

// Acción 'confirmar' — el paciente toca "Confirmo el turno" desde /turno (link que
// ahora también va en el mensaje de WhatsApp de recordatorio, ver gestion/index.html).
// Mismo modelo de seguridad que obtener/mover/cancelar: conocer el eventId alcanza, sin
// key. A propósito SIN ninguna restricción de fecha (a diferencia de una eventual
// restricción de "no tocar el mismo día" para mover/cancelar): confirmar asistencia el
// mismo día del turno sigue siendo útil, así que esta acción está disponible siempre.
async function confirmarPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a confirmar.' });
    }
    if (agendaPrimariaActiva()) {
      const r = await escribirAgendaRpc('consultorio_agenda_confirmar', { id: eventId, confirmado: true });
      if (!r.ok) return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
      await espejarEventoActualizado(r.turno || { id: eventId }, { confirmado: true });
      return res.status(200).json({ success: true, message: '¡Turno confirmado! Gracias por avisarnos.' });
    }
    const calendar = getCalendarClient();
    const calId = resolverCalendarId(calendarId);
    const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId: calId, eventId }));
    if (ev.status === 'cancelled') {
      return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
    }
    const nuevaDescripcion = escribirConfirmado(ev.description || '', true);
    await conReintentos(() => calendar.events.patch({ calendarId: calId, eventId, requestBody: { description: nuevaDescripcion } }));
    const { start: fechaConfirmado } = eventBounds(ev);
    await logActividad({
      tipo: 'turno_confirmado',
      detalle: `${ev.summary || 'paciente'} — ${formatArgDay(fechaConfirmado)} ${formatArgTime(fechaConfirmado)}hs`,
      actor: 'paciente (/turno)',
    });
    await espejarTurnosBestEffort();
    res.status(200).json({ success: true, message: '¡Turno confirmado! Gracias por avisarnos.' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'confirmar turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo confirmar el turno. Probá de nuevo.' });
  }
}

async function cancelarPropio(req, res) {
  try {
    const { eventId, calendarId } = req.body;
    if (!eventId) {
      return res.status(200).json({ success: false, message: 'Falta el turno a cancelar.' });
    }
    if (agendaPrimariaActiva()) {
      const r = await escribirAgendaRpc('consultorio_agenda_cancelar', { id: eventId });
      if (!r.ok) return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
      await borrarEspejo(r.calendar_id, r.calendar_event_id);
      await logActividad({ tipo: 'turno_cancelado', detalle: eventId, actor: 'paciente (/turno)' });
      return res.status(200).json({ success: true, message: 'Turno cancelado.' });
    }
    const calendar = getCalendarClient();
    const calId = resolverCalendarId(calendarId);
    let detalleLegible = eventId;
    try {
      const { data: ev } = await conReintentos(() => calendar.events.get({ calendarId: calId, eventId }));
      const { start } = eventBounds(ev);
      detalleLegible = `${ev.summary || 'paciente'} — ${formatArgDay(start)} ${formatArgTime(start)}hs`;
    } catch { /* eventId pelado como último recurso, no bloquea la cancelación */ }

    await conReintentos(() => calendar.events.delete({ calendarId: calId, eventId }));
    await logActividad({ tipo: 'turno_cancelado', detalle: detalleLegible, actor: 'paciente (/turno)' });
    await espejarTurnosBestEffort();
    res.status(200).json({ success: true, message: 'Turno cancelado.' });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'cancelar turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo cancelar el turno. Probá de nuevo.' });
  }
}

async function moverPropio(req, res) {
  try {
    const { eventId, date, time, calendarId } = req.body;
    if (!eventId || !date || !time) {
      return res.status(200).json({ success: false, message: 'Faltan datos para reprogramar.' });
    }

    if (agendaPrimariaActiva()) {
      const { slotMinutes } = await obtenerHorariosConfig();
      const inicio = toArgDate(date, time);
      const r = await escribirAgendaRpc('consultorio_agenda_mover', { id: eventId, inicio: inicio.toISOString(), fin: new Date(inicio.getTime() + slotMinutes * 60000).toISOString(), calendar_id: CALENDAR_ID });
      if (!r.ok) return res.status(200).json({ success: false, message: 'Justo se ocupó ese horario. Elegí otro disponible.' });
      const turnoActualizado = r.turno || { id: eventId };
      if (r.calendar_anterior) turnoActualizado.calendar_id = r.calendar_anterior;
      if (r.calendar_event_id_anterior !== undefined) turnoActualizado.calendar_event_id = r.calendar_event_id_anterior;
      await espejarEventoActualizado(turnoActualizado, { inicio: inicio.toISOString(), fin: new Date(inicio.getTime() + slotMinutes * 60000).toISOString(), calendar_id: CALENDAR_ID });
      return res.status(200).json({ success: true, message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`, eventId: r.id || eventId, codigoCorto: r.codigo_corto || '' });
    }

    const calendar = getCalendarClient();
    const origenSobreturno = calendarId === SOBRETURNOS_CALENDAR_ID;
    const newStart = toArgDate(date, time);
    const newEnd = new Date(newStart.getTime() + SLOT_MINUTES * 60000);

    // El horario elegido siempre es del calendario principal (30 min) — tanto para
    // reprogramar un turno común como para convertir un sobreturno en uno — así que
    // el chequeo de solapamiento es siempre contra CALENDAR_ID.
    const { data: existing } = await conReintentos(() => calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: newStart.toISOString(),
      timeMax: newEnd.toISOString(),
      singleEvents: true,
    }));

    const overlapping = (existing.items || []).some((ev) => {
      if (ev.id === eventId) return false;
      const { start: evStart, end: evEnd } = eventBounds(ev);
      return newStart < evEnd && newEnd > evStart;
    });

    if (overlapping) {
      return res.status(200).json({ success: false, message: 'Justo se ocupó ese horario. Elegí otro disponible.' });
    }

    if (origenSobreturno) {
      // Convertir sobreturno -> turno común: el paciente eligió un horario del
      // calendario normal (30 min) desde /turno, que no tiene selector de horarios
      // de sobreturno (15 min) — no alcanza con mover fecha/hora, hay que recrear
      // el evento en el otro calendario con la duración correcta. Se crea primero
      // el turno nuevo y recién si sale bien se borra el sobreturno viejo, para no
      // perder el turno si algo falla en el medio (ver decisions.md).
      const { data: original } = await conReintentos(() => calendar.events.get({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId }));
      if (original.status === 'cancelled') {
        return res.status(200).json({ success: false, message: 'No encontramos ese turno. Puede que ya haya sido cancelado.' });
      }

      const partes = (original.summary || '').trim().split(/\s+/);
      const nombre = partes.shift() || '';
      const apellido = partes.join(' ');

      const resultado = await crearTurno(calendar, {
        date,
        time,
        nombre,
        apellido,
        telefono: extraerTelefono(original.description || ''),
        motivo: extraerMotivo(original.description || ''),
        esNuevo: extraerEsNuevoPaciente(original.description || ''),
        origen: 'conversion-sobreturno',
      });
      if (!resultado.success) return res.status(200).json(resultado);

      await conReintentos(() => calendar.events.delete({ calendarId: SOBRETURNOS_CALENDAR_ID, eventId }));
      await logActividad({
        tipo: 'turno_reprogramado',
        detalle: `${original.summary || 'paciente'} — pasó a ${date} ${time}hs`,
        actor: 'paciente (/turno)',
      });

      await espejarTurnosBestEffort();
      return res.status(200).json({
        success: true,
        message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
        eventId: resultado.eventId,
        calendarId: CALENDAR_ID,
        codigoCorto: resultado.codigoCorto,
      });
    }

    // Se asegura el código corto antes de reprogramar (un turno viejo podría no
    // tenerlo todavía) — para turnos que ya lo tienen esto es solo una lectura, no
    // agrega ninguna escritura de más. Ver asegurarCodigoCorto en lib/googleCalendar.js.
    const { data: original } = await conReintentos(() => calendar.events.get({ calendarId: CALENDAR_ID, eventId }));
    const codigoCorto = await asegurarCodigoCorto(calendar, CALENDAR_ID, eventId, original.description || '');

    await conReintentos(() => calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        start: { dateTime: newStart.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: newEnd.toISOString(), timeZone: TIME_ZONE },
      },
    }));

    await logActividad({
      tipo: 'turno_reprogramado',
      detalle: `${original.summary || 'paciente'} — pasó a ${date} ${time}hs`,
      actor: 'paciente (/turno)',
    });

    await espejarTurnosBestEffort();
    res.status(200).json({
      success: true,
      message: `Turno reprogramado para el ${date} a las ${time} hs (hora Argentina).`,
      eventId,
      calendarId: CALENDAR_ID,
      codigoCorto,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/reservar.js', detalle: 'mover turno (propio)', error: err });
    res.status(500).json({ success: false, message: 'No se pudo reprogramar el turno. Probá de nuevo.' });
  }
}
