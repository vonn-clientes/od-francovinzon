import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarDni } from '../lib/pacientesSheet.js';
import { mismaPersonaEstricta } from '../lib/identidadTurno.js';

test('DNI de relleno cuenta como sin DNI', () => {
  for (const d of ['0', '00000000', '11111111', '999999', '123', '-', '']) assert.equal(normalizarDni(d), '');
  assert.equal(normalizarDni('46.861.050'), '46861050');
});

test('dos personas con DNI de relleno no son la misma por eso', () => {
  const a = { dni: '00000000', nombre: 'Ana', apellido: 'Paz', telefono: '3442111111' };
  const b = { dni: '00000000', nombre: 'Luis', apellido: 'Paz', telefono: '3442111111' };
  assert.equal(mismaPersonaEstricta(a, b), false);
  assert.equal(mismaPersonaEstricta(a, { ...a }), true);
});
