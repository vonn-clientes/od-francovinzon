import test from 'node:test';
import assert from 'node:assert/strict';
import { filasAEscaneo, escanearFichasDesdeSupabase, debeUsarSupabaseAdmin } from '../lib/adminSupabase.js';

const fila = {
  id: 'f1', nombre: 'Iara', apellido: 'Barreto', dni: '47.782.165', fechaNacimiento: '31/01/2007', localidad: 'C Del U',
  obraSocial: 'Particular', planTratamiento: '', saldoTexto: '$45.000,00', diasTexto: '16',
  movimientos: [{ fecha: '4/8/2026', tratamiento: 'x', debe: '$75.000,00', haber: '$50.000,00', saldo: '$25.000,00', formaPago: '' }],
};

test('filasAEscaneo replica la forma del escaneo de Google', () => {
  const e = filasAEscaneo([fila]);
  assert.equal(e.total, 1); assert.equal(e.fallidos, 0);
  assert.equal(e.fichas[0].saldo, 45000); assert.equal(e.fichas[0].diasSinPago, 16);
  assert.equal(e.fichas[0].archivo, 'Iara Barreto - 47.782.165 - Ficha');
  assert.deepEqual(Object.keys(e.fichas[0].movimientos[0]), ['fecha', 'tratamiento', 'debe', 'haber', 'saldo', 'formaPago']);
});

test('días sin pago absurdos (>10 años) se descartan igual que antes', () => {
  assert.equal(filasAEscaneo([{ ...fila, diasTexto: '99999' }]).fichas[0].diasSinPago, 0);
});

test('escanearFichasDesdeSupabase falla si no hay fichas o responde error', async () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' };
  await assert.rejects(escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: true, json: async () => [] }) }));
  await assert.rejects(escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: false, status: 500 }) }));
  const ok = await escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: true, json: async () => [fila] }) });
  assert.equal(ok.origen, 'supabase');
});

test('debeUsarSupabaseAdmin exige la bandera y las credenciales', () => {
  assert.equal(debeUsarSupabaseAdmin({ SUPABASE_READS: '1', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }), true);
  assert.equal(debeUsarSupabaseAdmin({ SUPABASE_READS: '0', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }), false);
});
