import test from 'node:test';
import assert from 'node:assert/strict';
import { espejarConfig, espejarActividad, espejarAlerta, espejarLote } from '../lib/espejoConfig.js';

const env = (fn) => {
  const old = process.env.SUPABASE_SYNC_ON_WRITE;
  process.env.SUPABASE_SYNC_ON_WRITE = '1';
  return Promise.resolve().then(fn).finally(() => {
    if (old === undefined) delete process.env.SUPABASE_SYNC_ON_WRITE;
    else process.env.SUPABASE_SYNC_ON_WRITE = old;
  });
};
const opts = (fetchImpl) => ({ url: 'https://example.test/', serviceKey: 'test-secret', fetchImpl });

test('espeja cada RPC con headers, endpoint y payload esperado', async () => env(async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  await espejarConfig('horarios', { lunes: [] }, { ...opts(fetchImpl), actualizado: '2026-01-01T00:00:00Z' });
  await espejarActividad({ fecha: 'f', tipo: 't', detalle: 'd', actor: 'a' }, opts(fetchImpl));
  await espejarAlerta({ fecha: 'f', endpoint: 'e', detalle: 'd', mensaje: 'm' }, opts(fetchImpl));
  assert.deepEqual(calls.map(c => c.url), [
    'https://example.test/rest/v1/rpc/consultorio_config_set',
    'https://example.test/rest/v1/rpc/consultorio_log_actividad',
    'https://example.test/rest/v1/rpc/consultorio_log_alerta',
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p: { clave: 'horarios', valor: { lunes: [] }, actualizado: '2026-01-01T00:00:00Z' } });
  assert.equal(calls[0].init.headers.apikey, 'test-secret');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(calls[1].init.body).p, { fecha: 'f', tipo: 't', detalle: 'd', actor: 'a' });
  assert.deepEqual(JSON.parse(calls[2].init.body).p, { fecha: 'f', endpoint: 'e', detalle: 'd', mensaje: 'm' });
}));

test('no llama a fetch cuando el interruptor está apagado o faltan credenciales', async () => {
  const old = process.env.SUPABASE_SYNC_ON_WRITE;
  delete process.env.SUPABASE_SYNC_ON_WRITE;
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true }; };
  try {
    await espejarConfig('k', {}, opts(fetchImpl));
    process.env.SUPABASE_SYNC_ON_WRITE = '1';
    await espejarActividad({}, { fetchImpl });
    assert.equal(calls, 0);
  } finally {
    if (old === undefined) delete process.env.SUPABASE_SYNC_ON_WRITE;
    else process.env.SUPABASE_SYNC_ON_WRITE = old;
  }
});

test('las funciones individuales no lanzan ante fallos HTTP ni de red', async () => env(async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await espejarConfig('dato-sensible', { clave: 'privada' }, opts(async () => { throw new Error('secreto'); }));
    await espejarActividad({}, opts(async () => ({ ok: false })));
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(w => !w.includes('secreto') && !w.includes('dato-sensible')));
}));

test('espeja lote por partes y reporta conteos de éxitos y errores', async () => env(async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body).p });
    return { ok: !url.endsWith('consultorio_log_actividad') };
  };
  const result = await espejarLote({ configs: [{ clave: 'a' }, { clave: 'b' }, { clave: 'c' }], actividad: [{ tipo: 'x' }, { tipo: 'y' }], alertas: [{ endpoint: 'e' }], tamanoLote: 2 }, opts(fetchImpl));
  assert.deepEqual(result, { configs: 3, actividad: 0, alertas: 1, errores: 2 });
  assert.deepEqual(calls.map(c => c.payload.length), [2, 1, 2, 1]);
  assert.ok(calls.every(c => Array.isArray(c.payload)));
}));

test('espejarLote cuenta filas como errores cuando faltan credenciales', async () => {
  const result = await espejarLote({ configs: [{ clave: 'a' }], alertas: [{ endpoint: 'e' }] }, { fetchImpl: async () => ({ ok: true }) });
  assert.deepEqual(result, { configs: 0, actividad: 0, alertas: 0, errores: 2 });
});
