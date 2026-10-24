import test from 'node:test';
import assert from 'node:assert/strict';
import { guardarRecetaSupabase, listarRecetasSupabase, descargarRecetaSupabase, guardarTemporalReceta, leerTemporalReceta, borrarTemporalReceta } from '../lib/recetasSupabase.js';

const env = { SUPABASE_WRITES_PRIMARY: '1', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'service' };

test('guarda binario en Storage y metadatos solo por RPC de consultorio', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'uuid-1' }) };
  };
  const r = await guardarRecetaSupabase({ fichaId: 'ficha-1', nombre: 'receta final.pdf', buffer: Buffer.from('pdf'), env, fetchImpl, ahora: 123 });
  assert.equal(r.ruta, 'supabase');
  assert.match(calls[0].url, /storage\/v1\/object\/recetas\/ficha-1\/123-receta-final.pdf$/);
  assert.match(calls[1].url, /rest\/v1\/rpc\/consultorio_registrar_receta$/);
  assert.match(calls[1].url, /\/rest\/v1\/rpc\/consultorio_registrar_receta$/);
  assert.equal(JSON.parse(calls[1].options.body).p_archivo.sha256.length, 64);
  assert.equal(calls.some((x) => /rest\/v1\/archivos_paciente/.test(x.url)), false);
});

test('timeout al subir o registrar se informa incierto y no permite doble escritura', async () => {
  const r = await guardarRecetaSupabase({ fichaId: 'f', buffer: Buffer.from('pdf'), env, fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(r, { ruta: 'incierta', motivo: 'ambiguo' });
});

test('rechazo HTTP 5xx es ambiguo; solo un rechazo 4xx confirmado cae a Google', async () => {
  const r = await guardarRecetaSupabase({ fichaId: 'f', buffer: Buffer.from('pdf'), env, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(r.ruta, 'incierta');
  const confirmado = await guardarRecetaSupabase({ fichaId: 'f', buffer: Buffer.from('pdf'), env, fetchImpl: async () => ({ ok: false, status: 400 }) });
  assert.equal(confirmado.ruta, 'google');
});

test('lectura lista y descarga por RPC más endpoint privado de Storage', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('consultorio_listar_recetas')) return { ok: true, json: async () => [{ id: 'u', ficha_id: 'f', nombre: 'r.pdf', copiado_en: '2026-01-01', metadata: {} }] };
    if (url.endsWith('consultorio_leer_receta')) return { ok: true, json: async () => ({ id: 'u', ficha_id: 'f', storage_path: 'f/1-r.pdf', mime_type: 'application/pdf' }) };
    return { ok: true, arrayBuffer: async () => Buffer.from('pdf') };
  };
  assert.equal((await listarRecetasSupabase({ fichaId: 'f', env, fetchImpl })).recetas[0].id, 'u');
  const pdf = await descargarRecetaSupabase({ id: 'u', env, fetchImpl });
  assert.equal(pdf.buffer.toString(), 'pdf');
  assert.match(calls[2], /storage\/v1\/object\/recetas\/f\/1-r.pdf$/);
});

test('borrador temporal privado tiene ciclo guardar, leer y borrar', async () => {
  const bodies = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') bodies.push(JSON.parse(options.body));
    if (!options.method) return { ok: true, json: async () => ({ expira: Date.now() + 10000, contenido: { receta: { dni: '1' } } }) };
    return { ok: true, status: 200 };
  };
  assert.equal((await guardarTemporalReceta({ codigo: '0123456789', contenido: { x: 1 }, env, fetchImpl })).disponible, true);
  assert.deepEqual((await leerTemporalReceta({ codigo: '0123456789', env, fetchImpl })).contenido, { receta: { dni: '1' } });
  assert.equal((await borrarTemporalReceta({ codigo: '0123456789', env, fetchImpl })).disponible, true);
  assert.deepEqual(bodies[0].contenido, { x: 1 });
});
