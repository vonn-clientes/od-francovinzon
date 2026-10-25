import test from 'node:test';
import assert from 'node:assert/strict';
import { mismaPersonaEstricta as m } from '../lib/identidadTurno.js';

test('DNI idéntico = misma persona; DNI distinto = distinta aunque compartan teléfono', () => {
  assert.equal(m({ dni: '30.111.222', telefono: '1' }, { dni: '30111222', telefono: '2' }), true);
  assert.equal(m({ dni: '30111222', telefono: '3442111111', nombre: 'Ana' }, { dni: '50111222', telefono: '3442111111', nombre: 'Ana' }), false);
});
test('sin DNI: hace falta nombre completo exacto Y mismo teléfono', () => {
  const t = { nombre: 'Perez Ana', telefono: '+54 9 3442 11-1111' };
  assert.equal(m(t, { nombre: 'Ana', apellido: 'Perez', telefono: '3442111111' }), true);
  assert.equal(m(t, { nombre: 'Ana María', apellido: 'Perez', telefono: '3442111111' }), false, 'nombre parecido = duda');
  assert.equal(m(t, { nombre: 'Ana', apellido: 'Perez', telefono: '3442999999' }), false);
  assert.equal(m({ nombre: 'Hijo', telefono: '3442111111' }, { nombre: 'Padre', telefono: '3442111111' }), false, 'teléfono compartido solo no alcanza');
  assert.equal(m({ nombre: '', telefono: '' }, { nombre: '', telefono: '' }), false);
});
