function celdaTextoLimpia(valor) {
  if (valor === true || valor === false || valor === 'TRUE' || valor === 'FALSE') return '';
  return valor || '';
}

export function construirRespuestaFicha({ id, driveModifiedTime, campos, financiero, movRaw, presRaw, monedaFilas }) {
  const c = (campos || []).map((r) => (r[0] != null ? String(r[0]) : ''));
  while (c.length < 11) c.push('');
  const [nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento] = c;
  const f = financiero || [];
  const movimientos = (movRaw || []).map((row, i) => ({
    fila: 18 + i, fecha: row[0] || '', tratamiento: row[1] || '', debe: row[2] || '', haber: row[3] || '', saldo: row[4] || '', formaPago: row[6] || '',
    monedaDebe: (monedaFilas?.[i] || [])[0] || '', monedaHaber: (monedaFilas?.[i] || [])[1] || '', aplicaA: (monedaFilas?.[i] || [])[2] || '', cotizacion: (monedaFilas?.[i] || [])[3] || '',
  })).filter((m) => m.fecha || m.tratamiento || m.debe || m.haber).map((m) => ({ ...m, anulado: /^\[ANULADO\]/.test(m.tratamiento) }));
  const prestacionesObraSocial = (presRaw || []).map((row, i) => ({
    fila: 18 + i, fecha: row[0] || '', tratamiento: celdaTextoLimpia(row[1]), codigo: celdaTextoLimpia(row[2]), autorizado: row[3] === true || row[3] === 'TRUE',
  })).filter((p) => p.fecha || p.tratamiento || p.codigo);
  return {
    id, driveModifiedTime,
    campos: { nombre, apellido, dni, fechaNacimiento, domicilio, localidad, obraSocial, nAfiliado, plan, telefono, planTratamiento },
    financiero: { total: f[0]?.[1] || '$0,00', pagado: f[1]?.[1] || '$0,00', saldo: f[2]?.[1] || '$0,00', alDiaTexto: f[3]?.[0] || '', diasSinPagoTexto: f[5]?.[1] || '' },
    movimientos, prestacionesObraSocial,
  };
}
