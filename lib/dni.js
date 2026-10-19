// DNI: se compara siempre por dígitos (con o sin puntos da igual) y se guarda siempre
// con puntos ("46.861.050"). Si trae algo que no es número ni separador (letras, "-"),
// se deja tal cual para no inventar datos.
export function soloDigitosDni(dni) {
  return String(dni ?? '').replace(/\D/g, '');
}
export function formatearDniConPuntos(dni) {
  const crudo = String(dni ?? '').trim();
  if (!crudo || crudo === '-') return crudo;
  if (/[^\d.\s]/.test(crudo)) return crudo;
  const d = soloDigitosDni(crudo);
  if (!d) return crudo;
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
