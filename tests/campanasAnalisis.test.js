import test from 'node:test';
import assert from 'node:assert/strict';
import { unirAgendaConActividad, parseFechaFlexible, analizarPeriodo, metricasCampana, esDniPrueba, hoyAR, sumarDiasYmd, diasEntre } from '../lib/campanasAnalisis.js';

const ar = (s) => Date.parse(`${s}-03:00`);
// Todos los datos son inventados.
const reg = (o) => ({ dni: '', telefono: '', nombre: '', creado: ar('2026-11-02T10:00:00'), ...o });

test('fechas en hora Argentina', () => {
  assert.equal(sumarDiasYmd('2026-11-01', -1), '2026-10-31');
  assert.equal(diasEntre('2026-11-01', '2026-11-05'), 5);
  assert.equal(hoyAR(ar('2026-11-05T23:30:00')), '2026-11-05');
  assert.equal(hoyAR(Date.parse('2026-11-06T02:30:00Z')), '2026-11-05'); // 23:30 AR
});

test('dni de prueba', () => {
  assert.equal(esDniPrueba('22222222'), true);
  assert.equal(esDniPrueba('12345678'), true);
  assert.equal(esDniPrueba('123'), true);
  assert.equal(esDniPrueba(''), false);
  assert.equal(esDniPrueba('30.111.222'), false);
});

test('cuenta por creación (no por fecha del turno) y separa nuevas de recurrentes', () => {
  const registros = [
    reg({ dni: '30111222', nombre: 'Ana Prueba', creado: ar('2026-11-02T10:00:00'), inicio: ar('2026-11-20T10:00:00') }), // nueva, turno futuro
    reg({ dni: '30111222', nombre: 'Ana Prueba', creado: ar('2026-11-03T10:00:00') }), // misma persona
    reg({ dni: '31222333', nombre: 'Beto Ejemplo', creado: ar('2026-11-04T09:00:00') }), // recurrente
    reg({ dni: '31222333', nombre: 'Beto Ejemplo', creado: ar('2026-09-01T09:00:00') }), // turno previo
    reg({ dni: '32333444', nombre: 'Cami Fuera', creado: ar('2026-11-06T00:00:01') }), // fuera del rango
    reg({ dni: '33444555', nombre: 'Dani Ficha', creado: ar('2026-11-01T12:00:00') }), // con ficha, sin turnos previos
  ];
  const padron = [{ dni: '33444555', nombre: 'Dani Ficha', ficha: true }];
  const r = analizarPeriodo({ registros, padron, desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r.turnosCreados, 4);
  assert.equal(r.personasDistintas, 3);
  assert.equal(r.nuevas, 1);
  assert.equal(r.recurrentes, 1);
  assert.equal(r.conFichaSinFechaClara, 1);
});

test('ficha anterior (última visita previa) = recurrente; ficha sin fecha clara = grupo aparte', () => {
  const registros = [
    reg({ dni: '30111222', nombre: 'Vieja Ficha', creado: ar('2026-11-02T10:00:00') }),
    reg({ dni: '31222333', nombre: 'Ficha Reciente', creado: ar('2026-11-03T10:00:00') }),
    reg({ dni: '32333444', nombre: 'Sin Ficha', creado: ar('2026-11-04T10:00:00') }),
  ];
  const padron = [
    { dni: '30111222', nombre: 'Vieja Ficha', ficha: true, ultimaVisita: ar('2026-08-10T12:00:00') },
    { dni: '31222333', nombre: 'Ficha Reciente', ficha: true, ultimaVisita: ar('2026-11-03T12:00:00') },
  ];
  const r = analizarPeriodo({ registros, padron, desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r.recurrentes, 1);
  assert.equal(r.conFichaSinFechaClara, 1);
  assert.equal(r.nuevas, 1);
});

test('fechas del padrón en ISO y dd/mm/aaaa', () => {
  assert.equal(parseFechaFlexible('03/10/2026'), Date.parse('2026-10-03T12:00:00-03:00'));
  assert.equal(parseFechaFlexible('2026-10-03'), Date.parse('2026-10-03'));
  assert.equal(parseFechaFlexible(''), null);
  assert.equal(parseFechaFlexible('nunca'), null);
});

test('el límite del período usa el día completo en hora Argentina', () => {
  const registros = [
    reg({ dni: '30111222', nombre: 'Ana Prueba', creado: ar('2026-11-05T23:59:00') }),
    reg({ dni: '31222333', nombre: 'Beto Ejemplo', creado: ar('2026-11-01T00:00:00') }),
    reg({ dni: '32333444', nombre: 'Cami Fuera', creado: ar('2026-10-31T23:59:59') }),
  ];
  const r = analizarPeriodo({ registros, desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r.nuevas, 2);
});

test('dudosos no se cuentan: dni de prueba, teléfono con dni distintos, sin datos', () => {
  const registros = [
    reg({ dni: '22222222', nombre: 'Prueba Uno', telefono: '3442111111' }),
    reg({ dni: '30111222', nombre: 'Padre Madre', telefono: '3442222222' }),
    reg({ dni: '30111223', nombre: 'Hijo Madre', telefono: '3442222222' }),
    reg({ nombre: 'Sin Datos' }),
  ];
  const r = analizarPeriodo({ registros, desde: '2026-11-01', hasta: '2026-11-05' });
  const motivos = r.dudosos.map((d) => d.motivo).join('|');
  assert.match(motivos, /DNI de prueba/);
  assert.match(motivos, /Mismo teléfono asociado a DNI distintos/);
  assert.match(motivos, /sin DNI ni teléfono/);
  assert.equal(r.nuevas, 0);
  assert.ok(r.dudosos.every((d) => !('nombre' in d)));
});

test('mismo nombre con DNI distinto es dudoso; el teléfono solo no alcanza para decir recurrente', () => {
  const registros = [
    reg({ dni: '30111222', nombre: 'Juan Perez', creado: ar('2026-10-01T10:00:00') }),
    reg({ dni: '35999888', nombre: 'Juan Perez' }),
    reg({ nombre: 'Nene Gomez', telefono: '3442333333', creado: ar('2026-10-01T10:00:00') }),
    reg({ nombre: 'Nena Gomez', telefono: '3442333333' }),
  ];
  const r = analizarPeriodo({ registros, desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r.dudosos.length, 1);
  assert.equal(r.nuevas, 1); // Nena Gomez: mismo teléfono que Nene, pero otro nombre → persona nueva
  assert.equal(r.recurrentes, 0);
});

test('fecha de creación ausente o de migración se informa, no se estima', () => {
  const registros = [
    { dni: '30111222', nombre: 'Ana', creado: NaN },
    reg({ dni: '31222333', nombre: 'Beto', creado: ar('2026-11-02T10:00:00'), inicio: ar('2026-08-01T10:00:00') }),
  ];
  const r = analizarPeriodo({ registros, desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r.noDeterminable.length, 2);
});

test('métricas de campaña: promedio vs 30 días previos y costo por nueva', () => {
  const registros = [
    reg({ dni: '30111222', nombre: 'Ana', creado: ar('2026-10-20T10:00:00') }), // previo (nueva en la base)
    reg({ dni: '31222333', nombre: 'Beto', creado: ar('2026-11-02T10:00:00')}),
    reg({ dni: '32333444', nombre: 'Cami', creado: ar('2026-11-03T10:00:00')}),
  ];
  const m = metricasCampana({ campana: { inicio: '2026-11-01', fin: '2026-11-05', inversion: 50000 }, registros, padron: [], hoy: '2026-11-06' });
  assert.equal(m.nuevas, 2);
  assert.equal(m.dias, 5);
  assert.equal(m.promedioDiarioNuevas, 0.4);
  assert.equal(m.nuevasPrevios30, 1);
  assert.equal(m.promedioDiarioNuevasPrevios30, 0.03);
  assert.equal(m.costoPorNueva, 25000);
  const sinInv = metricasCampana({ campana: { inicio: '2026-11-01', fin: null }, registros, padron: [], hoy: '2026-11-06' });
  assert.equal(sinInv.costoPorNueva, null);
});

test('une el registro de actividad con la agenda por nombre + fecha + hora (Argentina)', () => {
  const agenda = [
    { dni: '30111222', telefono: '3442000001', nombre: 'Ana Prueba', inicio: ar('2026-11-20T10:00:00') },
    { dni: '31222333', telefono: '3442000002', nombre: 'Beto Ejemplo', inicio: ar('2026-09-10T09:30:00') }, // sin alta en el registro
  ];
  const actividad = [
    { tipo: 'turno_creado', fecha: '2026-11-02T13:00:00+00:00', detalle: 'Ana Prueba — 2026-11-20 10:00' },
    { tipo: 'sobreturno_creado', fecha: '2026-11-03T13:00:00+00:00', detalle: 'Cami Cancelada — 2026-11-21 11:00' }, // ya no está en la agenda
    { tipo: 'login', fecha: '2026-10-27T13:00:00+00:00', detalle: '/admin' },
  ];
  const { registros, coberturaDesde } = unirAgendaConActividad({ agenda, actividad });
  assert.equal(coberturaDesde, Date.parse('2026-10-27T13:00:00+00:00'));
  assert.equal(registros.length, 3);
  const ana = registros.find((r) => r.nombre === 'Ana Prueba');
  assert.equal(ana.dni, '30111222');
  assert.equal(ana.creado, Date.parse('2026-11-02T13:00:00+00:00'));
  const cami = registros.find((r) => r.nombre === 'Cami Cancelada');
  assert.equal(cami.dni, ''); // sin datos de contacto → irá a dudosos, nunca cuenta como nueva
  const beto = registros.find((r) => r.nombre === 'Beto Ejemplo');
  assert.ok(Number.isNaN(beto.creado)); // creación desconocida
  const r = analizarPeriodo({ registros, desde: '2026-11-01', hasta: '2026-11-05', coberturaDesde });
  assert.equal(r.nuevas, 1);
  assert.equal(r.dudosos.length, 1);
  assert.equal(r.noDeterminable.length, 0);
  // Beto (turno del 10/09, creación desconocida) cuenta como turno previo de sí mismo si vuelve a sacar turno
  const r2 = analizarPeriodo({ registros: [...registros, { dni: '31222333', telefono: '3442000002', nombre: 'Beto Ejemplo', creado: ar('2026-11-04T10:00:00') }], desde: '2026-11-01', hasta: '2026-11-05' });
  assert.equal(r2.recurrentes, 1);
});

test('si el registro empieza después del inicio del período se avisa', () => {
  const r = analizarPeriodo({ registros: [], desde: '2026-11-01', hasta: '2026-11-05', coberturaDesde: ar('2026-11-03T00:00:00') });
  assert.match(r.noDeterminable[0].motivo, /empieza después/);
});
