import test from 'node:test';
import assert from 'node:assert/strict';
import { firmarToken, verificarToken, vistaPublica, validarCambios } from '../lib/autoficha.js';

const secreto = 'secreto-test';

test('token válido, expirado y manipulado', () => {
  const token = firmarToken({ fichaId: 'ficha-123', ahora: 1000, ttlMs: 5000, secreto });
  assert.deepEqual(verificarToken(token, { ahora: 2000, secreto }), { ok: true, fichaId: 'ficha-123' });
  assert.deepEqual(verificarToken(token, { ahora: 6000, secreto }), { ok: false, motivo: 'expirado' });
  const manipulado = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.deepEqual(verificarToken(manipulado, { ahora: 2000, secreto }), { ok: false, motivo: 'invalido' });
});

test('vista pública incluye solo campos autorizados aunque haya datos financieros', () => {
  const vista = vistaPublica({ campos: { nombre: 'Ana', telefono: '111', saldo: '$900', movimientos: [1], prestaciones: [2], financiero: { total: 9 } }, saldo: 22 });
  assert.deepEqual(Object.keys(vista), ['nombre', 'apellido', 'dni', 'fechaNacimiento', 'domicilio', 'localidad', 'telefono', 'obraSocial', 'nAfiliado', 'plan']);
  assert.equal(vista.nombre, 'Ana');
  assert.equal('saldo' in vista || 'movimientos' in vista || 'financiero' in vista, false);
});

test('validaciones, campos desconocidos, cambios vacíos y bloqueos', () => {
  const actuales = { nombre: 'Ana', apellido: 'Pérez', dni: '12345678', domicilio: 'Calle 1' };
  const resultado = validarCambios({
    nombre: 'Otro', dni: '11111111', domicilio: '  Calle 2  ', telefono: 'abc',
    fechaNacimiento: '31/02/2000', inventado: 'x', localidad: 'L'.repeat(121),
  }, actuales, { ahora: new Date('2026-10-22T12:00:00') });
  assert.deepEqual(resultado.cambios, [{ campo: 'domicilio', valor: 'Calle 2' }]);
  assert.equal(resultado.errores.telefono, 'Ingresá un teléfono válido (al menos 8 dígitos).');
  assert.match(resultado.errores.fechaNacimiento, /fecha válida/);
  assert.equal(resultado.errores.inventado, 'Campo no permitido.');
  assert.match(resultado.errores.localidad, /120 caracteres/);
  assert.deepEqual(validarCambios({ domicilio: 'Calle 1' }, actuales).cambios, []);
});

test('DNI y nombre/apellido vacíos se pueden completar; DNI debe tener 7 u 8 dígitos', () => {
  const r = validarCambios({ nombre: ' Lucía ', apellido: 'Suárez', dni: '1234567' }, {});
  assert.deepEqual(r.cambios, [{ campo: 'nombre', valor: 'Lucía' }, { campo: 'apellido', valor: 'Suárez' }, { campo: 'dni', valor: '1234567' }]);
  assert.match(validarCambios({ dni: '123' }, {}).errores.dni, /7 u 8/);
});
