// Compartido solo por las dos páginas móviles. Nunca agrega la clave a una URL.
(() => {
  let key = '';
  try { key = localStorage.getItem('mobile_key') || ''; } catch { /* almacenamiento bloqueado */ }
  let revision = 0;
  let pendiente = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'mobile-key-dialog';
  dialog.setAttribute('aria-labelledby', 'mobile-key-title');
  dialog.innerHTML = `<form>
    <h2 id="mobile-key-title">Clave de acceso</h2>
    <p id="mobile-key-message">Ingresá la clave del consultorio.</p>
    <label for="mobile-key-input">Clave de acceso</label>
    <input id="mobile-key-input" type="password" autocomplete="current-password" required>
    <div class="mobile-key-actions"><button type="button" id="mobile-key-cancel">Cancelar</button><button type="submit">Guardar y continuar</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('input');
  let resolver;
  function terminar(aceptada) {
    dialog.close();
    input.value = '';
    const resolve = resolver;
    resolver = null;
    pendiente = null;
    resolve?.(aceptada);
  }
  dialog.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input.value) return;
    key = input.value;
    revision += 1;
    try { localStorage.setItem('mobile_key', key); } catch { /* sigue en memoria */ }
    terminar(true);
  });
  dialog.querySelector('#mobile-key-cancel').addEventListener('click', () => terminar(false));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); terminar(false); });
  function pedirClave(rechazada = false) {
    if (pendiente) return pendiente;
    pendiente = new Promise((resolve) => { resolver = resolve; });
    dialog.querySelector('#mobile-key-message').textContent = rechazada
      ? 'La clave falta o no es válida. Ingresala para continuar.'
      : 'Ingresá la clave del consultorio para guardarla en este celular.';
    dialog.showModal();
    input.focus();
    return pendiente;
  }
  document.getElementById('mobile-key-open').addEventListener('click', () => pedirClave());

  window.mobileFetch = async (url, options = {}) => {
    while (true) {
      const enviada = revision;
      const headers = new Headers(options.headers);
      headers.set('x-gestion-key', key);
      // Obliga a validar incluso si el navegador guardó una imagen antes de activar la clave.
      const response = await fetch(url, { ...options, headers, cache: 'no-store' });
      if (response.status !== 401) return response;
      // Varias miniaturas pueden recibir 401 juntas: comparten un único diálogo.
      if (enviada !== revision) continue;
      if (!await pedirClave(true)) throw new Error('Acceso cancelado.');
      // Solo reintenta un 401 (el servidor rechazó antes de ejecutar la acción).
    }
  };

  const imagenes = new Map();
  window.mobileReleaseImage = (img) => {
    const estado = imagenes.get(img);
    if (estado?.url) URL.revokeObjectURL(estado.url);
    imagenes.delete(img);
    img.removeAttribute('src');
  };
  window.mobileLoadImage = async (img, url) => {
    window.mobileReleaseImage(img);
    const estado = {};
    imagenes.set(img, estado);
    try {
      const response = await window.mobileFetch(url);
      if (!response.ok) throw new Error('No se pudo cargar la foto.');
      const blob = await response.blob();
      if (imagenes.get(img) !== estado) return; // se cerró el visor o cambió el paciente
      estado.url = URL.createObjectURL(blob);
      img.src = estado.url;
    } catch {
      if (imagenes.get(img) === estado) {
        window.mobileReleaseImage(img);
        img.alt = 'No se pudo cargar la foto.';
      }
    }
  };
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) for (const img of imagenes.keys()) window.mobileReleaseImage(img);
  });
})();
