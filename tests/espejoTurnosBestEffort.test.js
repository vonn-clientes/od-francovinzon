import test from 'node:test';
import assert from 'node:assert/strict';
import { espejarTurnosBestEffort } from '../lib/espejoTurnos.js';

const original = {
  flag: process.env.SUPABASE_SYNC_ON_WRITE,
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_KEY,
};
function configurar(flag) {
  process.env.SUPABASE_SYNC_ON_WRITE = flag;
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
}
test.afterEach(() => {
  for (const [key, value] of Object.entries({ SUPABASE_SYNC_ON_WRITE: original.flag, SUPABASE_URL: original.url, SUPABASE_SERVICE_KEY: original.key })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('flag apagado retorna sin llamar al espejo ni al timeout', async () => {
  configurar('0');
  let llamadas = 0;
  await espejarTurnosBestEffort({ sincronizar: async () => { llamadas++; }, timeout: async (p) => { llamadas++; return p; } });
  assert.equal(llamadas, 0);
});

test('error de Supabase no se propaga', async () => {
  configurar('1');
  await assert.doesNotReject(espejarTurnosBestEffort({ sincronizar: async () => { throw new Error('error'); }, timeout: async (p) => p }));
});

test('timeout no se propaga', async () => {
  configurar('1');
  await assert.doesNotReject(espejarTurnosBestEffort({ sincronizar: async () => ({}), timeout: async () => { throw new Error('timeout'); } }));
});
