import { crearClienteSupabase, conTimeout } from './sincronizarSupabase.js';
import { conReintentos } from './retry.js';

function mensajeSeguro(e) {
  return String(e?.message || e || 'error').replace(/\d{6,}/g, '###').slice(0, 140);
}

export async function sincronizarTurnosVentana({ diasAtras = 30, diasAdelante = 120, dryRun = false } = {}) {
  // Con la agenda primaria en Supabase, Calendar es solo un espejo de salida: sincronizar
  // Calendar -> Supabase marcaría los turnos nuevos como "fuera de origen".
  if (process.env.SUPABASE_AGENDA_PRIMARY === '1') return { ok: true, omitido: 'agenda primaria en Supabase', dryRun };
  const [{ getCalendarClient, CALENDAR_ID, SOBRETURNOS_CALENDAR_ID }, { clasificarEvento }] = await Promise.all([
    import('./googleCalendar.js'), import('./sincronizarTurnos.js'),
  ]);
  const ahora = Date.now();
  const desde = new Date(ahora - diasAtras * 86400000).toISOString();
  const hasta = new Date(ahora + diasAdelante * 86400000).toISOString();
  const inicio = Date.now();
  const ventana = { desde, hasta };
  const calendarios = [];
  const errores = [];
  let calendar;
  try { calendar = getCalendarClient(); }
  catch (error) { return { ok: false, dryRun, ventana, calendarios, duracionMs: Date.now() - inicio, errores: [{ mensaje: mensajeSeguro(error) }] }; }
  const definiciones = [
    { tipo: 'turno', id: CALENDAR_ID, permiteBloqueos: true },
    { tipo: 'sobreturno', id: SOBRETURNOS_CALENDAR_ID, permiteBloqueos: false },
  ];
  const cliente = !dryRun && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? crearClienteSupabase({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY }) : null;
  if (!dryRun && !cliente) return { error: 'Falta configuración de Supabase.' };
  for (const def of definiciones) {
    const row = { tipo: def.tipo, eventos: 0, turnos: 0, bloqueos: 0, ignorados: 0 };
    const turnos = [];
    const bloqueos = [];
    try {
      let pageToken;
      do {
        const { data } = await conReintentos(() => calendar.events.list({
          calendarId: def.id, timeMin: desde, timeMax: hasta, singleEvents: true,
          orderBy: 'startTime', maxResults: 2500, ...(pageToken ? { pageToken } : {}),
        }));
        const items = data.items || [];
        row.eventos += items.length;
        for (const evento of items) {
          const clasificado = clasificarEvento(evento, { tipo: def.tipo, permitirBloqueos: def.permiteBloqueos });
          if (clasificado.turno) turnos.push(clasificado.turno);
          if (clasificado.bloqueo) bloqueos.push(clasificado.bloqueo);
          if (clasificado.ignorado) row.ignorados += 1;
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      row.turnos = turnos.length;
      row.bloqueos = bloqueos.length;
      if (cliente) await cliente.sincronizarTurnos({ calendar_id: def.id, ventana, turnos, bloqueos });
      if (dryRun) row.muestra = [...turnos.slice(0, 3).map((t) => ({ id: `${t.event_id.slice(0, 6)}…`, tipo: t.tipo, fecha: t.inicio })), ...bloqueos.slice(0, 3).map((b) => ({ id: `${b.event_id.slice(0, 6)}…`, tipo: b.clase, fecha: b.inicio }))];
    } catch (error) { errores.push({ calendario: def.tipo, mensaje: mensajeSeguro(error) }); }
    calendarios.push(row);
  }
  return { ok: errores.length === 0, dryRun, ventana, calendarios, duracionMs: Date.now() - inicio, errores };
}

export async function espejarTurnosBestEffort({ sincronizar = sincronizarTurnosVentana, timeout = conTimeout } = {}) {
  if (process.env.SUPABASE_SYNC_ON_WRITE !== '1' || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  try { await timeout(sincronizar({ diasAtras: 1, diasAdelante: 120 }), 4000); } catch { /* respuesta del turno tiene prioridad */ }
}
