import test from 'node:test';
import assert from 'node:assert/strict';
import { crearFichaSupabase } from '../lib/crearFichaSupabase.js';
import { actualizarContactoSupabase, guardarContacto } from '../lib/actualizarContactoSupabase.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'secret' };
const ok = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });

test('crear ficha usa RPC pública, normaliza campos y manda forma vacía', async () => {
  let url, body;
  const r = await crearFichaSupabase({ nombre: 'aNA', apellido: 'péREZ', campos: { dni: '12345678', domicilio: 'calle 1', telefono: '+549111' }, env, fetchImpl: async (u, o) => { url = u; body = JSON.parse(o.body); return ok({ ok: true, id: 'sb-1' }); } });
  assert.equal(r.id, 'sb-1');
  assert.equal(url, 'https://db.test/rest/v1/rpc/consultorio_crear_ficha');
  assert.deepEqual(body.p_ficha.campos, { dni: '12.345.678', domicilio: 'Calle 1', telefono: '+549111', nombre: 'Ana', apellido: 'Pérez' });
  assert.deepEqual(body.p_ficha.movimientos, []);
  assert.deepEqual(body.p_ficha.prestacionesObraSocial, []);
  assert.equal(body.p_ficha.financiero.total, '$0,00');
});

test('crear ficha conserva respuesta de negocio y falla sin lanzar ante transporte', async () => {
  const duplicada = await crearFichaSupabase({ nombre: 'Ana', apellido: 'Pérez', campos: { dni: '12345678' }, env, fetchImpl: async () => ok({ ok: false, motivo: 'dni_duplicado', id: 'sb-existente' }) });
  assert.deepEqual(duplicada, { ok: false, motivo: 'dni_duplicado', id: 'sb-existente' });
  assert.deepEqual(await crearFichaSupabase({ nombre: 'Ana', apellido: 'Pérez', env, fetchImpl: async () => { throw Error('offline'); } }), { ok: false, motivo: 'sin_snapshot' });
  assert.deepEqual(await crearFichaSupabase({ nombre: 'Ana', apellido: 'Pérez', env: { ...env, SUPABASE_WRITES_PRIMARY: '0' }, fetchImpl: async () => { throw Error('must not call'); } }), { ok: false, motivo: 'sin_snapshot' });
});

test('actualización de contacto tiene ramas apagada, sin ficha, éxito y fallo', async () => {
  let llamadas = 0;
  const fetchImpl = async (_u, opts) => { llamadas++; const b = JSON.parse(opts.body); return ok(b.p_id ? { ok: true, ficha: { campos: {} }, ficha_version: 1 } : { ok: true, version: 2 }); };
  assert.deepEqual(await actualizarContactoSupabase({ fichaId: 's1', campo: 'telefono', valor: '+549111', env: { ...env, SUPABASE_WRITES_PRIMARY: '0' }, fetchImpl }), { intentado: false, resultado: null });
  assert.deepEqual(await actualizarContactoSupabase({ campo: 'dni', valor: '123', env, fetchImpl }), { intentado: false, resultado: null });
  const guardado = await actualizarContactoSupabase({ fichaId: 's1', campo: 'telefono', valor: '+549111', env, fetchImpl });
  assert.equal(guardado.resultado.ok, true);
  assert.equal(llamadas, 2);
  const fallo = await actualizarContactoSupabase({ fichaId: 's1', campo: 'dni', valor: '123', env, fetchImpl: async () => { throw Error('offline'); } });
  assert.equal(fallo.intentado, true);
  assert.equal(fallo.resultado.motivo, 'sin_snapshot');
});

test('teléfono y DNI enrutan consolidado con dobles según ficha y resultado Supabase', async () => {
  for (const campo of ['telefono', 'dni']) {
    let google = 0;
    const upsertGoogle = async () => { google++; return 'consolidado'; };
    const base = { campo, valor: campo === 'dni' ? '12.345.678' : '+549111', upsertGoogle };
    const sinId = await guardarContacto({ ...base, env, fetchImpl: async () => { throw Error('no debe llamar'); } });
    assert.equal(sinId.ruta, 'google');
    assert.equal(google, 1);
    const apagada = await guardarContacto({ ...base, fichaId: 'sheet', env: { ...env, SUPABASE_WRITES_PRIMARY: '0' }, fetchImpl: async () => { throw Error('no debe llamar'); } });
    assert.equal(apagada.ruta, 'google');
    assert.equal(google, 2);
    const supabase = await guardarContacto({ ...base, fichaId: 'sheet', env, fetchImpl: async (u) => ok(u.endsWith('consultorio_leer_ficha') ? { ficha: { campos: {} }, ficha_version: 1 } : { ok: true, version: 2 }) });
    assert.equal(supabase.ruta, 'supabase');
    assert.equal(google, 2);
    const sbFallido = await guardarContacto({ ...base, fichaId: 'sb-1', env, fetchImpl: async () => { throw Error('offline'); } });
    assert.equal(sbFallido.ruta, 'rechazada');
    assert.equal(google, 2);
    const sheetFallido = await guardarContacto({ ...base, fichaId: 'sheet', env, fetchImpl: async () => { throw Error('offline'); } });
    assert.equal(sheetFallido.ruta, 'google');
    assert.equal(google, 3);
  }
});
