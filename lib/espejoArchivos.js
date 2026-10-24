import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const PAUSA_MS = 150;
const BUCKET = 'pacientes-archivos';
const RECETAS_BUCKET = 'recetas';

function safeMessage(err) {
  // Deliberately do not return provider response bodies, headers, or request URLs.
  const status = Number(err?.response?.status || err?.status);
  return status ? `Error HTTP ${status}` : 'Error al procesar el archivo';
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Promise.resolve(value);
  if (value instanceof Uint8Array) return Promise.resolve(Buffer.from(value));
  if (value?.data && value.data !== value) return asBuffer(value.data);
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const chunks = [];
      for await (const chunk of value) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    })();
  }
  return Promise.resolve(Buffer.from(value || ''));
}

function fichaDesdeNombre(name) {
  const m = /^([^/]+)__/.exec(String(name || ''));
  return m?.[1] || null;
}

function tipoArchivo(file) {
  const value = file.tipo || file.appProperties?.tipo || file.properties?.tipo;
  if (value === 'foto' || value === 'receta') return value;
  // Integration may supply the known folder name / ID in parentTypes or tipo.
  const parents = file.parentTypes || file.parents || [];
  for (const parent of parents) {
    const name = typeof parent === 'string' ? parent : parent.name;
    if (name === 'Fotos de pacientes (no tocar)') return 'foto';
    if (name === 'Recetas de pacientes (no tocar)') return 'receta';
  }
  return null;
}

async function descargar(drive, id) {
  const response = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
  return asBuffer(response?.data ?? response);
}

export async function listarArchivosDrive(drive, carpetaId) {
  const files = [];
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q: `'${String(carpetaId).replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,properties,appProperties,description)',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...(data?.files || []));
    pageToken = data?.nextPageToken;
  } while (pageToken);
  return files;
}

export async function copiarArchivosLote({ drive, ficheros = [], supabaseUrl, serviceKey, fetchImpl = globalThis.fetch, limite = 15, presupuestoMs = 240000 } = {}) {
  const resultado = { copiados: 0, salteados: 0, errores: [], pendientes: 0 };
  const start = Date.now();
  const max = Math.max(0, Number(limite) || 0);
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let previos = new Map();
  try {
    const r = await fetchImpl(`${String(supabaseUrl).replace(/\/$/, '')}/rest/v1/rpc/consultorio_listar_archivos_copiados`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!r.ok) throw new Error('rpc');
    previos = new Map((await r.json()).map((x) => [x.drive_file_id, x.drive_modified_time]));
  } catch {
    return { ...resultado, errores: [{ id: '(rpc)', mensaje: 'No se pudo consultar el índice' }], pendientes: ficheros.length };
  }
  let procesados = 0;
  for (let i = 0; i < ficheros.length; i++) {
    const f = ficheros[i];
    if (procesados >= max || Date.now() - start >= presupuestoMs) {
      resultado.pendientes = ficheros.length - i;
      break;
    }
    if (!f?.id) { resultado.errores.push({ id: '(sin id)', mensaje: 'Archivo sin identificador' }); continue; }
    const modified = f.modifiedTime || null;
    if (previos.has(f.id) && previos.get(f.id) === modified) { resultado.salteados++; continue; }
    procesados++;
    try {
      const tipo = tipoArchivo(f);
      const fichaId = f.ficha_id || f.fichaId || fichaDesdeNombre(f.name);
      if (!tipo || !fichaId) throw new Error('datos');
      const bytes = await descargar(drive, f.id);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const nombreSeguro = String(f.name || 'archivo').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'archivo';
      const stamp = Date.parse(modified || '') || Date.now();
      const storagePath = tipo === 'receta' ? `${fichaId}/${stamp}-${nombreSeguro}` : `${fichaId}/${tipo}/${f.id}`;
      const bucket = tipo === 'receta' ? RECETAS_BUCKET : BUCKET;
      const root = String(supabaseUrl).replace(/\/$/, '');
      const upload = await fetchImpl(`${root}/storage/v1/object/${bucket}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { ...headers, 'x-upsert': 'true', 'Content-Type': f.mimeType || 'application/octet-stream' }, body: bytes,
      });
      if (!upload.ok) throw Object.assign(new Error('upload'), { status: upload.status });
      const payload = { drive_file_id: f.id, ficha_id: fichaId, tipo, nombre: f.name, mime_type: f.mimeType || null, bytes: Number(f.size ?? bytes.length), sha256, storage_path: storagePath, drive_modified_time: modified, metadata: { description: f.description || null, parents: f.parents || [], properties: f.properties || {}, appProperties: f.appProperties || {} } };
      const saved = await fetchImpl(`${root}/rest/v1/rpc/consultorio_registrar_archivo`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ p: payload }),
      });
      if (!saved.ok) throw Object.assign(new Error('rpc'), { status: saved.status });
      resultado.copiados++;
    } catch (err) {
      resultado.errores.push({ id: f.id, mensaje: safeMessage(err) });
    }
    if (i < ficheros.length - 1) await new Promise((resolve) => setTimeout(resolve, PAUSA_MS));
  }
  return resultado;
}
