import test from 'node:test';
import assert from 'node:assert/strict';

// Supabase simulado (todo inventado): agenda primaria + escritura primaria, sin tocar Google ni producción.
process.env.ADMIN_KEY = 'clave-test';
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'svc';
process.env.SUPABASE_AGENDA_PRIMARY = '1';
process.env.SUPABASE_WRITES_PRIMARY = '1';
process.env.CONFIG_SOLO_SUPABASE = '1';

const almacen = {};
let columnaCreacion = 'created_at';
let actividadMock = [];
const turno = (o) => ({ tipo: 'turno', estado: 'confirmado', inicio: '2026-11-20T13:00:00Z', motivo: 'Consulta', ...o });
const turnos = () => [
  turno({ paciente_nombre: 'Ana Prueba', dni: '30111222', telefono: '3442000001', [columnaCreacion]: '2026-11-02T13:00:00Z' }),
  turno({ paciente_nombre: 'Beto Ejemplo', dni: '31222333', telefono: '3442000002', [columnaCreacion]: '2026-11-03T13:00:00Z' }),
  turno({ paciente_nombre: 'Beto Ejemplo', dni: '31222333', telefono: '3442000002', [columnaCreacion]: '2026-09-01T13:00:00Z', inicio: '2026-09-10T13:00:00Z' }),
  turno({ paciente_nombre: 'Prueba Falsa', dni: '22222222', telefono: '3442000003', [columnaCreacion]: '2026-11-04T13:00:00Z' }),
  { tipo: 'bloqueo', paciente_nombre: 'Almuerzo', [columnaCreacion]: '2026-11-04T13:00:00Z' },
];

let listasMock = null;
globalThis.fetch = async (url, init) => {
  const nombre = String(url).split('/rpc/')[1];
  const cuerpo = init?.body ? JSON.parse(init.body) : {};
  const ok = (data) => ({ ok: true, json: async () => data });
  if (nombre === 'consultorio_agenda_listar') return ok({ turnos: turnos() });
  if (nombre === 'consultorio_consolidados_listar') return ok([]);
  if (nombre === 'consultorio_actividad_recientes') return ok(actividadMock);
  if (nombre === 'consultorio_config_leer_varias') {
    const r = {}; for (const c of cuerpo.p_claves) if (c in almacen) r[c] = almacen[c]; return ok(r);
  }
  if (nombre === 'consultorio_config_set') { almacen[cuerpo.p.clave] = cuerpo.p.valor; return ok({ ok: true }); }
  if (nombre === 'consultorio_log_actividad') return ok({ ok: true });
  throw new Error(`rpc inesperada: ${nombre}`);
};

const { default: handler } = await import('../api/gestion/admin.js');

function llamar({ method = 'GET', query = {}, body = {} }) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, data: d }); }, send(d) { resolve({ status: this.statusCode, data: d }); } };
    handler({ method, query, body, headers: {} }, res);
  });
}

test('sin clave no responde', async () => {
  const r = await llamar({ query: { recurso: 'campana-analisis', desde: '2026-11-01', hasta: '2026-11-05' } });
  assert.equal(r.status, 401);
});

test('conteo por fecha de creación sobre la agenda en Supabase', async () => {
  const r = await llamar({ query: { recurso: 'campana-analisis', key: 'clave-test', desde: '2026-11-01', hasta: '2026-11-05' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.turnosCreados, 2);
  assert.equal(r.data.nuevas, 1);
  assert.equal(r.data.recurrentes, 1);
  assert.equal(r.data.dudosos.length, 1);
  assert.equal(JSON.stringify(r.data).includes('Ana Prueba'), false, 'sin nombres por defecto');
});

test('con ?detalle=1 salen los nombres', async () => {
  const r = await llamar({ query: { recurso: 'campana-analisis', key: 'clave-test', desde: '2026-11-01', hasta: '2026-11-05', detalle: '1' } });
  assert.deepEqual(r.data.nombres.nuevas, ['Ana Prueba']);
});

test('sin columna de creación y sin registro: no se estima, se informa', async () => {
  columnaCreacion = 'otra_cosa';
  const r = await llamar({ query: { recurso: 'campana-analisis', key: 'clave-test', desde: '2026-11-01', hasta: '2026-11-05' } });
  columnaCreacion = 'created_at';
  assert.equal(r.status, 200);
  assert.equal(r.data.nuevas, 0);
  const nota = r.data.noDeterminable.find((n) => n.columnasDisponibles);
  assert.ok(nota && nota.columnasDisponibles.includes('otra_cosa'));
});

test('sin columna de creación se usa el registro de actividad', async () => {
  columnaCreacion = 'otra_cosa';
  actividadMock = [
    { tipo: 'turno_creado', actor: 'gestión (Ayelen)', fecha: '2026-11-02T13:00:00+00:00', detalle: 'Ana Prueba — 2026-11-20 10:00' },
    { tipo: 'turno_creado', actor: 'gestión (Ayelen)', fecha: '2026-11-03T13:00:00+00:00', detalle: 'Beto Ejemplo — 2026-11-20 10:00' },
    { tipo: 'login', actor: 'admin', fecha: '2026-10-20T13:00:00+00:00', detalle: '/admin' },
  ];
  const r = await llamar({ query: { recurso: 'campana-analisis', key: 'clave-test', desde: '2026-11-01', hasta: '2026-11-05' } });
  columnaCreacion = 'created_at'; actividadMock = [];
  assert.equal(r.status, 200);
  assert.equal(r.data.turnosCreados, 2);
  assert.equal(r.data.nuevas, 1); // Ana: sin turnos previos
  assert.equal(r.data.recurrentes, 1); // Beto: tiene un turno el 10/09
  assert.ok(r.data.noDeterminable.some((n) => /registro de actividad/.test(n.motivo)));
});

test('campañas: iniciar, listar con métricas, finalizar', async () => {
  const ini = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'iniciar', nombre: 'Octubre IG', inicio: '2026-11-01', inversion: '50.000' } });
  assert.equal(ini.status, 200);
  const id = ini.data.campana.id;
  assert.deepEqual(ini.data.campana.inversiones, [{ concepto: 'Inversión', monto: 50000 }]);
  const lista = await llamar({ query: { recurso: 'campanas', key: 'clave-test' } });
  assert.equal(lista.data.campanas.length, 1);
  const m = lista.data.campanas[0].metricas;
  assert.equal(m.nuevas, 1);
  assert.equal(m.costoPorNueva, 50000);
  assert.equal(m.nombres, undefined);
  const fin = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'finalizar', id, fin: '2026-11-05' } });
  assert.equal(fin.status, 200);
  const otra = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'finalizar', id, fin: '2026-11-06' } });
  assert.equal(otra.status, 400);
  const det = await llamar({ query: { recurso: 'campanas', key: 'clave-test', id, detalle: '1' } });
  assert.deepEqual(det.data.campanas[0].metricas.nombres.nuevas, ['Ana Prueba']);
  assert.equal(det.data.campanas[0].fin, '2026-11-05');
});

test('validaciones de campaña', async () => {
  const sinNombre = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'iniciar', nombre: ' ' } });
  assert.equal(sinNombre.status, 400);
  const fechaMala = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'iniciar', nombre: 'X', inicio: '31/10/2026' } });
  assert.equal(fechaMala.status, 400);
});

const clave = 'clave-test';
const post = (body) => llamar({ method: 'POST', body: { recurso: 'campanas', key: clave, ...body } });
const getC = (extra = {}) => llamar({ query: { recurso: 'campanas', key: clave, ...extra } });

test('editar: nombre, fechas (también en una campaña finalizada) y varias inversiones que se suman', async () => {
  const ini = await post({ accion: 'iniciar', nombre: 'Google', inicio: '2026-11-01' });
  const id = ini.data.campana.id;
  await post({ accion: 'finalizar', id, fin: '2026-11-05' });
  const ed = await post({ accion: 'editar', id, nombre: 'Google noviembre', inicio: '2026-11-01', fin: '2026-11-05', inversiones: [{ concepto: 'Búsqueda', monto: '42.972' }, { concepto: 'Display', monto: '49.924' }, { concepto: '', monto: '' }] });
  assert.equal(ed.status, 200);
  const c = (await getC({ id })).data.campanas[0];
  assert.equal(c.nombre, 'Google noviembre');
  assert.equal(c.fin, '2026-11-05');
  assert.deepEqual(c.inversiones, [{ concepto: 'Búsqueda', monto: 42972 }, { concepto: 'Display', monto: 49924 }]);
  assert.equal(c.metricas.inversionTotal, 92896);
  assert.equal(c.metricas.costoPorNueva, 92896); // 1 nueva en el período → toda la pauta real
  // cambiar solo las fechas de una campaña ya finalizada y reabrirla
  const f = await post({ accion: 'editar', id, fin: '2026-11-04' });
  assert.equal(f.status, 200);
  assert.equal((await getC({ id })).data.campanas[0].fin, '2026-11-04');
  const reabre = await post({ accion: 'editar', id, fin: '' });
  assert.equal(reabre.status, 200);
  assert.equal((await getC({ id })).data.campanas[0].fin, null);
  assert.deepEqual((await getC({ id })).data.campanas[0].inversiones.length, 2); // no se perdieron las inversiones
  await post({ accion: 'eliminar', id });
});

test('editar valida: nombre vacío, fechas inválidas, cierre anterior al inicio, monto inválido, id inexistente', async () => {
  const id = (await post({ accion: 'iniciar', nombre: 'Validar', inicio: '2026-11-01' })).data.campana.id;
  assert.equal((await post({ accion: 'editar', id, nombre: '  ' })).status, 400);
  assert.equal((await post({ accion: 'editar', id, inicio: '1/11/2026' })).status, 400);
  assert.equal((await post({ accion: 'editar', id, fin: '2026-10-31' })).status, 400);
  assert.equal((await post({ accion: 'editar', id, inversiones: [{ concepto: 'x', monto: 'abc' }] })).status, 400);
  assert.equal((await post({ accion: 'editar', id: 'noexiste', nombre: 'X' })).status, 404);
  await post({ accion: 'eliminar', id });
});

test('campañas viejas con un solo número de inversión se leen y se pueden editar', async () => {
  // getConfig cachea: se siembra por el mismo setConfig que usa el panel (como quedó guardada una campaña vieja).
  const { setConfig } = await import('../lib/adminConfig.js');
  await setConfig('campanas', [{ id: 'aaaa1111', nombre: 'Vieja', inicio: '2026-11-01', fin: null, inversion: 50000 }]);
  const c = (await getC({ id: 'aaaa1111' })).data.campanas[0];
  assert.deepEqual(c.inversiones, [{ concepto: 'Inversión', monto: 50000 }]);
  assert.equal(c.metricas.inversionTotal, 50000);
  await post({ accion: 'editar', id: 'aaaa1111', inversiones: [{ concepto: 'Inversión', monto: '50.000' }, { concepto: 'Display', monto: '10.000' }] });
  assert.equal((await getC({ id: 'aaaa1111' })).data.campanas[0].metricas.inversionTotal, 60000);
  assert.equal(almacen.campanas[0].inversion, undefined);
  await post({ accion: 'eliminar', id: 'aaaa1111' });
});

test('archivar, desarchivar y eliminar', async () => {
  const id = (await post({ accion: 'iniciar', nombre: 'Archivable', inicio: '2026-11-01' })).data.campana.id;
  await post({ accion: 'archivar', id });
  assert.equal((await getC({ id })).data.campanas[0].archivada, true);
  await post({ accion: 'archivar', id, archivada: false });
  assert.equal((await getC({ id })).data.campanas[0].archivada, false);
  assert.equal((await post({ accion: 'eliminar', id })).status, 200);
  assert.deepEqual((await getC({ id })).data.campanas, []);
  assert.equal((await post({ accion: 'eliminar', id })).status, 404);
});

test('desglose por motivo con las categorías de "Listas desplegables", solo cantidades', async () => {
  const id = (await post({ accion: 'iniciar', nombre: 'Motivos', inicio: '2026-11-01' })).data.campana.id;
  const m = (await getC({ id })).data.campanas[0].metricas;
  assert.ok(Array.isArray(m.porMotivo));
  assert.equal(m.porMotivo.reduce((a, f) => a + f.total, 0), m.turnosCreados);
  const consulta = m.porMotivo.find((f) => f.categoria === 'Consulta');
  assert.ok(consulta && consulta.nuevas + consulta.recurrentes === consulta.total);
  assert.equal(JSON.stringify(m.porMotivo).includes('Ana'), false);
  await post({ accion: 'eliminar', id });
});

test('resolver casos dudosos: se guarda y los totales se recalculan; se puede deshacer', async () => {
  const id = (await post({ accion: 'iniciar', nombre: 'Casos', inicio: '2026-11-01', fin: '2026-11-05' })).data.campana.id;
  await post({ accion: 'finalizar', id, fin: '2026-11-05' });
  const antes = (await getC({ id, detalle: '1' })).data.campanas[0].metricas;
  assert.equal(antes.dudosos.length, 1);
  assert.equal(antes.dudosos[0].nombre, 'Prueba Falsa'); // con detalle=1 se puede identificar para decidir
  assert.match(antes.dudosos[0].clave, /^[a-f0-9]{20}$/);
  const sinDetalle = (await getC({ id })).data.campanas[0].metricas;
  assert.equal('nombre' in sinDetalle.dudosos[0], false);
  const nuevasAntes = antes.nuevas;

  assert.equal((await post({ accion: 'decidir', clave: antes.dudosos[0].clave, decision: 'nuevo' })).status, 200);
  const despues = (await getC({ id, detalle: '1' })).data.campanas[0].metricas;
  assert.equal(despues.dudosos.length, 0);
  assert.equal(despues.nuevas, nuevasAntes + 1);
  assert.equal(despues.resueltos.length, 1);
  assert.equal(despues.resueltos[0].decision, 'nuevo');

  await post({ accion: 'decidir', clave: antes.dudosos[0].clave, decision: 'descartar' });
  const descartado = (await getC({ id })).data.campanas[0].metricas;
  assert.equal(descartado.nuevas, nuevasAntes);
  assert.equal(descartado.turnosCreados, antes.turnosCreados);

  await post({ accion: 'decidir', clave: antes.dudosos[0].clave, decision: '' });
  const deshecho = (await getC({ id })).data.campanas[0].metricas;
  assert.equal(deshecho.dudosos.length, 1);
  assert.equal(almacen.campanasDecisiones[antes.dudosos[0].clave], undefined);
  assert.equal((await post({ accion: 'decidir', clave: 'xx', decision: 'nuevo' })).status, 400);
  assert.equal((await post({ accion: 'decidir', clave: antes.dudosos[0].clave, decision: 'quizás' })).status, 400);
  await post({ accion: 'eliminar', id });
});

test('exportar resumen CSV y PDF: totales, motivos y costo, sin nombres', async () => {
  const id = (await post({ accion: 'iniciar', nombre: 'Informe facultad', inicio: '2026-11-01', inversiones: [{ concepto: 'Búsqueda', monto: '1.000' }] })).data.campana.id;
  await post({ accion: 'finalizar', id, fin: '2026-11-05' });
  const csv = await llamar({ query: { recurso: 'export-campana', key: clave, id, formato: 'csv' } });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Pacientes nuevos/);
  assert.match(csv.data, /Costo por paciente nuevo/);
  assert.match(csv.data, /Turnos por motivo/);
  assert.match(csv.data, /Inversión: Búsqueda/);
  for (const nombre of ['Ana Prueba', 'Beto Ejemplo', 'Prueba Falsa']) assert.equal(csv.data.includes(nombre), false);
  const pdf = await llamar({ query: { recurso: 'export-campana', key: clave, id, formato: 'pdf' } });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(pdf.data).subarray(0, 4).toString(), '%PDF');
  assert.equal((await llamar({ query: { recurso: 'export-campana', key: clave, id: 'noexiste' } })).status, 404);
  assert.equal((await llamar({ query: { recurso: 'export-campana', id } })).status, 401);
  await post({ accion: 'eliminar', id });
});
