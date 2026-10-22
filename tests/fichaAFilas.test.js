import test from 'node:test';
import assert from 'node:assert/strict';
import { fichaAFilas } from '../lib/fichaAFilas.js';

test('transforma el objeto obtenerFicha y conserva datos, DNI y teléfono limpio', () => {
  const ficha = {
    campos: {
      nombre: ' Ada ', apellido: 'Ejemplo', dni: '12.345.678', telefono: ' +54 3442 123456 ',
      fechaNacimiento: '9/2/1990', obraSocial: 'Obra ficticia', plan: 'A',
      domicilio: 'Calle inventada 123', localidad: 'Ciudad ejemplo', nAfiliado: '0012', planTratamiento: 'Control',
    },
    movimientos: [{ fila: 18, fecha: '21/10/2026', tratamiento: 'Control', debe: '$1.234,56', haber: '' }],
  };
  const copia = structuredClone(ficha);
  assert.deepEqual(fichaAFilas(ficha), {
    paciente: {
      dni: '12345678', nombre: 'Ada', apellido: 'Ejemplo', telefono_e164: '+54 3442 123456',
      fecha_nacimiento: '1990-02-09', obra_social: 'Obra ficticia', plan: 'A',
      datos: { domicilio: 'Calle inventada 123', localidad: 'Ciudad ejemplo', nAfiliado: '0012', planTratamiento: 'Control' },
      saldo_ars: 1234.56, saldo_usd: 0,
    },
    movimientos: [{ fila_origen: 18, fecha: '2026-10-21', tratamiento: 'Control', debe: 1234.56, haber: 0,
      moneda_debe: 'ARS', moneda_haber: 'ARS', aplica_a: null, cotizacion: null, anulado: false }],
  });
  assert.deepEqual(ficha, copia);
});

test('saldos duales, conversión congelada, pago sin cotización y anulado retenido', () => {
  const { paciente, movimientos } = fichaAFilas({ movimientos: [
    { fila: 18, debe: 'US$300,00', monedaDebe: 'USD' },
    { fila: 19, haber: '$300.000,00', monedaHaber: 'ARS', aplicaA: 'USD', cotizacion: '1000' },
    { fila: 20, haber: 50000, aplicaA: 'USD' },
    { fila: 21, debe: 999, tratamiento: '[ANULADO] Control' },
    { fila: 22, debe: 888, anulado: true },
    { fila: 23, debe: 100, haber: 25 },
  ] });
  assert.equal(paciente.saldo_usd, 0);
  assert.equal(paciente.saldo_ars, 75);
  assert.equal(movimientos[1].cotizacion, 1000);
  assert.equal(movimientos[2].cotizacion, null);
  assert.equal(movimientos[3].anulado, true);
  assert.equal(movimientos[3].debe, 999);
  assert.equal(movimientos[4].anulado, true);
});

test('usa la cotización fallback para calcular saldo de una fila sin cotización propia', () => {
  const { paciente } = fichaAFilas({ movimientos: [
    { debe: 10, monedaDebe: 'USD' }, { haber: 10000, aplicaA: 'USD' },
  ] }, { cotizacionFallback: 1000 });
  assert.equal(paciente.saldo_usd, 0);
});

test('fechas imposibles, vacías y DNI sin dígitos producen null', () => {
  for (const fecha of ['31/02/2026', '29/02/2025', '0/1/2026', '1/13/2026', '', 'basura']) {
    const r = fichaAFilas({ campos: { fechaNacimiento: fecha, dni: 'sin DNI' }, movimientos: [{ fecha }] });
    assert.equal(r.paciente.fecha_nacimiento, null);
    assert.equal(r.paciente.dni, null);
    assert.equal(r.movimientos[0].fecha, null);
    assert.equal(r.movimientos[0].debe, 0);
  }
  assert.equal(fichaAFilas({ campos: { fechaNacimiento: '29/02/2024' } }).paciente.fecha_nacimiento, '2024-02-29');
});

test('fechas de movimientos: día/mes, ISO y serial con el criterio horario existente', () => {
  for (const [fecha, esperado] of [
    ['9/2/2026', '2026-02-09'], ['2026-10-21T12:00:00Z', '2026-10-21'],
    ['2026-02-30', null], [45235, '2023-11-04'], [45235.5, '2023-11-05'],
    [20000, null], [60000, null],
  ]) assert.equal(fichaAFilas({ movimientos: [{ fecha }] }).movimientos[0].fecha, esperado);
});

test('ficha vacía y metadatos inválidos tienen valores insertables', () => {
  const r = fichaAFilas({});
  assert.equal(r.paciente.saldo_ars, 0);
  assert.equal(r.paciente.saldo_usd, 0);
  assert.deepEqual(r.movimientos, []);
  for (const cotizacion of ['', 'ilegible', -1, Infinity, 0]) {
    const m = fichaAFilas({ movimientos: [{ cotizacion, aplicaA: 'EUR', monedaDebe: 'EUR' }] }).movimientos[0];
    assert.equal(m.cotizacion, null);
    assert.equal(m.aplica_a, null);
    assert.equal(m.moneda_debe, 'ARS');
  }
});
