import test from 'node:test';
import assert from 'node:assert/strict';
import { fusionarFichas } from '../lib/fichaMotor.js';
import { fusionarEnSupabase } from '../lib/escrituraPrimaria.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'secret' };
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data });

test('fusionarFichas completa campos vacíos y conserva ambos historiales', () => {
  const result = fusionarFichas(
    { id: 'd', campos: { nombre: 'Ana', telefono: '' }, movimientos: [{ id: 'm1', debe: '0' }], prestacionesObraSocial: [] },
    { id: 'o', campos: { nombre: 'Otra', telefono: '123' }, movimientos: [{ id: 'm2', debe: '0' }], prestacionesObraSocial: [{ id: 'p1' }] },
  );
  assert.equal(result.campos.nombre, 'Ana');
  assert.equal(result.campos.telefono, '123');
  assert.deepEqual(result.movimientos.map(x => x.id), ['m1', 'm2']);
  assert.equal(result.prestacionesObraSocial[0].id, 'p1');
});

test('fusión llama una RPC atómica con destino y origen y timeout es ambiguo', async () => {
  const llamadas = [];
  const fetchImpl = async (url, opts) => {
    const name = url.split('/').at(-1); llamadas.push([name, JSON.parse(opts.body)]);
    if (name === 'consultorio_leer_ficha') return response({ ficha: { id: 'x', campos: {} }, ficha_version: 2 });
    return response({ ok: true, version: 3 });
  };
  const ok = await fusionarEnSupabase({ destino: 'd', origen: 'o', env, fetchImpl });
  assert.equal(ok.ok, true);
  const ultima = llamadas.at(-1);
  assert.equal(ultima[0], 'consultorio_fusionar_fichas');
  assert.equal(ultima[1].p_version_destino, 2);
  assert.equal(ultima[1].p_version_origen, 2);
  assert.equal(ultima[1].p_ficha.campos != null, true);
  const colgadoAlFusionar = async (url, opts) => {
    if (url.endsWith('consultorio_leer_ficha')) return response({ ficha: { id: 'x', campos: {} }, ficha_version: 2 });
    return new Promise(() => {});
  };
  const uncertain = await fusionarEnSupabase({ destino: 'd', origen: 'o', env, fetchImpl: colgadoAlFusionar });
  assert.equal(uncertain.motivo, 'ambiguo');
  const conflicto = await fusionarEnSupabase({ destino: 'd', origen: 'o', env, fetchImpl: async (url) => url.endsWith('consultorio_leer_ficha') ? response({ ficha: { id: 'x', campos: {} }, ficha_version: 2 }) : response({ ok: false, motivo: 'conflicto' }) });
  assert.equal(conflicto.motivo, 'conflicto');
});

