import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../mobilephotouploaderodfrancovinzon/mobile-auth.js', import.meta.url), 'utf8');
class Elemento {
  listeners = {};
  value = '';
  addEventListener(tipo, fn) { this.listeners[tipo] = fn; }
  emitir(tipo) { this.listeners[tipo]?.({ preventDefault() {} }); }
  setAttribute() {}
  removeAttribute(nombre) { delete this[nombre]; }
  focus() {}
  showModal() { this.open = true; this.aperturas = (this.aperturas || 0) + 1; }
  close() { this.open = false; }
}
function entorno({ guardada = '', storageBloqueado = false, fetchImpl } = {}) {
  const input = new Elemento(), form = new Elemento(), cancelar = new Elemento(), mensaje = new Elemento();
  const dialog = new Elemento(), boton = new Elemento(), window = new Elemento();
  dialog.querySelector = (q) => ({ input, form, '#mobile-key-cancel': cancelar, '#mobile-key-message': mensaje }[q]);
  const almacenamiento = { mobile_key: guardada };
  const calls = [], revocadas = [];
  let blobs = 0;
  const context = { window, Headers, Error,
    document: { createElement: () => dialog, body: { appendChild() {} }, getElementById: () => boton },
    localStorage: {
      getItem(k) { if (storageBloqueado) throw Error('bloqueado'); return almacenamiento[k]; },
      setItem(k, v) { if (storageBloqueado) throw Error('bloqueado'); almacenamiento[k] = v; },
    },
    URL: { createObjectURL: () => `blob:prueba-${++blobs}`, revokeObjectURL: (url) => revocadas.push(url) },
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl ? fetchImpl(url, init) : { status: 200, ok: true, blob: async () => ({}) }; },
  };
  vm.runInNewContext(source, context);
  return { window, dialog, input, form, cancelar, boton, calls, almacenamiento, revocadas };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('sin clave: no pregunta si servidor permite; respeta body y headers existentes', async () => {
  const e = entorno();
  const r = await e.window.mobileFetch('/api/gestion/pacientes', { method: 'POST', body: '{"accion":"subir-foto"}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(e.dialog.open, undefined);
  assert.equal(e.calls[0].init.headers.get('x-gestion-key'), '');
  assert.equal(e.calls[0].init.headers.get('content-type'), 'application/json');
  assert.equal(e.calls[0].init.body, '{"accion":"subir-foto"}');
  assert.equal(e.calls[0].init.cache, 'no-store');
});

test('lee mobile_key y permite cargarla antes de activar el interruptor', async () => {
  const e = entorno({ guardada: 'previa' });
  await e.window.mobileFetch('/api/gestion/pacientes?modo=hoy-publico');
  assert.equal(e.calls[0].init.headers.get('x-gestion-key'), 'previa');
  e.boton.emitir('click');
  e.input.value = 'nueva'; e.form.emitir('submit');
  assert.equal(e.almacenamiento.mobile_key, 'nueva');
  assert.equal(e.input.value, '');
});

test('401 simultáneos comparten diálogo, clave incorrecta vuelve a pedir y reintenta la misma acción', async () => {
  const e = entorno({ fetchImpl: async (_, init) => ({ status: init.headers.get('x-gestion-key') === 'válida' ? 200 : 401 }) });
  const requests = ['/api/gestion/pacientes', '/api/gestion/pacientes?modo=foto-imagen&fotoId=prueba'];
  const uno = e.window.mobileFetch(requests[0], { method: 'POST', body: '{"accion":"subir-foto"}' });
  const dos = e.window.mobileFetch(requests[1]);
  await tick();
  assert.equal(e.dialog.aperturas, 1);
  e.input.value = 'incorrecta'; e.form.emitir('submit');
  await tick();
  assert.equal(e.dialog.aperturas, 2);
  e.input.value = 'válida'; e.form.emitir('submit');
  const respuestas = await Promise.all([uno, dos]);
  assert.ok(respuestas.every((r) => r.status === 200));
  assert.equal(e.almacenamiento.mobile_key, 'válida');
  assert.equal(e.calls.length, 6);
  assert.ok(e.calls.every((c) => requests.includes(c.url)), 'no pone clave en URL');
  assert.ok(e.calls.filter((c) => c.url === requests[0]).every((c) => c.init.body === '{"accion":"subir-foto"}'));
});

test('localStorage bloqueado: guarda en memoria y reintenta', async () => {
  const e = entorno({ storageBloqueado: true, fetchImpl: async (_, init) => ({ status: init.headers.get('x-gestion-key') ? 200 : 401 }) });
  const p = e.window.mobileFetch('/api/gestion/pacientes');
  await tick();
  e.input.value = 'prueba'; e.form.emitir('submit');
  assert.equal((await p).status, 200);
  assert.equal((await e.window.mobileFetch('/api/gestion/pacientes')).status, 200);
  assert.equal(e.dialog.aperturas, 1);
});

test('cancelar termina todos los reintentos y un 500 nunca repite una escritura', async () => {
  const e = entorno({ fetchImpl: async () => ({ status: 401 }) });
  const p = e.window.mobileFetch('/api/gestion/pacientes');
  const rechazo = assert.rejects(p, /Acceso cancelado/);
  await tick(); e.cancelar.emitir('click'); await rechazo;
  assert.equal(e.calls.length, 1);
  const fallo = entorno({ fetchImpl: async () => ({ status: 500 }) });
  assert.equal((await fallo.window.mobileFetch('/api/gestion/pacientes', { method: 'POST' })).status, 500);
  assert.equal(fallo.calls.length, 1);
});

test('miniaturas y visor: blob con header, liberar al reemplazar/cerrar y no revivir una carga descartada', async () => {
  const e = entorno({ guardada: 'clave' });
  const img = new Elemento();
  await e.window.mobileLoadImage(img, '/api/gestion/pacientes?modo=foto-imagen&fotoId=1');
  assert.equal(img.src, 'blob:prueba-1');
  assert.equal(e.calls[0].init.headers.get('x-gestion-key'), 'clave');
  await e.window.mobileLoadImage(img, '/api/gestion/pacientes?modo=foto-imagen&fotoId=2');
  assert.deepEqual(e.revocadas, ['blob:prueba-1']);
  e.window.mobileReleaseImage(img);
  assert.deepEqual(e.revocadas, ['blob:prueba-1', 'blob:prueba-2']);
  assert.equal(img.src, undefined);
  let resolver;
  const lento = entorno({ fetchImpl: () => new Promise((resolve) => { resolver = resolve; }) });
  const carga = lento.window.mobileLoadImage(img, '/api/gestion/pacientes?modo=foto-imagen&fotoId=3');
  lento.window.mobileReleaseImage(img);
  resolver({ status: 200, ok: true, blob: async () => ({}) });
  await carga;
  assert.equal(img.src, undefined);
});

test('ambas páginas usan el helper en todos sus fetch y conservan noindex', () => {
  for (const pagina of ['index.html', 'receta/index.html']) {
    const html = readFileSync(new URL(`../mobilephotouploaderodfrancovinzon/${pagina}`, import.meta.url), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex,\s*nofollow">/);
    assert.match(html, /<script src="(?:\.\.\/)?mobile-auth.js"><\/script>/);
    assert.doesNotMatch(html, /\bfetch\(/);
    assert.doesNotMatch(html, /<img[^>]+src="\/api\//);
    for (const [, attrs, code] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(attrs)) assert.equal(code.trim(), '');
      else new vm.Script(code); // sintaxis y estructura de scripts inline
    }
  }
});
