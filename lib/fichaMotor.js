// Motor puro para mutar fichas con la estructura devuelta por obtenerFicha.
import { randomUUID, createHash } from 'node:crypto';

const CAMPOS = new Set(['nombre','apellido','dni','fechaNacimiento','domicilio','localidad','obraSocial','nAfiliado','plan','telefono','planTratamiento']);
const MAYUSCULAS = new Set(['nombre','apellido','domicilio','localidad','obraSocial','plan','planTratamiento']);
const copia = (x) => structuredClone(x ?? {});
const texto = (x) => String(x ?? '').trim();
const titulo = (x) => String(x ?? '').toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const formatearDni = (x) => { const crudo=String(x??'').trim(); if(!crudo||crudo==='-'||/[^\d.\s]/.test(crudo)) return crudo; const d=crudo.replace(/\D/g,''); return d ? d.replace(/\B(?=(\d{3})+(?!\d))/g,'.') : crudo; };
const mayusculas = (x) => x == null ? x : String(x).toUpperCase();
export function parsearImporteAR(valor) {
  let t = String(valor == null ? '' : valor).replace(/[^\d.,-]/g, '');
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = parseFloat(t); return Number.isFinite(n) ? n : 0;
}
const numero = (v) => Number(v) > 0 ? Number(v) : 0;
function fechaHoy(ahora) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Argentina/Buenos_Aires', year:'numeric', month:'2-digit', day:'2-digit' });
  return f.format(new Date(ahora));
}
function fechaISO(s) {
  const t = texto(s), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return /^\d{4}-\d\d-\d\d/.test(t) ? t.slice(0,10) : t;
}
function money(n) { const redondeado=Math.round((n + Math.sign(n)*Number.EPSILON)*100)/100; return (redondeado<0?'-':'') + '$' + new Intl.NumberFormat('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(redondeado)); }
const fechaMovimiento = (m) => {
  const d = fechaISO(m.fecha);
  return /^\d{4}-\d\d-\d\d$/.test(d) ? d : null;
};
const formatoEnteroAR = (n) => { const entero=Math.round(n); return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(Object.is(entero,-0)?0:entero); };
export function recalcularDerivados(ficha, { ahora = new Date() } = {}) {
  const f = copia(ficha), movimientos = f.movimientos || [], activos = movimientos.filter(m => !m.anulado && !/^\[ANULADO\]/.test(m.tratamiento));
  let saldoAcumulado = 0;
  for (const m of movimientos) {
    const anulado = m.anulado || /^\[ANULADO\]/.test(m.tratamiento || '');
    saldoAcumulado += anulado ? 0 : parsearImporteAR(m.debe) - parsearImporteAR(m.haber);
    m.saldo = money(saldoAcumulado);
  }
  let total=0,pagado=0,ultimoPago=null,ultimoMovimiento=null;
  for (const m of activos) {
    total += parsearImporteAR(m.debe);
    const haber = parsearImporteAR(m.haber);
    pagado += haber;
    const d = fechaMovimiento(m);
    if (d && (!ultimoMovimiento || d > ultimoMovimiento)) ultimoMovimiento=d;
    if (d && haber > 0 && (!ultimoPago || d > ultimoPago)) ultimoPago=d;
  }
  const saldo=total-pagado, alDia=Math.abs(saldo)<0.005;
  const origen=ultimoPago||ultimoMovimiento;
  const dias=origen ? Math.max(0, Math.floor((Date.parse(fechaHoy(ahora)+'T00:00:00Z')-Date.parse(origen+'T00:00:00Z'))/86400000)) : '';
  f.financiero={...(f.financiero||{}),total:money(total),pagado:money(pagado),saldo:money(saldo),alDiaTexto:alDia?'✅ AL DÍA':`🔴 DEBE $${formatoEnteroAR(saldo)}`,diasSinPagoTexto:alDia?'':dias === ''?'':String(dias)};
  return f;
}
export function asegurarIds(ficha) {
  const f=copia(ficha);
  for (const k of ['movimientos','prestacionesObraSocial']) f[k]=(f[k]||[]).map((x,i)=>({...x,id:x.id||createHash('sha256').update(`${f.id||''}|${k}|${JSON.stringify(x)}|${i}`).digest('hex').slice(0,32)}));
  return f;
}
function encontrar(items, body) { return items.findIndex(x => body.idRegistro ? x.id===body.idRegistro : Number(x.fila)===Number(body.fila)); }
export function aplicarAccion(ficha, accion, body={}, { ahora = new Date() } = {}) {
  let f=asegurarIds(ficha), cambios=[]; const b=body;
  const cambio=(tipo,id,antes,despues)=>cambios.push({tipo,id,antes,despues});
  if (accion==='actualizar-campo') {
    if (!CAMPOS.has(b.campo)) throw Error('Campo inválido.');
    const v=b.campo==='dni' ? formatearDni(b.valor) : MAYUSCULAS.has(b.campo)?titulo(b.valor):b.valor??'';
    const antes=f.campos?.[b.campo]; f.campos={...(f.campos||{}),[b.campo]:v}; cambio(accion,b.campo,antes,v);
  } else if (accion.startsWith('movimiento-')) {
    const xs=f.movimientos||[]; let i;
    if(accion==='movimiento-agregar') { if(!texto(b.fecha)) throw Error('Falta fecha.'); const x={id:randomUUID(),fila:null}; xs.push(x); i=xs.length-1; }
    else { i=encontrar(xs,b); if(i<0) throw Error('Movimiento no encontrado.'); }
    const x=xs[i], antes=copia(x);
    if(accion==='movimiento-limpiar') { xs.splice(i,1); cambio(accion,x.id,antes,null); }
    else if(accion==='movimiento-anular') { if(!/^\[ANULADO\]/.test(x.tratamiento||'')) { x.tratamiento=`[ANULADO] ${x.tratamiento||''} (era: Debe ${money(parsearImporteAR(x.debe))} / Haber ${money(parsearImporteAR(x.haber))})`; x.debe=money(0); x.haber=money(0); x.anulado=true; } cambio(accion,x.id,antes,copia(x)); }
    else { Object.assign(x,{fecha:b.fecha??'',tratamiento:titulo(b.tratamiento)||'',debe:money(parsearImporteAR(b.debe)),haber:money(parsearImporteAR(b.haber)),formaPago:String(b.formaPago||'').toUpperCase()}); for(const k of ['monedaDebe','monedaHaber','aplicaA']) if(b[k]!==undefined)x[k]=['ARS','USD'].includes(b[k])?b[k]:''; if(b.cotizacion!==undefined)x.cotizacion=numero(b.cotizacion)||''; cambio(accion,x.id,antes,copia(x)); }
    f.movimientos=xs;
  } else if (accion.startsWith('prestacion-')) {
    const xs=f.prestacionesObraSocial||[]; let i;
    if(accion==='prestacion-agregar'){if(!texto(b.fecha))throw Error('Falta fecha.');xs.push({id:randomUUID()});i=xs.length-1;} else {i=encontrar(xs,b);if(i<0)throw Error('Prestación no encontrada.');}
    const x=xs[i], antes=copia(x);
    if(accion==='prestacion-eliminar')xs.splice(i,1); else Object.assign(x,{fecha:b.fecha??'',tratamiento:mayusculas(b.tratamiento)||'',codigo:mayusculas(b.codigo)||'',autorizado:b.autorizado===true||b.autorizado==='TRUE'});
    cambio(accion,x.id,antes,accion==='prestacion-eliminar'?null:copia(x)); f.prestacionesObraSocial=xs;
  } else throw Error('Acción inválida.');
  return {ficha:recalcularDerivados(f,{ahora}),cambios};
}
