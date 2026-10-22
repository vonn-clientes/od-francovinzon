// Port de numeroImporte, efectoMov y calcularCuentas de pacientes/index.html.
export function parsearImporteAR(valor) {
  let t = String(valor == null ? '' : valor).replace(/[^\d.,-]/g, '');
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

export function efectoMov(m, cotizacionFallback) {
  const debe = parsearImporteAR(m.debe), haber = parsearImporteAR(m.haber);
  const mDebe = m.monedaDebe === 'USD' ? 'USD' : 'ARS';
  const mHab = m.monedaHaber === 'USD' ? 'USD' : 'ARS';
  const destino = m.aplicaA === 'USD' || m.aplicaA === 'ARS' ? m.aplicaA : mHab;
  const cot = Number(m.cotizacion) > 0 ? Number(m.cotizacion) : (cotizacionFallback || 0);
  let acreditado = haber;
  if (mHab !== destino) {
    if (!cot) acreditado = 0;
    else acreditado = mHab === 'ARS' ? haber / cot : haber * cot;
  }
  return { mDebe, debe, destino, acreditado };
}

export function calcularCuentas(movimientos, cotizacionFallback) {
  const c = { ARS: { debe: 0, pagado: 0 }, USD: { debe: 0, pagado: 0 } };
  (movimientos || []).forEach((m) => {
    // La API deriva anulado del prefijo; admitir también filas sin ese indicador.
    if (m.anulado || /^\[ANULADO\]/.test(m.tratamiento)) return;
    const e = efectoMov(m, cotizacionFallback);
    c[e.mDebe].debe += e.debe;
    c[e.destino].pagado += e.acreditado;
  });
  c.ARS.saldo = c.ARS.debe - c.ARS.pagado;
  c.USD.saldo = c.USD.debe - c.USD.pagado;
  return c;
}
