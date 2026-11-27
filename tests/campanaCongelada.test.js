import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metricasConResumenFinal, normalizarCampana } from '../lib/campanasAnalisis.js';

const cerrada = { id: 'a', nombre: 'Meta', inicio: '2026-09-01', fin: '2026-09-30', inversiones: [{ concepto: 'Meta', monto: 90000 }],
  resumenFinal: { guardadoEn: '2026-10-01T00:00:00Z', metricas: { nuevas: 9, recurrentes: 4, dias: 29 } } };

test('campaña cerrada: los pacientes nuevos quedan fijos aunque los datos vivos cambien', () => {
  const m = metricasConResumenFinal(cerrada, { nuevas: 1, recurrentes: 12, dias: 29, inversionTotal: 0, costoPorNueva: null });
  assert.equal(m.nuevas, 9);
  assert.equal(m.recurrentes, 4);
  assert.equal(m.costoPorNueva, 10000);
  assert.equal(m.resumenCongelado, true);
});

test('campaña abierta o sin resumen guardado: sigue en vivo', () => {
  const vivo = { nuevas: 3 };
  assert.equal(metricasConResumenFinal({ ...cerrada, fin: null }, vivo), vivo);
  assert.equal(metricasConResumenFinal({ ...cerrada, resumenFinal: undefined }, vivo), vivo);
});

test('normalizarCampana conserva el resumen guardado', () => {
  assert.deepEqual(normalizarCampana(cerrada).resumenFinal, cerrada.resumenFinal);
});

test('admin.js: al finalizar guarda el resumen y las métricas lo usan', () => {
  const src = readFileSync(new URL('../api/gestion/admin.js', import.meta.url), 'utf8');
  assert.ok(src.includes('resumenFinalDe(cerrada, hoy)'));
  assert.ok(src.includes('return metricasConResumenFinal(c, metricas);'));
});
