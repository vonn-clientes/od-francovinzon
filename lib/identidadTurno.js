// Identidad turno↔ficha SIN dudas. Una persona del turno es "la misma" que una fila con ficha solo si:
//   - los dos tienen DNI y es idéntico, o
//   - alguno no tiene DNI y coinciden EXACTO el nombre completo (sin importar el orden de las palabras,
//     tildes ni mayúsculas) Y el teléfono.
// El teléfono solo nunca alcanza (chicos con el teléfono de los padres). Todo lo demás es "sin ficha"
// y lo asigna Fausto en /admin → Pacientes sin ficha.
import { normalizarDni, normalizarTelefonoMapeo } from './pacientesSheet.js';

export function tokensNombre(...partes) {
  return partes.join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

export function mismaPersonaEstricta(a, b) {
  const da = normalizarDni(a.dni), db = normalizarDni(b.dni);
  if (da && db) return da === db;
  const ta = normalizarTelefonoMapeo(a.telefono), tb = normalizarTelefonoMapeo(b.telefono);
  if (!ta || ta !== tb) return false;
  const na = tokensNombre(a.nombre || '', a.apellido || ''), nb = tokensNombre(b.nombre || '', b.apellido || '');
  return !!na && na === nb;
}
