import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarAccion, asegurarIds, parsearImporteAR, recalcularDerivados } from '../lib/fichaMotor.js';

const ahora='2026-10-22T12:00:00Z';
const base=()=>({id:'f',campos:{},financiero:{total:'viejo',pagado:'viejo',saldo:'viejo',alDiaTexto:'viejo',diasSinPagoTexto:'viejo'},movimientos:[],prestacionesObraSocial:[]});
const cinco=(f)=>Object.fromEntries(['total','pagado','saldo','alDiaTexto','diasSinPagoTexto'].map(k=>[k,f.financiero[k]]));
function verificaDerivados(result) {
  assert.deepEqual(cinco(result.ficha),cinco(recalcularDerivados(result.ficha,{ahora})));
  for(const v of Object.values(cinco(result.ficha))) assert.notEqual(v,'viejo');
}

test('parsea importes argentinos con coma y miles',()=>{assert.equal(parsearImporteAR('$1.234,56'),1234.56);assert.equal(parsearImporteAR('1234.56'),1234.56);assert.equal(parsearImporteAR('1.234'),1234);});
test('recalcula sumas ARS, saldo, estado y anulaciones',()=>{
  const f=base();f.movimientos=[{debe:'$1.000,00',haber:'$200,00',fecha:'1/10/2026'},{debe:'$9.000,00',haber:'$8.000,00',fecha:'2/10/2026',anulado:true},{debe:0,haber:0,fecha:'3/10/2026',tratamiento:'[ANULADO] ajuste'}];
  const r=recalcularDerivados(f,{ahora});assert.equal(r.financiero.total,'$1.000,00');assert.equal(r.financiero.pagado,'$200,00');assert.equal(r.financiero.saldo,'$800,00');assert.equal(r.financiero.alDiaTexto,'🔴 DEBE $800');assert.equal(r.financiero.diasSinPagoTexto,'21');
  assert.equal(recalcularDerivados({...f,movimientos:[{debe:'749.322,17'}]},{ahora}).financiero.alDiaTexto,'🔴 DEBE $749.322');
  assert.equal(recalcularDerivados({...f,movimientos:[{haber:'10.000,00'}]},{ahora}).financiero.alDiaTexto,'🔴 DEBE $-10.000');
  assert.equal(recalcularDerivados({...f,movimientos:[{haber:'0,44'}]},{ahora}).financiero.alDiaTexto,'🔴 DEBE $0');
  assert.equal(recalcularDerivados({...f,movimientos:[{debe:'10,00',haber:'10,00'}]},{ahora}).financiero.alDiaTexto,'✅ AL DÍA');
});
test('días desde último pago o último movimiento, en fechas locales de Argentina',()=>{
  const calc=(movimientos)=>recalcularDerivados({...base(),movimientos},{ahora}).financiero.diasSinPagoTexto;
  assert.equal(calc([{fecha:'15/9/2026',haber:'1'}]),'37');
  assert.equal(calc([{fecha:'30/9/2026',debe:'1'}]),'22');
  assert.equal(calc([{fecha:'21/10/2026',debe:'1'}]),'1');
  assert.equal(calc([{fecha:'9/10/2026',haber:'1'}]),'13');
  assert.equal(calc([{fecha:'1/10/2026',debe:'1',haber:'1'}]),'');
});
test('actualizar-campo recalcula los cinco derivados',()=>{const r=aplicarAccion(base(),'actualizar-campo',{campo:'nombre',valor:'ana pérez'},{ahora});assert.equal(r.ficha.campos.nombre,'Ana Pérez');verificaDerivados(r);});
test('movimiento-agregar recalcula los cinco derivados',()=>{const r=aplicarAccion(base(),'movimiento-agregar',{fecha:'22/10/2026',debe:'1.234,00'},{ahora});assert.equal(r.ficha.financiero.total,'$1.234,00');verificaDerivados(r);});
test('movimiento-editar recalcula los cinco derivados',()=>{const f=base();f.movimientos=[{id:'m',fecha:'1/10/2026',debe:'1'}];const r=aplicarAccion(f,'movimiento-editar',{idRegistro:'m',fecha:'22/10/2026',debe:'20',haber:'5'},{ahora});assert.equal(r.ficha.financiero.saldo,'$15,00');verificaDerivados(r);});
test('movimiento-anular recalcula los cinco derivados',()=>{const f=base();f.movimientos=[{id:'m',fecha:'1/10/2026',debe:'20'}];const r=aplicarAccion(f,'movimiento-anular',{idRegistro:'m'},{ahora});assert.equal(r.ficha.financiero.total,'$0,00');verificaDerivados(r);});
test('movimiento-limpiar recalcula los cinco derivados',()=>{const f=base();f.movimientos=[{id:'m',fecha:'1/10/2026',debe:'20'}];const r=aplicarAccion(f,'movimiento-limpiar',{idRegistro:'m'},{ahora});assert.equal(r.ficha.movimientos.length,0);assert.equal(r.ficha.financiero.total,'$0,00');verificaDerivados(r);});
test('prestacion-agregar recalcula los cinco derivados',()=>{const r=aplicarAccion(base(),'prestacion-agregar',{fecha:'hoy',tratamiento:'limpieza',codigo:'abc',autorizado:true},{ahora});assert.equal(r.ficha.prestacionesObraSocial[0].tratamiento,'LIMPIEZA');verificaDerivados(r);});
test('prestacion-editar recalcula los cinco derivados',()=>{const f=base();f.prestacionesObraSocial=[{id:'p'}];const r=aplicarAccion(f,'prestacion-editar',{idRegistro:'p',fecha:'mañana',tratamiento:'control',codigo:'x'},{ahora});assert.equal(r.ficha.prestacionesObraSocial[0].codigo,'X');verificaDerivados(r);});
test('prestacion-eliminar recalcula los cinco derivados',()=>{const f=base();f.prestacionesObraSocial=[{id:'p'}];const r=aplicarAccion(f,'prestacion-eliminar',{idRegistro:'p'},{ahora});assert.equal(r.ficha.prestacionesObraSocial.length,0);verificaDerivados(r);});
test('asegurarIds determinístico',()=>{const f=base();f.movimientos=[{fila:18,fecha:'01/01/2020'}];assert.equal(asegurarIds(f).movimientos[0].id,asegurarIds(f).movimientos[0].id);});
