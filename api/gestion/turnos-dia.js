import {
  getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID, BLOCK_MARKER, FERIADO_ATENDIDO_MARKER,
  toArgDate, eventBounds, isValidGestionKey, extraerTelefono, extraerEsNuevoPaciente,
  extraerTelefonoVerificado, extraerConfirmado, extraerDni, extraerCodigoCorto,
} from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { conReintentos } from '../../lib/retry.js';
import { listarPacientesConsolidados } from '../../lib/pacientesConsolidados.js';
import { normalizarDni } from '../../lib/pacientesSheet.js';

export default async function handler(req, res) {
  if (!isValidGestionKey(req.query.key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const dateStr = req.query.date;
    const dayStart = toArgDate(dateStr, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60000);

    const calendar = getCalendarClient();

    const [principal, sobreturnos] = await Promise.all([
      conReintentos(() => calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
      })),
      conReintentos(() => calendar.events.list({
        calendarId: SOBRETURNOS_CALENDAR_ID,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
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

    // Ficha confirmada (para el botón QR "Mis datos"): solo si el DNI del turno coincide
    // EXACTO con una persona del registro consolidado que ya tiene ficha. Si algo falla
    // o hay duda, no se marca nada (sin fichaId no aparece el botón).
    try {
      const conDni = items.filter((it) => it.dni && it.tipo !== 'bloqueo');
      if (conDni.length) {
        const filas = await listarPacientesConsolidados({ cache: true });
        const porDni = new Map();
        for (const f of filas) {
          const d = f.dni && normalizarDni(f.dni);
          if (!d || !f.fichaId) continue;
          porDni.set(d, porDni.has(d) ? null : f.fichaId);
        }
        for (const it of conDni) {
          const fichaId = porDni.get(normalizarDni(it.dni));
          if (fichaId) it.fichaId = fichaId;
        }
      }
    } catch { /* sin fichaId: no se muestra el botón QR */ }

    items.sort((a, b) => new Date(a.start) - new Date(b.start));

    res.status(200).json(items);
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/turnos-dia.js', error: err });
    res.status(500).json({ error: 'No se pudo cargar la agenda del día.' });
  }
}
