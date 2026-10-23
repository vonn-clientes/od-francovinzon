/* Fecha de nacimiento en tres selectores (día, mes, año) en vez de un texto libre.
   Uso: <input data-fecha-nac> (se engancha solo) o FechaNacimiento.attach(input) para campos creados por JS.
   El <input> original queda oculto y conserva el valor en formato dd/mm/aaaa (lo que ya guarda el sistema),
   así el resto del código sigue leyendo input.value igual que antes. Una fecha incompleta no se guarda. */
(function () {
  var MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var st = document.createElement('style');
  st.textContent = '.fn3{display:grid;grid-template-columns:.85fr 1.6fr 1.05fr;gap:8px}.fn3 select{width:100%;min-width:0;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' fill=\'none\' stroke=\'%231E3A5F\' stroke-width=\'1.8\' stroke-linecap=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;padding-right:28px!important;cursor:pointer}.fn3 select:invalid,.fn3 select.fn-vacio{color:#8A8578}';
  document.head.appendChild(st);

  function opt(v, t, sel) { var o = document.createElement('option'); o.value = v; o.textContent = t; if (sel) o.selected = true; return o; }

  function attach(input) {
    if (!input || input.dataset.fnListo) return;
    input.dataset.fnListo = '1';
    var cs = getComputedStyle(input);
    var wrap = document.createElement('div'); wrap.className = 'fn3';
    var dia = document.createElement('select'), mes = document.createElement('select'), anio = document.createElement('select');
    [dia, mes, anio].forEach(function (s, i) {
      s.setAttribute('aria-label', ['Día de nacimiento', 'Mes de nacimiento', 'Año de nacimiento'][i]);
      ['minHeight', 'border', 'borderRadius', 'paddingTop', 'paddingBottom', 'paddingLeft', 'fontSize', 'fontFamily', 'color', 'backgroundColor'].forEach(function (k) { s.style[k] = cs[k]; });
      s.style.minHeight = cs.height;
    });
    mes.appendChild(opt('', 'Mes'));
    MESES.forEach(function (m, i) { mes.appendChild(opt(String(i + 1).padStart(2, '0'), m)); });
    var actual = new Date().getFullYear();
    anio.appendChild(opt('', 'Año'));
    for (var y = actual; y >= 1920; y--) anio.appendChild(opt(String(y), String(y)));

    function diasDelMes() {
      var m = Number(mes.value), a = Number(anio.value) || 2000;
      return m ? new Date(a, m, 0).getDate() : 31;
    }
    function armarDias(sel) {
      var n = diasDelMes(); dia.innerHTML = ''; dia.appendChild(opt('', 'Día'));
      for (var d = 1; d <= n; d++) dia.appendChild(opt(String(d).padStart(2, '0'), String(d)));
      dia.value = sel && Number(sel) <= n ? String(Number(sel)).padStart(2, '0') : '';
    }
    function pintarVacios() { [dia, mes, anio].forEach(function (s) { s.classList.toggle('fn-vacio', !s.value); }); }
    function sincronizar() {
      var d = dia.value, m = mes.value, a = anio.value, nuevo;
      if (!d && !m && !a) nuevo = '';
      else if (d && m && a) nuevo = d + '/' + m + '/' + a;
      else { input.dataset.fnIncompleta = '1'; pintarVacios(); return; } // incompleta: no se toca el valor guardado
      delete input.dataset.fnIncompleta;
      pintarVacios();
      if (input.value !== nuevo) { input.value = nuevo; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    var p = String(input.value || '').split('/');
    mes.value = p[1] ? String(Number(p[1])).padStart(2, '0') : '';
    if (p[2] && !anio.querySelector('option[value="' + p[2] + '"]') && /^\d{4}$/.test(p[2])) anio.appendChild(opt(p[2], p[2]));
    anio.value = p[2] || '';
    armarDias(p[0]); pintarVacios();
    mes.addEventListener('change', function () { armarDias(dia.value); sincronizar(); });
    anio.addEventListener('change', function () { armarDias(dia.value); sincronizar(); });
    dia.addEventListener('change', sincronizar);
    wrap.append(dia, mes, anio);
    input.style.display = 'none';
    input.parentNode.insertBefore(wrap, input.nextSibling);
  }

  function auto() { document.querySelectorAll('input[data-fecha-nac]').forEach(attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto); else auto();
  window.FechaNacimiento = { attach: attach };
})();
