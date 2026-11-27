import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esExtensionDeNombre } from '../lib/identidadTurno.js';

test('solo se completa un nombre si el corto está contenido en el largo', () => {
  assert.equal(esExtensionDeNombre('Juan Perez', 'Juan Carlos Perez'), true);
  assert.equal(esExtensionDeNombre('Perez Juan', 'JUAN CARLOS PÉREZ'), true);
  assert.equal(esExtensionDeNombre('Juan Perez', 'Maria Gomez Lopez'), false);
  assert.equal(esExtensionDeNombre('', 'Juan Perez'), false);
});

test('confirmarMatch no renombra sin esa guarda', () => {
  const src = readFileSync(new URL('../api/gestion/pacientes.js', import.meta.url), 'utf8');
  assert.equal((src.match(/esExtensionDeNombre\(/g) || []).length, 2);
});
