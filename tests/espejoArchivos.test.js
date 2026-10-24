import test from 'node:test';
import assert from 'node:assert/strict';
import { copiarArchivosLote, listarArchivosDrive } from '../lib/espejoArchivos.js';

const file = { id: 'drive-1', name: 'ficha-7__123.jpg', mimeType: 'image/jpeg', size: '3', modifiedTime: '2026-01-01T00:00:00Z', tipo: 'foto' };

test('copia archivo, calcula checksum y registra metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('consultorio_listar_archivos_copiados')) return { ok: true, json: async () => [] };
    return { ok: true };
  };
  const drive = { files: { get: async () => ({ data: Buffer.from('abc') }) } };
  const result = await copiarArchivosLote({ drive, ficheros: [file], supabaseUrl: 'https://db.test', serviceKey: 'secret', fetchImpl });
  assert.deepEqual(result, { copiados: 1, salteados: 0, errores: [], pendientes: 0 });
  assert.match(calls[1].url, /storage\/v1\/object\/pacientes-archivos\/ficha-7\/foto\/drive-1$/);
  assert.equal(calls[1].options.headers['x-upsert'], 'true');
  const body = JSON.parse(calls[2].options.body).p;
  assert.equal(body.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(body.ficha_id, 'ficha-7');
});

test('copia recetas al bucket privado recetas con la ruta ficha/timestamp-nombre', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => [] }; };
  const drive = { files: { get: async () => ({ data: Buffer.from('pdf') }) } };
  await copiarArchivosLote({ drive, ficheros: [{ ...file, tipo: 'receta', name: 'ficha-7__receta.pdf' }], supabaseUrl: 'https://db.test', serviceKey: 'secret', fetchImpl });
  assert.match(calls[1], /storage\/v1\/object\/recetas\/ficha-7\/[0-9]+-ficha-7__receta.pdf$/);
});

test('saltea mismo modifiedTime sin descargar', async () => {
  let downloaded = false;
  const fetchImpl = async () => ({ ok: true, json: async () => [{ drive_file_id: file.id, drive_modified_time: file.modifiedTime }] });
  const drive = { files: { get: async () => { downloaded = true; return { data: Buffer.from('x') }; } } };
  const result = await copiarArchivosLote({ drive, ficheros: [file], supabaseUrl: 'https://db.test', serviceKey: 'secret', fetchImpl });
  assert.equal(result.salteados, 1);
  assert.equal(downloaded, false);
});

test('lista carpetas paginadas', async () => {
  const requests = [];
  const drive = { files: { list: async (params) => {
    requests.push(params);
    return { data: requests.length === 1 ? { files: [{ id: 'a' }], nextPageToken: 'next' } : { files: [{ id: 'b' }] } };
  } } };
  const files = await listarArchivosDrive(drive, 'folder');
  assert.deepEqual(files.map((x) => x.id), ['a', 'b']);
  assert.equal(requests[1].pageToken, 'next');
});

test('presupuesto deja el resto como pendiente', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  const result = await copiarArchivosLote({ drive: {}, ficheros: [file, { ...file, id: '2' }], supabaseUrl: 'https://db.test', serviceKey: 'secret', fetchImpl, limite: 0 });
  assert.equal(result.pendientes, 2);
});
