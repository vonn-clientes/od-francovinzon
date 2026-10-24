import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaPrimariaActiva, agendaRpc, leerAgendaRpc, escribirAgendaRpc, filasComoEventos } from '../lib/agendaSupabase.js';

const env = { SUPABASE_AGENDA_PRIMARY: '1', SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_KEY: 'secret' };

test('agenda primaria requiere bandera y credenciales', () => {
  assert.equal(agendaPrimariaActiva(env), true);
  assert.equal(agendaPrimariaActiva({ ...env, SUPABASE_AGENDA_PRIMARY: '0' }), false);
  assert.equal(agendaPrimariaActiva({ ...env, SUPABASE_SERVICE_KEY: '' }), false);
});

test('agendaRpc usa endpoint RPC y credencial service role', async () => {
  let request;
  const data = await agendaRpc('consultorio_agenda_listar', { p_desde: 'a' }, { env, fetchImpl: async (url, init) => {
    request = { url, init };
    return { ok: true, json: async () => ({ turnos: [] }) };
  } });
  assert.equal(request.url, 'https://db.test/rest/v1/rpc/consultorio_agenda_listar');
  assert.equal(request.init.headers.apikey, 'secret');
  assert.deepEqual(JSON.parse(request.init.body), { p_desde: 'a' });
  assert.deepEqual(data, { turnos: [] });
});

test('lecturas retornan null al fallar y escrituras propagan el fallo ambiguo', async () => {
  assert.equal(await leerAgendaRpc('x', {}, { env, fetchImpl: async () => { throw new Error('offline'); } }), null);
  await assert.rejects(escribirAgendaRpc('x', {}), /no está configurada/);
  await assert.rejects(agendaRpc('x', {}, { env, fetchImpl: async () => { throw new Error('timeout'); } }), /timeout/);
});

test('filas de agenda mantienen uuid, tipo y atributos públicos', () => {
  const [ev] = filasComoEventos({ turnos: [{ id: 'uuid', inicio: '2026-10-24T12:00:00Z', fin: '2026-10-24T12:30:00Z', tipo: 'turno', paciente_nombre: 'Ana', codigo_corto: 'ABC123', confirmado: true }] });
  assert.equal(ev.id, 'uuid');
  assert.equal(ev.codigoCorto, 'ABC123');
  assert.equal(ev.confirmado, true);
});
