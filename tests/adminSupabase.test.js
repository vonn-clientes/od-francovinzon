import test from 'node:test';
import assert from 'node:assert/strict';
import { filasAEscaneo, escanearFichasDesdeSupabase, debeUsarSupabaseAdmin, rpcAdmin } from '../lib/adminSupabase.js';

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
  assert.deepEqual(Object.keys(e.fichas[0].movimientos[0]), ['fecha', 'tratamiento', 'debe', 'haber', 'saldo', 'formaPago', 'monedaDebe', 'monedaHaber', 'aplicaA', 'cotizacion']);
});

test('días sin pago absurdos (>10 años) se descartan igual que antes', () => {
  assert.equal(filasAEscaneo([{ ...fila, diasTexto: '99999' }]).fichas[0].diasSinPago, 0);
});

test('escanearFichasDesdeSupabase falla si no hay fichas o responde error', async () => {
  const env = { SUPABASE_READS: '1', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' };
  assert.equal(await escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: true, json: async () => [] }) }), null);
  assert.equal(await escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: false, status: 500 }) }), null);
  const ok = await escanearFichasDesdeSupabase({ env, fetchImpl: async () => ({ ok: true, json: async () => [fila] }) });
  assert.equal(ok.origen, 'supabase');
});

test('filasAEscaneo adapta ficha_json.campos y movimientos', () => {
  const r = filasAEscaneo([{ id: 'sb-1', ficha_json: { campos: { nombre: 'Ana', apellido: 'Paz', dni: '123', localidad: 'Uru' }, financiero: { saldo: '$1.200,50', diasSinPagoTexto: '42' }, movimientos: [{ fecha: '1/2/2026', debe: '$2,00', monedaDebe: 'USD' }] } }]);
  assert.equal(r.fichas[0].archivo.includes('Ana'), true);
  assert.equal(r.fichas[0].saldo, 1200.5);
  assert.equal(r.fichas[0].diasSinPago, 42);
  assert.equal(r.fichas[0].movimientos[0].monedaDebe, 'USD');
});

test('rpcAdmin vuelve null ante fallo y no propaga excepciones', async () => {
  const env = { SUPABASE_READS: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'secret' };
  assert.equal(await rpcAdmin('consultorio_prueba', {}, { env, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await rpcAdmin('consultorio_prueba', {}, { env, fetchImpl: async () => ({ ok: false }) }), null);
});

test('debeUsarSupabaseAdmin exige la bandera y las credenciales', () => {
  assert.equal(debeUsarSupabaseAdmin({ SUPABASE_READS: '1', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }), true);
  assert.equal(debeUsarSupabaseAdmin({ SUPABASE_READS: '0', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }), false);
});

test('los saldos en pesos y en dólares se calculan por separado', async () => {
  const { calcularCuentas } = await import('../lib/cuentaSaldo.js');
  const c = calcularCuentas([
    { debe: '$100.000,00', haber: '$40.000,00', monedaDebe: 'ARS', monedaHaber: 'ARS' },
    { debe: '$1.000,00', haber: '$300,00', monedaDebe: 'USD', monedaHaber: 'USD' },
  ]);
  assert.equal(c.ARS.saldo, 60000);
  assert.equal(c.USD.saldo, 700);
});
