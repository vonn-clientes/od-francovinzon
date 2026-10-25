import { getCalendarClient, isValidGestionKey, telefonoParaWhatsApp, extraerDni } from '../../lib/googleCalendar.js';
import { avisarFallo } from '../../lib/alertas.js';
import { upsertPacienteConsolidado } from '../../lib/pacientesConsolidados.js';
import { espejarTurnosBestEffort } from '../../lib/espejoTurnos.js';
import { guardarContacto } from '../../lib/actualizarContactoSupabase.js';
import { agendaPrimariaActiva, leerAgendaRpc, escribirAgendaRpc } from '../../lib/agendaSupabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido.' });
  }

  const { key, eventId, calendarId, telefono, fichaId } = req.body;

  if (!isValidGestionKey(key)) {
    return res.status(401).json({ success: false, message: 'No autorizado.' });
  }

  // Vacío = borrar el número (permitido solo acá, no al crear un turno nuevo).
  // "telefono" llega ya en formato E.164 del selector de país (intl-tel-input) del cliente.
  const crudo = (telefono || '').trim();
  let valorGuardar = '-';
  if (crudo) {
    const normalizado = telefonoParaWhatsApp(crudo);
    if (!normalizado) {
      return res.status(200).json({ success: false, message: 'Ese número no parece válido. Revisalo e intentá de nuevo.' });
    }
    valorGuardar = normalizado;
  }

  try {
    if (agendaPrimariaActiva()) {
      const rows = await leerAgendaRpc('consultorio_agenda_por_id', { p_id: eventId });
      const turno = Array.isArray(rows) ? rows[0] : rows?.turno || rows;
      if (!turno) return res.status(404).json({ success: false, message: 'No se encontró el turno.' });
      let desc = turno.description_original || '';
      if (/Tel[eé]fono:\s*[^\n]*/i.test(desc)) desc = desc.replace(/Tel[eé]fono:\s*[^\n]*/i, `Teléfono: ${valorGuardar}`);
      else if (valorGuardar !== '-') desc = `${desc.trimEnd()}${desc.trim() ? '\n' : ''}Teléfono: ${valorGuardar}`;
      else return res.status(200).json({ success: true, message: 'Sin cambios.', telefono: '', telefonoVerificado: false });
      if (valorGuardar === '-') desc = desc.replace(/\n?Tel[eé]fono verificado:\s*[^\n]*/i, '');
      else if (/Tel[eé]fono verificado:\s*[^\n]*/i.test(desc)) desc = desc.replace(/Tel[eé]fono verificado:\s*[^\n]*/i, 'Teléfono verificado: Sí');
      else desc = desc.replace(/(Tel[eé]fono:\s*[^\n]*)/i, '$1\nTeléfono verificado: Sí');
      const r = await escribirAgendaRpc('consultorio_agenda_actualizar_contacto', { id: turno.id, telefono: valorGuardar === '-' ? '' : valorGuardar, description_original: desc });
      if (!r?.ok) throw new Error('No se pudo confirmar la actualización del teléfono.');
      return res.status(200).json({ success: true, message: crudo ? 'Teléfono actualizado.' : 'Teléfono borrado.', telefono: valorGuardar === '-' ? '' : valorGuardar, telefonoVerificado: valorGuardar !== '-' });
    }
    const calendar = getCalendarClient();
    const { data: ev } = await calendar.events.get({ calendarId, eventId });

    const descActual = ev.description || '';
    const yaTieneLinea = /Tel[eé]fono:\s*[^\n]*/i.test(descActual);

    let nuevaDescripcion;
    if (yaTieneLinea) {
      nuevaDescripcion = descActual.replace(/Tel[eé]fono:\s*[^\n]*/i, `Teléfono: ${valorGuardar}`);
    } else if (valorGuardar !== '-') {
      const limpia = descActual.replace(/\s+$/, '');
      nuevaDescripcion = limpia ? `${limpia}\nTeléfono: ${valorGuardar}` : `Teléfono: ${valorGuardar}`;
    } else {
      return res.status(200).json({ success: true, message: 'Sin cambios.', telefono: '', telefonoVerificado: false });
    }

    // "Teléfono verificado: Sí" marca que el número pasó por el selector de país recién
    // (ver decisions.md). Si se borra el teléfono, se saca la marca; si se carga uno
    // nuevo, se agrega o reemplaza.
    const yaTieneVerificado = /Tel[eé]fono verificado:\s*[^\n]*/i.test(nuevaDescripcion);
    if (valorGuardar === '-') {
      if (yaTieneVerificado) {
        nuevaDescripcion = nuevaDescripcion.replace(/\n?Tel[eé]fono verificado:\s*[^\n]*/i, '');
      }
    } else if (yaTieneVerificado) {
      nuevaDescripcion = nuevaDescripcion.replace(/Tel[eé]fono verificado:\s*[^\n]*/i, 'Teléfono verificado: Sí');
    } else {
      nuevaDescripcion = nuevaDescripcion.replace(
        /(Tel[eé]fono:\s*[^\n]*)/i,
        '$1\nTeléfono verificado: Sí'
      );
    }

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { description: nuevaDescripcion },
    });

    // Best-effort, ver lib/pacientesConsolidados.js — solo si se cargó un teléfono (no
    // al borrarlo, no hay con qué sincronizar).
    if (valorGuardar !== '-') {
      const partesNombre = (ev.summary || '').trim().split(/\s+/);
      const nombre = partesNombre.shift() || '';
      const apellido = partesNombre.join(' ');
      await guardarContacto({ fichaId, campo: 'telefono', valor: valorGuardar, upsertGoogle: () => upsertPacienteConsolidado({ telefono: valorGuardar, nombre, apellido, dni: extraerDni(descActual), origen: 'turno' }) });
    }

    await espejarTurnosBestEffort();
    res.status(200).json({
      success: true,
      message: crudo ? 'Teléfono actualizado.' : 'Teléfono borrado.',
      // Para que el cliente pueda parchear la fila en memoria sin volver a pedir el día entero.
      telefono: valorGuardar === '-' ? '' : valorGuardar,
      telefonoVerificado: valorGuardar !== '-',
    });
  } catch (err) {
    console.error(err);
    await avisarFallo({ endpoint: 'api/gestion/agregar-telefono.js', error: err });
    res.status(500).json({ success: false, message: 'No se pudo guardar el teléfono.' });
  }
}
