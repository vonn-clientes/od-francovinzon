import test from 'node:test';
import assert from 'node:assert/strict';
import { separarNombres, sugerirTurnoCompartido, claveCompartido } from '../lib/turnoCompartido.js';

test('separa nombres de un turno compartido', () => {
  assert.deepEqual(separarNombres('Agostina Y Benja Schulman'), ['Agostina Schulman', 'Benja Schulman']);
  assert.deepEqual(separarNombres('Juan Pérez y Ana Gómez'), ['Juan Pérez', 'Ana Gómez']);
  assert.equal(separarNombres('Ana Rios'), null);
  assert.equal(separarNombres('Yanina Gómez'), null);
});

test('sugiere la ficha de cada persona por teléfono, apellido y nombre', () => {
  const fichas = [
    { fichaId: 'A', nombre: 'Agostina', apellido: 'Schulman', telefono: '3814152224' },
    { fichaId: 'B', nombre: 'Benjamin', apellido: 'Schulman', telefono: '3814152224' },
    { fichaId: 'C', nombre: 'Benjamin', apellido: 'Valdez', telefono: '3442458467' },
  ];
  const r = sugerirTurnoCompartido({ nombre: 'Agostina Y Benja Schulman', telefono: '5493814152224' }, fichas);
  assert.deepEqual(r.map((x) => x.sugerida?.id), ['A', 'B']);
  assert.equal(sugerirTurnoCompartido({ nombre: 'Ana Rios', telefono: '1' }, fichas), null);
});

test('sin teléfono en común no sugiere', () => {
  const fichas = [{ fichaId: 'B', nombre: 'Benjamin', apellido: 'Schulman', telefono: '1111111111' }];
  const r = sugerirTurnoCompartido({ nombre: 'Agostina y Benja Schulman', telefono: '3814152224' }, fichas);
  assert.equal(r[1].sugerida, null);
});

test('clave estable', () => {
  assert.equal(claveCompartido({ nombre: 'Agostina Y Benja  Schulman', telefono: '+54 9 381 415-2224', dni: '' }), claveCompartido({ nombre: 'agostina y benja schulman', telefono: '3814152224' }));
});
