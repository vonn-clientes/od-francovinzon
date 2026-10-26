import test from 'node:test';
import assert from 'node:assert/strict';
import { descripcionConConfirmado } from '../lib/agendaSupabase.js';
import { extraerConfirmado } from '../lib/googleCalendar.js';
test('turno confirmado en la columna se ve confirmado', () => {
  assert.equal(extraerConfirmado(descripcionConConfirmado({ confirmado: true, description_original: 'Teléfono: 1' })), true);
  assert.equal(extraerConfirmado(descripcionConConfirmado({ confirmado: true, description_original: 'Confirmado: No' })), true);
  assert.equal(extraerConfirmado(descripcionConConfirmado({ confirmado: false, description_original: 'Teléfono: 1' })), false);
  assert.equal(extraerConfirmado(descripcionConConfirmado({ confirmado: true, description_original: '' })), true);
});
