// Análisis de campañas (solo lectura): cuántas personas NUEVAS sacaron turno en un período,
// contando por la fecha de CREACIÓN del turno (no la del turno). Lógica pura, sin I/O, para
// poder probarla con datos inventados (tests/campanasAnalisis.test.js).
//
// Identidad: misma regla estricta que el cruce turno↔ficha (lib/identidadTurno.js): DNI idéntico,
// o sin DNI y mismo nombre completo + mismo teléfono. El teléfono solo nunca alcanza (hijos
// con el teléfono de los padres). Los casos dudosos NO se cuentan como nuevos ni recurrentes:
// van aparte para que los resuelva Fausto, nunca se decide por él.
import { createHash } from 'node:crypto';
import { mismaPersonaEstricta, tokensNombre } from './identidadTurno.js';

// Fecha de una celda del padrón: ISO ("2026-10-03" / con hora) o "dd/mm/aaaa". null si no se entiende.
export function parseFechaFlexible(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const dmy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const ms = dmy ? Date.parse(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}T12:00:00-03:00`) : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

const digitos = (s) => String(s || '').replace(/\D/g, '');

// DNI inválido o de prueba: vacío, muy corto, todos dígitos iguales o secuencias típicas.
export function esDniPrueba(dni) {
  const d = digitos(dni);
  if (!d) return false; // vacío = "sin DNI", no "de prueba"
  return d.length < 7 || /^(\d)\1+$/.test(d) || /^(12345678|123456789|12312312|87654321)$/.test(d);
}

// "YYYY-MM-DD" en hora Argentina (UTC-3, sin horario de verano) → milisegundos.
export function inicioDiaAR(ymd) { return Date.parse(`${ymd}T00:00:00-03:00`); }
export function finDiaAR(ymd) { return Date.parse(`${ymd}T23:59:59.999-03:00`); }
export function hoyAR(ahora = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}
export function sumarDiasYmd(ymd, dias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(inicioDiaAR(ymd) + dias * DIA_MS + 12 * 3600 * 1000);
}
export function diasEntre(desdeYmd, hastaYmd) {
  return Math.round((inicioDiaAR(hastaYmd) - inicioDiaAR(desdeYmd)) / DIA_MS) + 1;
}

// ---------- Identidad estable de un caso (para guardar la decisión manual de Fausto) ----------
// Se guarda un hash corto, nunca el DNI/teléfono/nombre en claro. Una decisión vale para la PERSONA:
// aplica igual en cualquier campaña y a todos sus turnos del período.
export function clavePersona(r) {
  const dni = digitos(r.dni);
  const tel = digitos(r.telefono);
  const nom = tokensNombre(r.nombre || '');
  const crudo = dni && !esDniPrueba(dni) ? `d:${dni}` : (tel ? `t:${tel}|${nom}` : `n:${nom}`);
  return createHash('sha256').update(`campanas|${crudo}`).digest('hex').slice(0, 20);
}
export const DECISIONES = ['nuevo', 'recurrente', 'descartar'];

// ---------- Motivo del turno → categoría ----------
// "Motivo" es texto libre. Orden: alineadores → tratamientos de "Listas desplegables" (la coincidencia más
// larga gana) → consulta/control → Otros. Sin motivo va aparte.
const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
export function categorizarMotivo(motivo, tratamientos = []) {
  const m = sinAcentos(motivo);
  if (!m || m === '-') return 'Sin motivo';
  if (/alineador|invisalign|aligner|ortodoncia invisible/.test(m)) return 'Alineadores';
  let mejor = null;
  for (const t of tratamientos) {
    const n = sinAcentos(t);
    if (n.length < 4) continue;
    if (m.includes(n) || (m.length >= 4 && n.includes(m))) { if (!mejor || n.length > mejor.n.length) mejor = { n, t }; }
  }
  if (mejor) return mejor.t;
  if (/consulta|control|revision|chequeo|primera vez|evaluacion|presupuesto|diagnostico|turno nuevo|visita/.test(m)) return 'Consulta';
  return 'Otros';
}

// ---------- Pesos / inversiones ----------
// Pesos en formato argentino: "50.000" = cincuenta mil, "50.000,50" con coma decimal; un número se usa tal cual.
export function parsearPesos(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const t = String(v ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
// Lista de inversiones válidas: [{ concepto, monto }]; descarta filas vacías y lanza si un monto es inválido.
export function limpiarInversiones(lista) {
  const out = [];
  for (const i of Array.isArray(lista) ? lista : []) {
    const concepto = String(i?.concepto ?? '').trim().slice(0, 60);
    const vacio = i?.monto === '' || i?.monto == null;
    if (vacio && !concepto) continue;
    const monto = parsearPesos(i?.monto);
    if (monto === null) throw new Error('Hay una inversión con un monto inválido.');
    out.push({ concepto: concepto || 'Inversión', monto });
  }
  return out;
}
// Campañas viejas guardaban un solo número (`inversion`): se leen como una inversión.
export function normalizarCampana(c) {
  const inversiones = Array.isArray(c.inversiones)
    ? c.inversiones
    : (Number.isFinite(Number(c.inversion)) && Number(c.inversion) > 0 && c.inversion !== null ? [{ concepto: 'Inversión', monto: Number(c.inversion) }] : []);
  return { id: c.id, nombre: c.nombre, inicio: c.inicio, fin: c.fin || null, archivada: !!c.archivada, inversiones };
}
export const totalInversion = (c) => normalizarCampana(c).inversiones.reduce((a, i) => a + (Number(i.monto) || 0), 0);

// registros: [{ dni, telefono, nombre, motivo, creado (ms), inicio (ms, opcional) }]
// padron: [{ dni, telefono, nombre, ficha (bool), ultimaVisita (ms|null) }] — fichas / pacientes consolidados.
// decisiones: { [clavePersona]: 'nuevo' | 'recurrente' | 'descartar' } — lo que Fausto resolvió a mano para
// los casos dudosos y los "con ficha de antigüedad no confirmable". Solo esos dos grupos aceptan decisión.
// Una ficha NO prueba por sí sola que la persona ya era paciente: puede haberse creado en el primer turno
// del propio período. Solo cuenta como anterior si tiene una última visita previa al período; si tiene ficha
// pero no hay forma de saber desde cuándo, va al grupo aparte `conFicha` (no se estima).
export function analizarPeriodo({ registros, padron = [], desde, hasta, detalle = false, coberturaDesde = null, decisiones = {}, tratamientos = [] }) {
  const d0 = inicioDiaAR(desde);
  const d1 = finDiaAR(hasta);
  const salida = {
    turnosCreados: 0, personasDistintas: 0, nuevas: 0, recurrentes: 0,
    conFichaSinFechaClara: 0, dudosos: [], conFicha: [], resueltos: [], resueltosTotales: { nuevo: 0, recurrente: 0, descartar: 0 },
    porMotivo: [], noDeterminable: [],
  };
  if (detalle) salida.nombres = { nuevas: [], recurrentes: [] };

  const limpios = registros.filter((r) => Number.isFinite(r.creado));
  // Un turno sin fecha de creación pero cuya fecha de turno ya pasó (antes del período) se creó, como
  // mucho, ese mismo día: alcanza para saber que la persona ya tenía un turno anterior.
  const soloCota = registros.filter((r) => !Number.isFinite(r.creado) && Number.isFinite(r.inicio) && r.inicio < d0);
  const sinUbicar = registros.filter((r) => !Number.isFinite(r.creado) && !(Number.isFinite(r.inicio) && r.inicio < d0)).length;
  if (sinUbicar) salida.noDeterminable.push({ motivo: `${sinUbicar} turnos (de fecha posterior al inicio del período) no tienen fecha de creación disponible: no se pueden ubicar ni dentro ni fuera del período.` });
  if (Number.isFinite(coberturaDesde) && d0 < coberturaDesde) salida.noDeterminable.push({ motivo: 'El registro de actividad con las fechas de creación empieza después del inicio del período: los primeros días pueden estar incompletos.' });

  // Artefacto de importación: un turno que ya ocurrió antes del período pero figura "creado" dentro
  // de él, o después de su propia fecha, indica que la fecha de creación es la de una migración.
  const anomalos = limpios.filter((r) => r.creado >= d0 && r.creado <= d1 && Number.isFinite(r.inicio) && r.inicio < d0).length;
  if (anomalos) salida.noDeterminable.push({ motivo: `${anomalos} turnos tienen fecha de creación dentro del período pero ocurrieron antes de que empiece: la fecha de creación puede ser la de una migración y no la real.` });

  const sospechoso = (dni) => esDniPrueba(dni);
  const telDnis = new Map();
  const dniNombres = new Map();
  for (const r of limpios) {
    const dni = digitos(r.dni);
    if (r.telefono && dni && !sospechoso(dni)) {
      const set = telDnis.get(r.telefono) || new Set(); set.add(dni); telDnis.set(r.telefono, set);
    }
    if (dni && !sospechoso(dni)) {
      const set = dniNombres.get(dni) || new Set(); set.add(tokensNombre(r.nombre)); dniNombres.set(dni, set);
    }
  }

  const previos = [...limpios.filter((r) => r.creado < d0), ...soloCota];
  const comoPersona = (x) => ({ dni: sospechoso(digitos(x.dni)) ? '' : digitos(x.dni), telefono: digitos(x.telefono), nombre: x.nombre || '' });
  const previosPersonas = previos.map(comoPersona);
  const padronPersonas = padron.map((p) => ({ ...comoPersona(p), ficha: !!p.ficha, ultimaVisita: p.ultimaVisita }));
  const hayTurnoPrevio = (r) => previosPersonas.some((p) => mismaPersonaEstricta(comoPersona(r), p));
  const padronAnterior = (r) => padronPersonas.some((p) => p.ficha && Number.isFinite(p.ultimaVisita) && p.ultimaVisita < d0 && mismaPersonaEstricta(comoPersona(r), p));
  const hayPadron = (r) => padronPersonas.some((p) => mismaPersonaEstricta(comoPersona(r), p));

  // 1) Agrupar los turnos creados en el período por PERSONA y clasificar cada grupo.
  const grupos = new Map();
  for (const r of limpios.filter((x) => x.creado >= d0 && x.creado <= d1)) {
    const clave = clavePersona(r);
    if (!grupos.has(clave)) grupos.set(clave, { clave, rs: [] });
    grupos.get(clave).rs.push(r);
  }
  const porMotivo = new Map();
  const otros = new Map();
  const sumarMotivo = (r, tipo) => {
    const cat = categorizarMotivo(r.motivo, tratamientos);
    const f = porMotivo.get(cat) || { categoria: cat, nuevas: 0, recurrentes: 0, sinClasificar: 0, total: 0 };
    f[tipo] += 1; f.total += 1; porMotivo.set(cat, f);
    if (detalle && cat === 'Otros') { const t = String(r.motivo || '').trim().slice(0, 80); otros.set(t, (otros.get(t) || 0) + 1); }
  };

  for (const g of grupos.values()) {
    const r = g.rs[0];
    const dni = digitos(r.dni);
    const motivos = [];
    if (g.rs.some((x) => sospechoso(digitos(x.dni)) && digitos(x.dni))) motivos.push('DNI de prueba o inválido');
    if (g.rs.some((x) => x.telefono && telDnis.get(x.telefono)?.size > 1)) motivos.push('Mismo teléfono asociado a DNI distintos');
    if (dni && !sospechoso(dni)) {
      const mio = tokensNombre(r.nombre);
      for (const [otroDni, nombres] of dniNombres) {
        if (otroDni !== dni && mio && nombres.has(mio)) { motivos.push('Mismo nombre con DNI distinto'); break; }
      }
    }
    if (!dni && !r.telefono) motivos.push('Turno sin DNI ni teléfono');
    const idParcial = dni ? `DNI ••${dni.slice(-2)}` : (r.telefono ? `tel. ••${digitos(r.telefono).slice(-2)}` : 'sin identificador');
    const base = motivos.length ? 'dudoso' : (hayTurnoPrevio(r) || padronAnterior(r) ? 'recurrente' : (hayPadron(r) ? 'ficha' : 'nuevo'));
    const decision = (base === 'dudoso' || base === 'ficha') && DECISIONES.includes(decisiones[g.clave]) ? decisiones[g.clave] : null;
    const entrada = { clave: g.clave, turnos: g.rs.length, identificadorParcial: idParcial, ...(detalle ? { nombre: r.nombre } : {}) };

    if (decision) {
      salida.resueltos.push({ ...entrada, decision, de: base === 'dudoso' ? motivos.join('; ') : 'Con ficha, antigüedad no confirmable' });
      salida.resueltosTotales[decision] += 1;
      if (decision === 'descartar') continue;
    } else if (base === 'dudoso') {
      salida.dudosos.push({ ...entrada, motivo: motivos.join('; ') });
      continue; // sin decidir: no se cuenta (ni turnos ni persona)
    }
    const final = decision || base; // 'nuevo' | 'recurrente' | 'ficha' (pendiente)
    salida.turnosCreados += g.rs.length;
    salida.personasDistintas += 1;
    if (final === 'ficha') {
      salida.conFichaSinFechaClara += 1;
      salida.conFicha.push(entrada);
      g.rs.forEach((x) => sumarMotivo(x, 'sinClasificar'));
    } else if (final === 'recurrente') {
      salida.recurrentes += 1;
      if (detalle) salida.nombres.recurrentes.push(r.nombre);
      g.rs.forEach((x) => sumarMotivo(x, 'recurrentes'));
    } else {
      salida.nuevas += 1;
      if (detalle) salida.nombres.nuevas.push(r.nombre);
      g.rs.forEach((x) => sumarMotivo(x, 'nuevas'));
    }
  }
  salida.porMotivo = [...porMotivo.values()].sort((a, b) => b.total - a.total || a.categoria.localeCompare(b.categoria, 'es'));
  if (detalle) salida.otrosMotivos = [...otros.entries()].map(([texto, cantidad]) => ({ texto: texto || '(vacío)', cantidad })).sort((a, b) => b.cantidad - a.cantidad).slice(0, 40);
  return salida;
}

// Métricas de una campaña: período propio vs los 30 días anteriores a su inicio. El costo por paciente nuevo
// usa la pauta real: la SUMA de todas las inversiones cargadas.
export function metricasCampana({ campana, registros, padron, hoy, detalle = false, coberturaDesde = null, decisiones = {}, tratamientos = [] }) {
  const c = normalizarCampana(campana);
  const fin = c.fin || hoy;
  const dias = Math.max(1, diasEntre(c.inicio, fin));
  const comunes = { registros, padron, coberturaDesde, decisiones, tratamientos };
  const durante = analizarPeriodo({ ...comunes, desde: c.inicio, hasta: fin, detalle });
  const baseDesde = sumarDiasYmd(c.inicio, -30);
  const baseHasta = sumarDiasYmd(c.inicio, -1);
  const base = analizarPeriodo({ ...comunes, desde: baseDesde, hasta: baseHasta });
  const inversionTotal = totalInversion(c);
  return {
    ...durante,
    dias,
    inversionTotal,
    promedioDiarioNuevas: +(durante.nuevas / dias).toFixed(2),
    promedioDiarioNuevasPrevios30: +(base.nuevas / 30).toFixed(2),
    nuevasPrevios30: base.nuevas,
    costoPorNueva: inversionTotal > 0 && durante.nuevas > 0 ? Math.round(inversionTotal / durante.nuevas) : null,
  };
}

// ---------- Resumen exportable (CSV/PDF): solo totales, sin nombres ----------
export function filasResumenCampana(campana, m) {
  const c = normalizarCampana(campana);
  const pesos = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('es-AR')}`);
  const ymd = (d) => String(d || '').split('-').reverse().join('/');
  const filas = [
    ['Campaña', c.nombre, '', ''],
    ['Período', `${ymd(c.inicio)} al ${c.fin ? ymd(c.fin) : 'en curso'} (${m.dias} días)`, '', ''],
    ...c.inversiones.map((i) => [`Inversión: ${i.concepto}`, pesos(i.monto), '', '']),
    ['Inversión total', c.inversiones.length ? pesos(m.inversionTotal) : '—', '', ''],
    ['Turnos creados', m.turnosCreados, '', ''],
    ['Personas distintas', m.personasDistintas, '', ''],
    ['Pacientes nuevos', m.nuevas, '', ''],
    ['Pacientes recurrentes', m.recurrentes, '', ''],
    ['Nuevos por día (campaña)', m.promedioDiarioNuevas.toLocaleString('es-AR'), '', ''],
    ['Nuevos por día (30 días previos)', m.promedioDiarioNuevasPrevios30.toLocaleString('es-AR'), '', ''],
    ['Costo por paciente nuevo', pesos(m.costoPorNueva), '', ''],
    ['Casos resueltos a mano', `${m.resueltosTotales.nuevo} nuevos, ${m.resueltosTotales.recurrente} recurrentes, ${m.resueltosTotales.descartar} descartados`, '', ''],
    ['Casos sin resolver', `${m.dudosos.length} dudosos (no se cuentan), ${m.conFicha.length} con ficha de antigüedad no confirmable`, '', ''],
  ];
  if (m.porMotivo.length) {
    filas.push(['Turnos por motivo', 'Total', 'Nuevos', 'Recurrentes']);
    for (const f of m.porMotivo) filas.push([f.categoria, f.total, f.nuevas, f.recurrentes]);
    if (m.porMotivo.some((f) => f.sinClasificar)) filas.push(['(sin clasificar como nuevo/recurrente)', m.porMotivo.reduce((a, f) => a + f.sinClasificar, 0), '', '']);
  }
  for (const n of m.noDeterminable || []) filas.push(['Aviso', n.motivo, '', '']);
  return filas;
}

// Cuando la agenda no guarda la fecha de creación (hoy, en Supabase), esa fecha sale del registro de
// actividad ("turno_creado"/"sobreturno_creado": detalle "Nombre Apellido — AAAA-MM-DD HH:MM"). Se une
// cada alta con su turno de la agenda por nombre + fecha + hora (hora Argentina) para recuperar DNI y
// teléfono. Un alta sin turno en la agenda (cancelado o movido) queda con DNI/teléfono vacíos: el análisis
// lo manda a "dudosos", nunca lo cuenta como persona nueva.
const DETALLE_ALTA = /^(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/;
const claveTurno = (nombre, ymd, hhmm) => `${tokensNombre(nombre)}|${ymd}|${hhmm}`;
function ymdHmAR(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(ms).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return { ymd: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

export function unirAgendaConActividad({ agenda, actividad }) {
  const porClave = new Map();
  for (const t of agenda) {
    if (!Number.isFinite(t.inicio)) continue;
    const { ymd, hhmm } = ymdHmAR(t.inicio);
    porClave.set(claveTurno(t.nombre, ymd, hhmm), t);
  }
  let coberturaDesde = null;
  for (const e of actividad) {
    const t = Date.parse(e.fecha);
    if (Number.isFinite(t) && (coberturaDesde === null || t < coberturaDesde)) coberturaDesde = t;
  }
  const usados = new Set();
  const registros = [];
  for (const e of actividad) {
    if (e.tipo !== 'turno_creado' && e.tipo !== 'sobreturno_creado') continue;
    const creado = Date.parse(e.fecha);
    const m = String(e.detalle || '').match(DETALLE_ALTA);
    if (!m || !Number.isFinite(creado)) continue;
    const k = claveTurno(m[1].trim(), m[2], m[3]);
    const t = porClave.get(k);
    if (t) usados.add(k);
    registros.push({
      dni: t?.dni || '', telefono: t?.telefono || '', nombre: m[1].trim(), motivo: t?.motivo || '', creado,
      inicio: t?.inicio ?? Date.parse(`${m[2]}T${m[3]}:00-03:00`),
    });
  }
  // Turnos de la agenda sin alta en el registro: la fecha de creación se desconoce (NaN).
  for (const t of agenda) {
    if (!Number.isFinite(t.inicio)) continue;
    const { ymd, hhmm } = ymdHmAR(t.inicio);
    if (!usados.has(claveTurno(t.nombre, ymd, hhmm))) registros.push({ dni: t.dni, telefono: t.telefono, nombre: t.nombre, motivo: t.motivo || '', creado: NaN, inicio: t.inicio });
  }
  return { registros, coberturaDesde };
}
