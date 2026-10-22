import test from 'node:test';
import assert from 'node:assert/strict';
import { eventoATurno, eventoABloqueo, clasificarEvento } from '../lib/sincronizarTurnos.js';
import { crearClienteSupabase } from '../lib/sincronizarSupabase.js';

const base = (overrides = {}) => ({
  id: 'evt-inventado-123', summary: 'Ángela Pérez', location: 'Consultorio',
  start: { dateTime: '2026-10-22T12:00:00Z' }, end: { dateTime: '2026-10-22T12:30:00Z' },
  description: 'Teléfono: +54 9 3442 123456\nDNI: 12.345.678\nEmail: angela@example.test\nMotivo: Limpieza\nPaciente nuevo: Sí\nTeléfono verificado: Sí\nConfirmado: Sí\nConfirmación solicitada: Sí\nCódigo corto: ABC234',
  updated: '2026-10-20T10:00:00Z', ...overrides,
});

test('turno normal mapea campos y normaliza DNI', () => {
  const turno = eventoATurno(base());
  assert.equal(turno.tipo, 'turno');
  assert.equal(turno.paciente_nombre, 'Ángela Pérez');
  assert.equal(turno.dni, '12345678');
  assert.equal(turno.telefono, '+54 9 3442 123456');
  assert.equal(turno.email, 'angela@example.test');
  assert.equal(turno.paciente_nuevo, true);
  assert.equal(turno.confirmacion_solicitada, true);
  assert.equal(turno.ubicacion, 'Consultorio');
});

test('parsers toleran acentos y guion como valor vacío', () => {
  const turno = eventoATurno(base({ description: 'Teléfono: -\nDNI: -\nMotívo: Control\nCódigo corto: -' }));
  assert.equal(turno.telefono, '');
  assert.equal(turno.dni, '');
  assert.equal(turno.codigo_corto, '');
});

test('description HTML legado se procesa', () => {
  const turno = eventoATurno(base({ description: '<p>Teléfono: 3442123456</p>\n<p>DNI: 12345678</p>\n<p>Motivo: Control</p>' }));
  assert.equal(turno.telefono, '3442123456');
  assert.equal(turno.motivo, 'Control');
});

test('bloqueo horario y bloqueo de día completo se reconocen', () => {
  const horario = eventoABloqueo(base({ description: 'BLOQUEO_AUTOMATICO_TURNOS\nMotivo: Personal' }));
  assert.equal(horario.clase, 'bloqueo');
  assert.equal(horario.dia_completo, false);
  const dia = eventoABloqueo(base({ start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, description: 'BLOQUEO_AUTOMATICO_TURNOS' }));
  assert.equal(dia.dia_completo, true);
});

test('feriado atendido se clasifica como bloqueo de clase feriado', () => {
  const feriado = eventoABloqueo(base({ start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, description: 'FERIADO_ATENDIDO' }));
  assert.equal(feriado.clase, 'feriado_atendido');
});

test('eventos cancelados se ignoran', () => {
  const evento = base({ status: 'cancelled' });
  assert.equal(eventoATurno(evento), null);
  assert.deepEqual(clasificarEvento(evento), { turno: null, bloqueo: null, ignorado: true });
});

test('sobreturno conserva tipo y no convierte marcadores en bloqueos', () => {
  const evento = base({ description: 'Motivo: Urgencia' });
  assert.equal(eventoATurno(evento, { tipo: 'sobreturno' }).tipo, 'sobreturno');
  assert.equal(clasificarEvento(base({ description: 'BLOQUEO_AUTOMATICO_TURNOS' }), { tipo: 'sobreturno', permitirBloqueos: false }).turno.tipo, 'sobreturno');
});

test('cliente Supabase sincroniza turnos mediante RPC envolviendo el payload en p', async () => {
  let request;
  const payload = { calendar_id: 'cal', ventana: { desde: 'a', hasta: 'b' }, turnos: [], bloqueos: [] };
  const cliente = crearClienteSupabase({ url: 'https://db.example', serviceKey: 'secreto', fetchImpl: async (...args) => {
    request = args;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  } });
  await cliente.sincronizarTurnos(payload);
  assert.equal(request[0], 'https://db.example/rest/v1/rpc/consultorio_sync_turnos');
  assert.deepEqual(JSON.parse(request[1].body), { p: payload });
});
