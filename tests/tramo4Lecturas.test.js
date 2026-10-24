import test from 'node:test';
import assert from 'node:assert/strict';
import { filasAEscaneo } from '../lib/adminSupabase.js';

test('tramo 4 preserva ficha vacía como señal para usar Google', () => {
  const filas = filasAEscaneo([{ id: 'sb-9', ficha_json: { campos: {}, movimientos: [] } }]);
  assert.equal(filas.total, 1);
  assert.equal(filas.fichas[0].movimientos.length, 0);
  assert.equal(filas.fichas[0].saldo, 0);
});

test('tramo 4 acepta los datos planos de RPC existentes por compatibilidad', () => {
  const filas = filasAEscaneo([{ id: 'x', nombre: 'Eva', apellido: 'Sol', saldoTexto: '$20,00', movimientos: [{ fecha: '1/1/2026' }] }]);
  assert.equal(filas.fichas[0].saldo, 20);
  assert.equal(filas.fichas[0].movimientos.length, 1);
});
