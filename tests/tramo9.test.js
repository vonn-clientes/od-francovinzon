import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { crearRespaldoDiario } from '../lib/respaldoSupabase.js';
import { guardarConfigSupabase } from '../lib/espejoConfig.js';

test('RPC de configuración acepta escritura primaria sin bandera de espejo', async () => {
  const keys = ['SUPABASE_WRITES_PRIMARY', 'SUPABASE_SYNC_ON_WRITE', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_SYNC_ON_WRITE: '0', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'service' });
  let request;
  try {
    const ok = await guardarConfigSupabase('horarios', { slotMinutes: 30 }, '2026-10-24T00:00:00Z', {
      fetchImpl: async (url, init) => { request = { url, body: JSON.parse(init.body) }; return { ok: true }; },
    });
    assert.equal(ok, true);
    assert.equal(request.url, 'https://sb.test/rest/v1/rpc/consultorio_config_set');
    assert.equal(request.body.p.clave, 'horarios');
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

test('respaldo diario comprime exportación, mantiene 14 y elimina anteriores en Storage privado', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/consultorio_exportar_respaldo')) return { ok: true, json: async () => ({ pacientes: [{ ficha_json: { sensible: true } }] }) };
    if (url.includes('/object/list/respaldos')) return { ok: true, json: async () => Array.from({ length: 16 }, (_, i) => ({ name: `2026-10-${String(24 - i).padStart(2, '0')}.json.gz` })) };
    return { ok: true };
  };
  const r = await crearRespaldoDiario({ env: { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'service' }, fetchImpl, ahora: new Date('2026-10-24T15:00:00Z') });
  assert.equal(r.ok, true);
  const upload = calls.find((x) => x.url.includes('/object/respaldos/'));
  assert.match(upload.url, /2026-10-24\.json\.gz$/);
  assert.equal(upload.init.headers['Content-Type'], 'application/gzip');
  assert.equal(upload.init.headers['x-upsert'], 'true');
  assert.equal(JSON.parse(gunzipSync(upload.init.body).toString()).pacientes[0].ficha_json.sensible, true);
  const deletion = calls.find((x) => x.init.method === 'DELETE');
  assert.equal(deletion.init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(deletion.init.body).prefixes.length, 2);
});
