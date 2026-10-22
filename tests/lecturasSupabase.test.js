import test from 'node:test';
import assert from 'node:assert/strict';
import { construirRespuestaFicha } from '../lib/respuestaFicha.js';
import { debeIntentarLecturaSupabase, fichaSupabaseFresca } from '../lib/lecturasSupabase.js';
import { crearClienteSupabase, conTimeout } from '../lib/sincronizarSupabase.js';

test('construirRespuestaFicha replica el JSON de obtenerFicha, incluidos anulados y prestaciones', () => {
  assert.deepEqual(construirRespuestaFicha({
    id: 'f-1', driveModifiedTime: '2026-10-20T12:00:00Z',
    campos: [['Ana'], ['Pérez'], ['123'], ['2000-01-01']], financiero: [['', '$1'], ['', '$2'], ['', '$3'], ['AL DÍA'], [], ['', '$4']],
    movRaw: [['01/01', '[ANULADO] control', '$5', '', '$5', '', 'Efectivo']],
    presRaw: [['02/01', 'Control', 'A1', 'TRUE'], ['', 'FALSE', '', 'FALSE']], monedaFilas: [['USD', '', '', '100']],
  }), {
    id: 'f-1', driveModifiedTime: '2026-10-20T12:00:00Z',
    campos: { nombre: 'Ana', apellido: 'Pérez', dni: '123', fechaNacimiento: '2000-01-01', domicilio: '', localidad: '', obraSocial: '', nAfiliado: '', plan: '', telefono: '', planTratamiento: '' },
    financiero: { total: '$1', pagado: '$2', saldo: '$3', alDiaTexto: 'AL DÍA', diasSinPagoTexto: '$4' },
    movimientos: [{ fila: 18, fecha: '01/01', tratamiento: '[ANULADO] control', debe: '$5', haber: '', saldo: '$5', formaPago: 'Efectivo', monedaDebe: 'USD', monedaHaber: '', aplicaA: '', cotizacion: '100', anulado: true }],
    prestacionesObraSocial: [{ fila: 18, fecha: '02/01', tratamiento: 'Control', codigo: 'A1', autorizado: true }],
  });
});

test('decide lectura Supabase solo con flag y credenciales, y acepta fechas iguales a milisegundos', () => {
  assert.equal(debeIntentarLecturaSupabase('0', 'u', 'k'), false);
  assert.equal(debeIntentarLecturaSupabase('1', 'u', ''), false);
  assert.equal(debeIntentarLecturaSupabase('1', 'u', 'k'), true);
  const f = { id: 'x' };
  assert.equal(fichaSupabaseFresca({ ficha: f, drive_modified_time: '2026-10-20T12:00:00.100Z' }, '2026-10-20T12:00:00.100Z'), f);
  assert.equal(fichaSupabaseFresca({ ficha: f, drive_modified_time: '2026-10-20T12:00:00.099Z' }, '2026-10-20T12:00:00.100Z'), null);
  assert.equal(fichaSupabaseFresca(null, '2026-10-20T12:00:00Z'), null);
});

test('errores, timeout, JSON inválido y sin fila quedan listos para fallback', async () => {
  const errorClient = crearClienteSupabase({ url: 'https://db.example', serviceKey: 'k', fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(errorClient.leerFicha('x'), /offline/);
  const badJson = crearClienteSupabase({ url: 'https://db.example', serviceKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) });
  await assert.rejects(badJson.leerFicha('x'), /JSON inválida/);
  const noRow = crearClienteSupabase({ url: 'https://db.example', serviceKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => null }) });
  assert.equal(await noRow.leerFicha('x'), null);
  await assert.rejects(conTimeout(new Promise(() => {}), 5), /timeout/);
});
