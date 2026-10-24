// Acceso a la agenda primaria. Lecturas pueden volver a Calendar; las escrituras
// nunca lo hacen: un timeout puede significar que la transacción sí confirmó.
const enabled = (env = process.env) => env.SUPABASE_AGENDA_PRIMARY === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_KEY;

export function agendaPrimariaActiva(env = process.env) { return enabled(env); }

export async function agendaRpc(nombre, parametros = {}, { env = process.env, fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  if (!enabled(env)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${nombre}`, {
      method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parametros), signal: controller.signal,
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new Error(data?.message || data?.details || `Supabase HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

export async function leerAgendaRpc(nombre, parametros = {}, opciones = {}) {
  try { return await agendaRpc(nombre, parametros, opciones); } catch { return null; }
}

export async function escribirAgendaRpc(nombre, p) {
  if (!enabled()) throw new Error('La agenda primaria no está configurada.');
  const data = await agendaRpc(nombre, { p }, { timeoutMs: 3500 });
  if (!data || data.ok === false) return data || { ok: false, error: 'No se pudo confirmar la operación.' };
  return data;
}

export function turnosDeLectura(datos) {
  if (Array.isArray(datos)) return datos;
  return Array.isArray(datos?.turnos) ? datos.turnos : [];
}

export function filasComoEventos(datos) {
  return turnosDeLectura(datos).map((t) => ({
    id: t.id, event_id: t.calendar_event_id || null, calendarId: t.calendar_id || '',
    inicio: t.inicio, fin: t.fin, start: t.inicio, end: t.fin,
    title: t.paciente_nombre || '', summary: t.paciente_nombre || '',
    description: t.description_original || '', tipo: t.tipo || 'turno', estado: t.estado,
    motivo: t.motivo || '', dni: t.dni || '', telefono: t.telefono || '', email: t.email || '',
    codigoCorto: t.codigo_corto || '', codigo_corto: t.codigo_corto || '',
    confirmado: !!t.confirmado, confirmacionSolicitada: !!t.confirmacion_solicitada,
    esNuevoPaciente: !!t.paciente_nuevo, telefonoVerificado: !!t.telefono_verificado,
    allDay: false, ubicacion: t.ubicacion || '',
  }));
}

export async function eventosAgenda(desde, hasta) {
  const datos = await leerAgendaRpc('consultorio_agenda_listar', { p_desde: desde, p_hasta: hasta }, { timeoutMs: 2200 });
  if (datos === null) return null;
  const filas = turnosDeLectura(datos);
  const bloqueos = Array.isArray(datos?.bloqueos) ? datos.bloqueos : [];
  const convertir = (t, bloqueo = false) => ({
    id: t.id, summary: t.paciente_nombre || t.motivo || '', description: t.description_original || '',
    start: bloqueo && t.dia_completo ? { date: new Date(new Date(t.inicio).getTime() - 3 * 3600000).toISOString().slice(0, 10) } : { dateTime: t.inicio },
    end: bloqueo && t.dia_completo ? { date: new Date(new Date(t.fin).getTime() - 3 * 3600000).toISOString().slice(0, 10) } : { dateTime: t.fin },
    status: t.estado === 'cancelado' ? 'cancelled' : 'confirmed',
    __tipo: bloqueo ? (t.clase || 'bloqueo') : (t.tipo || 'turno'),
  });
  return [...filas.map((t) => convertir(t)), ...bloqueos.map((b) => convertir(b, true))];
}

export function calendarioDesdeEventos(eventos) {
  return { events: { list: async () => ({ data: { items: eventos || [] } }) } };
}
