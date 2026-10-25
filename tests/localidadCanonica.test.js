import test from 'node:test';
import assert from 'node:assert/strict';
import { localidadCanonica, aplicarAccion } from '../lib/fichaMotor.js';

test('variantes de Concepción del Uruguay se normalizan', () => {
  for (const v of ['C Del U', 'C Del U ', 'Cdel U', 'C de Lu', 'C. del U.', 'CdU', 'c del u', 'Concepcion Del Uruguay ', 'Concepción Del Uruguay', 'concepción del uruguay', 'Concepcion']) {
    assert.equal(localidadCanonica(v), 'Concepción del Uruguay', v);
  }
});
test('otras localidades no se tocan', () => {
  for (const v of ['Gchu', 'Caseros', 'San Jose', 'Urdinarrain Entre Rios', '']) assert.equal(localidadCanonica(v), v);
});
test('actualizar-campo localidad guarda el valor canónico', () => {
  const r = aplicarAccion({ campos: {}, movimientos: [], prestacionesObraSocial: [] }, 'actualizar-campo', { campo: 'localidad', valor: 'c del u' });
  assert.equal(r.ficha.campos.localidad, 'Concepción del Uruguay');
});
