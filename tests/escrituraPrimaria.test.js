import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarEnSupabase, escrituraPrimariaActiva, ejecutarEscrituraPrimaria } from '../lib/escrituraPrimaria.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'secret' };
const fila = (ficha = { id: 'p1', campos: {} }, ficha_version = 4) => ({ ficha, ficha_version });
function respuesta(data, ok = true) { return { ok, status: ok ? 200 : 500, json: async () => data }; }
function fakeFetch(handler) {
  const llamadas = [];
  const fetchImpl = async (url, options) => {
    const rpc = url.split('/').at(-1), body = JSON.parse(options.body);
    llamadas.push({ rpc, body });
    return handler(rpc, body, llamadas.length);
  };
  fetchImpl.llamadas = llamadas;
  return fetchImpl;
}

test('la bandera requiere activación y credenciales', () => {
  assert.equal(escrituraPrimariaActiva({ ...env, SUPABASE_WRITES_PRIMARY: '0' }), false);
  assert.equal(escrituraPrimariaActiva({ ...env, SUPABASE_SERVICE_KEY: '' }), false);
  assert.equal(escrituraPrimariaActiva(env), true);
});

test('la ruta apagada conserva Google y no invoca Supabase', async () => {
  let supabase = 0, google = 0;
  const r = await ejecutarEscrituraPrimaria({ activa: false, aplicar: async () => { supabase += 1; }, escribirGoogle: async () => { google += 1; return 'sheet'; } });
  assert.deepEqual(r, { ruta: 'google', resultado: 'sheet' });
  assert.equal(supabase, 0);
  assert.equal(google, 1);
});

test('Supabase exitoso no invoca Google y ambiguo tampoco permite fallback', async () => {
  let google = 0;
  const ok = await ejecutarEscrituraPrimaria({ activa: true, aplicar: async () => ({ ok: true, ficha: {} }), escribirGoogle: async () => { google += 1; } });
  assert.equal(ok.ruta, 'supabase');
  assert.equal(google, 0);
  const ambiguo = await ejecutarEscrituraPrimaria({ activa: true, aplicar: async () => ({ ok: false, motivo: 'ambiguo' }), escribirGoogle: async () => { google += 1; } });
  assert.deepEqual(ambiguo, { ruta: 'rechazada', resultado: { ok: false, motivo: 'ambiguo' } });
  assert.equal(google, 0);
});

test('sin_snapshot permite Google; invalido y conflicto no', async () => {
  let google = 0;
  const base = { activa: true, escribirGoogle: async () => { google += 1; return 'sheet'; } };
  assert.equal((await ejecutarEscrituraPrimaria({ ...base, aplicar: async () => ({ ok: false, motivo: 'sin_snapshot' }) })).ruta, 'google');
  assert.equal((await ejecutarEscrituraPrimaria({ ...base, aplicar: async () => ({ ok: false, motivo: 'invalido' }) })).ruta, 'rechazada');
  assert.equal((await ejecutarEscrituraPrimaria({ ...base, aplicar: async () => ({ ok: false, motivo: 'conflicto' }) })).ruta, 'rechazada');
  assert.equal(google, 1);
});

test('aplica y guarda la acción usando p_accion y p_body', async () => {
  const fetchImpl = fakeFetch((rpc) => respuesta(rpc === 'consultorio_leer_ficha' ? fila() : { ok: true, version: 5 }));
  const result = await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: { campo: 'nombre', valor: 'ana' }, ahora: new Date('2026-01-01'), env, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.version, 5);
  assert.equal(result.ficha.campos.nombre, 'Ana');
  assert.equal(fetchImpl.llamadas[1].body.p_accion, 'actualizar-campo');
  assert.deepEqual(fetchImpl.llamadas[1].body.p_body, { campo: 'nombre', valor: 'ana' });
});

test('relee y reaplica al recibir conflicto', async () => {
  let escritura = 0;
  const fetchImpl = fakeFetch((rpc) => {
    if (rpc === 'consultorio_leer_ficha') return respuesta(fila({ id: 'p1', campos: { nombre: escritura ? 'Viejo' : '' } }, 4 + escritura));
    escritura += 1;
    return respuesta(escritura === 1 ? { ok: false, motivo: 'conflicto', version: 5 } : { ok: true, version: 6 });
  });
  const result = await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: { campo: 'apellido', valor: 'perez' }, env, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.llamadas.filter((x) => x.rpc === 'consultorio_leer_ficha').length, 2);
  assert.equal(fetchImpl.llamadas[3].body.p_version_esperada, 5);
});

test('devuelve conflicto luego de tres conflictos', async () => {
  const fetchImpl = fakeFetch((rpc) => respuesta(rpc === 'consultorio_leer_ficha' ? fila() : { ok: false, motivo: 'conflicto', version: 9 }));
  const result = await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: { campo: 'nombre', valor: 'ana' }, env, fetchImpl });
  assert.deepEqual(result, { ok: false, motivo: 'conflicto', version: 9 });
  assert.equal(fetchImpl.llamadas.filter((x) => x.rpc === 'consultorio_aplicar_ficha').length, 4);
});

test('un timeout al escribir queda ambiguo', async () => {
  const fetchImpl = fakeFetch((rpc) => {
    if (rpc === 'consultorio_leer_ficha') return respuesta(fila());
    return new Promise(() => {});
  });
  assert.deepEqual(await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: { campo: 'nombre', valor: 'Ana' }, env, fetchImpl }), { ok: false, motivo: 'ambiguo' });
});

test('ficha inexistente o lectura fallida devuelve sin_snapshot', async () => {
  const noExiste = fakeFetch(() => respuesta(null));
  assert.deepEqual(await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: {}, env, fetchImpl: noExiste }), { ok: false, motivo: 'sin_snapshot' });
  const falla = fakeFetch(() => { throw new Error('red'); });
  assert.deepEqual(await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: {}, env, fetchImpl: falla }), { ok: false, motivo: 'sin_snapshot' });
});

test('errores de validación del motor devuelven invalido', async () => {
  const fetchImpl = fakeFetch((rpc) => respuesta(rpc === 'consultorio_leer_ficha' ? fila() : null));
  assert.deepEqual(await aplicarEnSupabase({ id: 'p1', accion: 'actualizar-campo', body: { campo: 'desconocido' }, env, fetchImpl }), { ok: false, motivo: 'invalido', mensaje: 'Campo inválido.' });
  assert.equal(fetchImpl.llamadas.length, 1);
});
