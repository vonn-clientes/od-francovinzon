import test from 'node:test';
import assert from 'node:assert/strict';
import { compararSombra } from '../lib/compararSombra.js';

const ahora = '2026-10-22T12:00:00Z';
const base = () => ({ campos: { nombre:'Ana', dni:'12.345.678' }, financiero:{total:'$0,00',pagado:'$0,00',saldo:'$0,00',alDiaTexto:'✅ AL DÍA',diasSinPagoTexto:''}, movimientos:[], prestacionesObraSocial:[] });
test('compara los valores y omite identificadores y orden de claves', () => {
  const antes=base(), despues={...base(),campos:{dni:'12.345.678',nombre:'Ana'},driveModifiedTime:'nuevo',movimientos:[{id:'google',fila:22,fecha:'22/10/2026',tratamiento:'Control',debe:'0',haber:'0',formaPago:'EFECTIVO',monedaDebe:'',monedaHaber:'',aplicaA:'',cotizacion:''}]};
  const r=compararSombra({antes,despues,accion:'movimiento-agregar',body:{fecha:'22/10/2026',tratamiento:'control',formaPago:'efectivo'},ahora});
  assert.equal(r.igual,true); assert.deepEqual(r.diffs,[]);
});
test('reporta diferencias legibles y limita a veinte', () => {
  const a=base(); a.campos={}; const b=base(); b.campos={}; b.financiero={};
  const r=compararSombra({antes:a,despues:b,accion:'actualizar-campo',body:{campo:'nombre',valor:'Eva'},ahora});
  assert.equal(r.igual,false); assert.equal(r.diffs[0].ruta,'campos.nombre');
});
test('tolera un día de diferencia en diasSinPagoTexto', () => {
  const antes=base(); antes.movimientos=[{id:'m',fila:18,fecha:'1/10/2026',debe:'10',haber:0}];
  const despues={...antes,campos:{...antes.campos,nombre:'Eva'},financiero:{total:'$10,00',pagado:'$0,00',saldo:'$10,00',alDiaTexto:'🔴 DEBE $10',diasSinPagoTexto:'20'},movimientos:antes.movimientos};
  assert.equal(compararSombra({antes,despues,accion:'actualizar-campo',body:{campo:'nombre',valor:'Eva'},ahora}).igual,true);
});
test('omite cambios de registro sin identificador coincidente', () => {
  const r=compararSombra({antes:base(),despues:base(),accion:'movimiento-editar',body:{fila:99},ahora});
  assert.deepEqual(r,{igual:null,diffs:[],omitido:'sin_identificador'});
});
test('captura errores del motor', () => {
  assert.deepEqual(compararSombra({antes:base(),despues:base(),accion:'actualizar-campo',body:{campo:'invalido'},ahora}),{igual:false,diffs:[{ruta:'motor',esperado:'ok',real:'Campo inválido.'}]});
});
test('admite fila de handler y normaliza DNI como el handler real', () => {
  const antes=base(); antes.movimientos=[{fila:18,fecha:'1/10/2026'}];
  const resultado=compararSombra({antes,despues:{...antes,campos:{...antes.campos,dni:'12.345.678-A'}},accion:'actualizar-campo',body:{campo:'dni',valor:'12.345.678-A'},ahora});
  assert.equal(resultado.igual,true);
});
