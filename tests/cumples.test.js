import test from 'node:test';
import assert from 'node:assert/strict';
import { esCumpleEn, marcarCumples } from '../lib/cumples.js';

test('detecta el cumpleaños y calcula la edad', () => {
  assert.deepEqual(esCumpleEn('26/11/1990', '2026-11-26'), { edad: 36 });
  assert.deepEqual(esCumpleEn('1990-11-26', '2026-11-26'), { edad: 36 });
  assert.equal(esCumpleEn('25/11/1990', '2026-11-26'), null);
  assert.equal(esCumpleEn('', '2026-11-26'), null);
  assert.equal(esCumpleEn('sin dato', '2026-11-26'), null);
});

test('29 de febrero se festeja el 28 en años no bisiestos', () => {
  assert.deepEqual(esCumpleEn('29/02/2000', '2027-02-28'), { edad: 27 });
  assert.equal(esCumpleEn('29/02/2000', '2028-02-28'), null);
  assert.deepEqual(esCumpleEn('29/02/2000', '2028-02-29'), { edad: 28 });
});

test('marca solo turnos con ficha y nunca bloqueos', async () => {
  const items = [
    { id: 1, tipo: 'turno', fichaId: 'a' },
    { id: 2, tipo: 'turno', fichaId: 'b' },
    { id: 3, tipo: 'turno' },
    { id: 4, tipo: 'bloqueo', fichaId: 'a' },
  ];
  const fichas = { a: { campos: { fechaNacimiento: '26/11/2000' } }, b: { campos: { fechaNacimiento: '01/01/2000' } } };
  await marcarCumples(items, '2026-11-26', { leerFicha: async (id) => fichas[id] });
  assert.deepEqual(items[0].cumple, { edad: 26 });
  assert.equal(items[1].cumple, undefined);
  assert.equal(items[2].cumple, undefined);
  assert.equal(items[3].cumple, undefined);
});

test('si falla la lectura de una ficha no rompe', async () => {
  const items = [{ id: 1, tipo: 'turno', fichaId: 'a' }];
  await marcarCumples(items, '2026-11-26', { leerFicha: async () => { throw new Error('caída'); } });
  assert.equal(items[0].cumple, undefined);
});
