import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Prueba estática de las rutas primarias. Este checkout no incluye node_modules
// (googleapis tampoco está instalado), por eso la prueba de integración que importa
// handlers y parchea sus clientes no puede ejecutarse aquí.
test('las rutas Tramo 10 usan RPC Supabase y respetan el interruptor de espejo', async () => {
  const [dni, telefono, reservar, admin, sql] = await Promise.all([
    readFile(new URL('../api/gestion/agregar-dni.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/agregar-telefono.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/reservar.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/agenda_contacto_dni_bloqueo_id.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(dni, /consultorio_agenda_actualizar_contacto/);
  assert.match(telefono, /consultorio_agenda_actualizar_contacto/);
  assert.match(reservar, /consultorio_agenda_buscar_por_dni/);
  assert.match(admin, /consultorio_agenda_crear_bloqueo/);
  assert.match(admin, /consultorio_agenda_borrar_bloqueo/);
  assert.match(sql, /regexp_replace\(coalesce\(t\.dni/);
  assert.match(sql, /-03:00/);
});

test('las lecturas del Tramo 11 tienen rutas Supabase y cortan el fallback bajo flags primarios', async () => {
  const [buscar, pacientes, admin, dni, telefono] = await Promise.all([
    readFile(new URL('../api/gestion/buscar.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/pacientes.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/agregar-dni.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/gestion/agregar-telefono.js', import.meta.url), 'utf8'),
  ]);
  assert.match(buscar, /eventosAgenda\(desde\.toISOString\(\), hasta\.toISOString\(\)\)/);
  assert.match(buscar, /SUPABASE_AGENDA_PRIMARY/);
  assert.match(buscar, /No se pudo leer la agenda en Supabase/);
  assert.match(buscar, /SUPABASE_WRITES_PRIMARY !== '1'.*buscarPacienteConsolidado/s);
  assert.match(pacientes, /if \(primaria\) return res\.status\(503\).*Supabase/s);
  assert.match(pacientes, /consultorio_agenda_actualizar_contacto/);
  assert.match(pacientes, /agendaPrimariaActiva\(\)/);
  assert.match(pacientes, /leerMapeosSupabase\(\{ leerGoogle: leerMapeosDesdeGoogle \}\)/);
  assert.match(admin, /agendaPrimariaActiva\(\) \? null : getCalendarClient\(\)/);
  assert.match(admin, /async function leerProximosTurnosPersonas[\s\S]*?eventosAgenda/);
  assert.match(admin, /async function exportTurnos[\s\S]*?eventosAgenda/);
  for (const handler of [dni, telefono]) assert.match(handler, /consultorio_agenda_actualizar_contacto/);
});
