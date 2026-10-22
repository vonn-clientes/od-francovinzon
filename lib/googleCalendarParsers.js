// Parsers sin dependencias externas compartidos por Google Calendar y sus espejos.
const textoPlano = (description = '') => String(description).replace(/<[^>]*>/g, ' ');
function extraer(description, etiqueta) {
  const match = textoPlano(description).match(etiqueta);
  const valor = match ? match[1].trim() : '';
  return valor && valor !== '-' ? valor : '';
}
export const extraerTelefono = (d) => extraer(d, /Tel[eé]fono:\s*([^\n]+)/i);
export const extraerMotivo = (d) => extraer(d, /Motivo:\s*([^\n]+)/i);
export const extraerDni = (d) => extraer(d, /DNI:\s*([^\n]+)/i);
export const extraerEmail = (d) => extraer(d, /Email:\s*([^\n]+)/i);
export const extraerCodigoCorto = (d) => extraer(d, /C[oó]digo corto:\s*([^\n]+)/i);
export function extraerEsNuevoPaciente(d) {
  return /^s/i.test(extraer(d, /Paciente nuevo:\s*(S[ií]|No)/i));
}
export function extraerTelefonoVerificado(d) {
  return /Tel[eé]fono verificado:\s*S[ií]/i.test(textoPlano(d));
}
export function extraerConfirmado(d) {
  return /Confirmado:\s*S[ií]/i.test(textoPlano(d));
}
export function extraerConfirmacionSolicitada(d) {
  return /Confirmaci[oó]n solicitada:\s*S[ií]/i.test(textoPlano(d));
}
export { textoPlano };
