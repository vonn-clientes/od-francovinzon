import { fichaAFilas } from './fichaAFilas.js';

function mensajeSeguro(value, serviceKey) {
  let mensaje = typeof value === 'string' ? value : 'Error de Supabase';
  if (serviceKey) mensaje = mensaje.split(serviceKey).join('[redacted]');
  return mensaje;
}

export function crearClienteSupabase({ url, serviceKey, fetchImpl = fetch }) {
  return {
    async leerFicha(id) {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_leer_ficha`, {
          method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_id: id }),
        });
      } catch (error) { throw new Error(mensajeSeguro(error?.message || error, serviceKey)); }
      let data;
      try { data = await response.json(); } catch { throw new Error('Respuesta JSON inválida de Supabase'); }
      if (!response.ok) throw new Error(mensajeSeguro(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`, serviceKey));
      if (Array.isArray(data)) return data[0] ?? null;
      return data;
    },
    async leerSnapshot(clave) {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_leer_snapshot`, {
          method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_clave: clave }),
        });
      } catch (error) { throw new Error(mensajeSeguro(error?.message || error, serviceKey)); }
      let data;
      try { data = await response.json(); } catch { throw new Error('Respuesta JSON inválida de Supabase'); }
      if (!response.ok) throw new Error(mensajeSeguro(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`, serviceKey));
      if (Array.isArray(data)) return data[0] ?? null;
      return data;
    },
    async guardarSnapshot({ clave, datos, drive_modified_time }) {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_guardar_snapshot`, {
          method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p: { clave, datos, drive_modified_time } }),
        });
      } catch (error) { throw new Error(mensajeSeguro(error?.message || error, serviceKey)); }
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(mensajeSeguro(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`, serviceKey));
      return data;
    },
    async estadoSync() {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_estado_sync`, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch (error) { throw new Error(mensajeSeguro(error?.message || error, serviceKey)); }
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(mensajeSeguro(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`, serviceKey));
      return new Map((Array.isArray(data) ? data : []).map((row) => [row.ficha_sheet_id, row.drive_modified_time ?? null]));
    },
    async sincronizarFicha(payload) {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_sync_ficha`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p: payload }),
        });
      } catch (error) {
        throw new Error(mensajeSeguro(error?.message || error, serviceKey));
      }
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const raw = data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`;
        const safe = mensajeSeguro(raw, serviceKey);
        const mensaje = data?.code === '23505' ? `DNI duplicado en otra ficha: ${safe}` : safe;
        throw new Error(mensaje);
      }
      return data;
    },
    async sincronizarTurnos(payload) {
      let response;
      try {
        response = await fetchImpl(`${String(url).replace(/\/$/, '')}/rest/v1/rpc/consultorio_sync_turnos`, {
          method: 'POST',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p: payload }),
        });
      } catch (error) { throw new Error(mensajeSeguro(error?.message || error, serviceKey)); }
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(mensajeSeguro(data?.message || data?.error || data?.hint || `Error HTTP ${response.status}`, serviceKey));
      return data;
    },
  };
}

export function construirPayload(idFicha, ficha, opciones = {}) {
  const { paciente, movimientos } = fichaAFilas(ficha, opciones);
  const payload = { ficha_sheet_id: idFicha, paciente, movimientos };
  if (opciones.driveModifiedTime !== undefined) payload.drive_modified_time = opciones.driveModifiedTime;
  if (ficha.fichaJson !== undefined) payload.ficha_json = ficha.fichaJson;
  return payload;
}

export function filtrarArchivosModificados(archivos, desde) {
  const timestamp = Date.parse(desde);
  if (!Number.isFinite(timestamp)) return [...(archivos || [])];
  return (archivos || []).filter((archivo) => {
    const modificado = Date.parse(archivo.modifiedTime || '');
    return Number.isFinite(modificado) && modificado > timestamp;
  });
}

export async function conTimeout(promise, ms = 4000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function sincronizarFichas({
  ids, leerFicha, cliente, tamanoLote = 20, pausaMs = 150,
  cotizacionFallback = 0, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), driveModifiedTimes,
  limite = Infinity,
}) {
  const inicio = Date.now();
  const seleccion = Array.from(ids || []).slice(0, Math.max(0, limite));
  const errores = [];
  let ok = 0;
  const lote = Math.max(1, Math.floor(Number(tamanoLote) || 1));
  for (let i = 0; i < seleccion.length; i += 1) {
    const id = seleccion[i];
    try {
      const ficha = await leerFicha(id);
      await cliente.sincronizarFicha(construirPayload(id, ficha, { cotizacionFallback, driveModifiedTime: ficha.driveModifiedTime ?? (driveModifiedTimes?.has(id) ? driveModifiedTimes.get(id) : undefined) }));
      ok += 1;
    } catch (error) {
      errores.push({ id, mensaje: mensajeSeguro(error?.message || error, '') });
    }
    if (i < seleccion.length - 1) {
      await esperar(pausaMs);
      if ((i + 1) % lote === 0) await esperar(pausaMs);
    }
  }
  return { total: seleccion.length, ok, errores, duracionMs: Date.now() - inicio };
}
