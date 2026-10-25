import test from 'node:test';
import assert from 'node:assert/strict';

test('sellar-config guarda el default de las claves ausentes y respeta las que ya están', async () => {
  Object.assign(process.env, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', SUPABASE_READS: '1', SUPABASE_WRITES_PRIMARY: '1', ADMIN_KEY: 'ak', CONFIG_SOLO_SUPABASE: '1' });
  const almacen = { reservaOnlinePausada: false };
  globalThis.fetch = async (url, opts) => {
    const n = String(url).match(/rpc\/(\w+)/)?.[1];
    const body = opts?.body ? JSON.parse(opts.body) : {};
    let out = null;
    if (n === 'consultorio_config_leer_varias') out = Object.fromEntries((body.p_claves || []).filter((c) => c in almacen).map((c) => [c, almacen[c]]));
    if (n === 'consultorio_config_set') { almacen[body.p.clave] = body.p.valor; out = true; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { default: handler } = await import('../api/gestion/admin.js');
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, send(b) { this.body = b; return this; } };
  await handler({ method: 'POST', query: {}, body: { key: 'ak', recurso: 'sellar-config' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(almacen.reservaOnlinePausada, false, 'no pisa el valor ya guardado');
  for (const c of ['horarios', 'textos', 'listas', 'radios']) assert.ok(almacen[c], `${c} guardada`);
  assert.equal(res.body.informe.reservaOnlinePausada, 'ya estaba en Supabase');
  assert.match(res.body.informe.horarios, /valor por defecto/);
});
