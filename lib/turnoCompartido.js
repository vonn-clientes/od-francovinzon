// Turnos dados a más de una persona con un solo nombre ("Agostina y Benja Schulman").
// Ayelén a veces agenda hermanos o familiares juntos: el turno no se toca, pero en /admin
// tiene que poder vincularse a las fichas de cada uno en vez de quedar "sin ficha" para siempre.
import { normalizarDni } from './pacientesSheet.js';

const sinTildes = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const tel10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);

// "Agostina Y Benja Schulman" -> ["Agostina Schulman", "Benja Schulman"]. null si es una sola persona.
export function separarNombres(nombre) {
  const partes = String(nombre || '').trim().split(/\s+(?:y|e|&)\s+|\s*\+\s*/i).map((p) => p.trim()).filter(Boolean);
  if (partes.length < 2) return null;
  const ultima = partes[partes.length - 1].split(/\s+/);
  const apellido = ultima.length > 1 ? ultima[ultima.length - 1] : '';
  return partes.map((p) => (p.split(/\s+/).length === 1 && apellido ? `${p} ${apellido}` : p));
}

// Una ficha es de esa persona si comparten teléfono y apellido, y un nombre empieza con el otro
// ("Benja" / "Benjamín"). Con DNI en ambos lados manda el DNI.
function coincide(nombreParte, telefono, ficha) {
  const tp = sinTildes(nombreParte).split(/\s+/);
  const tf = sinTildes(`${ficha.nombre} ${ficha.apellido}`).split(/\s+/).filter(Boolean);
  if (!tf.length || tel10(telefono).length < 8 || tel10(telefono) !== tel10(ficha.telefono)) return false;
  const apellido = tp[tp.length - 1];
  if (tp.length > 1 && !tf.includes(apellido)) return false;
  const nombre = tp[0];
  return tf.some((t) => t.length >= 3 && nombre.length >= 3 && (t.startsWith(nombre) || nombre.startsWith(t)));
}

// Devuelve [{ nombre, sugerida: {id, nombre} | null }] o null si el turno es de una sola persona.
export function sugerirTurnoCompartido(persona, fichas) {
  const nombres = separarNombres(persona.nombre);
  if (!nombres) return null;
  return nombres.map((n) => {
    const ids = new Map();
    for (const f of fichas) if (f.fichaId && coincide(n, persona.telefono, f)) ids.set(f.fichaId, `${f.nombre} ${f.apellido}`.trim());
    const [id, nombre] = ids.size === 1 ? [...ids][0] : [];
    return { nombre: n, sugerida: id ? { id, nombre } : null };
  });
}

// Clave estable del turno compartido ya resuelto (se guarda en la configuración de /admin).
export function claveCompartido({ nombre, telefono, dni }) {
  return `${sinTildes(nombre).replace(/\s+/g, ' ')}|${tel10(telefono)}|${normalizarDni(dni) || ''}`;
}
