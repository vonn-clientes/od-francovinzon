import { calcularCuentas, parsearImporteAR } from './cuentaSaldo.js';

const texto = (valor) => String(valor == null ? '' : valor).trim();

function fechaCalendario(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(`${iso}T00:00:00Z`);
  return y > 0 && Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d
    ? iso : null;
}

// Formatos de fechaMovimientoAISO (usada por api/gestion/pacientes.js),
// con validación adicional para no insertar fechas imposibles en PostgreSQL.
function fechaISO(valor, movimiento = false) {
  const s = texto(valor);
  const partes = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (partes) return fechaCalendario(`${partes[3]}-${partes[2].padStart(2, '0')}-${partes[1].padStart(2, '0')}`);
  if (!movimiento) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return fechaCalendario(s.slice(0, 10));
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 60000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    // El helper original aplica formatArgDay al instante del serial, incluso
    // si su medianoche UTC cae en el día anterior en Argentina.
    const partesFecha = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const p = Object.fromEntries(partesFecha.map(({ type, value }) => [type, value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  return null;
}

export function fichaAFilas(ficha, { cotizacionFallback = 0 } = {}) {
  const campos = ficha.campos || {};
  const originales = ficha.movimientos || [];
  const cuentas = calcularCuentas(originales, cotizacionFallback);
  const paciente = {
    dni: texto(campos.dni).replace(/\D/g, '') || null,
    nombre: texto(campos.nombre),
    apellido: texto(campos.apellido),
    // Los normalizadores del repo son para wa.me o comparación (últimos
    // diez dígitos), no E.164. No adivinar país ni importar clientes con IO.
    telefono_e164: texto(campos.telefono),
    fecha_nacimiento: fechaISO(campos.fechaNacimiento),
    obra_social: texto(campos.obraSocial),
    plan: texto(campos.plan),
    datos: {
      domicilio: texto(campos.domicilio), localidad: texto(campos.localidad),
      nAfiliado: texto(campos.nAfiliado), planTratamiento: texto(campos.planTratamiento),
    },
    saldo_ars: cuentas.ARS.saldo,
    saldo_usd: cuentas.USD.saldo,
  };
  const movimientos = originales.map((m) => {
    const cot = Number(m.cotizacion);
    return {
      fila_origen: m.fila,
      fecha: fechaISO(m.fecha, true),
      tratamiento: String(m.tratamiento ?? ''),
      debe: parsearImporteAR(m.debe), haber: parsearImporteAR(m.haber),
      moneda_debe: m.monedaDebe === 'USD' ? 'USD' : 'ARS',
      moneda_haber: m.monedaHaber === 'USD' ? 'USD' : 'ARS',
      aplica_a: m.aplicaA === 'ARS' || m.aplicaA === 'USD' ? m.aplicaA : null,
      cotizacion: Number.isFinite(cot) && cot > 0 ? cot : null,
      anulado: Boolean(m.anulado || /^\[ANULADO\]/.test(m.tratamiento)),
    };
  });
  return { paciente, movimientos };
}
