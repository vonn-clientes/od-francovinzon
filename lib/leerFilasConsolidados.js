import { crearClienteSupabase, conTimeout } from './sincronizarSupabase.js';
import { conReintentos } from './retry.js';

function filaDesdeValores(r, i) {
  const numero = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    fila: i + 2,
    telefono: r[0] || '', nombre: r[1] || '', apellido: r[2] || '', dni: r[3] || '',
    fichaId: r[4] || '', origen: r[5] || '', actualizado: r[6] || '', email: r[7] || '',
    turnosPasados: numero(r[8]), turnosAsistidos: numero(r[9]), visitas: numero(r[10]),
    ultimaVisita: r[11] || '', calcActualizado: r[12] || '',
  };
}

export async function leerFilasConsolidados(sheets, sheetId, { drive, env = process.env, cliente, fetchImpl, timeout = conTimeout } = {}) {
  const leerGoogle = async () => {
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A2:M' }));
    return (data.values || []).map((r, i) => filaDesdeValores(r, i))
      .filter((f) => f.telefono || f.nombre || f.apellido || f.dni);
  };
  if (env.SUPABASE_READS !== '1' || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return leerGoogle();
  try {
    const { data: metadata } = await conReintentos(() => drive.files.get({ fileId: sheetId, fields: 'modifiedTime' }));
    const modifiedTime = metadata?.modifiedTime;
    if (!modifiedTime || !Number.isFinite(Date.parse(modifiedTime))) return leerGoogle();
    const supabase = cliente || crearClienteSupabase({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, fetchImpl });
    const snapshot = await timeout(supabase.leerSnapshot('consolidados'), 3000);
    if (snapshot?.datos && Number.isFinite(Date.parse(snapshot.drive_modified_time || ''))
      && Date.parse(snapshot.drive_modified_time) >= Date.parse(modifiedTime)) return snapshot.datos;
    const filas = await leerGoogle();
    try {
      await timeout(supabase.guardarSnapshot({ clave: 'consolidados', datos: filas, drive_modified_time: modifiedTime }), 3000);
    } catch { /* La escritura del caché nunca debe interrumpir al lector. */ }
    return filas;
  } catch {
    return leerGoogle();
  }
}
