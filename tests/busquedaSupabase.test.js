import test from 'node:test';
import assert from 'node:assert/strict';
import { buscarPacientesSupabase, listarPacientesSupabase } from '../lib/busquedaSupabase.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'secret' };
const fila = { ficha_sheet_id: 'sheet-1', nombre: 'José', apellido: 'Pérez', dni: '123', telefono: '+549111', obra_social: 'OS', ficha_json: { campos: {} } };

test('bandera apagada no llama RPC y deja disponible el fallback Google', async () => {
  let llamadas = 0;
  const resultado = await buscarPacientesSupabase('Jose', { env: { ...env, SUPABASE_WRITES_PRIMARY: '0' }, fetchImpl: async () => { llamadas += 1; } });
  assert.equal(resultado, null);
  assert.equal(llamadas, 0);
});

test('bandera encendida busca por RPC public y normaliza campos para el handler', async () => {
  let url; let body;
  const resultado = await buscarPacientesSupabase('Jose', { env, fetchImpl: async (u, opts) => {
    url = u; body = JSON.parse(opts.body);
    return { ok: true, json: async () => [fila] };
  } });
  assert.equal(url, 'https://db.example/rest/v1/rpc/consultorio_buscar_pacientes');
  assert.deepEqual(body, { p_q: 'Jose', p_limite: 500 });
  assert.deepEqual(resultado[0], { id: 'sheet-1', nombre: 'José', apellido: 'Pérez', dni: '123', telefono: '+549111', obra_social: 'OS', ficha_json: { campos: {} } });
});

test('fallo devuelve null; respuesta vacía es [] para que el handler caiga a Google', async () => {
  assert.equal(await listarPacientesSupabase({ env, fetchImpl: async () => { throw new Error('offline'); } }), null);
  const vacio = await listarPacientesSupabase({ env, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  assert.deepEqual(vacio, []);
});
