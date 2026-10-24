// Endpoint propio (no fusionado en agregar-telefono.js) para no arriesgar la lógica ya
// delicada de esa regex (línea "Teléfono verificado" acoplada) al retocarla bajo apuro —
// hay margen de sobra en el límite de 12 funciones (ver CLAUDE.md), así que un archivo
// nuevo y chico es más seguro acá que un retrofit del otro. Mismo patrón general:
// lee la description del evento, parchea (o agrega) la línea "DNI: ...", guarda.
import { getCalendarClient, isValidGestionKey, extraerTelefono } from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { formatearDniConPuntos } from '../../lib/dni.js';
import { upsertPacienteConsolidado } from '../../lib/pacientesConsolidados.js';
import { espejarTurnosBestEffort } from '../../lib/espejoTurnos.js';
import { guardarContacto } from '../../lib/actualizarContactoSupabase.js';
import { agendaPrimariaActiva, leerAgendaRpc, escribirAgendaRpc } from '../../lib/agendaSupabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, dni, fichaId } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  // Vacío = borrar el DNI (mismo criterio que agregar-telefono.js) — no es obligatorio,
  // así que se permite dejarlo en blanco de nuevo si se cargó por error.
  const crudo = (dni || '').trim().replace(/[.\s]/g, '');
  const valorGuardar = formatearDniConPuntos(crudo) || '-';

  try {
    if (agendaPrimariaActiva()) {
      const rows = await leerAgendaRpc('consultorio_agenda_por_id', { p_id: eventId });
      const turno = Array.isArray(rows) ? rows[0] : rows?.turno || rows;
      if (!turno) return res.status(404).json({ success: false, message: 'No se encontró el turno.' });
      const nueva = actualizarLinea(turno.description_original || '', /DNI:\s*[^\n]*/i, `DNI: ${valorGuardar}`, valorGuardar !== '-');
      if (nueva === null) return res.status(200).json({ success: true, message: 'Sin cambios.', dni: '' });
      const r = await escribirAgendaRpc('consultorio_agenda_actualizar_contacto', { id: turno.id, dni: crudo, description_original: nueva });
      if (!r?.ok) throw new Error('No se pudo confirmar la actualización del DNI.');
      return res.status(200).json({ success: true, message: crudo ? 'DNI actualizado.' : 'DNI borrado.', dni: valorGuardar === '-' ? '' : valorGuardar });
    }
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId, eventId });

    const descActual = ev.description || '';
    const yaTieneLinea = /DNI:\s*[^\n]*/i.test(descActual);

    let nuevaDescripcion;
    if (yaTieneLinea) {
      nuevaDescripcion = descActual.replace(/DNI:\s*[^\n]*/i, `DNI: ${valorGuardar}`);
    } else if (valorGuardar !== '-') {
      const limpia = descActual.replace(/\s+$/, '');
      nuevaDescripcion = limpia ? `${limpia}\nDNI: ${valorGuardar}` : `DNI: ${valorGuardar}`;
    } else {
      return res.status(200).json({ success: true, message: 'Sin cambios.', dni: '' });
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    // Best-effort, ver lib/pacientesConsolidados.js — solo si se cargó un DNI de verdad.
    if (crudo) {
      const partesNombre = (ev.summary || '').trim().split(/\s+/);
      const nombre = partesNombre.shift() || '';
      const apellido = partesNombre.join(' ');
      await guardarContacto({ fichaId, campo: 'dni', valor: valorGuardar, upsertGoogle: () => upsertPacienteConsolidado({ telefono: extraerTelefono(descActual), nombre, apellido, dni: crudo, origen: 'turno' }) });
    }

    await espejarTurnosBestEffort();
    res.status(200).json({
      success: true,
      message: crudo ? 'DNI actualizado.' : 'DNI borrado.',
      dni: valorGuardar === '-' ? '' : valorGuardar,
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/agregar-dni.js', error: err });
    res.status(500).json({ success: false, message: 'No se pudo guardar el DNI.' });
  }
}

function actualizarLinea(texto, regex, linea, agregar) {
  if (regex.test(texto)) return texto.replace(regex, linea);
  if (!agregar) return null;
  const limpia = texto.trimEnd();
  return limpia ? `${limpia}\n${linea}` : linea;
}
