import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const CAMPOS_AUTOFICHA = [
  { clave: 'nombre', etiqueta: 'Nombre', tipo: 'text', autocomplete: 'given-name', soloLecturaConValor: true },
  { clave: 'apellido', etiqueta: 'Apellido', tipo: 'text', autocomplete: 'family-name', soloLecturaConValor: true },
  { clave: 'dni', etiqueta: 'DNI', tipo: 'text', autocomplete: 'off', soloLecturaConValor: true },
  { clave: 'fechaNacimiento', etiqueta: 'Fecha de nacimiento', tipo: 'text', autocomplete: 'bday', soloLecturaConValor: false },
  { clave: 'domicilio', etiqueta: 'Domicilio', tipo: 'text', autocomplete: 'street-address', soloLecturaConValor: false },
  { clave: 'localidad', etiqueta: 'Localidad', tipo: 'text', autocomplete: 'address-level2', soloLecturaConValor: false },
  { clave: 'telefono', etiqueta: 'Teléfono', tipo: 'tel', autocomplete: 'tel', soloLecturaConValor: false },
  { clave: 'obraSocial', etiqueta: 'Obra social', tipo: 'text', autocomplete: 'organization', soloLecturaConValor: false },
  { clave: 'nAfiliado', etiqueta: 'Nº de afiliado', tipo: 'text', autocomplete: 'off', soloLecturaConValor: false },
  { clave: 'plan', etiqueta: 'Plan', tipo: 'text', autocomplete: 'off', soloLecturaConValor: false },
];

const CAMPOS = new Set(CAMPOS_AUTOFICHA.map((c) => c.clave));
const BLOQUEADOS_CON_VALOR = new Set(['dni', 'nombre', 'apellido']);
const b64url = (s) => Buffer.from(s).toString('base64url');

export function secretoAutoficha(gestionKey) {
  return createHash('sha256').update('autoficha|' + String(gestionKey)).digest('hex');
}

export function firmarToken({ fichaId, ahora = Date.now(), ttlMs = 3 * 3600 * 1000, secreto }) {
  if (!fichaId || !secreto) throw new TypeError('fichaId y secreto son obligatorios');
  const payload = b64url(JSON.stringify({ f: String(fichaId), e: Number(ahora) + Number(ttlMs) }));
  const firma = createHmac('sha256', secreto).update(payload).digest('base64url');
  return `${payload}.${firma}`;
}

export function verificarToken(token, { ahora = Date.now(), secreto } = {}) {
  try {
    if (typeof token !== 'string' || !secreto) return { ok: false, motivo: 'invalido' };
    const partes = token.split('.');
    if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, motivo: 'invalido' };
    const esperada = createHmac('sha256', secreto).update(partes[0]).digest();
    const recibida = Buffer.from(partes[1], 'base64url');
    if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return { ok: false, motivo: 'invalido' };
    const payload = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    if (typeof payload.f !== 'string' || !payload.f || !Number.isFinite(payload.e)) return { ok: false, motivo: 'invalido' };
    if (Number(ahora) >= payload.e) return { ok: false, motivo: 'expirado' };
    return { ok: true, fichaId: payload.f };
  } catch { return { ok: false, motivo: 'invalido' }; }
}

export function vistaPublica(ficha) {
  const origen = ficha?.campos || ficha || {};
  return Object.fromEntries(CAMPOS_AUTOFICHA.map(({ clave }) => [clave, origen[clave] ?? '']));
}

function fechaValida(valor, ahora) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(valor);
  if (!m) return false;
  const d = Number(m[1]), mes = Number(m[2]), anio = Number(m[3]);
  const fecha = new Date(anio, mes - 1, d);
  if (fecha.getFullYear() !== anio || fecha.getMonth() !== mes - 1 || fecha.getDate() !== d) return false;
  const hoy = new Date(ahora);
  hoy.setHours(23, 59, 59, 999);
  return fecha <= hoy;
}

export function validarCambios(entrada, actuales = {}, { ahora = new Date() } = {}) {
  const cambios = [], errores = {};
  const datos = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  for (const [campo, bruto] of Object.entries(datos)) {
    if (!CAMPOS.has(campo)) { errores[campo] = 'Campo no permitido.'; continue; }
    if (typeof bruto !== 'string') { errores[campo] = 'Ingresá un texto válido.'; continue; }
    const valor = bruto.trim();
    if (valor.length > 120) { errores[campo] = 'Usá 120 caracteres o menos.'; continue; }
    if (BLOQUEADOS_CON_VALOR.has(campo) && String(actuales?.[campo] ?? '').trim()) continue;
    if (valor === String(actuales?.[campo] ?? '').trim()) continue;
    if (campo === 'telefono') {
      const digitos = valor.replace(/\D/g, '');
      if (!/^[\d+\s-]*$/.test(valor) || digitos.length < 8) { errores[campo] = 'Ingresá un teléfono válido (al menos 8 dígitos).'; continue; }
    }
    if (campo === 'dni' && !/^\d{7,8}$/.test(valor.replace(/\D/g, ''))) { errores[campo] = 'El DNI debe tener 7 u 8 dígitos.'; continue; }
    if (campo === 'fechaNacimiento' && valor && !fechaValida(valor, ahora)) { errores[campo] = 'Ingresá una fecha válida en formato dd/mm/aaaa, que no sea futura.'; continue; }
    cambios.push({ campo, valor });
  }
  return { cambios, errores };
}
