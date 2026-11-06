// Análisis de campañas (solo lectura): cuántas personas NUEVAS sacaron turno en un período,
// contando por la fecha de CREACIÓN del turno (no la del turno). Lógica pura, sin I/O, para
// poder probarla con datos inventados (tests/campanasAnalisis.test.js).
//
// Identidad: misma regla estricta que el cruce turno↔ficha (lib/identidadTurno.js): DNI idéntico,
// o sin DNI y mismo nombre completo + mismo teléfono. El teléfono solo nunca alcanza (hijos
// con el teléfono de los padres). Los casos dudosos NO se cuentan como nuevos ni recurrentes:
// van aparte para que los resuelva Fausto, nunca se decide por él.
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

// registros: [{ dni, telefono, nombre, creado (ms), inicio (ms, opcional) }]
// padron: [{ dni, telefono, nombre, ficha (bool), ultimaVisita (ms|null) }] — fichas / pacientes consolidados.
// Una ficha NO prueba por sí sola que la persona ya era paciente: puede haberse creado en el primer turno
// del propio período. Solo cuenta como anterior si tiene una última visita previa al período; si tiene ficha
// pero no hay forma de saber desde cuándo, va al grupo aparte `conFichaSinFechaClara` (no se estima).
export function analizarPeriodo({ registros, padron = [], desde, hasta, detalle = false }) {
  const d0 = inicioDiaAR(desde);
  const d1 = finDiaAR(hasta);
  const salida = {
    turnosCreados: 0, personasDistintas: 0, nuevas: 0, recurrentes: 0,
    conFichaSinFechaClara: 0, dudosos: [], noDeterminable: [],
  };
  if (detalle) salida.nombres = { nuevas: [], recurrentes: [] };

  const limpios = registros.filter((r) => Number.isFinite(r.creado));
  const sinFecha = registros.length - limpios.length;
  if (sinFecha) salida.noDeterminable.push({ motivo: `${sinFecha} turnos sin fecha de creación disponible; no se pudieron ubicar en ningún período.` });

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

  const previos = limpios.filter((r) => r.creado < d0);
  const comoPersona = (x) => ({ dni: sospechoso(digitos(x.dni)) ? '' : digitos(x.dni), telefono: digitos(x.telefono), nombre: x.nombre || '' });
  const previosPersonas = previos.map(comoPersona);
  const padronPersonas = padron.map((p) => ({ ...comoPersona(p), ficha: !!p.ficha, ultimaVisita: p.ultimaVisita }));
  const hayTurnoPrevio = (r) => previosPersonas.some((p) => mismaPersonaEstricta(comoPersona(r), p));
  const padronAnterior = (r) => padronPersonas.some((p) => p.ficha && Number.isFinite(p.ultimaVisita) && p.ultimaVisita < d0 && mismaPersonaEstricta(comoPersona(r), p));
  const hayPadron = (r) => padronPersonas.some((p) => mismaPersonaEstricta(comoPersona(r), p));

  const vistos = new Set();
  for (const r of limpios.filter((x) => x.creado >= d0 && x.creado <= d1)) {
    const dni = digitos(r.dni);
    const motivos = [];
    if (dni && sospechoso(dni)) motivos.push('DNI de prueba o inválido');
    if (r.telefono && telDnis.get(r.telefono)?.size > 1) motivos.push('Mismo teléfono asociado a DNI distintos');
    if (dni && !sospechoso(dni)) {
      const mio = tokensNombre(r.nombre);
      for (const [otroDni, nombres] of dniNombres) {
        if (otroDni !== dni && mio && nombres.has(mio)) { motivos.push('Mismo nombre con DNI distinto'); break; }
      }
    }
    if (!dni && !r.telefono) motivos.push('Turno sin DNI ni teléfono');
    if (motivos.length) {
      salida.dudosos.push({
        motivo: motivos.join('; '),
        identificadorParcial: dni ? `DNI ••${dni.slice(-2)}` : (r.telefono ? `tel. ••${r.telefono.slice(-2)}` : 'sin identificador'),
        ...(detalle ? { nombre: r.nombre } : {}),
      });
      continue;
    }
    salida.turnosCreados += 1;
    const clave = dni ? `d:${dni}` : `t:${r.telefono}|${tokensNombre(r.nombre)}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.personasDistintas += 1;
    if (hayTurnoPrevio(r) || padronAnterior(r)) {
      salida.recurrentes += 1;
      if (detalle) salida.nombres.recurrentes.push(r.nombre);
      continue;
    }
    if (hayPadron(r)) salida.conFichaSinFechaClara += 1;
    else {
      salida.nuevas += 1;
      if (detalle) salida.nombres.nuevas.push(r.nombre);
    }
  }
  return salida;
}

// Métricas de una campaña: período propio vs los 30 días anteriores a su inicio.
export function metricasCampana({ campana, registros, padron, hoy, detalle = false }) {
  const fin = campana.fin || hoy;
  const dias = Math.max(1, diasEntre(campana.inicio, fin));
  const durante = analizarPeriodo({ registros, padron, desde: campana.inicio, hasta: fin, detalle });
  const baseDesde = sumarDiasYmd(campana.inicio, -30);
  const baseHasta = sumarDiasYmd(campana.inicio, -1);
  const base = analizarPeriodo({ registros, padron, desde: baseDesde, hasta: baseHasta });
  const inversion = Number(campana.inversion);
  return {
    ...durante,
    dias,
    promedioDiarioNuevas: +(durante.nuevas / dias).toFixed(2),
    promedioDiarioNuevasPrevios30: +(base.nuevas / 30).toFixed(2),
    nuevasPrevios30: base.nuevas,
    costoPorNueva: Number.isFinite(inversion) && inversion > 0 && durante.nuevas > 0 ? Math.round(inversion / durante.nuevas) : null,
  };
}
