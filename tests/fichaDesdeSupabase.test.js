import test from 'node:test';
import assert from 'node:assert/strict';
import { leerFichaSupabase, leerMovimientosSupabase } from '../lib/fichaDesdeSupabase.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'k' };

test('bandera apagada conserva Google: las lecturas Supabase no se invocan', async () => {
  let llamadas = 0;
  const fetchImpl = async () => { llamadas += 1; throw new Error('no debería llamar'); };
  assert.equal(await leerFichaSupabase('id', { env: {}, fetchImpl }), null);
  assert.equal(await leerMovimientosSupabase('id', null, { env: {}, fetchImpl }), null);
  assert.equal(llamadas, 0);
});

test('bandera encendida lee ficha y movimientos de Supabase', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ ficha: { campos: { nombre: 'Ana' }, movimientos: [{ fecha: '24/10/2026', tratamiento: 'Control' }, { fecha: '1/9/2026', tratamiento: 'Otro' }] } }) };
  };
  assert.deepEqual((await leerFichaSupabase('id', { env, fetchImpl })).campos, { nombre: 'Ana' });
  assert.deepEqual(await leerMovimientosSupabase('id', '2026-10-24', { env, fetchImpl }), [{ fecha: '24/10/2026', tratamiento: 'Control' }]);
  assert.equal((await leerMovimientosSupabase('id', null, { env, fetchImpl })).length, 2);
  assert.match(urls[0], /consultorio_leer_ficha/);
});

test('sin ficha en Supabase devuelve null y deja al llamador caer a Google', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ficha: null }) });
  assert.equal(await leerFichaSupabase('id', { env, fetchImpl }), null);
  assert.equal(await leerFichaSupabase('id', { env, fetchImpl: async () => { throw new Error('offline'); } }), null);
});
