// Cumpleaños de pacientes con turno en el día (cartel de /gestion y /pacientes).
// Solo se marca un turno con ficha confirmada (fichaId por DNI exacto, ver turnos-dia.js):
// la fecha de nacimiento sale de esa ficha, nunca del nombre ni del teléfono.
import { leerFichaSupabase } from './fichaDesdeSupabase.js';

// "dd/mm/aaaa" (formato de la ficha) o "aaaa-mm-dd" -> { d, m, y } o null.
export function partesFecha(valor) {
  const s = String(valor || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { d: +m[1], m: +m[2], y: +m[3] };
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { d: +m[3], m: +m[2], y: +m[1] };
  return null;
}

// dateStr "aaaa-mm-dd" (día de Argentina). Los nacidos el 29/2 lo festejan el 28/2 en años no bisiestos.
export function esCumpleEn(fechaNacimiento, dateStr) {
  const n = partesFecha(fechaNacimiento);
  const h = partesFecha(dateStr);
  if (!n || !h || n.m < 1 || n.m > 12 || n.d < 1 || n.d > 31) return null;
  const bisiesto = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const coincide = (n.d === h.d && n.m === h.m) || (n.d === 29 && n.m === 2 && h.d === 28 && h.m === 2 && !bisiesto(h.y));
  if (!coincide) return null;
  const edad = h.y - n.y;
  return { edad: edad > 0 && edad < 120 ? edad : null };
}

// Agrega `cumple: { edad }` a los turnos (no bloqueos) cuyo paciente cumple años ese día.
// Best effort: si no se puede leer una ficha, ese turno simplemente no lleva cartel.
export async function marcarCumples(items, dateStr, { leerFicha = leerFichaSupabase } = {}) {
  const ids = [...new Set(items.filter((it) => it.fichaId && it.tipo !== 'bloqueo').map((it) => it.fichaId))];
  if (!ids.length) return;
  const fechas = new Map();
  await Promise.all(ids.map(async (id) => {
    try {
      const ficha = await leerFicha(id);
      const f = ficha?.campos?.fechaNacimiento;
      if (f) fechas.set(id, f);
    } catch { /* sin cartel para esa ficha */ }
  }));
  for (const it of items) {
    if (!it.fichaId || it.tipo === 'bloqueo') continue;
    const c = esCumpleEn(fechas.get(it.fichaId), dateStr);
    if (c) it.cumple = c;
  }
}
