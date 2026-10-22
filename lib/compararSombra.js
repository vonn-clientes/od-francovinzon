import { aplicarAccion } from './fichaMotor.js';

const CAMPOS = ['nombre','apellido','dni','fechaNacimiento','domicilio','localidad','obraSocial','nAfiliado','plan','telefono','planTratamiento'];
const FINANCIERO = ['total','pagado','saldo','alDiaTexto','diasSinPagoTexto'];
const ignoradas = new Set(['id','fila','driveModifiedTime']);
const ordenado = (v) => {
  if (Array.isArray(v)) return v.map(ordenado);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).filter(k => !ignoradas.has(k)).sort().map(k => [k, ordenado(v[k])]));
};
const texto = (v) => JSON.stringify(ordenado(v));
function sinMetaRegistro(x) {
  const out = Object.fromEntries(Object.entries(x || {}).filter(([k]) => !ignoradas.has(k)));
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  for (const k of ['debe','haber','cotizacion']) if (out[k] !== '' && out[k] != null && Number.isFinite(Number(out[k]))) out[k] = Number(out[k]);
  return out;
}
function diferencia(ruta, esperado, real) { return { ruta, esperado, real }; }

export function compararSombra({ antes, despues, accion, body = {}, ahora } = {}) {
  try {
    const esAgregar = accion === 'movimiento-agregar' || accion === 'prestacion-agregar';
    if (!esAgregar && !usable(antes, accion, body)) return { igual: null, diffs: [], omitido: 'sin_identificador' };
    const resultado = aplicarAccion(antes, accion, body, { ahora });
    const esperado = resultado.ficha;
    const real = despues || {};
    const diffs = [];
    for (const k of CAMPOS) {
      const a = esperado.campos?.[k] ?? '', b = real.campos?.[k] ?? '';
      if (texto(a) !== texto(b)) diffs.push(diferencia(`campos.${k}`, a, b));
    }
    for (const k of FINANCIERO) {
      const a = esperado.financiero?.[k] ?? '', b = real.financiero?.[k] ?? '';
      if (k === 'diasSinPagoTexto' && a !== '' && b !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a)-Number(b)) <= 1) continue;
      if (texto(a) !== texto(b)) diffs.push(diferencia(`financiero.${k}`, a, b));
    }
    compararLista('movimientos', esperado.movimientos || [], real.movimientos || [], diffs);
    compararLista('prestacionesObraSocial', esperado.prestacionesObraSocial || [], real.prestacionesObraSocial || [], diffs);
    return { igual: diffs.length === 0, diffs: diffs.slice(0,20) };
  } catch (e) {
    return { igual: false, diffs: [{ ruta: 'motor', esperado: 'ok', real: String(e?.message || e || 'error') }] };
  }
}
function usable(antes, accion, body) {
  if (body?.idRegistro) {
    const key = accion.startsWith('prestacion-') ? 'prestacionesObraSocial' : 'movimientos';
    if ((antes?.[key] || []).some(x => x.id === body.idRegistro)) return true;
  }
  if (body?.fila != null && Number.isFinite(Number(body.fila))) {
    const key = accion.startsWith('prestacion-') ? 'prestacionesObraSocial' : 'movimientos';
    if ((antes?.[key] || []).some(x => Number(x.fila) === Number(body.fila))) return true;
  }
  return accion === 'actualizar-campo';
}
function compararLista(ruta, a, b, diffs) {
  const aa = a.map(sinMetaRegistro), bb = b.map(sinMetaRegistro);
  const n = Math.max(aa.length, bb.length);
  for (let i=0; i<n; i++) if (texto(aa[i]) !== texto(bb[i])) diffs.push(diferencia(`${ruta}[${i}]`, aa[i] ?? null, bb[i] ?? null));
}
