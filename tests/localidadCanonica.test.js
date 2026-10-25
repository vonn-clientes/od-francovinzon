import test from 'node:test';
import assert from 'node:assert/strict';
import { localidadCanonica, aplicarAccion } from '../lib/fichaMotor.js';

test('variantes de Concepción del Uruguay se normalizan', () => {
  for (const v of ['C Del U', 'C Del U ', 'Cdel U', 'C de Lu', 'C. del U.', 'CdU', 'c del u', 'Concepcion Del Uruguay ', 'Concepción Del Uruguay', 'concepción del uruguay', 'Concepcion']) {
    assert.equal(localidadCanonica(v), 'Concepción del Uruguay', v);
  }
});
test('otras localidades no se tocan', () => {
  for (const v of ['Rosario', 'Paraná', '']) assert.equal(localidadCanonica(v), v);
});
test('otras localidades de la lista se escriben bien', () => {
  const casos = { Gchu: 'Gualeguaychú', gualeguaychu: 'Gualeguaychú', 'San Jose': 'San José', 'san josé': 'San José', Caseros: 'Caseros', 'Urdinarrain Entre Rios': 'Urdinarrain', 'San Justo': 'San Justo', 'Villa elisa': 'Villa Elisa' };
  for (const [v, ok] of Object.entries(casos)) assert.equal(localidadCanonica(v), ok, v);
});
test('actualizar-campo localidad guarda el valor canónico', () => {
  const r = aplicarAccion({ campos: {}, movimientos: [], prestacionesObraSocial: [] }, 'actualizar-campo', { campo: 'localidad', valor: 'c del u' });
  assert.equal(r.ficha.campos.localidad, 'Concepción del Uruguay');
});
