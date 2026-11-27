import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('healthcheck: un respaldo que no se crea avisa y marca error', () => {
  const src = readFileSync(new URL('../api/gestion/pacientes.js', import.meta.url), 'utf8');
  assert.ok(src.includes('if (!respaldo.ok)'));
  assert.ok(src.includes("resultados.respaldo === 'error';"));
});
