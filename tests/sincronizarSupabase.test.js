import test from 'node:test';
import assert from 'node:assert/strict';
import { crearClienteSupabase, construirPayload, sincronizarFichas, filtrarArchivosModificados, conTimeout } from '../lib/sincronizarSupabase.js';

const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('cliente Supabase hace RPC autenticado y devuelve el uuid', async () => {
  let request;
  const cliente = crearClienteSupabase({ url: 'https://db.example/', serviceKey: 'secreto', fetchImpl: async (...args) => {
    request = args;
    return response(200, 'uuid-123');
  } });
  const payload = { ficha_sheet_id: 'sheet-1', paciente: {}, movimientos: [] };
  assert.equal(await cliente.sincronizarFicha(payload), 'uuid-123');
  assert.equal(request[0], 'https://db.example/rest/v1/rpc/consultorio_sync_ficha');
  assert.equal(request[1].headers.apikey, 'secreto');
  assert.equal(request[1].headers.Authorization, 'Bearer secreto');
  assert.deepEqual(JSON.parse(request[1].body), { p: payload });
});

test('estadoSync consulta la RPC y devuelve Map de ficha a modifiedTime', async () => {
  let request;
  const cliente = crearClienteSupabase({ url: 'https://db.example/', serviceKey: 'secreto', fetchImpl: async (...args) => {
    request = args;
    return response(200, [{ ficha_sheet_id: 'sheet-a', drive_modified_time: '2026-10-20T12:00:00Z' }, { ficha_sheet_id: 'sheet-b', drive_modified_time: null }]);
  } });
  const estado = await cliente.estadoSync();
  assert.equal(request[0], 'https://db.example/rest/v1/rpc/consultorio_estado_sync');
  assert.equal(request[1].method, 'POST');
  assert.deepEqual(JSON.parse(request[1].body), {});
  assert.equal(estado.get('sheet-a'), '2026-10-20T12:00:00Z');
  assert.equal(estado.get('sheet-b'), null);
});

test('cliente reporta mensaje de error de Supabase y oculta la clave', async () => {
  const cliente = crearClienteSupabase({ url: 'https://db.example', serviceKey: 'clave-super-secreta', fetchImpl: async () => response(500, { message: 'No se pudo guardar' }) });
  await assert.rejects(cliente.sincronizarFicha({}), (error) => error.message === 'No se pudo guardar' && !error.message.includes('clave-super-secreta'));
});

test('23505 identifica DNI duplicado y nunca expone la clave', async () => {
  const clave = 'clave-super-secreta';
  const cliente = crearClienteSupabase({ url: 'https://db.example', serviceKey: clave, fetchImpl: async () => response(409, { code: '23505', message: `conflicto ${clave}` }) });
  await assert.rejects(cliente.sincronizarFicha({}), (error) => error.message.startsWith('DNI duplicado en otra ficha') && !error.message.includes(clave));
});

test('construye el payload incluyendo id de hoja y filas transformadas', () => {
  const payload = construirPayload('ficha-x', { campos: { dni: '12.345.678' }, movimientos: [] });
  assert.equal(payload.ficha_sheet_id, 'ficha-x');
  assert.equal(payload.paciente.dni, '12345678');
  assert.deepEqual(payload.movimientos, []);
});

test('construirPayload agrega drive_modified_time top-level solo cuando se proporciona', () => {
  const ficha = { campos: {}, movimientos: [] };
  assert.equal(construirPayload('a', ficha, { driveModifiedTime: '2026-10-20T12:00:00Z' }).drive_modified_time, '2026-10-20T12:00:00Z');
  assert.equal(Object.hasOwn(construirPayload('a', ficha), 'drive_modified_time'), false);
});

test('una falla aislada no frena las fichas siguientes y se respeta el orden secuencial y limite', async () => {
  const enVuelo = { actual: 0, maximo: 0 };
  const vistos = [];
  const payloads = [];
  const resultado = await sincronizarFichas({
    ids: ['a', 'b', 'c', 'd'], limite: 3, tamanoLote: 2, pausaMs: 0, esperar: async () => {},
    leerFicha: async (id) => {
      enVuelo.actual += 1;
      enVuelo.maximo = Math.max(enVuelo.maximo, enVuelo.actual);
      vistos.push(id);
      await Promise.resolve();
      enVuelo.actual -= 1;
      if (id === 'b') throw new Error('ficha inválida');
      return { campos: { nombre: id }, movimientos: [] };
    },
    cliente: { sincronizarFicha: async (payload) => { payloads.push(payload); return 'uuid'; } },
  });
  assert.deepEqual(vistos, ['a', 'b', 'c']);
  assert.equal(enVuelo.maximo, 1);
  assert.deepEqual(payloads.map((p) => p.ficha_sheet_id), ['a', 'c']);
  assert.equal(resultado.total, 3);
  assert.equal(resultado.ok, 2);
  assert.deepEqual(resultado.errores, [{ id: 'b', mensaje: 'ficha inválida' }]);
});

test('filtra por modifiedTime estrictamente posterior a desde', () => {
  const files = [{ id: 'a', modifiedTime: '2026-01-01T00:00:00Z' }, { id: 'b', modifiedTime: '2026-01-02T00:00:00Z' }];
  assert.deepEqual(filtrarArchivosModificados(files, '2026-01-01T00:00:00Z'), [files[1]]);
});

test('conTimeout rechaza cuando la operación supera el límite', async () => {
  await assert.rejects(conTimeout(new Promise(() => {}), 5), /timeout/);
});
