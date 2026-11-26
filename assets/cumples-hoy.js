/* Cartel de cumpleaños en la barra izquierda de /gestion y /pacientes.
   Muestra, durante todo el día, a los pacientes con turno hoy que cumplen años (ficha confirmada por DNI).
   Uso: <div id="cumples-hoy"></div> + <script src="/assets/cumples-hoy.js" defer></script>.
   Usa la misma clave de gestión de la sesión (sessionStorage.gestionKey). */
(function () {
  var TZ = 'America/Argentina/Buenos_Aires';
  var st = document.createElement('style');
  st.textContent =
    '#cumples-hoy:empty{display:none}' +
    '.cumple-card{position:relative;overflow:hidden;margin:14px 0 6px;padding:14px 14px 12px;border-radius:14px;' +
    'background:linear-gradient(135deg,#FFF4D9 0%,#FDE3EC 55%,#E3EEFF 100%);border:1.5px solid #D4A24C;' +
    'box-shadow:0 4px 14px rgba(212,162,76,.25);color:#1E3A5F}' +
    '.cumple-card::before,.cumple-card::after{content:"";position:absolute;width:70px;height:70px;border-radius:50%;opacity:.35;pointer-events:none}' +
    '.cumple-card::before{background:radial-gradient(circle,#E8628C 2px,transparent 3px) 0 0/14px 14px;top:-12px;right:-10px}' +
    '.cumple-card::after{background:radial-gradient(circle,#3E7BD4 2px,transparent 3px) 0 0/16px 16px;bottom:-18px;left:-14px}' +
    '.cumple-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;margin-bottom:8px}' +
    '.cumple-head svg{flex:none}' +
    '.cumple-item{position:relative;background:rgba(255,255,255,.75);border-radius:10px;padding:8px 10px;margin-top:6px;font-size:14px;line-height:1.35}' +
    '.cumple-item b{display:block;font-size:15px}' +
    '.cumple-item span{color:#5b6b80;font-size:13px}';
  document.head.appendChild(st);

  var TORTA = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 1.3 1.4 2.3 0 3.6C10.6 4.3 11 3.3 12 2z" fill="#E8628C"/><rect x="11.2" y="5.5" width="1.6" height="4" rx=".8" fill="#D4A24C"/><rect x="4" y="9.5" width="16" height="5.5" rx="2" fill="#E8628C"/><path d="M4 12.5c1.3 1 2.7 1 4 0s2.7-1 4 0 2.7 1 4 0 2.7-1 4 0" stroke="#fff" stroke-width="1.3" fill="none"/><rect x="3" y="15" width="18" height="6" rx="2" fill="#1E3A5F"/></svg>';

  function hoy() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return p; // aaaa-mm-dd
  }
  function hora(iso) {
    return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var ultimaFecha = '';
  function cargar() {
    var cont = document.getElementById('cumples-hoy');
    var key = sessionStorage.getItem('gestionKey');
    if (!cont || !key) return;
    var fecha = hoy();
    fetch('/api/gestion/turnos-dia?date=' + fecha + '&cumples=1&key=' + encodeURIComponent(key))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) {
        var vistos = {};
        var lista = (Array.isArray(items) ? items : []).filter(function (it) {
          if (!it.cumple || !it.fichaId || vistos[it.fichaId]) return false;
          vistos[it.fichaId] = 1; return true;
        });
        ultimaFecha = fecha;
        if (!lista.length) { cont.innerHTML = ''; return; }
        cont.innerHTML = '<div class="cumple-card" role="status"><div class="cumple-head">' + TORTA +
          (lista.length === 1 ? 'Hoy es su cumpleaños' : 'Hoy cumplen años') + '</div>' +
          lista.map(function (it) {
            var edad = it.cumple.edad ? ' · cumple ' + it.cumple.edad : '';
            return '<div class="cumple-item"><b>' + esc(it.title) + '</b><span>Turno ' + hora(it.start) + edad + '</span></div>';
          }).join('') + '</div>';
      })
      .catch(function () { /* sin cartel si falla: no molesta al resto del panel */ });
  }

  function iniciar() {
    cargar();
    // Se recarga cada 10 minutos (por si se agenda un turno nuevo) y al cambiar de día.
    setInterval(function () { if (hoy() !== ultimaFecha || !document.hidden) cargar(); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && hoy() !== ultimaFecha) cargar(); });
    // Después de iniciar sesión la clave aparece en sessionStorage: reintento corto hasta tenerla.
    var intentos = 0;
    var t = setInterval(function () {
      intentos++;
      if (sessionStorage.getItem('gestionKey') && !ultimaFecha) cargar();
      if (ultimaFecha || intentos > 60) clearInterval(t);
    }, 5000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
