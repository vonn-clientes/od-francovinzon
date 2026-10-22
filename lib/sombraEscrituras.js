// Modo sombra: compara lo que haría el motor (lib/fichaMotor.js) con lo que realmente
// escribió Google, sin cambiar nada del flujo real. Todo es best-effort y nunca tira.
import { compararSombra } from './compararSombra.js';
import { conTimeout } from './sincronizarSupabase.js';

export const ACCIONES_SOMBRA = new Set(['actualizar-campo', 'movimiento-agregar', 'movimiento-editar', 'movimiento-anular', 'movimiento-limpiar', 'prestacion-agregar', 'prestacion-editar', 'prestacion-eliminar']);

export async function leerAntesSombra(cliente, id) {
  try {
    const fila = await conTimeout(cliente.leerFicha(id), 2000);
    return fila?.ficha ?? null;
  } catch { return null; }
}

export async function registrarSombra(cliente, { id, accion, body, antes }) {
  try {
    if (!antes) return;
    const fila = await conTimeout(cliente.leerFicha(id), 2000);
    const despues = fila?.ficha;
    if (!despues) return;
    const r = compararSombra({ antes, despues, accion, body, ahora: new Date() });
    await conTimeout(cliente.registrarSombra({ accion, ficha_id: String(id).replace(/\d{6,}/g, '###'), igual: r.igual, omitido: r.omitido ?? null, diffs: (r.diffs || []).slice(0, 20) }), 2000);
  } catch { /* la sombra nunca afecta la respuesta */ }
}
