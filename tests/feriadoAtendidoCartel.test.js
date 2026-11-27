import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('buscar.js: con agenda en Supabase el cartel de feriado lee atendido/bloqueado', () => {
  const src = readFileSync(new URL('../api/gestion/buscar.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function feriadoDelDia');
  const cuerpo = src.slice(i, i + 2500);
  assert.ok(!cuerpo.includes("{ feriado, atendido: false, bloqueado: false }"));
  assert.ok(cuerpo.includes("ev.__tipo === 'feriado_atendido'"));
});
