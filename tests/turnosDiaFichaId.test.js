import test from 'node:test';
import assert from 'node:assert/strict';

// Regresión 2026-10-25: con SUPABASE_AGENDA_PRIMARY la agenda devolvía los turnos sin
// `fichaId` y /gestion mostraba "Crear ficha" en todos. Cubre DNI en descripción, DNI solo
// en la columna, teléfono sin DNI y ambigüedad.
test('turnos-dia asigna fichaId a turnos de pacientes con ficha (agenda en Supabase)', async () => {
  Object.assign(process.env, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', SUPABASE_READS: '1',
    SUPABASE_WRITES_PRIMARY: '1', SUPABASE_AGENDA_PRIMARY: '1', GESTION_KEY: 'gk' });
  const t = (id, extra) => ({ id, inicio: '2030-01-07T12:00:00Z', fin: '2030-01-07T12:30:00Z', tipo: 'turno', estado: 'pendiente', paciente_nombre: 'X', ...extra });
  const turnos = [
    t('a', { description_original: 'DNI: 30111222', dni: '30111222' }),
    t('b', { description_original: 'sin datos', dni: '40222333' }),
    t('c', { description_original: '', telefono: '3442999999' }),
    t('d', { description_original: '', dni: '55555555' }),
    t('e', { description_original: '', dni: '77777777' }),
  ];
  const consolidados = [
    { id: '1', dni: '30111222', ficha_id: 'F1' }, { id: '2', dni: '40222333', ficha_id: 'F2' },
    { id: '3', telefono: '3442999999', ficha_id: 'F3' }, { id: '4', dni: '55555555', ficha_id: 'F4' }, { id: '5', dni: '55555555', ficha_id: 'F5' },
  ];
  globalThis.fetch = async (url) => {
    const n = String(url).match(/rpc\/(\w+)/)?.[1];
    const body = n === 'consultorio_agenda_listar' ? { turnos, bloqueos: [] } : n === 'consultorio_consolidados_listar' ? consolidados : null;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { default: handler } = await import('../api/gestion/turnos-dia.js');
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler({ method: 'GET', query: { key: 'gk', date: '2030-01-07' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const porId = Object.fromEntries(res.body.map((x) => [x.id, x.fichaId]));
  assert.equal(porId.a, 'F1');
  assert.equal(porId.b, 'F2');
  assert.equal(porId.c, 'F3');
  assert.equal(porId.d, undefined, 'DNI en dos fichas = ambiguo, no se asigna');
  assert.equal(porId.e, undefined);
});
