import test from 'node:test';
import assert from 'node:assert/strict';
import { listarConsolidadosSupabase, upsertConsolidadoSupabase, guardarAsistenciaSupabase } from '../lib/consolidadosSupabase.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'service' };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('consolidados consults are made only through public RPC endpoints', async () => {
  let url = '';
  const rows = await listarConsolidadosSupabase({ env, fetchImpl: async (u) => { url = u; return response(200, [{ id: 'x' }]); } });
  assert.deepEqual(rows, [{ id: 'x' }]);
  assert.equal(url, 'https://db.example/rest/v1/rpc/consultorio_consolidados_listar');
});

test('ambiguous Supabase upsert is reported without a Google fallback', async () => {
  let calls = 0;
  const result = await upsertConsolidadoSupabase({ dni: '123' }, { env, fetchImpl: async () => { calls++; throw new Error('timeout'); } });
  assert.deepEqual(result, { ok: false, motivo: 'ambiguo' });
  assert.equal(calls, 1);
});

test('attendance write calls its RPC and reports a rejected write', async () => {
  let url = '';
  const result = await guardarAsistenciaSupabase({ fichaId: 'f1' }, { env, fetchImpl: async (u) => { url = u; return response(200, { ok: false }); } });
  assert.equal(url, 'https://db.example/rest/v1/rpc/consultorio_consolidados_asistencia');
  assert.equal(result.ok, false);
});
