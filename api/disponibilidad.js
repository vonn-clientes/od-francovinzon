import { getCalendarClient, getDisponibilidadMes, getHorariosLibresDia, toArgDate } from '../lib/googleCalendar.js';
import { avisarFallo } from '../lib/alertas.js';
import { getConfig, obtenerHorariosConfig, obtenerReservaOnlinePausada } from '../lib/adminConfig.js';
import { eventosAgenda, calendarioDesdeEventos } from '../lib/agendaSupabase.js';

// Fusiona lo que antes eran disponibilidad-mes.js + horarios-dia.js (mismo patrón de
// "modo" ya usado en api/gestion/buscar.js) para no sumar un archivo nuevo — ver
// CLAUDE.md sobre el límite de 12 funciones serverless del plan Hobby de Vercel.
//
// Sin "modo" (default) — GET ?year&month: disponibilidad del mes, { "1": bool, ... }.
// ?modo=dia — GET ?modo=dia&date: horarios libres de un día puntual, array de "HH:mm".
// ?modo=estado — GET: { pausada: bool } del interruptor de reserva online (ver el
// pedido, 2026-08-14). Vive acá (no en api/gestion/admin.js) porque /turnos y la home
// son páginas públicas sin ADMIN_KEY/GESTION_KEY, y este archivo ya es público.
export default async function handler(req, res) {
  const esModoDia = req.query.modo === 'dia';
  const esModoEstado = req.query.modo === 'estado';
  try {
    if (req.query.modo === 'listas') {
      const listas = await getConfig('listas', { obrasSociales: [] });
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({ obrasSociales: listas.obrasSociales || [] });
    }
    if (esModoEstado) {
      const pausada = await obtenerReservaOnlinePausada();
      return res.status(200).json({ pausada });
    }

    const { schedule, slotMinutes } = await obtenerHorariosConfig();

    if (esModoDia) {
      if (process.env.SUPABASE_AGENDA_PRIMARY === '1') {
        const date = req.query.date;
        const inicio = toArgDate(date, '00:00');
        const fin = new Date(inicio.getTime() + 86400000);
        const eventos = await eventosAgenda(inicio.toISOString(), fin.toISOString());
        if (eventos !== null) return res.status(200).json(await getHorariosLibresDia(calendarioDesdeEventos(eventos), date, schedule, slotMinutes));
      }
      const calendar = getCalendarClient();
      const free = await getHorariosLibresDia(calendar, req.query.date, schedule, slotMinutes);
      return res.status(200).json(free);
    }

    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    if (process.env.SUPABASE_AGENDA_PRIMARY === '1') {
      const desde = toArgDate(`${year}-${String(month).padStart(2, '0')}-01`, '00:00');
      const hasta = toArgDate(`${year}-${String(month).padStart(2, '0')}-01`, '00:00');
      hasta.setUTCDate(hasta.getUTCDate() + new Date(Date.UTC(year, month, 0)).getUTCDate());
      const eventos = await eventosAgenda(desde.toISOString(), hasta.toISOString());
      if (eventos !== null) return res.status(200).json(await getDisponibilidadMes(calendarioDesdeEventos(eventos), year, month, schedule, slotMinutes));
    }
    const calendar = getCalendarClient();
    const result = await getDisponibilidadMes(calendar, year, month, schedule, slotMinutes);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    const detalle = esModoEstado ? 'modo=estado' : esModoDia ? 'modo=dia' : 'modo=mes';
    await avisarFallo({ endpoint: 'api/disponibilidad.js', detalle, error: err });
    if (esModoEstado) return res.status(200).json({ pausada: true }); // fail-safe: nunca romper /turnos ni la home
    const message = esModoDia ? 'No se pudieron cargar los horarios.' : 'No se pudo cargar la disponibilidad.';
    res.status(500).json({ error: message });
  }
}
