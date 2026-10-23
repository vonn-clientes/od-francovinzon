/* Desplegable de localidades con la estética del sitio (reemplaza al <datalist> nativo, que no se puede estilar).
   Uso: <input data-combo-localidad> (se engancha solo) o ComboLocalidad.attach(input) para campos creados por JS.
   Se puede escribir cualquier otra localidad: la lista solo sugiere. */
(function () {
  var LOCALIDADES = ['Concepción del Uruguay', 'Gualeguaychú', 'San José', 'Caseros', 'Urdinarrain', 'San Justo', 'Colón', 'Basavilbaso', 'Villa Elisa', 'Pronunciamiento'];
  var css = '.cl-lista{position:absolute;z-index:1000;background:#fff;border:1.5px solid var(--line,#E9E4D8);border-radius:14px;box-shadow:0 14px 34px rgba(30,58,95,.18);padding:6px;max-height:232px;overflow-y:auto;overscroll-behavior:contain;font-family:inherit}' +
    '.cl-lista[hidden]{display:none}' +
    '.cl-op{display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:10px;padding:10px 12px;font:600 14.5px/1.2 inherit;font-family:inherit;color:var(--navy,#1E3A5F);cursor:pointer}' +
    '.cl-op:hover,.cl-op.cl-act{background:rgba(212,162,76,.16)}' +
    '.cl-op b{font-weight:800;color:var(--navy,#1E3A5F)}' +
    '.cl-tit{padding:6px 12px 4px;font:700 10.5px/1 inherit;font-family:inherit;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#8A8578)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var norm = function (t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };

  function attach(input, cfg) {
    cfg = cfg || {};
    var items = cfg.items || LOCALIDADES, titulo = cfg.titulo || 'Localidades frecuentes';
    if (!input || input.dataset.clListo) return;
    input.dataset.clListo = '1';
    input.setAttribute('autocomplete', 'off'); input.removeAttribute('list');
    var padre = input.parentElement;
    if (getComputedStyle(padre).position === 'static') padre.style.position = 'relative';
    var lista = document.createElement('div'); lista.className = 'cl-lista'; lista.hidden = true; lista.setAttribute('role', 'listbox');
    padre.appendChild(lista);
    var act = -1, opciones = [];

    function pintar() {
      var q = norm(input.value.trim());
      var fuente = typeof items === 'function' ? items() : items;
      opciones = fuente.filter(function (l) { return !q || norm(l).indexOf(q) !== -1; });
      if (cfg.otra) opciones = opciones.concat([OTRA]);
      if (!opciones.length || (opciones.length === 1 && norm(opciones[0]) === q)) { cerrar(); return; }
      lista.innerHTML = '<div class="cl-tit">' + titulo + '</div>';
      opciones.forEach(function (l, i) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'cl-op'; b.setAttribute('role', 'option'); b.textContent = l; b.dataset.i = i;
        lista.appendChild(b);
      });
      act = -1; abrir();
    }
    function abrir() {
      lista.hidden = false;
      var r = input.getBoundingClientRect();
      var abajo = window.innerHeight - r.bottom;
      lista.style.left = input.offsetLeft + 'px'; lista.style.width = input.offsetWidth + 'px';
      if (abajo < 250 && r.top > abajo) { lista.style.top = ''; lista.style.bottom = (padre.clientHeight - input.offsetTop + 4) + 'px'; }
      else { lista.style.bottom = ''; lista.style.top = (input.offsetTop + input.offsetHeight + 4) + 'px'; }
    }
    function cerrar() { lista.hidden = true; act = -1; }
    function elegir(texto) {
      if (texto === OTRA) { input.value = ''; cerrar(); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); return; }
      input.value = texto;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      cerrar();
    }
    function marcar(n) {
      var ops = lista.querySelectorAll('.cl-op'); if (!ops.length) return;
      act = (n + ops.length) % ops.length;
      ops.forEach(function (o, i) { o.classList.toggle('cl-act', i === act); });
      ops[act].scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('focus', pintar);
    input.addEventListener('input', pintar);
    input.addEventListener('blur', function () { setTimeout(cerrar, 120); });
    input.addEventListener('keydown', function (e) {
      if (lista.hidden) { if (e.key === 'ArrowDown') { pintar(); e.preventDefault(); } return; }
      if (e.key === 'ArrowDown') { marcar(act + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { marcar(act - 1); e.preventDefault(); }
      else if (e.key === 'Enter' && act >= 0) { elegir(opciones[act]); e.preventDefault(); }
      else if (e.key === 'Escape') { cerrar(); e.stopPropagation(); }
    });
    // mousedown (no click): se elige antes de que el input pierda el foco
    lista.addEventListener('mousedown', function (e) {
      var b = e.target.closest('.cl-op'); if (!b) return;
      e.preventDefault(); elegir(opciones[Number(b.dataset.i)]);
    });
  }

  var OTRA = '✎ Otra (escribir)…';
  var OBRAS_DEFAULT = ['Particular', 'Ospe', 'Oser', 'Iosper', 'Sancor Salud', 'Sancor Salud (IVA gravado)', 'Sancor Salud (IVA no gravado)', 'Pami', 'Unión Personal', 'Osseg', 'Dasuten', 'Medicus', 'Jerárquicos Salud', 'Ospia', 'Municipal', 'Osalara', 'Ospim', 'Osecac', 'Osuner', 'Osde', 'Poder Judicial', 'Unimédica', 'Osfatlyf', 'Swiss Medical', 'Amebpba', 'Federada Salud', 'Iosfa', 'Osplad'];
  var obras = OBRAS_DEFAULT.slice();
  function attachObra(input) { attach(input, { items: function () { return obras; }, titulo: 'Obras sociales', otra: true }); }
  // La lista real se edita en /admin → Listas desplegables; si no carga, queda la de arriba.
  function cargarObras() {
    try {
      fetch('/api/disponibilidad?modo=listas').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && Array.isArray(d.obrasSociales) && d.obrasSociales.length) obras = d.obrasSociales.filter(Boolean);
      }).catch(function () {});
    } catch (e) {}
  }
  function autoObra() { cargarObras(); document.querySelectorAll('input[data-combo-obra]').forEach(attachObra); }
  function auto() { document.querySelectorAll('input[data-combo-localidad]').forEach(attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { auto(); autoObra(); }); else { auto(); autoObra(); }
  window.ComboLocalidad = { attach: attach };
  window.ComboObraSocial = { attach: attachObra };
})();
