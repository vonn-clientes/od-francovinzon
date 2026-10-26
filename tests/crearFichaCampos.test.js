import test from 'node:test';
import assert from 'node:assert/strict';
import { crearFichaSupabase } from '../lib/crearFichaSupabase.js';
test('crear ficha ignora campos que la ficha no guarda (email)', async () => {
  const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k' };
  const r = await crearFichaSupabase({ nombre: 'Ana', apellido: 'Paz', campos: { email: 'a@b.com', dni: '30123456' }, env,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, id: 'sb-1' }) }) });
  assert.equal(r.ok, true);
});
