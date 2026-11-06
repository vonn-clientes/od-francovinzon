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
const turno = (o) => ({ tipo: 'turno', estado: 'confirmado', inicio: '2026-11-20T13:00:00Z', ...o });
const turnos = () => [
  turno({ paciente_nombre: 'Ana Prueba', dni: '30111222', telefono: '3442000001', [columnaCreacion]: '2026-11-02T13:00:00Z' }),
  turno({ paciente_nombre: 'Beto Ejemplo', dni: '31222333', telefono: '3442000002', [columnaCreacion]: '2026-11-03T13:00:00Z' }),
  turno({ paciente_nombre: 'Beto Ejemplo', dni: '31222333', telefono: '3442000002', [columnaCreacion]: '2026-09-01T13:00:00Z', inicio: '2026-09-10T13:00:00Z' }),
  turno({ paciente_nombre: 'Prueba Falsa', dni: '22222222', telefono: '3442000003', [columnaCreacion]: '2026-11-04T13:00:00Z' }),
  { tipo: 'bloqueo', paciente_nombre: 'Almuerzo', [columnaCreacion]: '2026-11-04T13:00:00Z' },
];

globalThis.fetch = async (url, init) => {
  const nombre = String(url).split('/rpc/')[1];
  const cuerpo = init?.body ? JSON.parse(init.body) : {};
  const ok = (data) => ({ ok: true, json: async () => data });
  if (nombre === 'consultorio_agenda_listar') return ok({ turnos: turnos() });
  if (nombre === 'consultorio_consolidados_listar') return ok([]);
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

test('sin columna de creación se informa en vez de estimar', async () => {
  columnaCreacion = 'otra_cosa';
  const r = await llamar({ query: { recurso: 'campana-analisis', key: 'clave-test', desde: '2026-11-01', hasta: '2026-11-05' } });
  columnaCreacion = 'created_at';
  assert.equal(r.status, 200);
  assert.equal(r.data.nuevas, 0);
  const nota = r.data.noDeterminable.find((n) => n.columnasDisponibles);
  assert.ok(nota && nota.columnasDisponibles.includes('otra_cosa'));
});

test('campañas: iniciar, listar con métricas, finalizar', async () => {
  const ini = await llamar({ method: 'POST', body: { recurso: 'campanas', key: 'clave-test', accion: 'iniciar', nombre: 'Octubre IG', inicio: '2026-11-01', inversion: '50.000' } });
  assert.equal(ini.status, 200);
  const id = ini.data.campana.id;
  assert.equal(ini.data.campana.inversion, 50000);
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
