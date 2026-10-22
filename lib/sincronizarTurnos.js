import {
  extraerTelefono, extraerMotivo, extraerDni, extraerEmail, extraerCodigoCorto,
  extraerEsNuevoPaciente, extraerTelefonoVerificado, extraerConfirmado,
  extraerConfirmacionSolicitada,
} from './googleCalendarParsers.js';

function fechaEvento(valor) {
  if (!valor) return null;
  return valor.dateTime || `${valor.date}T00:00:00-03:00`;
}

export function eventoATurno(evento, { tipo = 'turno' } = {}) {
  if (!evento || evento.status === 'cancelled') return null;
  const description = evento.description || '';
  const inicio = fechaEvento(evento.start);
  const fin = fechaEvento(evento.end);
  const nombre = String(evento.summary || '').trim();
  return {
    event_id: evento.id,
    tipo: tipo === 'sobreturno' ? 'sobreturno' : 'turno',
    inicio, fin, estado: 'activo', motivo: extraerMotivo(description),
    paciente_nombre: nombre,
    dni: extraerDni(description).replace(/\D/g, ''),
    telefono: extraerTelefono(description), email: extraerEmail(description),
    paciente_nuevo: extraerEsNuevoPaciente(description),
    telefono_verificado: extraerTelefonoVerificado(description),
    confirmado: extraerConfirmado(description),
    confirmacion_solicitada: extraerConfirmacionSolicitada(description),
    codigo_corto: extraerCodigoCorto(description), ubicacion: evento.location || '',
    description_original: description, updated: evento.updated || null,
  };
}

export function eventoABloqueo(evento) {
  if (!evento || evento.status === 'cancelled') return null;
  const description = evento.description || '';
  const esFeriado = description.includes('FERIADO_ATENDIDO');
  const esBloqueo = description.includes('BLOQUEO_AUTOMATICO_TURNOS');
  if (!esFeriado && !esBloqueo) return null;
  const motivo = extraerMotivo(description) || String(evento.summary || '').trim();
  return {
    event_id: evento.id, clase: esFeriado ? 'feriado_atendido' : 'bloqueo',
    inicio: fechaEvento(evento.start), fin: fechaEvento(evento.end),
    dia_completo: !!evento.start?.date && !evento.start?.dateTime, motivo,
  };
}

export function clasificarEvento(evento, { tipo = 'turno', permitirBloqueos = tipo === 'turno' } = {}) {
  if (!evento || evento.status === 'cancelled') return { turno: null, bloqueo: null, ignorado: true };
  const bloqueo = permitirBloqueos ? eventoABloqueo(evento) : null;
  if (bloqueo) return { turno: null, bloqueo, ignorado: false };
  if (!evento.start || !evento.end) return { turno: null, bloqueo: null, ignorado: true };
  return { turno: eventoATurno(evento, { tipo }), bloqueo: null, ignorado: false };
}
