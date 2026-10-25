import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER,
  toArgDate, eventBounds, isValidGestionKey, extraerTelefono, extraerEsNuevoPaciente,
  extraerTelefonoVerificado, extraerConfirmado, extraerDni, extraerCodigoCorto,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';
import { listarPacientesConsolidados } from '../../lib/pacientesConsolidados.js';
import { normalizarDni } from '../../lib/pacientesSheet.js';
import { eventosAgenda } from '../../lib/agendaSupabase.js';

// Ficha confirmada (para el botón QR "Mis datos" y para no mostrar "Crear ficha"): SOLO si el
// DNI coincide EXACTO con una persona del registro consolidado que ya tiene ficha. El teléfono
// NO se usa (los chicos usan el de sus padres). Sin DNI o con duda no se marca nada: esos casos
// los asigna Fausto a mano en /admin.
async function asignarFichaId(items) {
  try {
    const candidatos = items.filter((it) => it.dni && it.tipo !== 'bloqueo');
    if (!candidatos.length) return;
    const filas = await listarPacientesConsolidados({ cache: true });
    // Mapas valor -> fichaId; null si el valor está en más de una ficha (ambiguo).
    const mapa = (clave) => {
      const m = new Map();
      for (const f of filas) {
        const k = clave(f);
        if (!k || !f.fichaId) continue;
        m.set(k, m.has(k) && m.get(k) !== f.fichaId ? null : f.fichaId);
      }
      return m;
    };
    const porDni = mapa((f) => f.dni && normalizarDni(f.dni));
    for (const it of candidatos) {
      const fichaId = porDni.get(normalizarDni(it.dni));
      if (fichaId) it.fichaId = fichaId;
    }
  } catch { /* sin fichaId: no se muestra el botón QR */ }
}

export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const dateStr = req.query.date;
    const dayStart = toArgDate(dateStr, '00:00');
    // `dias` (opcional, 1-31): para /datosqr, que lista los próximos turnos de varios días.
    const dias = Math.min(31, Math.max(1, parseInt(req.query.dias || '1', 10) || 1));
    const dayEnd = new Date(dayStart.getTime() + dias * 24 * 60 * 60000);

    if (process.env.SUPABASE_AGENDA_PRIMARY === '1') {
      const supa = await eventosAgenda(dayStart.toISOString(), dayEnd.toISOString());
      if (supa !== null) {
        const items = supa.filter((ev) => ev.__tipo !== 'feriado_atendido').map((ev) => {
          const { start, end } = eventBounds(ev);
          const bloqueo = ev.__tipo === 'bloqueo';
          return { id: ev.id, calendarId: ev.calendarId || '', start: start.toISOString(), end: end.toISOString(),
            title: ev.summary || '', description: ev.description || '', tipo: bloqueo ? 'bloqueo' : ev.__tipo,
            allDay: false, telefono: extraerTelefono(ev.description) || ev.__telefono || '', dni: extraerDni(ev.description) || ev.__dni || '',
            codigoCorto: extraerCodigoCorto(ev.description), esNuevoPaciente: extraerEsNuevoPaciente(ev.description),
            telefonoVerificado: extraerTelefonoVerificado(ev.description), confirmado: extraerConfirmado(ev.description) };
        });
        await asignarFichaId(items);
        items.sort((a, b) => new Date(a.start) - new Date(b.start));
        return res.status(200).json(items);
      }
    }

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      })),
      conReintentos(() => calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        maxResults: 2500,
      })),
    ]);

    const items = [];

    (principal.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      const allDay = !ev.start.dateTime;
      // El marcador de "feriado que se atiende" (feature 2026-08-24) no es un bloqueo ni
      // un turno: su estado ya lo informa el badge de feriado de la cabecera — si entrara
      // acá se vería como una fila "Feriado atendido" tipo bloqueo, que confunde.
      if (allDay && (ev.description || '').includes(FERIADO_ATENDIDO_MARKER)) return;
      const isBloqueo = allDay || (ev.description || '').includes(BLOCK_MARKER);
      items.push({
        id: ev.id,
        calendarId: CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: isBloqueo ? 'bloqueo' : 'turno',
        allDay,
        telefono: extraerTelefono(ev.description),
        dni: extraerDni(ev.description),
        codigoCorto: extraerCodigoCorto(ev.description),
        esNuevoPaciente: extraerEsNuevoPaciente(ev.description),
        telefonoVerificado: extraerTelefonoVerificado(ev.description),
        confirmado: extraerConfirmado(ev.description),
      });
    });

    (sobreturnos.data.items || []).forEach((ev) => {
      const { start, end } = eventBounds(ev);
      items.push({
        id: ev.id,
        calendarId: SOBRETURNOS_CALENDAR_ID,
        start: start.toISOString(),
        end: end.toISOString(),
        title: ev.summary || '',
        description: ev.description || '',
        tipo: 'sobreturno',
        allDay: !ev.start.dateTime,
        telefono: extraerTelefono(ev.description),
        dni: extraerDni(ev.description),
        codigoCorto: extraerCodigoCorto(ev.description),
        esNuevoPaciente: extraerEsNuevoPaciente(ev.description),
        telefonoVerificado: extraerTelefonoVerificado(ev.description),
        confirmado: extraerConfirmado(ev.description),
      });
    });

    await asignarFichaId(items);

    items.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json(items);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/turnos-dia.js', error: err });
    res.status(500).json({ error: 'No se pudo cargar la agenda del día.' });
  }
}
