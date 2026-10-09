// Asistente virtual del consultorio: ventana de chat que habla con /api/asistente.
(() => {
  if (window.__asistente) return; window.__asistente = true;
  const WA = 'https://wa.me/5403442457764?text=Hola!%20Quiero%20sacar%20un%20turno';
  const URG = 'https://wa.me/543442403556?text=Hola!%20Tengo%20una%20urgencia%20dental';
  const historial = [];
  let ocupado = false;

  const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt) e.textContent = txt; return e; };

  const btn = el('button', 'asis-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Preguntanos</span>';

  const panel = el('div', 'asis-panel');
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Asistente virtual del consultorio');
  const head = el('div', 'asis-head');
  const tit = el('div'); tit.append(el('strong', '', 'Asistente del consultorio'), el('small', '', 'Asistente virtual con IA'));
  const cerrar = el('button', 'asis-close', '×'); cerrar.type = 'button'; cerrar.setAttribute('aria-label', 'Cerrar el asistente');
  head.append(tit, cerrar);
  const body = el('div', 'asis-body'); body.setAttribute('aria-live', 'polite');
  const nota = el('div', 'asis-note', 'Es un asistente virtual: no reemplaza una consulta. No compartas datos personales ni de salud por acá.');
  const foot = el('form', 'asis-foot');
  const input = el('input', 'asis-input'); input.type = 'text'; input.maxLength = 500; input.placeholder = 'Escribí tu consulta…'; input.setAttribute('aria-label', 'Tu consulta'); input.autocomplete = 'off';
  const enviar = el('button', 'asis-send', 'Enviar'); enviar.type = 'submit';
  foot.append(input, enviar);
  const wa = el('a', 'asis-wa', 'Prefiero hablar por WhatsApp'); wa.href = WA; wa.target = '_blank'; wa.rel = 'noopener';
  panel.append(head, body, foot);

  // Texto seguro: escapa todo y convierte solo links http(s) en <a>.
  function render(contenedor, texto) {
    const re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;
    let ult = 0, m;
    while ((m = re.exec(texto))) {
      if (m.index > ult) contenedor.append(document.createTextNode(texto.slice(ult, m.index)));
      const a = el('a'); a.href = m[0]; a.textContent = m[0].replace(/^https?:\/\//, '').replace(/\?.*$/, '');
      if (!m[0].startsWith(location.origin)) { a.target = '_blank'; a.rel = 'noopener'; }
      contenedor.append(a); ult = m.index + m[0].length;
    }
    if (ult < texto.length) contenedor.append(document.createTextNode(texto.slice(ult)));
  }
  function botonWA(urg) {
    const a = el('a', 'asis-wabtn', urg ? 'Urgencias por WhatsApp' : 'Escribinos por WhatsApp');
    a.href = urg ? URG : WA; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  const bajar = () => { body.scrollTop = body.scrollHeight; };
  function burbuja(rol, texto, boton) {
    let urg = boton === 'urg', quiere = Boolean(boton);
    if (rol !== 'user') {
      if (/\[\[URGENCIAS\]\]/i.test(texto)) { urg = true; quiere = true; }
      if (/\[\[WHATSAPP\]\]/i.test(texto)) quiere = true;
      texto = texto.replace(/\[\[[A-Z]+\]\]/gi, '').replace(/https?:\/\/wa\.me\/\S*/gi, '').replace(/[ \t]+\n/g, '\n').trim();
    }
    const m = el('div', 'asis-msg ' + (rol === 'user' ? 'asis-user' : 'asis-bot')); render(m, texto);
    if (rol !== 'user' && quiere) m.append(el('br'), botonWA(urg));
    body.append(m); bajar(); return m;
  }

  function sugerencias() {
    const box = el('div', 'asis-chips');
    ['Quiero sacar un turno', '¿Qué horarios tienen?', '¿Atienden mi obra social?', 'Tengo dolor de muela', '¿Qué tratamientos hacen?'].forEach((t) => {
      const c = el('button', 'asis-chip', t); c.type = 'button'; c.onclick = () => { box.remove(); preguntar(t); }; box.append(c);
    });
    body.append(box); bajar();
  }

  async function preguntar(texto) {
    if (ocupado) return; texto = texto.trim(); if (!texto) return;
    ocupado = true; enviar.disabled = true;
    burbuja('user', texto); historial.push({ role: 'user', content: texto });
    const typing = el('div', 'asis-typing'); typing.append(el('i'), el('i'), el('i')); body.append(typing); bajar();
    try {
      const r = await fetch('/api/asistente', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: historial.slice(-10) }) });
      const d = await r.json().catch(() => ({}));
      typing.remove();
      if (r.ok && d.reply) { historial.push({ role: 'assistant', content: d.reply }); burbuja('bot', d.reply); }
      else if (r.status === 429) burbuja('bot', 'Estás escribiendo muy rápido. Probá de nuevo en unos minutos o escribinos por WhatsApp.', 'wa');
      else burbuja('bot', 'Ahora no pude responderte. Escribinos por WhatsApp y te contestamos a la brevedad.', 'wa');
    } catch (e) {
      typing.remove(); burbuja('bot', 'Ahora no pude responderte. Escribinos por WhatsApp y te contestamos a la brevedad.', 'wa');
    }
    ocupado = false; enviar.disabled = false; input.focus();
  }

  function abrir() {
    panel.classList.add('open'); btn.style.display = 'none';
    if (!body.childElementCount) { burbuja('bot', '¡Hola! Soy el asistente virtual del consultorio del Dr. Franco Vinzón. Te cuento sobre horarios, tratamientos y obras sociales. Los turnos los coordina Ayelén por WhatsApp. ¿En qué te ayudo?'); sugerencias(); }
    setTimeout(() => input.focus(), 50);
    try { window.va && window.va('event', { name: 'asistente_abierto' }); } catch (e) {}
  }
  function cerrarPanel() { panel.classList.remove('open'); btn.style.display = ''; btn.focus(); }
  btn.onclick = abrir; cerrar.onclick = cerrarPanel;
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarPanel(); });
  foot.onsubmit = (e) => { e.preventDefault(); const t = input.value; input.value = ''; preguntar(t); };

  document.body.append(btn, panel);
})();
