// Planilla "Pacientes consolidados" (ver el pedido, 2026-08-14) — fuente única de verdad
// para dos cosas que antes escaneaban Calendar/Drive por separado en cada request (poco
// confiable y lento): el autocompletado de nombre->teléfono/DNI de /gestion, y la sección
// "Pacientes en total" del panel /admin. Vive en PACIENTES_FOLDER_ID, mismo patrón de
// auto-provisión que la hoja de mapeo teléfono-ficha (ver api/gestion/pacientes.js).
//
// Una fila por persona. Criterio de identidad (SISTEMA CENTRALIZADO DE PACIENTES,
// 2026-08-25): el DNI es el identificador principal cuando está disponible; el teléfono
// normalizado (últimos 10 dígitos) queda como identificador secundario. Si una fila tiene
// fichaId, esos datos (nombre/apellido/dni) SIEMPRE ganan sobre lo que traiga un turno
// para la misma persona — la ficha es la fuente más confiable. El email es un dato
// central más (se completa desde los turnos y desde el perfil del paciente).
//
// Un paciente puede no tener teléfono ni DNI todavía (Ayelen da el turno con datos
// faltantes y se completan después — ver pedido 2026-08-25): la fila se crea igual con
// lo que haya; se identifica por lo que tenga.
//
// Se mantiene al día con escrituras puntuales (upsertPacienteConsolidado), no con un
// escaneo completo periódico — se llama desde cada lugar que crea/edita una ficha o un
// turno con nombre/teléfono/DNI (crearPaciente, escribirCampoEnSheet, crear-turno.js,
// agregar-telefono.js, agregar-dni.js, evento.js al mover con nombre nuevo). Todas esas
// llamadas son best-effort: si la planilla falla, nunca tira ni bloquea el flujo
// principal (crear el turno, guardar la ficha) — ver el catch de acá abajo.
import { getPacientesSheetsClient, getPacientesDriveClient } from './googleOAuthPacientes.js';
import { formatearDniConPuntos } from './dni.js';
import { conReintentos } from './retry.js';
import { PACIENTES_FOLDER_ID, SHEET_NAME, normalizarTelefonoMapeo, normalizarDni } from './pacientesSheet.js';

export const PACIENTES_CONSOLIDADOS_NAME = 'Pacientes consolidados (no tocar)';
const RANGO_DATOS = 'A2:M';
// Columnas A..H: datos del paciente (ver el encabezado). Columnas I..M: ESTADÍSTICAS DE
// ASISTENCIA (2026-08-25) — las escribe un cálculo diario (cron 5:30 + botón manual en
// /gestion), NO los upserts normales (que solo tocan A..H y nunca pisan estas). Son:
//   I turnosPasados | J turnosAsistidos | K visitas (días con movimiento ≤ hoy)
//   L ultimaVisita (AAAA-MM-DD) | M calcActualizado (timestamp ISO del cálculo)
// Reglas (preguntas del usuario, ver decisions.md): asistió = hay movimiento válido ese
// día; el % se calcula POR TURNO (si hubo movimiento ese día, todos los turnos de ese
// día cuentan); denominador = turnos pasados (fecha anterior a hoy; los cancelados se
// borran, no cuentan); visitas = días con movimiento (incluye urgencias sin turno).
const ENCABEZADOS = ['telefono', 'nombre', 'apellido', 'dni', 'fichaId', 'origen', 'actualizado', 'email',
  'turnosPasados', 'turnosAsistidos', 'visitas', 'ultimaVisita', 'calcActualizado'];

let cacheSheetId = null;
async function getOrCreateConsolidadosSheetId() {
  if (cacheSheetId) return cacheSheetId;
  const drive = getPacientesDriveClient();
  const sheets = getPacientesSheetsClient();
  const { data } = await conReintentos(() => drive.files.list({
    q: `'${PACIENTES_FOLDER_ID}' in parents and name = '${PACIENTES_CONSOLIDADOS_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
    fields: 'files(id)',
  }));
  if (data.files && data.files.length) {
    cacheSheetId = data.files[0].id;
    // Migración idempotente del encabezado (2026-08-25): la planilla existente tenía 7
    // columnas; se agrega la columna H "email" si no está (1 sola escritura, segura).
    await asegurarEncabezado(sheets, cacheSheetId);
    return cacheSheetId;
  }
  const creada = await conReintentos(() => sheets.spreadsheets.create({
    requestBody: { properties: { title: PACIENTES_CONSOLIDADOS_NAME } },
    fields: 'spreadsheetId',
  }));
  const id = creada.data.spreadsheetId;
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'A1:M1',
    valueInputOption: 'RAW',
    requestBody: { values: [ENCABEZADOS] },
  }));
  // Recién creada vive en "Mi unidad" — se mueve a la carpeta de Pacientes para que
  // quede junto a todo lo demás (mismo criterio que getOrCreateMapeoSheetId).
  await conReintentos(() => drive.files.update({ fileId: id, addParents: PACIENTES_FOLDER_ID, fields: 'id' }));
  cacheSheetId = id;
  return id;
}

// Asegura que la primera fila tenga el encabezado completo (hasta M1, con las columnas
// de estadísticas de asistencia). Idempotente: si la última columna esperada ya está,
// no escribe nada.
async function asegurarEncabezado(sheets, sheetId) {
  try {
    const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A1:M1' }));
    const fila = (data.values && data.values[0]) || [];
    const completo = ENCABEZADOS.every((nombre, i) => String(fila[i] || '').trim() === nombre);
    if (completo) return;
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'A1:M1',
      valueInputOption: 'RAW',
      requestBody: { values: [ENCABEZADOS] },
    }));
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo asegurar el encabezado:', err?.message || err);
  }
}

function filaDesdeValores(r, i) {
  const numero = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    fila: i + 2,
    telefono: r[0] || '', nombre: r[1] || '', apellido: r[2] || '', dni: r[3] || '',
    fichaId: r[4] || '', origen: r[5] || '', actualizado: r[6] || '', email: r[7] || '',
    // Estadísticas de asistencia (columnas I..M; vacías hasta el primer cálculo).
    turnosPasados: numero(r[8]),
    turnosAsistidos: numero(r[9]),
    visitas: numero(r[10]),
    ultimaVisita: r[11] || '',
    calcActualizado: r[12] || '',
  };
}

async function leerFilas(sheets, sheetId) {
  const { data } = await conReintentos(() => sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: RANGO_DATOS }));
  // BUG CORREGIDO (2026-08-25): el índice de la fila se calculaba DESPUÉS del filter, así
  // que con filas vacías intercaladas (las que deja la fusión de duplicados al hacer clear)
  // los updates posteriores escribían en filas equivocadas. Ahora se mapea con el índice
  // REAL de la hoja y se filtra después.
  return (data.values || [])
    .map((r, i) => filaDesdeValores(r, i))
    .filter((f) => f.telefono || f.nombre || f.apellido || f.dni);
}

function normalizarNombreConsolidado(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Best-effort a propósito: nunca tira. Identidad: si viene DNI, se busca primero por DNI
// (identificador principal del paciente); si no, por teléfono normalizado (secundario).
// Si no hay ni DNI ni teléfono no hay con qué matchear y la fila no se escribe.
export async function upsertPacienteConsolidado({ telefono, nombre, apellido, dni: dniCrudo, fichaId, origen, email }) {
  const dni = formatearDniConPuntos(dniCrudo);
  const telNorm = normalizarTelefonoMapeo(telefono);
  const dniNorm = normalizarDni(dni);
  if (!telNorm && !dniNorm) return;

  try {
    const sheetId = await getOrCreateConsolidadosSheetId();
    const sheets = getPacientesSheetsClient();
    const filas = await leerFilas(sheets, sheetId);
    const ahora = new Date().toISOString();

    const porDni = dniNorm ? filas.find((f) => f.dni && normalizarDni(f.dni) === dniNorm) : null;
    const porTelefono = telNorm ? filas.find((f) => f.telefono && normalizarTelefonoMapeo(f.telefono) === telNorm) : null;

    // Si hay una fila para el DNI y OTRA distinta para el teléfono (datos que antes
    // estaban separados), se unifican en la fila del DNI y se borra la del teléfono —
    // mismo paciente con dos registros. Nunca se pierde la ficha (se preserva la que
    // tenga fichaId; si las dos tienen, gana la del DNI y la otra ficha queda intacta
    // en Drive, solo se desvincula de la planilla).
    if (porDni && porTelefono && porDni.fila !== porTelefono.fila) {
      const fusion = porDni;
      const fichaDeLaOtra = porTelefono.fichaId;
      const nombreFinal = fusion.nombre || porTelefono.nombre;
      const apellidoFinal = fusion.apellido || porTelefono.apellido;
      const emailFinal = fusion.email || porTelefono.email;
      const fichaIdFinal = fusion.fichaId || porTelefono.fichaId;
      const telefonoFinal = fusion.telefono || porTelefono.telefono || telefono;
      await conReintentos(() => sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `A${fusion.fila}:H${fusion.fila}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[telefonoFinal, nombreFinal, apellidoFinal, fusion.dni || dni, fichaIdFinal, fichaIdFinal ? 'ficha' : (fusion.origen || 'turno'), ahora, emailFinal]] },
      }));
      await conReintentos(() => sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `A${porTelefono.fila}:H${porTelefono.fila}` }));
      if (fichaDeLaOtra && !fusion.fichaId) {
        // la ficha de la fila absorbida se re-vincula a la fila ganadora
      }
      return;
    }

    const existente = porDni || porTelefono;

    if (!existente) {
      await conReintentos(() => sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'A:H',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[telefono || '', nombre || '', apellido || '', dni || '', fichaId || '', origen || 'turno', ahora, email || '']] },
      }));
      return;
    }

    // Si la fila existente ya tiene ficha y esta llamada no trae una (viene de un turno),
    // la ficha gana — solo se completan huecos, nunca se pisa un dato real de la ficha.
    const esFichaGanadora = existente.fichaId && !fichaId;
    const nombreFinal = esFichaGanadora ? (existente.nombre || nombre) : (nombre || existente.nombre);
    const apellidoFinal = esFichaGanadora ? (existente.apellido || apellido) : (apellido || existente.apellido);
    const dniFinal = esFichaGanadora ? (existente.dni || dni) : (dni || existente.dni);
    const fichaIdFinal = fichaId || existente.fichaId;
    const telefonoFinal = esFichaGanadora ? (existente.telefono || telefono) : (telefono || existente.telefono);
    const emailFinal = email || existente.email;

    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `A${existente.fila}:H${existente.fila}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[telefonoFinal, nombreFinal, apellidoFinal, dniFinal, fichaIdFinal, fichaIdFinal ? 'ficha' : (existente.origen || 'turno'), ahora, emailFinal]] },
    }));
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo sincronizar la planilla consolidada:', err?.message || err);
  }
}

// Búsqueda por DNI (identificador principal) — para el buscador de pacientes de /gestion
// y para el perfil central. Coincidencia exacta por dígitos.
export async function buscarPacienteConsolidadoPorDni(dni) {
  const dniNorm = normalizarDni(dni);
  if (!dniNorm) return null;
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  const filas = await leerFilas(sheets, sheetId);
  return filas.find((f) => f.dni && normalizarDni(f.dni) === dniNorm) || null;
}

// Autocompletado de /gestion (ver el pedido) — sustituye el escaneo de turnos por
// nombre en Calendar, que fallaba cuando el nombre del turno no coincidía exacto con el
// de la ficha o cuando el paciente no tenía ningún turno reciente con teléfono cargado.
// Coincidencia por substring, igual que antes; ante varios candidatos, gana el que tiene
// ficha y, a igualdad, el más recientemente actualizado.
export async function buscarPacienteConsolidadoPorNombre(nombreBuscado) {
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  const filas = await leerFilas(sheets, sheetId);
  const normalizado = normalizarNombreConsolidado(nombreBuscado);
  if (!normalizado) return null;

  const candidatos = filas.filter((f) => normalizarNombreConsolidado(`${f.nombre} ${f.apellido}`).includes(normalizado));
  candidatos.sort((a, b) => {
    const porFicha = (b.fichaId ? 1 : 0) - (a.fichaId ? 1 : 0);
    if (porFicha !== 0) return porFicha;
    return new Date(b.actualizado || 0) - new Date(a.actualizado || 0);
  });
  return candidatos[0] || null;
}

// Base de "Pacientes en total" del dashboard de /admin — ver el pedido.
export async function listarPacientesConsolidados() {
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  return leerFilas(sheets, sheetId);
}

// (La función reemplazarTodasLasFilas() — solo para el backfill inicial — se eliminó
// definitivamente el 2026-08-24 junto con el backfill, una vez confirmado que la
// planilla "Pacientes consolidados" ya está poblada por los upserts normales. El
// historial de este archivo guarda la función por si algún día hace falta.)

// Edición de datos centrales del paciente (Fase 3, sistema centralizado 2026-08-25).
// Encuentra la fila por la identidad actual (DNI preferente, después teléfono) y la
// reescribe con los campos nuevos — incluido el cambio de DNI/teléfono (la identidad
// futura queda con el valor nuevo, los próximos upserts la encuentran). Campos
// soportados: nombre, apellido, dni, telefono, email. Best-effort (nunca tira).
export async function actualizarPacienteConsolidado({ dni, telefono, campos }) {
  const { nombre, apellido, dni: dniNuevo, telefono: telefonoNuevo, email } = campos || {};
  const dniNorm = normalizarDni(dni);
  const telNorm = normalizarTelefonoMapeo(telefono);
  if (!dniNorm && !telNorm) return;

  try {
    const sheetId = await getOrCreateConsolidadosSheetId();
    const sheets = getPacientesSheetsClient();
    const filas = await leerFilas(sheets, sheetId);
    const existente = dniNorm
      ? filas.find((f) => f.dni && normalizarDni(f.dni) === dniNorm)
      : filas.find((f) => f.telefono && normalizarTelefonoMapeo(f.telefono) === telNorm);
    const ahora = new Date().toISOString();

    const nuevaFila = {
      telefono: telefonoNuevo != null ? telefonoNuevo : (existente ? existente.telefono : telefono || ''),
      nombre: nombre != null ? nombre : (existente ? existente.nombre : ''),
      apellido: apellido != null ? apellido : (existente ? existente.apellido : ''),
      dni: dniNuevo != null ? dniNuevo : (existente ? existente.dni : dni || ''),
      email: email != null ? email : (existente ? existente.email : ''),
      fichaId: existente ? existente.fichaId : '',
      origen: existente ? (existente.fichaId ? 'ficha' : existente.origen) : 'turno',
    };

    const values = [[nuevaFila.telefono, nuevaFila.nombre, nuevaFila.apellido, nuevaFila.dni, nuevaFila.fichaId, nuevaFila.origen, ahora, nuevaFila.email]];
    if (existente) {
      await conReintentos(() => sheets.spreadsheets.values.update({
        spreadsheetId: sheetId, range: `A${existente.fila}:H${existente.fila}`,
        valueInputOption: 'RAW', requestBody: { values },
      }));
    } else {
      await conReintentos(() => sheets.spreadsheets.values.append({
        spreadsheetId: sheetId, range: 'A:H', valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', requestBody: { values },
      }));
    }
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo actualizar el paciente central:', err?.message || err);
  }
}

// Búsqueda por teléfono normalizado (identificador secundario, para pacientes sin DNI).
export async function buscarPacienteConsolidadoPorTelefono(telefono) {
  const telNorm = normalizarTelefonoMapeo(telefono);
  if (!telNorm) return null;
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  const filas = await leerFilas(sheets, sheetId);
  return filas.find((f) => f.telefono && normalizarTelefonoMapeo(f.telefono) === telNorm) || null;
}

// Escribe las estadísticas de asistencia en una fila (columnas I..M). La usa el cálculo
// diario/manual (lib/asistenciaPacientes.js). Nunca toca A..H. Best-effort.
export async function guardarAsistenciaEnFila({ fila, turnosPasados, turnosAsistidos, visitas, ultimaVisita }) {
  try {
    const sheetId = await getOrCreateConsolidadosSheetId();
    const sheets = getPacientesSheetsClient();
    await conReintentos(() => sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `I${fila}:M${fila}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          turnosPasados || 0, turnosAsistidos || 0, visitas || 0,
          ultimaVisita || '', new Date().toISOString(),
        ]],
      },
    }));
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo guardar asistencia:', err?.message || err);
  }
}

// ---------- Asignación de personas "solo turno" a una ficha ----------
function claveNombre(f) {
  return normalizarNombreConsolidado(`${f.nombre} ${f.apellido}`).split(' ').filter(Boolean).sort().join(' ');
}
const soloDigitos = (v) => String(v || '').replace(/\D/g, '');

function distanciaEdicion(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(actual[j - 1] + 1, anterior[j] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    anterior = actual;
  }
  return anterior[b.length];
}

// Candidatas para revisar manualmente. DNI exacto identifica mejor; nombres exactos o
// muy parecidos ayudan cuando falta el DNI. Nunca sugiere una ficha con DNI distinto.
export function candidatasParaFicha(persona, filas, max = 5) {
  const nombrePersona = claveNombre(persona);
  const dniPersona = soloDigitos(persona.dni);
  const porFicha = new Map();
  for (const f of filas) {
    if (!f.fichaId || f.fichaId === persona.fichaId) continue;
    const nombreFicha = claveNombre(f);
    const dniFicha = soloDigitos(f.dni);
    const dniCoincide = !!dniPersona && dniPersona === dniFicha;
    const dniDistinto = !!dniPersona && !!dniFicha && !dniCoincide;
    const distancia = nombrePersona && nombreFicha ? distanciaEdicion(nombrePersona, nombreFicha) : Infinity;
    const similitud = distancia === Infinity ? 0 : 1 - distancia / Math.max(nombrePersona.length, nombreFicha.length, 1);
    if (dniDistinto && similitud !== 1) continue;
    if (!dniCoincide && similitud < 0.78) continue;
    const puntaje = dniDistinto ? 60 : (dniCoincide ? 100 + similitud : (similitud === 1 ? 90 : Math.round(similitud * 80)));
    const actual = porFicha.get(f.fichaId);
    if (!actual || puntaje > actual.puntaje) porFicha.set(f.fichaId, {
      id: f.fichaId,
      nombre: `${f.nombre} ${f.apellido}`.trim(),
      dni: f.dni || '',
      puntaje,
      motivo: dniCoincide ? 'DNI coincidente' : (dniDistinto ? 'Nombre exacto · DNI distinto' : (similitud === 1 ? 'Nombre exacto' : 'Nombre parecido')),
    });
  }
  return [...porFicha.values()].sort((a, b) => b.puntaje - a.puntaje || a.nombre.localeCompare(b.nombre, 'es')).slice(0, max);
}

// fila de la persona -> fichaId, solo cuando el nombre (sin importar orden, tildes ni
// mayúsculas) coincide con UNA sola ficha. Homónimos (2 fichas iguales) no se sugieren.
export function sugerenciasPorNombre(filas) {
  const res = new Map();
  for (const f of filas) {
    if (f.fichaId) continue;
    const candidatas = candidatasParaFicha(f, filas);
    if (candidatas.length && candidatas[0].motivo === 'Nombre exacto'
      && candidatas.filter((c) => c.puntaje === candidatas[0].puntaje).length === 1) {
      res.set(f.fila, candidatas[0].id);
    }
  }
  return res;
}

function validarAsignacion(filas, fila, fichaId) {
  const persona = filas.find((f) => f.fila === Number(fila));
  if (!persona || persona.fichaId) return { error: 'Esa persona ya no está sin ficha. Recargá la lista.' };
  if (!persona.telefono && !persona.dni) return { error: 'Sin teléfono ni DNI no se puede vincular.' };
  const dni = soloDigitos(persona.dni);
  if (dni && filas.some((f) => f.fila !== persona.fila && f.fichaId && f.fichaId !== fichaId && soloDigitos(f.dni) === dni)) {
    return { error: 'El DNI de esta persona ya pertenece a otra ficha.' };
  }
  return { persona };
}

async function aplicarAsignacion(persona, fichaId) {
  await upsertPacienteConsolidado({
    telefono: persona.telefono, nombre: persona.nombre, apellido: persona.apellido,
    dni: persona.dni, fichaId, origen: 'ficha', email: persona.email,
  });
}

// La ficha puede no estar (todavía) en la planilla consolidada aunque exista en Drive:
// se verifica leyendo la ficha misma y, si falta en la planilla, se la agrega. Una ficha
// puede quedar vinculada a muchos turnos/personas: no hay límite.
async function asegurarFichaEnPlanilla(filas, fichaId) {
  if (filas.some((f) => f.fichaId === fichaId)) return true;
  try {
    const sheets = getPacientesSheetsClient();
    const { data } = await conReintentos(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: fichaId, ranges: [`${SHEET_NAME}!C5:C7`, `${SHEET_NAME}!C14`],
    }));
    const [nombre = '', apellido = '', dni = ''] = (data.valueRanges?.[0]?.values || []).map((r) => r[0] || '');
    const telefono = data.valueRanges?.[1]?.values?.[0]?.[0] || '';
    await upsertPacienteConsolidado({ telefono, nombre, apellido, dni, fichaId, origen: 'ficha' });
    return true;
  } catch (err) {
    console.warn('[pacientesConsolidados] no se pudo leer la ficha para asignar:', err?.message || err);
    return false;
  }
}

export async function asignarFilaAFicha(fila, fichaId) {
  const filas = await listarPacientesConsolidados();
  const v = validarAsignacion(filas, fila, fichaId);
  if (v.error) return { ok: false, error: v.error };
  if (!(await asegurarFichaEnPlanilla(filas, fichaId))) return { ok: false, error: 'No se pudo leer esa ficha. Probá de nuevo en un momento.' };
  await aplicarAsignacion(v.persona, fichaId);
  return { ok: true, nombre: `${v.persona.nombre} ${v.persona.apellido}`.trim() };
}

// Asigna hasta `max` coincidencias exactas por nombre; devuelve cuántas quedan.
export async function asignarCoincidenciasExactas(max = 25) {
  const filas = await listarPacientesConsolidados();
  const sug = [...sugerenciasPorNombre(filas)];
  let asignadas = 0, omitidas = 0;
  for (const [fila, fichaId] of sug.slice(0, max)) {
    const v = validarAsignacion(filas, fila, fichaId);
    if (v.error) { omitidas++; continue; }
    await aplicarAsignacion(v.persona, fichaId);
    asignadas++;
  }
  return { asignadas, omitidas, restantes: Math.max(0, sug.length - max) };
}

// Deshace una asignación hecha a mano: la fila de la persona vuelve a "solo turno".
// Solo se permite si la ficha conserva otra fila propia (nunca se toca la fila de la ficha).
export async function desasignarFila(fila) {
  const filas = await listarPacientesConsolidados();
  const p = filas.find((f) => f.fila === Number(fila));
  if (!p || !p.fichaId) return { ok: false, error: 'Esa persona no tiene una ficha asignada.' };
  if (!filas.some((f) => f.fila !== p.fila && f.fichaId === p.fichaId)) {
    return { ok: false, error: 'Esa fila es la propia de la ficha: no se puede desvincular desde acá.' };
  }
  const sheetId = await getOrCreateConsolidadosSheetId();
  const sheets = getPacientesSheetsClient();
  await conReintentos(() => sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `A${p.fila}:H${p.fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[p.telefono, p.nombre, p.apellido, p.dni, '', 'turno', new Date().toISOString(), p.email]] },
  }));
  return { ok: true, nombre: `${p.nombre} ${p.apellido}`.trim() };
}
