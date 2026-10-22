export function debeIntentarLecturaSupabase(flag, url, serviceKey) {
  return flag === '1' && Boolean(url && serviceKey);
}

export function fichaSupabaseFresca(row, driveModifiedTime) {
  const ficha = row?.ficha ?? row?.ficha_json;
  if (!ficha || typeof ficha !== 'object' || Array.isArray(ficha)) return null;
  const guardada = Date.parse(row?.drive_modified_time || '');
  const actual = Date.parse(driveModifiedTime || '');
  return Number.isFinite(guardada) && Number.isFinite(actual) && guardada >= actual ? ficha : null;
}
