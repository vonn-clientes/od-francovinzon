import test from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import PDFDocument from 'pdfkit';
import { nombreArchivo } from '../lib/pacientesSheet.js';
import handler from '../api/gestion/pacientes.js';

// Handler real, clientes de Google y fetch simulados; todos los datos son inventados.
test('interruptor mobile: matriz completa sin red', async (t) => {
  const envAnterior = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in envAnterior)) delete process.env[k];
    Object.assign(process.env, envAnterior);
  });
  for (const k of Object.keys(process.env)) {
    if (/^(SUPABASE_|GOOGLE_|RESEND_|CONFIG_SOLO_)/.test(k)) delete process.env[k];
  }
  process.env.GESTION_KEY = 'gestion-prueba';
  process.env.ADMIN_KEY = 'admin-prueba';
  const calls = [];
  const registrar = (nombre, data) => async () => { calls.push(nombre); return { data }; };
  const paciente = { id: 'paciente-test', name: nombreArchivo('Ana', 'Ejemplo', '12345678') };
  const temporal = { receta: { paciente: 'EJEMPLO ANA', medicamentos: [] }, candidatos: [] };
  t.mock.method(google, 'drive', () => ({ files: {
    list: async ({ q }) => {
      calls.push('drive.list');
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return { data: { files: [{ id: 'folder-test' }] } };
      if (q.includes('.json')) return { data: { files: [{ id: 'temporal-test' }] } };
      if (q.includes('name contains')) return { data: { files: [{ id: 'archivo-test', name: 'paciente-test__foto.jpg', createdTime: '2026-11-26T10:00:00Z' }] } };
      return { data: { files: [paciente] } };
    },
    get: async ({ fileId }) => { calls.push('drive.get'); return { data: fileId === 'temporal-test' ? temporal : Buffer.from('archivo simulado') }; },
    create: registrar('drive.create', { id: 'archivo-nuevo' }),
    delete: registrar('drive.delete', {}),
    export: registrar('drive.export', 'Paciente: EJEMPLO ANA\nDNI: 12345678'),
  } }));
  t.mock.method(google, 'sheets', () => ({ spreadsheets: { values: {
    get: registrar('sheets.get', { values: [['Ana'], ['Ejemplo'], ['12345678'], ['01/01/2000']] }),
  } } }));
  t.mock.method(google, 'calendar', () => ({ events: { list: registrar('calendar.list', { items: [] }) } }));
  t.mock.method(globalThis, 'fetch', async () => { calls.push('fetch simulado'); return { ok: false, status: 404 }; });
  const pdf = await new Promise((resolve) => {
    const doc = new PDFDocument({ size: [40, 40], margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.end();
  });
  const rutas = [
    ...[
      ['hoy-publico', {}], ['buscar-publico', { q: 'Ana' }], ['fotos', { id: 'paciente-test' }],
      ['foto-imagen', { fotoId: 'archivo-test' }], ['recetas', { id: 'paciente-test' }],
      ['receta-pdf', { recetaId: 'archivo-test' }], ['receta-proceso', { codigo: '0123456789' }],
    ].map(([modo, query]) => ({ nombre: modo, method: 'GET', query: { modo, ...query }, body: {} })),
    ...[
      ['subir-foto', { pacienteId: 'paciente-test', fotoBase64: 'data:image/jpeg;base64,YQ==' }],
      ['eliminar-foto', { fotoId: 'archivo-test' }], ['receta-procesar-pdf', { pdfBase64: pdf }],
      ['receta-guardar', { pacienteId: 'paciente-test', receta: temporal.receta }],
    ].map(([accion, body]) => ({ nombre: accion, method: 'POST', query: {}, body: { accion, ...body } })),
  ];
  async function llamar(ruta, credenciales = {}) {
    const req = { ...ruta, headers: {}, ...credenciales,
      query: { ...ruta.query, ...credenciales.query }, body: { ...ruta.body, ...credenciales.body } };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; }, json(data) { this.data = data; return this; }, send(data) { this.data = data; return this; } };
    await handler(req, res);
    return res;
  }
  for (const ruta of rutas) await t.test(ruta.nombre, async () => {
    delete process.env.MOBILE_REQUIERE_CLAVE;
    const legado = await llamar(ruta);
    assert.equal(legado.statusCode, 200);
    assert.notEqual(legado.data?.success, false);
    for (const valor of ['0', 'true', '']) {
      process.env.MOBILE_REQUIERE_CLAVE = valor;
      const r = await llamar(ruta, { headers: { 'x-gestion-key': 'incorrecta' } });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.data, legado.data, 'apagado conserva respuesta y flujo');
    }
    process.env.MOBILE_REQUIERE_CLAVE = '1';
    for (const headers of [{}, { 'x-gestion-key': '' }, { 'x-gestion-key': 'incorrecta' }]) {
      calls.length = 0;
      const r = await llamar(ruta, { headers });
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.data, { error: 'unauthorized' });
      assert.deepEqual(calls, [], 'rechaza antes de leer o escribir');
    }
    for (const credenciales of [
      { headers: { 'x-gestion-key': 'gestion-prueba' } },
      { headers: { 'x-gestion-key': 'admin-prueba' } },
      { query: { key: 'gestion-prueba' } }, { body: { key: 'admin-prueba' } },
      { headers: { 'x-gestion-key': 'admin-prueba' }, query: { key: 'incorrecta' }, body: { key: 'incorrecta' } },
    ]) {
      const r = await llamar(ruta, credenciales);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.data, legado.data, 'con clave mantiene el flujo legado');
      assert.equal(r.headers['Cache-Control'], 'private, no-store');
    }
    for (const key of ['', 'incorrecta']) {
      const r = await llamar(ruta, { headers: { 'x-gestion-key': key }, query: { key: 'gestion-prueba' }, body: { key: 'admin-prueba' } });
      assert.equal(r.statusCode, 401, 'no evade header inválido mediante fallback');
    }
  });
  await t.test('Atajo excluido y modos ajenos conservan su autenticación', async () => {
    process.env.MOBILE_REQUIERE_CLAVE = '1';
    const shortcut = await llamar({ method: 'POST', body: { accion: 'receta-recibir-shortcut' } });
    assert.equal(shortcut.statusCode, 400);
    assert.equal(shortcut.data.message, 'Falta el PDF.');
    for (const modo of ['listar', 'ficha', 'datos-ficha', 'autoficha', 'healthcheck', 'diagnostico-consolidados']) {
      const r = await llamar({ method: 'GET', query: { modo } });
      assert.equal(r.statusCode, 401, modo);
    }
    const callback = await llamar({ method: 'GET', query: { modo: 'foto-imagen', code: 'no-evade', state: 'gestion-prueba' } });
    assert.equal(callback.statusCode, 401);
  });
});
