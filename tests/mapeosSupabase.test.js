import test from 'node:test';
import assert from 'node:assert/strict';

test('mapeos: migra de Google una vez, guarda en Supabase y hace upsert', async () => {
  Object.assign(process.env, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', SUPABASE_READS: '1', SUPABASE_WRITES_PRIMARY: '1' });
  const almacen = {};
  globalThis.fetch = async (url, opts) => {
    const n = String(url).match(/rpc\/(\w+)/)?.[1];
    const body = opts?.body ? JSON.parse(opts.body) : {};
    let out = null;
    if (n === 'consultorio_config_leer_varias') out = Object.fromEntries((body.p_claves || []).filter((c) => c in almacen).map((c) => [c, almacen[c]]));
    if (n === 'consultorio_config_set') { almacen[body.p.clave] = body.p.valor; out = true; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { leerMapeosSupabase, guardarMapeoSupabase, CLAVE_MAPEOS } = await import('../lib/mapeosSupabase.js');
  let lecturasGoogle = 0;
  const leerGoogle = async () => { lecturasGoogle++; return [{ telefono: '1', dni: '10', decision: 'si', fecha: 'f' }]; };
  const a = await leerMapeosSupabase({ leerGoogle });
  assert.equal(a.length, 1);
  assert.equal(lecturasGoogle, 1);
  assert.deepEqual(almacen[CLAVE_MAPEOS], a);
  await guardarMapeoSupabase({ telefono: '2', dni: '20', decision: 'no' }, { leerGoogle });
  await guardarMapeoSupabase({ telefono: '1', dni: '10', decision: 'no' }, { leerGoogle });
  assert.equal(almacen[CLAVE_MAPEOS].length, 2);
  assert.equal(almacen[CLAVE_MAPEOS].find((m) => m.dni === '10').decision, 'no');
  assert.equal(lecturasGoogle, 1, 'Google no se vuelve a leer');
});
