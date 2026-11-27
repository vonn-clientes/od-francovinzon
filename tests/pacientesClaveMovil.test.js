import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pacientes/index.html', import.meta.url), 'utf8');

test('/pacientes manda la clave (header) en todos los pedidos de fotos y recetas', () => {
  const sensibles = ['modo=fotos', 'modo=foto-imagen', 'modo=recetas', 'modo=receta-pdf',
    "accion: 'subir-foto'", "accion: 'eliminar-foto'", "accion: 'receta-procesar-pdf'", "accion: 'receta-guardar'"];
  for (const marca of sensibles) assert.ok(html.includes(marca), `falta ${marca}`);
  // Ninguna llamada a esos endpoints puede usar fetch() pelado.
  for (const m of html.matchAll(/fetch\(([^;]*?)(?:\)\s*;|\n)/g)) {
    assert.ok(!/modo=(fotos|foto-imagen|recetas|receta-pdf)/.test(m[1]), `fetch sin clave: ${m[0].slice(0, 80)}`);
  }
  for (const accion of ["accion: 'eliminar-foto'", "accion: 'subir-foto'", "accion: 'receta-procesar-pdf'", "accion: 'receta-guardar'"]) {
    const i = html.indexOf(accion);
    const llamada = html.lastIndexOf('await fetch(', i);
    const llamadaMovil = html.lastIndexOf('await fetchMovil(', i);
    assert.ok(llamadaMovil > llamada, `${accion} no usa fetchMovil`);
  }
});

test('/pacientes no deja la clave en URLs ni carga fotos con <img src> directo', () => {
  assert.ok(!/<img src="\/api\/gestion\/pacientes\?modo=foto-imagen/.test(html));
  assert.ok(!/visorImg\.src = url/.test(html));
  assert.ok(html.includes("headers.set('x-gestion-key', gestionKey)"));
});
