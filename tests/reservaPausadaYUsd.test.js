import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const leer = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');

test('reservar.js: la reserva online pausada se corta en el servidor antes de crear el turno', () => {
  const src = leer('../api/reservar.js');
  const iPausa = src.indexOf('await obtenerReservaOnlinePausada()');
  const iCrear = src.indexOf("escribirAgendaRpc('consultorio_agenda_crear_turno'");
  const iCrearGoogle = src.indexOf('await crearTurno(calendar');
  assert.ok(iPausa > 0, 'falta el chequeo de pausa');
  assert.ok(iPausa < iCrear && iPausa < iCrearGoogle, 'el chequeo debe ir antes de crear el turno');
  // Mover/cancelar/obtener/confirmar siguen funcionando aunque esté pausada (se resuelven antes).
  assert.ok(src.indexOf("accion === 'cancelar'") < iPausa);
});

test('admin.js: los cobros en dólares no se suman a los pesos', () => {
  const src = leer('../api/gestion/admin.js');
  const i = src.indexOf('async function calcularFinanzasPacientes');
  const cuerpo = src.slice(i, i + 12000);
  assert.ok(cuerpo.includes("m.monedaHaber === 'USD'"));
  assert.ok(cuerpo.indexOf("m.monedaHaber === 'USD'") < cuerpo.indexOf('ingresosPorDia[fechaISO] ='));
  assert.ok(cuerpo.includes('cobrosUsdPorMes'));
});
