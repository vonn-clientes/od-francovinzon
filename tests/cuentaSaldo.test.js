import test from 'node:test';
import assert from 'node:assert/strict';
import { parsearImporteAR, efectoMov, calcularCuentas } from '../lib/cuentaSaldo.js';

test('importes argentinos, vacíos, ilegibles y numéricos conservan el parser del navegador', () => {
  for (const [entrada, esperado] of [
    ['$1.234,56', 1234.56], ['US$300,00', 300], ['$0,00', 0], ['', 0],
    [null, 0], [undefined, 0], ['ilegible', 0], [1234.56, 1234.56],
    ['1.000', 1000], ['12.50', 12.5], ['-$1.234,56', -1234.56],
    [Infinity, 0], [1.234, 1234],
  ]) assert.equal(parsearImporteAR(entrada), esperado);
});

test('cuenta en pesos y cuentas vacías', () => {
  assert.deepEqual(calcularCuentas([{ debe: '$1.000,00' }, { haber: '$300,00' }]), {
    ARS: { debe: 1000, pagado: 300, saldo: 700 }, USD: { debe: 0, pagado: 0, saldo: 0 },
  });
  assert.deepEqual(calcularCuentas(), calcularCuentas([{ debe: '', haber: '' }]));
});

test('deuda en dólares permanece separada de pesos', () => {
  const c = calcularCuentas([{ debe: 300, monedaDebe: 'USD' }, { debe: 1000 }, { haber: 50, monedaHaber: 'USD' }]);
  assert.deepEqual(c.USD, { debe: 300, pagado: 50, saldo: 250 });
  assert.equal(c.ARS.saldo, 1000);
});

test('pago en pesos cancela dólares con cotización congelada, por encima del fallback', () => {
  const c = calcularCuentas([
    { debe: 300, monedaDebe: 'USD' },
    { haber: 150000, aplicaA: 'USD', cotizacion: '1000' },
    { haber: 300000, aplicaA: 'USD', cotizacion: 2000 },
  ], 500);
  assert.deepEqual(c.USD, { debe: 300, pagado: 300, saldo: 0 });
  assert.equal(c.ARS.pagado, 0);
});

test('conversión sin cotización acredita cero; fallback y conversión inversa', () => {
  assert.equal(efectoMov({ haber: 1000, aplicaA: 'USD' }).acreditado, 0);
  assert.equal(efectoMov({ haber: 1000, aplicaA: 'USD' }, 1000).acreditado, 1);
  assert.equal(efectoMov({ haber: 2, monedaHaber: 'USD', aplicaA: 'ARS', cotizacion: 1000 }).acreditado, 2000);
  assert.equal(efectoMov({ haber: 1000 }).acreditado, 1000);
});

test('anulados por indicador o prefijo no afectan saldo y no se mutan entradas', () => {
  const movimientos = Object.freeze([
    Object.freeze({ debe: 20 }),
    Object.freeze({ debe: 200, anulado: true }),
    Object.freeze({ haber: 500, tratamiento: '[ANULADO] Pago', anulado: false }),
  ]);
  assert.equal(calcularCuentas(movimientos).ARS.saldo, 20);
});
