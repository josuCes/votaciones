/* ============================================================
   ADEP V2.0 — ADMINISTRACIÓN
   Archivo: admin.js

   Integrado con admin.html rediseñado y estilos.css.
   Mantiene las colecciones existentes:
   filiales, usuarios, juntas, votaciones y votos.

   Funciones:
   - Autenticación y comprobación del rol administrativo.
   - Navegación de seis secciones con carrusel horizontal.
   - Crear, activar y finalizar reuniones.
   - Preparar, ordenar, publicar y cerrar preguntas.
   - Resultados y participación en tiempo real.
   - Gestión de usuarios y estado habilitado/deshabilitado.
   - Gestión de filiales con alta, edición, desactivación y eliminación segura.
   - Historial de reuniones con detalle de preguntas y votos.

   Nota de seguridad:
   El código cliente no sustituye reglas de Firestore ni
   una función de servidor para operaciones privilegiadas.
============================================================ */

(() => {
  "use strict";

  const C = {
    FILIALES: "filiales",
    USUARIOS: "usuarios",
    JUNTAS: "juntas",
    VOTACIONES: "votaciones",
    VOTOS: "votos",
    PARTICIPANTES: "participantesJunta"
  };

  const ESTADO = {
    PREPARADA: "preparada",
    ACTIVA: "activa",
    ABIERTA: "abierta",
    FINALIZADA: "finalizada",
    CANCELADA: "cancelada"
  };

  const DURACION_SEGUNDOS = 60;
  const $ = (id) => document.getElementById(id);

  // Hora del servidor (ver reloj-servidor.js).
  const serverNow = () => (window.ADEPReloj ? window.ADEPReloj.ahora() : Date.now());
  const clockSynced = () => Boolean(window.ADEPReloj && window.ADEPReloj.estaSincronizado());

  const state = {
    usuario: null,
    perfil: null,
    uidVerificado: null,
    uidVerificando: null,

    filiales: [],          // Filiales activas disponibles en formularios.
    todasFiliales: [],     // Incluye las filiales inactivas para su administración.
    editingFilialId: null,
    reuniones: [],
    reunionId: null,
    reunionActual: null,
    preguntas: [],
    votos: [],
    usuarios: [],
    participantes: [],

    stopReuniones: null,
    stopPreguntas: null,
    stopVotos: null,
    stopParticipantes: null,
    tick: null,

    cierresEnProceso: new Set(),
    avisoRelojMostrado: false,
    finalizandoReunion: new Set(),
    configurandoFin: new Set(),
    loadingHistory: false,
    editingUserId: null,
    historyCache: new Map()
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    ensureAdminOverlays();
    installDateTimePickers();
    installCustomSelects();
    bindCommonEvents();
    bindNavigation();
    bindUserManagement();
    bindFilialManagement();
    bindHistory();
    bindCarousel();

    if (typeof firebase === "undefined" || typeof db === "undefined" || typeof auth === "undefined") {
      showMessage("mensajeLoginAdmin", "Firebase no está disponible. Revise firebase-config.js y el orden de los scripts.");
      return;
    }

    auth.onAuthStateChanged(onAuthChanged);
    state.tick = window.setInterval(updateCountdown, 500);
    setActiveSection("seccionCrearReunion", false);
  }

  // ----------------------------------------------------------
  // Utilidades
  // ----------------------------------------------------------

  function database() {
    if (typeof db === "undefined" || !db) throw new Error("Firebase Firestore no está disponible.");
    return db;
  }

  function serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function toTimestamp(date) {
    return firebase.firestore.Timestamp.fromDate(date);
  }

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function clean(value) {
    return String(value ?? "").trim();
  }

  function safeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function isTimestamp(value) {
    return Boolean(value && typeof value.toMillis === "function");
  }

  function asDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    if (value instanceof Date) return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = asDate(value);
    if (!date) return "Sin fecha";
    return new Intl.DateTimeFormat("es-CR", {
      dateStyle: "medium", timeStyle: "short"
    }).format(date);
  }

  function showMessage(id, text, type = "error") {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.hidden = false;
    element.classList.remove("mensaje-error", "mensaje-exito", "mensaje-aviso", "mensaje-animado-admin");
    void element.offsetWidth;
    element.classList.add(type === "success" ? "mensaje-exito" : type === "warning" ? "mensaje-aviso" : "mensaje-error", "mensaje-animado-admin");
  }

  function clearMessage(id) {
    const element = $(id);
    if (!element) return;
    element.textContent = "";
    element.hidden = true;
    element.classList.remove("mensaje-error", "mensaje-exito", "mensaje-aviso");
  }

  function setBusy(button, busy, busyText = "PROCESANDO...") {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalText) button.dataset.originalText = button.textContent.trim();
      button.disabled = true;
      button.textContent = busyText;
    } else {
      button.disabled = false;
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  function explainError(error) {
    const messages = {
      "auth/invalid-email": "El correo electrónico no tiene un formato válido.",
      "auth/invalid-credential": "El correo o la contraseña son incorrectos.",
      "auth/user-not-found": "No existe una cuenta con ese correo.",
      "auth/wrong-password": "La contraseña es incorrecta.",
      "auth/email-already-in-use": "Ese correo ya está registrado en Firebase Authentication.",
      "auth/weak-password": "La contraseña es demasiado débil.",
      "auth/too-many-requests": "Hubo demasiados intentos. Inténtelo más tarde.",
      "auth/network-request-failed": "No se pudo conectar con Firebase Authentication.",
      "permission-denied": "Firebase rechazó la operación. Revise las reglas de Firestore.",
      "unavailable": "Firebase no está disponible en este momento.",
      "failed-precondition": "La operación no cumple una condición requerida por Firebase."
    };
    return messages[error?.code] || error?.message || "Ocurrió un error inesperado.";
  }

  function option(select, value, label) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }

  function getFilialName(data) {
    return clean(data.nombre || data.nombreFilial || data.filial || data.nombreCompleto || "");
  }

  function getMeetingName(data) {
    return clean(data.nombre || data.nombreReunion || data.titulo || "Reunión sin nombre");
  }

  function getQuestionText(data) {
    return clean(data.titulo || data.pregunta || data.textoPregunta || data.tema || "Pregunta sin título");
  }

  function stateLabel(value) {
    const s = normalize(value);
    const labels = {
      preparada: "Preparada", activa: "Activa", abierto: "Votación abierta",
      abierta: "Votación abierta", finalizada: "Finalizada", finalizado: "Finalizada",
      cancelada: "Cancelada", cancelado: "Cancelada"
    };
    return labels[s] || "Sin estado definido";
  }

  function meetingIsFinished(meeting) {
    const s = normalize(meeting?.estado || meeting?.estadoJunta || "");
    return ["finalizada", "finalizado", "cancelada", "cancelado", "cerrada", "cerrado"].includes(s);
  }

  function meetingIsActive(meeting) {
    if (!meeting || meeting.activa === false || meeting.activo === false) return false;
    return normalize(meeting.estado || meeting.estadoJunta || "") === ESTADO.ACTIVA;
  }

  function meetingBelongsToFilial(meeting, filialId, filialName) {
    const values = [meeting.filialId, meeting.filial_id, meeting.idFilial, meeting.filial]
      .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
      .map((v) => String(v).trim());
    return values.some((v) => v === String(filialId) || normalize(v) === normalize(filialName));
  }

  function filialBelongs(user, filialId, filialName) {
    return meetingBelongsToFilial(user, filialId, filialName);
  }

  // ----------------------------------------------------------
  // Controles de interfaz propios: confirmaciones, calendarios y selectores
  // ----------------------------------------------------------

  function ensureAdminOverlays() {
    if (!$('modalConfirmacionAdmin')) {
      const overlay = safeElement('div', 'modal-admin-fondo');
      overlay.id = 'modalConfirmacionAdmin';
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
      const card = safeElement('section', 'modal-admin-tarjeta');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'tituloModalAdmin');
      card.setAttribute('aria-describedby', 'textoModalAdmin');
      const icon = safeElement('div', 'modal-admin-icono', '✓');
      icon.id = 'iconoModalAdmin';
      icon.setAttribute('aria-hidden', 'true');
      const title = safeElement('h2', 'modal-admin-titulo', 'Confirmar acción');
      title.id = 'tituloModalAdmin';
      const message = safeElement('p', 'modal-admin-texto', '¿Desea continuar?');
      message.id = 'textoModalAdmin';
      const detail = safeElement('p', 'modal-admin-detalle', '');
      detail.id = 'detalleModalAdmin';
      const actions = safeElement('div', 'modal-admin-acciones');
      const cancel = safeElement('button', 'boton boton-claro modal-admin-cancelar', 'Cancelar');
      cancel.type = 'button';
      cancel.id = 'cancelarModalAdmin';
      const accept = safeElement('button', 'boton boton-principal modal-admin-aceptar', 'Confirmar');
      accept.type = 'button';
      accept.id = 'aceptarModalAdmin';
      actions.append(cancel, accept);
      const typedBox = safeElement('div', 'modal-admin-texto-confirmar');
      typedBox.id = 'cajaTextoModalAdmin';
      typedBox.hidden = true;
      const typedLabel = safeElement('label', 'modal-admin-texto-etiqueta', '');
      typedLabel.id = 'etiquetaTextoModalAdmin';
      typedLabel.htmlFor = 'entradaTextoModalAdmin';
      const typedInput = document.createElement('input');
      typedInput.type = 'text';
      typedInput.id = 'entradaTextoModalAdmin';
      typedInput.autocomplete = 'off';
      typedInput.spellcheck = false;
      typedBox.append(typedLabel, typedInput);
      card.append(icon, title, message, detail, typedBox, actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    }
    if (!$('contenedorToastAdmin')) {
      const toast = safeElement('div', 'contenedor-toast-admin');
      toast.id = 'contenedorToastAdmin';
      toast.setAttribute('aria-live', 'polite');
      toast.setAttribute('aria-atomic', 'true');
      document.body.appendChild(toast);
    }
  }

  function askAdminConfirmation({ title = 'Confirmar acción', message = '¿Desea continuar?', detail = '', confirmText = 'Confirmar', cancelText = 'Cancelar', tone = 'primary', requireText = '' } = {}) {
    ensureAdminOverlays();
    const overlay = $('modalConfirmacionAdmin');
    const card = overlay.querySelector('.modal-admin-tarjeta');
    const accept = $('aceptarModalAdmin');
    const cancel = $('cancelarModalAdmin');
    const previousFocus = document.activeElement;
    $('tituloModalAdmin').textContent = title;
    $('textoModalAdmin').textContent = message;
    $('detalleModalAdmin').textContent = detail;
    $('detalleModalAdmin').hidden = !detail;
    accept.textContent = confirmText;
    cancel.textContent = cancelText;
    card.dataset.tone = tone;
    $('iconoModalAdmin').textContent = tone === 'danger' ? '!' : tone === 'warning' ? '?' : tone === 'success' ? '✓' : 'i';
    accept.className = `boton modal-admin-aceptar ${tone === 'danger' ? 'boton-peligro' : 'boton-principal'}`;
    const typedBox = $('cajaTextoModalAdmin');
    const typedInput = $('entradaTextoModalAdmin');
    const typedMatches = () => normalize(typedInput.value) === normalize(requireText);
    if (requireText) {
      typedBox.hidden = false;
      $('etiquetaTextoModalAdmin').textContent = `Para confirmar, escriba exactamente: ${requireText}`;
      typedInput.value = '';
      accept.disabled = true;
    } else {
      typedBox.hidden = true;
      accept.disabled = false;
    }
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('admin-modal-abierto');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('admin-modal-abierto');
        accept.removeEventListener('click', onAccept);
        cancel.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKeyDown);
        typedInput.removeEventListener('input', onTyped);
        accept.disabled = false;
        typedBox.hidden = true;
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
        resolve(value);
      };
      const onAccept = () => { if (!requireText || typedMatches()) finish(true); };
      const onTyped = () => { accept.disabled = Boolean(requireText) && !typedMatches(); };
      typedInput.addEventListener('input', onTyped);
      const onCancel = () => finish(false);
      const onBackdrop = (event) => { if (event.target === overlay) finish(false); };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key === 'Tab') {
          const controls = [cancel, accept].filter((item) => !item.disabled);
          if (!controls.length) return;
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
          else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
        }
      };
      accept.addEventListener('click', onAccept);
      cancel.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKeyDown);
      window.requestAnimationFrame(() => (requireText ? typedInput : cancel).focus());
    });
  }

  function showAdminToast(message, type = 'success') {
    ensureAdminOverlays();
    const root = $('contenedorToastAdmin');
    const toast = safeElement('div', `toast-admin toast-admin-${type}`);
    const icon = safeElement('span', 'toast-admin-icono', type === 'error' ? '!' : type === 'warning' ? '!' : '✓');
    icon.setAttribute('aria-hidden', 'true');
    const text = safeElement('p', 'toast-admin-texto', message);
    toast.append(icon, text);
    root.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('toast-admin-saliendo');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      window.setTimeout(() => toast.remove(), 450);
    }, 3800);
  }

  function formatCedulaCR(value) {
    const digits = String(value ?? '').replace(/\D/g, '').slice(0, 9);
    if (!digits) return '';
    if (digits.length <= 1) return digits;
    if (digits.length <= 5) return `${digits.slice(0, 1)}-${digits.slice(1)}`;
    return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5)}`;
  }

  function representativeTypeLabel(value) {
    const labels = {
      participante: 'Participante',
      principal: 'Representante principal',
      suplente: 'Representante suplente',
      no_aplica: ''
    };
    return labels[normalize(value)] || '';
  }

  function validateCustomSelect(id, messageId) {
    const select = $(id);
    if (!select) return true;
    const mustChoose = select.dataset.customRequired === 'true';
    if (!mustChoose || select.value) {
      select.removeAttribute('aria-invalid');
      select.closest('.grupo-campo')?.classList.remove('campo-invalido-admin');
      return true;
    }
    select.setAttribute('aria-invalid', 'true');
    select.closest('.grupo-campo')?.classList.add('campo-invalido-admin');
    showMessage(messageId, 'Seleccione una opción de la lista antes de continuar.');
    const wrapper = select.parentElement?.querySelector('.selector-personalizado');
    wrapper?.querySelector('.selector-personalizado-boton')?.focus();
    wrapper?.classList.add('selector-error');
    return false;
  }

  const customSelectRegistry = new WeakMap();

  function installCustomSelects() {
    document.querySelectorAll('.pagina-admin select').forEach((select) => {
      if (select.dataset.customEnhanced === 'true') return;
      select.dataset.customEnhanced = 'true';
      select.dataset.customRequired = select.required ? 'true' : 'false';
      select.required = false;
      const initialTabIndex = select.getAttribute('tabindex');
      select.classList.add('selector-real-oculto');
      select.setAttribute('aria-hidden', 'true');
      select.tabIndex = -1;

      const wrapper = safeElement('div', 'selector-personalizado');
      const button = safeElement('button', 'selector-personalizado-boton');
      button.type = 'button';
      button.id = `${select.id || 'selector'}Personalizado`;
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', select.labels?.[0]?.textContent?.trim() || 'Seleccione una opción');
      const label = safeElement('span', 'selector-personalizado-valor', 'Seleccione una opción');
      const chevron = safeElement('span', 'selector-personalizado-chevron', '⌄');
      chevron.setAttribute('aria-hidden', 'true');
      button.append(label, chevron);
      const listbox = safeElement('div', 'selector-personalizado-lista');
      listbox.id = `${button.id}Opciones`;
      listbox.setAttribute('role', 'listbox');
      listbox.hidden = true;
      button.setAttribute('aria-controls', listbox.id);
      wrapper.append(button, listbox);
      select.insertAdjacentElement('afterend', wrapper);

      const close = () => {
        listbox.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        wrapper.classList.remove('selector-abierto');
      };
      const open = () => {
        if (select.disabled) return;
        document.querySelectorAll('.selector-personalizado.selector-abierto').forEach((other) => {
          if (other !== wrapper) {
            other.classList.remove('selector-abierto');
            other.querySelector('.selector-personalizado-lista').hidden = true;
            other.querySelector('.selector-personalizado-boton').setAttribute('aria-expanded', 'false');
          }
        });
        refresh();
        listbox.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        wrapper.classList.add('selector-abierto');
      };
      const refresh = () => {
        const selected = [...select.options].find((item) => item.value === select.value);
        label.textContent = selected?.textContent?.trim() || select.options[0]?.textContent?.trim() || 'Seleccione una opción';
        button.disabled = select.disabled;
        wrapper.classList.toggle('selector-deshabilitado', select.disabled);
        listbox.replaceChildren();
        [...select.options].forEach((optionElement) => {
          const opt = safeElement('button', 'selector-personalizado-opcion', optionElement.textContent.trim());
          opt.type = 'button';
          opt.setAttribute('role', 'option');
          opt.setAttribute('aria-selected', optionElement.value === select.value ? 'true' : 'false');
          opt.disabled = optionElement.disabled;
          if (optionElement.value === select.value) opt.classList.add('seleccionada');
          const txt = normalize(optionElement.textContent);
          if (/(activa|activa|en vivo|abierta)/.test(txt) && !/(inactiva|desactivada)/.test(txt)) opt.classList.add('opcion-estado-activo');
          if (/(finalizada|cancelada|inactiva|deshabilitada)/.test(txt)) opt.classList.add('opcion-estado-final');
          opt.addEventListener('click', () => {
            if (opt.disabled) return;
            select.value = optionElement.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            wrapper.classList.remove('selector-error');
            select.closest('.grupo-campo')?.classList.remove('campo-invalido-admin');
            close();
            button.focus();
          });
          listbox.appendChild(opt);
        });
      };
      button.addEventListener('click', () => listbox.hidden ? open() : close());
      button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); open(); listbox.querySelector('button:not(:disabled)')?.focus();
        } else if (event.key === 'Escape') close();
      });
      listbox.addEventListener('keydown', (event) => {
        const choices = [...listbox.querySelectorAll('button:not(:disabled)')];
        const index = choices.indexOf(document.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); choices[Math.min(index + 1, choices.length - 1)]?.focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); choices[Math.max(index - 1, 0)]?.focus(); }
      });
      const linkedLabels = [...document.querySelectorAll(`label[for="${CSS.escape(select.id)}"]`)];
      linkedLabels.forEach((linkedLabel) => linkedLabel.addEventListener('click', (event) => {
        event.preventDefault();
        open();
        button.focus();
      }));
      const observer = new MutationObserver(refresh);
      observer.observe(select, { childList: true, subtree: true, attributes: true });
      const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      try {
        Object.defineProperty(select, 'value', {
          configurable: true,
          enumerable: nativeValueDescriptor?.enumerable ?? true,
          get() { return nativeValueDescriptor.get.call(this); },
          set(value) { nativeValueDescriptor.set.call(this, value); refresh(); }
        });
      } catch (_) { /* Los navegadores que no permitan redefinirlo se sincronizan por eventos. */ }
      customSelectRegistry.set(select, { refresh, close, observer, initialTabIndex });
      select.addEventListener('change', refresh);
      refresh();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.selector-personalizado')) {
        document.querySelectorAll('.selector-personalizado.selector-abierto').forEach((wrapper) => {
          wrapper.classList.remove('selector-abierto');
          const list = wrapper.querySelector('.selector-personalizado-lista');
          const button = wrapper.querySelector('.selector-personalizado-boton');
          if (list) list.hidden = true;
          if (button) button.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }

  function getDateTimeValue(input) {
    return input?.dataset?.isoValue || '';
  }

  function setDateTimeValue(input, isoValue) {
    if (!input) return;
    input.dataset.isoValue = isoValue || '';
    if (!isoValue) {
      input.value = '';
      input.classList.remove('campo-fecha-seleccionado');
    } else {
      const date = new Date(isoValue);
      input.value = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('es-CR', {
        dateStyle: 'medium', timeStyle: 'short'
      }).format(date);
      input.classList.toggle('campo-fecha-seleccionado', Boolean(input.value));
    }
  }

  function clearDateTimeValue(input) {
    setDateTimeValue(input, '');
  }

  function toLocalDateTimeValue(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function installDateTimePickers() {
    ['fechaReunion', 'fechaVotacion'].forEach((id) => {
      const input = $(id);
      if (!input) return;
      input.type = 'text';
      input.readOnly = true;
      input.required = false;
      input.setAttribute('aria-haspopup', 'dialog');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('placeholder', id === 'fechaVotacion' ? 'Opcional · seleccionar fecha y hora' : 'Seleccione fecha y hora');
      input.classList.add('campo-fecha-personalizado');
      input.addEventListener('click', () => openDateTimePicker(input));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDateTimePicker(input); }
      });
      const form = input.form;
      form?.addEventListener('reset', () => window.setTimeout(() => clearDateTimeValue(input), 0));
    });
  }

  function openDateTimePicker(input) {
    let existing = $('modalFechaHoraAdmin');
    if (!existing) {
      existing = safeElement('div', 'modal-fecha-admin-fondo');
      existing.id = 'modalFechaHoraAdmin';
      existing.hidden = true;
      existing.setAttribute('aria-hidden', 'true');
      document.body.appendChild(existing);
    }
    const old = getDateTimeValue(input);
    const now = new Date();
    const parsed = old ? new Date(old) : now;
    const picker = {
      input,
      date: old && !Number.isNaN(parsed.getTime()) ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) : null,
      year: parsed.getFullYear(), month: parsed.getMonth(),
      hour: old && !Number.isNaN(parsed.getTime()) ? parsed.getHours() : now.getHours(),
      minute: old && !Number.isNaN(parsed.getTime()) ? parsed.getMinutes() : Math.round(now.getMinutes() / 5) * 5 % 60
    };

    const render = () => {
      existing.replaceChildren();
      const card = safeElement('section', 'modal-fecha-admin-tarjeta');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'tituloFechaHoraAdmin');
      const top = safeElement('div', 'modal-fecha-admin-cabecera');
      const kicker = safeElement('span', 'modal-fecha-admin-kicker', input.id === 'fechaVotacion' ? 'PROGRAMACIÓN OPCIONAL' : 'FECHA Y HORA');
      const title = safeElement('h2', 'modal-fecha-admin-titulo', input.id === 'fechaVotacion' ? 'Programar pregunta' : 'Programar reunión');
      title.id = 'tituloFechaHoraAdmin';
      const close = safeElement('button', 'modal-fecha-admin-cerrar', '×');
      close.type = 'button'; close.setAttribute('aria-label', 'Cerrar selector de fecha y hora');
      close.addEventListener('click', dismiss);
      top.append(kicker, title, close);
      card.appendChild(top);

      const body = safeElement('div', 'modal-fecha-admin-contenido');
      const calendar = safeElement('div', 'calendario-admin');
      const monthBar = safeElement('div', 'calendario-admin-cabecera');
      const prev = safeElement('button', 'calendario-admin-nav', '‹');
      prev.type = 'button'; prev.setAttribute('aria-label', 'Mes anterior');
      prev.addEventListener('click', () => { picker.month--; if (picker.month < 0) { picker.month = 11; picker.year--; } render(); });
      const monthName = safeElement('strong', 'calendario-admin-mes', new Intl.DateTimeFormat('es-CR', { month: 'long', year: 'numeric' }).format(new Date(picker.year, picker.month, 1)));
      const next = safeElement('button', 'calendario-admin-nav', '›');
      next.type = 'button'; next.setAttribute('aria-label', 'Mes siguiente');
      next.addEventListener('click', () => { picker.month++; if (picker.month > 11) { picker.month = 0; picker.year++; } render(); });
      monthBar.append(prev, monthName, next); calendar.appendChild(monthBar);
      const weekdays = safeElement('div', 'calendario-admin-dias-semana');
      ['L', 'M', 'X', 'J', 'V', 'S', 'D'].forEach((day) => weekdays.appendChild(safeElement('span', '', day)));
      calendar.appendChild(weekdays);
      const days = safeElement('div', 'calendario-admin-grid');
      const first = new Date(picker.year, picker.month, 1);
      const startDay = (first.getDay() + 6) % 7;
      const numberDays = new Date(picker.year, picker.month + 1, 0).getDate();
      for (let i = 0; i < startDay; i++) days.appendChild(safeElement('span', 'calendario-admin-espacio', ''));
      for (let day = 1; day <= numberDays; day++) {
        const button = safeElement('button', 'calendario-admin-dia', String(day));
        button.type = 'button';
        const isSelected = picker.date && picker.date.getFullYear() === picker.year && picker.date.getMonth() === picker.month && picker.date.getDate() === day;
        if (isSelected) button.classList.add('seleccionado');
        const today = new Date();
        if (today.getFullYear() === picker.year && today.getMonth() === picker.month && today.getDate() === day) button.classList.add('hoy');
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        button.addEventListener('click', () => { picker.date = new Date(picker.year, picker.month, day); render(); });
        days.appendChild(button);
      }
      calendar.appendChild(days);
      const selectedLine = safeElement('p', 'calendario-admin-seleccion', picker.date ? new Intl.DateTimeFormat('es-CR', { dateStyle: 'full' }).format(picker.date) : 'Seleccione un día en el calendario.');
      calendar.appendChild(selectedLine);
      body.appendChild(calendar);

      const time = safeElement('div', 'selector-hora-admin');
      time.appendChild(safeElement('span', 'modal-fecha-admin-kicker', 'HORA')); 
      time.appendChild(safeElement('p', 'selector-hora-admin-ayuda', 'Use los botones para ajustar la hora.'));
      const controls = safeElement('div', 'selector-hora-admin-controles');
      const makeStepper = (label, key, min, max, step = 1) => {
        const group = safeElement('div', 'selector-hora-admin-grupo');
        group.appendChild(safeElement('span', 'selector-hora-admin-label', label));
        const minus = safeElement('button', 'selector-hora-admin-cambio', '−'); minus.type = 'button'; minus.setAttribute('aria-label', `Reducir ${label.toLowerCase()}`);
        const value = safeElement('strong', 'selector-hora-admin-valor', String(picker[key]).padStart(2, '0'));
        const plus = safeElement('button', 'selector-hora-admin-cambio', '+'); plus.type = 'button'; plus.setAttribute('aria-label', `Aumentar ${label.toLowerCase()}`);
        minus.addEventListener('click', () => { picker[key] = picker[key] - step; if (picker[key] < min) picker[key] = max; render(); });
        plus.addEventListener('click', () => { picker[key] = picker[key] + step; if (picker[key] > max) picker[key] = min; render(); });
        group.append(minus, value, plus); return group;
      };
      controls.append(makeStepper('Hora', 'hour', 0, 23));
      controls.appendChild(safeElement('span', 'selector-hora-admin-dos-puntos', ':'));
      controls.append(makeStepper('Minutos', 'minute', 0, 55, 5));
      time.appendChild(controls);
      body.appendChild(time);
      card.appendChild(body);

      const actions = safeElement('div', 'modal-fecha-admin-acciones');
      if (input.id === 'fechaVotacion') {
        const clear = safeElement('button', 'boton boton-claro', 'Dejar sin programar');
        clear.type = 'button';
        clear.addEventListener('click', () => { clearDateTimeValue(input); dismiss(); });
        actions.appendChild(clear);
      }
      const cancel = safeElement('button', 'boton boton-claro', 'Cancelar'); cancel.type = 'button'; cancel.addEventListener('click', dismiss);
      const save = safeElement('button', 'boton boton-principal', 'Usar esta fecha y hora'); save.type = 'button';
      save.addEventListener('click', () => {
        if (!picker.date) {
          calendar.classList.add('calendario-admin-error');
          selectedLine.textContent = 'Seleccione un día para continuar.';
          return;
        }
        const date = new Date(picker.date.getFullYear(), picker.date.getMonth(), picker.date.getDate(), picker.hour, picker.minute, 0, 0);
        setDateTimeValue(input, toLocalDateTimeValue(date));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        dismiss();
      });
      actions.append(cancel, save);
      card.appendChild(actions);
      existing.appendChild(card);
      existing.hidden = false;
      existing.setAttribute('aria-hidden', 'false');
      document.body.classList.add('admin-modal-abierto');
      window.requestAnimationFrame(() => close.focus());
    };
    const dismiss = () => {
      existing.hidden = true;
      existing.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('admin-modal-abierto');
      input.focus({ preventScroll: true });
    };
    existing.onclick = (event) => { if (event.target === existing) dismiss(); };
    existing.onkeydown = (event) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    render();
  }

  // ----------------------------------------------------------
  // Navegación de seis secciones
  // ----------------------------------------------------------

  function bindNavigation() {
    document.querySelectorAll(".tarjeta-navegacion[data-seccion]").forEach((button) => {
      button.addEventListener("click", () => setActiveSection(button.dataset.seccion, true));
    });
  }

  function setActiveSection(sectionId, scrollCard) {
    const sectionIds = [
      "seccionCrearReunion",
      "seccionAdministrarReunion",
      "seccionReunionActiva",
      "seccionGestionarUsuarios",
      "seccionGestionarFiliales",
      "seccionHistorial"
    ];

    sectionIds.forEach((id) => {
      const section = $(id);
      if (section) {
        section.hidden = id !== sectionId;
        section.classList.toggle("activa", id === sectionId);
      }
    });

    // La bienvenida ilustrada aparece en la vista inicial de creación;
    // las demás secciones ganan espacio y muestran su herramienta directamente.
    const hero = document.querySelector(".saludo-admin");
    if (hero) hero.hidden = sectionId !== "seccionCrearReunion";

    document.querySelectorAll(".tarjeta-navegacion[data-seccion]").forEach((button) => {
      const active = button.dataset.seccion === sectionId;
      button.classList.toggle("activa", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      if (active && scrollCard) button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });

    if (sectionId === "seccionGestionarUsuarios") loadUsers();
    if (sectionId === "seccionGestionarFiliales") {
      loadFiliales().catch((error) => {
        console.error("Error al actualizar la lista de filiales:", error);
        showMessage("mensajeFilial", "No fue posible cargar las filiales. " + explainError(error));
      });
    }
    if (sectionId === "seccionHistorial") renderHistory();
    if (sectionId === "seccionReunionActiva") syncActiveMeetingSelector();
    updateCarouselButtons();
  }

  function bindCarousel() {
    const carousel = $("carruselNavegacion");
    $("btnCarruselIzquierda")?.addEventListener("click", () => {
      if (!carousel) return;
      const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
      if (carousel.scrollLeft <= 2) {
        carousel.scrollTo({ left: max, behavior: "smooth" });
      } else {
        carousel.scrollBy({ left: -Math.max(240, carousel.clientWidth * 0.7), behavior: "smooth" });
      }
    });
    $("btnCarruselDerecha")?.addEventListener("click", () => {
      if (!carousel) return;
      const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
      if (carousel.scrollLeft >= max - 2) {
        carousel.scrollTo({ left: 0, behavior: "smooth" });
      } else {
        carousel.scrollBy({ left: Math.max(240, carousel.clientWidth * 0.7), behavior: "smooth" });
      }
    });
    if (carousel) {
      carousel.addEventListener("scroll", updateCarouselButtons, { passive: true });
      window.addEventListener("resize", updateCarouselButtons);
      carousel.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
          carousel.scrollTo({ left: carousel.scrollLeft >= max - 2 ? 0 : Math.min(max, carousel.scrollLeft + 220), behavior: "smooth" });
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
          carousel.scrollTo({ left: carousel.scrollLeft <= 2 ? max : Math.max(0, carousel.scrollLeft - 220), behavior: "smooth" });
        }
      });
    }
    updateCarouselButtons();
  }

  function updateCarouselButtons() {
    const carousel = $("carruselNavegacion");
    const left = $("btnCarruselIzquierda");
    const right = $("btnCarruselDerecha");
    if (!carousel || !left || !right) return;
    const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
    // Carrusel circular: ambas flechas siguen disponibles en los extremos.
    left.disabled = max <= 2;
    right.disabled = max <= 2;
    left.hidden = max <= 2;
    right.hidden = max <= 2;
  }

  // ----------------------------------------------------------
  // Eventos generales y autenticación
  // ----------------------------------------------------------

  function bindCommonEvents() {
    $("botonVolverInicio")?.addEventListener("click", async (event) => {
      event.preventDefault();
      const link = event.currentTarget;
      const accepted = await askAdminConfirmation({
        title: "Volver al inicio",
        message: "¿Está seguro de que desea salir del panel administrativo?",
        detail: "Los cambios que ya guardó se conservarán.",
        confirmText: "Volver al inicio",
        tone: "warning"
      });
      if (accepted) window.location.assign(link.href);
    });
    $("formLoginAdmin")?.addEventListener("submit", signInAdmin);
    $("btnCerrarSesion")?.addEventListener("click", signOutAdmin);
    $("formCrearReunion")?.addEventListener("submit", createMeeting);
    $("reunionSeleccionada")?.addEventListener("change", (e) => selectMeeting(e.target.value));
    $("reunionActivaSeleccionada")?.addEventListener("change", (e) => {
      if (e.target.value && e.target.value !== state.reunionId) selectMeeting(e.target.value);
    });
    $("btnActivarReunion")?.addEventListener("click", activateMeeting);
    $("btnCerrarReunion")?.addEventListener("click", finishMeeting);
    $("btnCancelarReunion")?.addEventListener("click", cancelMeeting);
    $("btnEliminarReunion")?.addEventListener("click", () => deleteMeeting(state.reunionId));
    $("formCrearPregunta")?.addEventListener("submit", createQuestion);
    $("preguntaSeleccionada")?.addEventListener("change", () => { renderLiveControls(); renderResults(); renderParticipation(); });
    $("btnPublicarPregunta")?.addEventListener("click", publishQuestion);
    $("btnCerrarVotacion")?.addEventListener("click", () => closeCurrentVote(false));
  }

  async function signInAdmin(event) {
    event.preventDefault();
    clearMessage("mensajeLoginAdmin");
    const email = clean($("correoAdmin")?.value);
    const password = $("contrasenaAdmin")?.value || "";
    if (!email || !password) {
      showMessage("mensajeLoginAdmin", "Ingrese el correo y la contraseña.");
      return;
    }
    const button = $("btnLoginAdmin");
    setBusy(button, true, "VERIFICANDO...");
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch (error) {
      console.error("Error de inicio de sesión:", error);
      showMessage("mensajeLoginAdmin", explainError(error));
    } finally {
      setBusy(button, false);
    }
  }

  async function findUserProfile(user) {
    const dbx = database();
    const direct = await dbx.collection(C.USUARIOS).doc(user.uid).get();
    if (direct.exists) return { id: direct.id, data: direct.data() };
    if (user.email) {
      for (const field of ["correo", "email", "correoElectronico"]) {
        const result = await dbx.collection(C.USUARIOS).where(field, "==", user.email).limit(1).get();
        if (!result.empty) {
          const doc = result.docs[0];
          return { id: doc.id, data: doc.data() };
        }
      }
    }
    return null;
  }

  function isAdminProfile(profile) {
    if (!profile?.data) return false;
    const data = profile.data;
    const role = normalize(data.rol || data.tipoUsuario || data.tipo || data.role || "");
    const roles = Array.isArray(data.roles) ? data.roles.map(normalize) : [];
    const permitted = ["admin", "administrador"].includes(role) || roles.includes("admin") || roles.includes("administrador") || data.esAdministrador === true || data.isAdmin === true || data.administrador === true;
    const status = normalize(data.estado || "");
    const disabled = data.activo === false || data.activa === false || ["inactivo", "inactiva", "deshabilitado", "deshabilitada", "suspendido", "suspendida"].includes(status);
    return permitted && !disabled;
  }

  async function onAuthChanged(user) {
    if (!user) {
      state.usuario = null;
      state.perfil = null;
      state.uidVerificado = null;
      state.uidVerificando = null;
      clearAdminData();
      if ($("panelLoginAdmin")) $("panelLoginAdmin").hidden = false;
      if ($("panelAdmin")) $("panelAdmin").hidden = true;
      return;
    }

    if (state.uidVerificado === user.uid || state.uidVerificando === user.uid) return;
    state.uidVerificando = user.uid;

    try {
      const token = await user.getIdTokenResult();
      const tokenAdmin = token.claims.admin === true || token.claims.administrador === true;
      let profile = null;
      try {
        profile = await findUserProfile(user);
      } catch (profileError) {
        if (!tokenAdmin) throw profileError;
      }
      if (!tokenAdmin && !isAdminProfile(profile)) {
        state.uidVerificando = null;
        await auth.signOut();
        showMessage("mensajeLoginAdmin", "Esta cuenta no tiene permisos administrativos. Revise su documento en la colección usuarios.");
        return;
      }

      state.usuario = user;
      state.perfil = profile;
      state.uidVerificado = user.uid;
      state.uidVerificando = null;
      $("panelLoginAdmin").hidden = true;
      $("panelAdmin").hidden = false;
      const name = profile?.data?.nombreCompleto || profile?.data?.nombre || user.displayName || user.email || "Administrador";
      $("nombreAdministrador").textContent = `Sesión: ${name}`;

      await loadFiliales();
      await loadUsers();
      subscribeMeetings();
    } catch (error) {
      console.error("Error al verificar permisos:", error);
      state.uidVerificando = null;
      showMessage("mensajeLoginAdmin", "No fue posible comprobar los permisos. " + explainError(error));
      await auth.signOut();
    }
  }

  async function signOutAdmin() {
    const accepted = await askAdminConfirmation({
      title: "Cerrar sesión",
      message: "¿Desea cerrar la sesión administrativa?",
      detail: "Tendrá que volver a iniciar sesión para administrar las reuniones.",
      confirmText: "Cerrar sesión",
      tone: "warning"
    });
    if (!accepted) return;
    try {
      await auth.signOut();
    } catch (error) {
      showMessage("mensajeLoginAdmin", "No fue posible cerrar la sesión. " + explainError(error));
      showAdminToast("No fue posible cerrar la sesión.", "error");
    }
  }

  function clearAdminData() {
    if (state.stopReuniones) state.stopReuniones();
    if (state.stopPreguntas) state.stopPreguntas();
    if (state.stopVotos) state.stopVotos();
    if (state.stopParticipantes) state.stopParticipantes();
    state.stopReuniones = null;
    state.stopPreguntas = null;
    state.stopVotos = null;
    state.stopParticipantes = null;
    state.reuniones = [];
    state.preguntas = [];
    state.votos = [];
    state.usuarios = [];
    state.participantes = [];
    state.filiales = [];
    state.todasFiliales = [];
    state.editingFilialId = null;
    state.reunionId = null;
    state.reunionActual = null;
    state.historyCache.clear();
    ["filialReunion", "filialUsuarioNuevo", "reunionSeleccionada", "reunionActivaSeleccionada", "preguntaSeleccionada"].forEach((id) => {
      if ($(id)) $(id).replaceChildren();
    });
    ["listaPreguntas", "panelResultados", "panelParticipacion", "listaUsuarios", "listaHistorial", "listaFiliales"].forEach((id) => {
      if ($(id)) $(id).replaceChildren();
    });
    renderMeetingDetails();
    renderQuestionList();
    renderLiveControls();
    renderResults();
    renderParticipation();
  }

  // ----------------------------------------------------------
  // Filiales
  // ----------------------------------------------------------

  async function loadFiliales() {
    const previousValues = new Map();
    ["filialReunion", "filialUsuarioNuevo"].forEach((id) => {
      const select = $(id);
      if (select) previousValues.set(id, select.value);
    });

    const snap = await database().collection(C.FILIALES).get();
    state.todasFiliales = snap.docs.map((doc) => ({
      id: doc.id,
      data: doc.data(),
      name: getFilialName(doc.data())
    }))
      .filter((f) => Boolean(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));

    state.filiales = state.todasFiliales.filter((f) => filialIsEnabled(f.data));

    ["filialReunion", "filialUsuarioNuevo"].forEach((id) => {
      const select = $(id);
      if (!select) return;
      select.replaceChildren();
      option(select, "", state.filiales.length ? "Seleccione una filial" : "No hay filiales disponibles");
      state.filiales.forEach((f) => option(select, f.id, f.name));

      const prior = previousValues.get(id);
      if (prior && state.filiales.some((f) => f.id === prior)) {
        select.value = prior;
      }
      select.disabled = state.filiales.length === 0;
    });

    renderFilialList();
  }

  function filialIsEnabled(data) {
    if (data?.activo === false || data?.activa === false) return false;
    const status = normalize(data?.estado || "");
    return !["inactiva", "inactivo", "deshabilitada", "deshabilitado", "eliminada", "eliminado"].includes(status);
  }

  // ----------------------------------------------------------
  // Reuniones: crear, escuchar, seleccionar, activar/finalizar
  // ----------------------------------------------------------

  async function createMeeting(event) {
    event.preventDefault();
    clearMessage("mensajeReunion");
    const name = clean($("nombreReunion")?.value);
    const filialId = $("filialReunion")?.value;
    const pin = clean($("pinNuevaReunion")?.value);
    const dateText = getDateTimeValue($("fechaReunion"));
    const date = dateText ? new Date(dateText) : new Date(NaN);

    if (!name || !filialId || !/^\d{4}$/.test(pin)) {
      showMessage("mensajeReunion", "Complete el nombre, seleccione una filial y escriba un PIN de cuatro dígitos.");
      return;
    }
    if (!validateCustomSelect("filialReunion", "mensajeReunion")) return;
    if (!dateText || Number.isNaN(date.getTime())) {
      showMessage("mensajeReunion", "Seleccione una fecha y hora válidas.");
      return;
    }
    const filial = state.filiales.find((f) => f.id === filialId);
    if (!filial) {
      showMessage("mensajeReunion", "La filial seleccionada no está disponible.");
      return;
    }

    setBusy($("btnCrearReunion"), true, "CREANDO...");
    try {
      const pinResults = await database().collection(C.JUNTAS).where("pin", "==", pin).get();
      const duplicate = pinResults.docs.some((doc) => {
        const data = doc.data();
        return !meetingIsFinished(data) && meetingBelongsToFilial(data, filialId, filial.name);
      });
      if (duplicate) {
        showMessage("mensajeReunion", "Ese PIN ya está asignado a una reunión no finalizada de esta filial.");
        return;
      }

      const ref = await database().collection(C.JUNTAS).add({
        nombre: name,
        nombreReunion: name,
        filialId,
        filialNombre: filial.name,
        pin,
        fechaReunion: toTimestamp(date),
        estado: ESTADO.PREPARADA,
        activa: false,
        votacionActivaId: null,
        creadaEn: serverTimestamp(),
        creadaPor: state.usuario.uid,
        actualizadaEn: serverTimestamp()
      });

      $("formCrearReunion").reset();
      clearDateTimeValue($("fechaReunion"));
      showMessage("mensajeReunion", "La reunión se creó. Aún no está activa.", "success");
      $("reunionSeleccionada").value = ref.id;
      $("reunionActivaSeleccionada").value = ref.id;
      selectMeeting(ref.id);
      setActiveSection("seccionAdministrarReunion", true);
    } catch (error) {
      console.error("Error al crear reunión:", error);
      showMessage("mensajeReunion", "No se pudo crear la reunión. " + explainError(error));
    } finally {
      setBusy($("btnCrearReunion"), false);
    }
  }

  function subscribeMeetings() {
    if (state.stopReuniones) state.stopReuniones();
    state.stopReuniones = database().collection(C.JUNTAS).onSnapshot((snap) => {
      state.reuniones = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      sortMeetings();
      renderMeetingSelectors();
      renderHistory();

      let preferred = state.reunionId;
      if (!preferred || !state.reuniones.some((m) => m.id === preferred)) preferred = chooseInitialMeeting();
      if (preferred && preferred !== state.reunionId) selectMeeting(preferred);
      else {
        state.reunionActual = state.reuniones.find((m) => m.id === state.reunionId) || null;
        renderMeetingDetails();
        renderQuestionList();
        renderLiveControls();
        renderResults();
        renderParticipation();
      }
    }, (error) => {
      console.error("Error escuchando reuniones:", error);
      showMessage("mensajeReunion", "No se pudieron cargar las reuniones. " + explainError(error));
    });
  }

  function sortMeetings() {
    const createdTime = (meeting) =>
      asDate(meeting.creadaEn || meeting.createdAt || meeting.fechaCreacion || meeting.fechaReunion)?.getTime() || 0;
    state.reuniones.sort((a, b) => {
      // 1) Reuniones activas siempre arriba; 2) preparadas; 3) históricas.
      const rank = (meeting) => meetingIsActive(meeting) ? 0 : meetingIsFinished(meeting) ? 2 : 1;
      const delta = rank(a) - rank(b);
      if (delta) return delta;
      // Dentro de cada grupo, la más recientemente creada aparece primero.
      return createdTime(b) - createdTime(a);
    });
  }

  function chooseInitialMeeting() {
    return state.reuniones.find(meetingIsActive)?.id || state.reuniones.find((m) => !meetingIsFinished(m))?.id || state.reuniones[0]?.id || "";
  }

  function renderMeetingSelectors() {
    const selected = state.reunionId;
    ["reunionSeleccionada", "reunionActivaSeleccionada"].forEach((id) => {
      const select = $(id);
      if (!select) return;
      select.replaceChildren();
      option(select, "", state.reuniones.length ? "Seleccione una reunión" : "No hay reuniones registradas");
      state.reuniones.forEach((m) => {
        const name = getMeetingName(m);
        const filial = m.filialNombre || m.filial || "Sin filial";
        option(select, m.id, `${name} — ${filial} — ${formatDate(m.fechaReunion)} (${stateLabel(m.estado)})`);
      });
      select.value = selected || "";
    });
  }

  function selectMeeting(meetingId) {
    if (state.stopPreguntas) state.stopPreguntas();
    if (state.stopVotos) state.stopVotos();
    if (state.stopParticipantes) state.stopParticipantes();
    state.stopPreguntas = null;
    state.stopVotos = null;
    state.stopParticipantes = null;
    state.preguntas = [];
    state.votos = [];
    state.participantes = [];
    state.reunionId = meetingId || null;
    state.reunionActual = state.reuniones.find((m) => m.id === meetingId) || null;

    ["reunionSeleccionada", "reunionActivaSeleccionada"].forEach((id) => {
      if ($(id)) $(id).value = state.reunionId || "";
    });

    if (state.reunionId) {
      subscribeQuestions();
      subscribeVotes();
      subscribeParticipants();
    }
    renderMeetingDetails();
    renderQuestionList();
    renderLiveControls();
    renderResults();
    renderParticipation();
  }

  function renderMeetingDetails() {
    const meeting = state.reunionActual;
    if ($("detalleReunion")) $("detalleReunion").hidden = !meeting;
    if ($("sinReunionSeleccionada")) $("sinReunionSeleccionada").hidden = Boolean(meeting);
    if (!meeting) {
      if ($("nombreReunionActual")) $("nombreReunionActual").textContent = "Reunión";
      if ($("estadoReunion")) $("estadoReunion").textContent = "Sin reunión";
      if ($("filialActual")) $("filialActual").textContent = "—";
      if ($("fechaActual")) $("fechaActual").textContent = "—";
      if ($("btnActivarReunion")) $("btnActivarReunion").disabled = true;
      if ($("btnCerrarReunion")) $("btnCerrarReunion").disabled = true;
      if ($("btnCancelarReunion")) $("btnCancelarReunion").disabled = true;
      if ($("btnEliminarReunion")) $("btnEliminarReunion").disabled = true;
      if ($("btnGuardarPregunta")) $("btnGuardarPregunta").disabled = true;
      return;
    }
    $("nombreReunionActual").textContent = getMeetingName(meeting);
    $("estadoReunion").textContent = stateLabel(meeting.estado);
    $("estadoReunion").className = "etiqueta-estado " + (meetingIsActive(meeting) ? "estado-positivo" : meetingIsFinished(meeting) ? "estado-neutral" : "estado-pendiente");
    $("filialActual").textContent = meeting.filialNombre || meeting.filial || "Sin filial";
    $("fechaActual").textContent = formatDate(meeting.fechaReunion);
    $("btnActivarReunion").disabled = meetingIsActive(meeting) || meetingIsFinished(meeting);
    $("btnActivarReunion").textContent = meetingIsActive(meeting) ? "Reunión activa" : "Activar reunión";
    $("btnCerrarReunion").disabled = !meetingIsActive(meeting);
    $("btnCancelarReunion").disabled = meetingIsFinished(meeting);
    if ($("btnEliminarReunion")) $("btnEliminarReunion").disabled = meetingIsActive(meeting);
    $("btnGuardarPregunta").disabled = meetingIsFinished(meeting);
  }

  async function activateMeeting() {
    const meeting = state.reunionActual;
    if (!meeting || !state.reunionId || meetingIsFinished(meeting)) return;
    if (meetingIsActive(meeting)) return;
    const accepted = await askAdminConfirmation({
      title: "Activar reunión",
      message: "¿Desea activar esta reunión?",
      detail: "Los participantes podrán ingresar usando el PIN de esta reunión.",
      confirmText: "Sí, activar reunión",
      tone: "success"
    });
    if (!accepted) return;
    setBusy($("btnActivarReunion"), true, "ACTIVANDO...");
    clearMessage("mensajeEstadoReunion");
    try {
      await database().collection(C.JUNTAS).doc(state.reunionId).update({
        estado: ESTADO.ACTIVA,
        activa: true,
        activadaEn: serverTimestamp(),
        activadaPor: state.usuario.uid,
        actualizadaEn: serverTimestamp()
      });
      showMessage("mensajeEstadoReunion", "La reunión está activa. Los participantes pueden ingresar.", "success");
      setActiveSection("seccionReunionActiva", true);
      showAdminToast("La reunión está activa y lista para recibir participantes.", "success");
    } catch (error) {
      console.error("Error activando reunión:", error);
      showMessage("mensajeEstadoReunion", "No se pudo activar la reunión. " + explainError(error));
    } finally {
      setBusy($("btnActivarReunion"), false);
      renderMeetingDetails();
    }
  }

  function meetingHasOpenVote(meetingId = state.reunionId) {
    const meeting = state.reuniones.find((item) => item.id === meetingId) || state.reunionActual;
    return Boolean(meeting?.votacionActivaId) || state.preguntas.some((question) =>
      question.juntaId === meetingId && normalize(question.estado) === ESTADO.ABIERTA
    );
  }

  async function finishMeeting() {
    const meetingId = state.reunionId;
    const meeting = state.reunionActual;
    if (!meetingId || !meeting || !meetingIsActive(meeting)) return;
    if (meetingHasOpenVote(meetingId)) {
      showMessage("mensajeEstadoReunion", "No puede finalizar la reunión mientras haya una votación abierta. Cierre primero la votación en la sección «Reunión activa».", "warning");
      return;
    }
    const accepted = await askAdminConfirmation({
      title: "Finalizar reunión",
      message: "¿Desea finalizar esta reunión?",
      detail: "La reunión quedará guardada en el historial. No podrá reabrirse desde este panel.",
      confirmText: "Finalizar reunión",
      tone: "danger"
    });
    if (!accepted) return;
    setBusy($("btnCerrarReunion"), true, "FINALIZANDO...");
    try {
      const dbx = database();
      const meetingRef = dbx.collection(C.JUNTAS).doc(meetingId);
      await dbx.runTransaction(async (tx) => {
        const meetingDoc = await tx.get(meetingRef);
        if (!meetingDoc.exists) throw new Error("La reunión ya no existe.");
        const data = meetingDoc.data();
        if (data.votacionActivaId) {
          throw new Error("La reunión tiene una votación abierta. Cierre la votación antes de finalizarla.");
        }
        tx.update(meetingRef, {
          estado: ESTADO.FINALIZADA,
          activa: false,
          votacionActivaId: null,
          finalizadaEn: serverTimestamp(),
          finalizadaPor: state.usuario.uid,
          actualizadaEn: serverTimestamp()
        });
      });
      showMessage("mensajeEstadoReunion", "La reunión terminó y ya figura en el historial.", "success");
      renderHistory();
    } catch (error) {
      console.error("Error finalizando reunión:", error);
      showMessage("mensajeEstadoReunion", "No se pudo finalizar la reunión. " + explainError(error));
    } finally {
      setBusy($("btnCerrarReunion"), false);
      renderMeetingDetails();
    }
  }

  async function cancelMeeting() {
    const meetingId = state.reunionId;
    const meeting = state.reunionActual;
    if (!meetingId || !meeting || meetingIsFinished(meeting)) return;
    if (meetingHasOpenVote(meetingId)) {
      showMessage("mensajeEstadoReunion", "No puede cancelar la reunión mientras haya una votación abierta. Cierre primero la votación en la sección «Reunión activa».", "warning");
      return;
    }
    const accepted = await askAdminConfirmation({
      title: "Cancelar reunión",
      message: "¿Desea cancelar esta reunión?",
      detail: "La reunión quedará registrada como cancelada en el historial.",
      confirmText: "Sí, cancelar reunión",
      tone: "danger"
    });
    if (!accepted) return;
    setBusy($("btnCancelarReunion"), true, "CANCELANDO...");
    try {
      const dbx = database();
      const meetingRef = dbx.collection(C.JUNTAS).doc(meetingId);
      await dbx.runTransaction(async (tx) => {
        const meetingDoc = await tx.get(meetingRef);
        if (!meetingDoc.exists) throw new Error("La reunión ya no existe.");
        const data = meetingDoc.data();
        if (data.votacionActivaId) {
          throw new Error("La reunión tiene una votación abierta. Cierre la votación antes de cancelarla.");
        }
        tx.update(meetingRef, {
          estado: ESTADO.CANCELADA,
          activa: false,
          votacionActivaId: null,
          canceladaEn: serverTimestamp(),
          canceladaPor: state.usuario.uid,
          actualizadaEn: serverTimestamp()
        });
      });
      showMessage("mensajeEstadoReunion", "La reunión se canceló y quedó registrada en el historial.", "success");
      renderHistory();
    } catch (error) {
      console.error("Error cancelando reunión:", error);
      showMessage("mensajeEstadoReunion", "No se pudo cancelar la reunión. " + explainError(error));
    } finally {
      setBusy($("btnCancelarReunion"), false);
      renderMeetingDetails();
    }
  }

  async function deleteMeeting(meetingId) {
    const meeting = state.reuniones.find((m) => m.id === meetingId);
    if (!meeting) return;
    const name = getMeetingName(meeting);

    if (meetingIsActive(meeting) || meeting.votacionActivaId) {
      const message = "No se puede eliminar una reunión activa. Finalícela o cancélela primero.";
      showMessage("mensajeEstadoReunion", message, "warning");
      showAdminToast(message, "warning");
      return;
    }

    let counts;
    try {
      const [questions, votes, attendance] = await Promise.all([
        database().collection(C.VOTACIONES).where("juntaId", "==", meetingId).get(),
        database().collection(C.VOTOS).where("juntaId", "==", meetingId).get(),
        database().collection(C.PARTICIPANTES).where("juntaId", "==", meetingId).get()
      ]);
      counts = { questions: questions.size, votes: votes.size, attendance: attendance.size };
    } catch (error) {
      console.error("Error contando los datos de la reunión:", error);
      showAdminToast("No se pudo comprobar el contenido de la reunión. No se borró nada.", "error");
      return;
    }

    const accepted = await askAdminConfirmation({
      title: "Eliminar reunión",
      message: `¿Eliminar definitivamente «${name}»?`,
      detail: `Se borrarán también ${counts.questions} pregunta(s), ${counts.votes} voto(s) y ${counts.attendance} registro(s) de participación. Esta acción no se puede deshacer; si necesita conservar el historial, no la elimine.`,
      confirmText: "Eliminar para siempre",
      tone: "danger",
      requireText: name
    });
    if (!accepted) return;

    try {
      // La reunión se borra al final: si algo falla, queda para reintentar.
      await deleteAllWhere(C.VOTOS, "juntaId", meetingId);
      await deleteAllWhere(C.PARTICIPANTES, "juntaId", meetingId);
      await deleteAllWhere(C.VOTACIONES, "juntaId", meetingId);
      await database().collection(C.JUNTAS).doc(meetingId).delete();

      state.historyCache.delete(meetingId);
      if (!$("detalleHistorial").hidden && $("tituloDetalleHistorial").textContent === name) $("detalleHistorial").hidden = true;
      showAdminToast(`La reunión «${name}» y sus datos se eliminaron.`, "success");
      showMessage("mensajeEstadoReunion", `La reunión «${name}» se eliminó.`, "success");
    } catch (error) {
      console.error("Error eliminando la reunión:", error);
      showAdminToast("No se pudo eliminar la reunión por completo. " + explainError(error), "error");
    }
  }

  // ----------------------------------------------------------
  // Preguntas: crear, escuchar, ordenar, eliminar
  // ----------------------------------------------------------

  async function createQuestion(event) {
    event.preventDefault();
    clearMessage("mensajePregunta");
    const meeting = state.reunionActual;
    if (!state.reunionId || !meeting) {
      showMessage("mensajePregunta", "Seleccione una reunión primero.");
      return;
    }
    if (meetingIsFinished(meeting)) {
      showMessage("mensajePregunta", "No se pueden agregar preguntas a una reunión finalizada.");
      return;
    }
    const title = clean($("textoPregunta")?.value);
    const dateText = getDateTimeValue($("fechaVotacion"));
    const date = dateText ? new Date(dateText) : null;
    if (!title) {
      showMessage("mensajePregunta", "Escriba la pregunta o el tema.");
      return;
    }
    if (dateText && (!date || Number.isNaN(date.getTime()))) {
      showMessage("mensajePregunta", "La fecha y hora indicada no es válida. Corríjala o quite la programación.");
      return;
    }
    setBusy($("btnGuardarPregunta"), true, "GUARDANDO...");
    try {
      const snap = await database().collection(C.VOTACIONES).where("juntaId", "==", state.reunionId).get();
      const maxOrder = snap.docs.reduce((max, doc) => Math.max(max, Number(doc.data().orden) || 0), 0);
      await database().collection(C.VOTACIONES).add({
        juntaId: state.reunionId,
        filialId: meeting.filialId || null,
        titulo: title,
        pregunta: title,
        orden: maxOrder + 1,
        fechaProgramada: date ? toTimestamp(date) : null,
        estado: ESTADO.PREPARADA,
        duracionSegundos: DURACION_SEGUNDOS,
        creadaEn: serverTimestamp(),
        creadaPor: state.usuario.uid,
        actualizadaEn: serverTimestamp()
      });
      $("formCrearPregunta").reset();
      clearDateTimeValue($("fechaVotacion"));
      showMessage("mensajePregunta", date ? "Pregunta preparada y guardada con horario. No se ha publicado." : "Pregunta preparada y guardada sin horario definido. La hora era opcional; no se ha publicado.", "success");
    } catch (error) {
      console.error("Error creando pregunta:", error);
      showMessage("mensajePregunta", "No se pudo guardar la pregunta. " + explainError(error));
    } finally {
      setBusy($("btnGuardarPregunta"), false);
      renderMeetingDetails();
    }
  }

  function subscribeQuestions() {
    if (!state.reunionId) return;
    state.stopPreguntas = database().collection(C.VOTACIONES)
      .where("juntaId", "==", state.reunionId)
      .onSnapshot((snap) => {
        state.preguntas = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
          .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));
        setMissingEndTimes();
        renderQuestionList();
        renderLiveControls();
        renderResults();
        renderParticipation();
      }, (error) => {
        console.error("Error escuchando preguntas:", error);
        showMessage("mensajePregunta", "No se pudieron cargar las preguntas. " + explainError(error));
      });
  }

  function renderQuestionList() {
    const list = $("listaPreguntas");
    const select = $("preguntaSeleccionada");
    if (!list || !select) return;
    list.replaceChildren();
    if (!state.reunionId) {
      list.appendChild(safeElement("li", "estado-vacio", "Seleccione una reunión para ver sus preguntas."));
      select.replaceChildren();
      option(select, "", "Seleccione una pregunta");
      select.disabled = true;
      return;
    }
    if (!state.preguntas.length) {
      list.appendChild(safeElement("li", "estado-vacio", "Todavía no se han preparado preguntas para esta reunión."));
    }
    state.preguntas.forEach((q, index) => {
      const li = safeElement("li", "");
      const card = safeElement("div", "elemento-pregunta");
      const top = safeElement("div", "pregunta-lista-top");
      top.appendChild(safeElement("span", "indice-pregunta", String(index + 1).padStart(2, "0")));
      top.appendChild(safeElement("p", "texto-pregunta-lista", getQuestionText(q)));
      card.appendChild(top);
      const info = safeElement("div", "informacion-pregunta");
      info.appendChild(safeElement("span", "", `Horario: ${q.fechaProgramada ? formatDate(q.fechaProgramada) : "Sin horario definido"}`));
      info.appendChild(safeElement("span", "", `Estado: ${stateLabel(q.estado)}`));
      card.appendChild(info);
      const actions = safeElement("div", "acciones-pregunta");
      const selectBtn = safeElement("button", "boton boton-claro boton-pequeno", "Seleccionar");
      selectBtn.type = "button";
      selectBtn.dataset.selectQuestion = q.id;
      actions.appendChild(selectBtn);
      if (q.estado === ESTADO.PREPARADA) {
        if (index > 0 && state.preguntas[index - 1].estado === ESTADO.PREPARADA) {
          const up = safeElement("button", "boton boton-claro boton-pequeno", "Subir ↑");
          up.type = "button"; up.dataset.moveQuestion = q.id; up.dataset.direction = "up"; actions.appendChild(up);
        }
        if (index < state.preguntas.length - 1 && state.preguntas[index + 1].estado === ESTADO.PREPARADA) {
          const down = safeElement("button", "boton boton-claro boton-pequeno", "Bajar ↓");
          down.type = "button"; down.dataset.moveQuestion = q.id; down.dataset.direction = "down"; actions.appendChild(down);
        }
        const deleteBtn = safeElement("button", "boton boton-peligro boton-pequeno", "Eliminar");
        deleteBtn.type = "button"; deleteBtn.dataset.deleteQuestion = q.id; actions.appendChild(deleteBtn);
      }
      card.appendChild(actions);
      li.appendChild(card);
      list.appendChild(li);
    });

    const previous = select.value;
    select.replaceChildren();
    const available = state.preguntas.filter((q) => [ESTADO.PREPARADA, ESTADO.ABIERTA, ESTADO.FINALIZADA].includes(normalize(q.estado)));
    option(select, "", available.length ? "Seleccione una pregunta" : "No hay preguntas disponibles");
    available.forEach((q) => option(select, q.id, `${getQuestionText(q)} (${stateLabel(q.estado)})`));
    const active = getOpenQuestion();
    if (active) select.value = active.id;
    else if (available.some((q) => q.id === previous)) select.value = previous;
    select.disabled = !available.length;
    syncActiveMeetingSelector();
  }

  $("listaPreguntas")?.addEventListener("click", async (event) => {
    const selectButton = event.target.closest("[data-select-question]");
    if (selectButton) {
      $("preguntaSeleccionada").value = selectButton.dataset.selectQuestion;
      $("preguntaSeleccionada").dispatchEvent(new Event("change", { bubbles: true }));
      setActiveSection("seccionReunionActiva", true);
      renderLiveControls();
      return;
    }
    const deleteButton = event.target.closest("[data-delete-question]");
    if (deleteButton) {
      await deleteQuestion(deleteButton.dataset.deleteQuestion);
      return;
    }
    const moveButton = event.target.closest("[data-move-question]");
    if (moveButton) await moveQuestion(moveButton.dataset.moveQuestion, moveButton.dataset.direction);
  });

  async function deleteQuestion(id) {
    const question = state.preguntas.find((q) => q.id === id);
    if (!question || question.estado !== ESTADO.PREPARADA) return;
    const accepted = await askAdminConfirmation({
      title: "Eliminar pregunta",
      message: "¿Desea eliminar esta pregunta preparada?",
      detail: "Esta acción no se puede deshacer. Solo se permite eliminar preguntas que todavía no se hayan publicado.",
      confirmText: "Eliminar pregunta",
      tone: "danger"
    });
    if (!accepted) return;
    try {
      // Solamente se eliminan preguntas que aún no se han publicado.
      await database().collection(C.VOTACIONES).doc(id).delete();
      clearMessage("mensajePregunta");
      showMessage("mensajePregunta", "La pregunta preparada se eliminó.", "success");
    } catch (error) {
      showMessage("mensajePregunta", "No se pudo eliminar la pregunta. " + explainError(error));
    }
  }

  async function moveQuestion(id, direction) {
    const index = state.preguntas.findIndex((q) => q.id === id);
    const otherIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || otherIndex < 0 || otherIndex >= state.preguntas.length) return;
    const current = state.preguntas[index];
    const other = state.preguntas[otherIndex];
    if (current.estado !== ESTADO.PREPARADA || other.estado !== ESTADO.PREPARADA) return;
    try {
      const batch = database().batch();
      batch.update(database().collection(C.VOTACIONES).doc(current.id), { orden: Number(other.orden) || otherIndex + 1, actualizadaEn: serverTimestamp() });
      batch.update(database().collection(C.VOTACIONES).doc(other.id), { orden: Number(current.orden) || index + 1, actualizadaEn: serverTimestamp() });
      await batch.commit();
    } catch (error) {
      showMessage("mensajePregunta", "No se pudo cambiar el orden. " + explainError(error));
    }
  }

  // ----------------------------------------------------------
  // Publicación y cronómetro
  // ----------------------------------------------------------

  function getOpenQuestion() {
    const meeting = state.reunionActual;
    if (!meeting) return null;
    if (meeting.votacionActivaId) {
      return state.preguntas.find((q) => q.id === meeting.votacionActivaId && normalize(q.estado) === ESTADO.ABIERTA) || null;
    }
    const open = state.preguntas.filter((q) => normalize(q.estado) === ESTADO.ABIERTA);
    return open.length === 1 ? open[0] : null;
  }

  function getSelectedQuestion() {
    return state.preguntas.find((q) => q.id === $("preguntaSeleccionada")?.value) || null;
  }

  function syncActiveMeetingSelector() {
    const select = $("reunionActivaSeleccionada");
    if (!select) return;
    select.value = state.reunionId || "";
  }

  function renderLiveControls() {
    const meeting = state.reunionActual;
    const active = getOpenQuestion();
    const selected = getSelectedQuestion();
    const display = active || selected;
    const panel = $("panelPreguntaActual");
    if (!panel) return;
    panel.hidden = !display;
    if (!display) {
      $("textoPreguntaActual").textContent = "No hay una pregunta seleccionada.";
      $("estadoVotacion").textContent = "En espera";
      $("cronometroVotacion").textContent = "60 s";
      $("btnPublicarPregunta").disabled = true;
      $("btnCerrarVotacion").disabled = true;
      return;
    }
    $("textoPreguntaActual").textContent = getQuestionText(display);
    $("estadoVotacion").textContent = stateLabel(display.estado);
    const canPublish = Boolean(meeting && meetingIsActive(meeting) && !active && selected?.estado === ESTADO.PREPARADA);
    $("btnPublicarPregunta").disabled = !canPublish;
    $("btnCerrarVotacion").disabled = !active;
    updateCountdown();
  }

  async function publishQuestion() {
    clearMessage("mensajeControlVotacion");
    const meeting = state.reunionActual;
    const question = getSelectedQuestion();
    if (!meeting || !state.reunionId) {
      showMessage("mensajeControlVotacion", "Seleccione una reunión."); return;
    }
    if (!meetingIsActive(meeting)) {
      showMessage("mensajeControlVotacion", "Primero active la reunión en Administrar una reunión."); return;
    }
    if (getOpenQuestion()) {
      showMessage("mensajeControlVotacion", "Ya existe una votación abierta. Cierrela antes de publicar otra."); return;
    }
    if (!question || question.estado !== ESTADO.PREPARADA) {
      showMessage("mensajeControlVotacion", "Seleccione una pregunta preparada."); return;
    }
    const accepted = await askAdminConfirmation({
      title: "Publicar votación",
      message: "¿Publicar esta pregunta durante 60 segundos?",
      detail: "En cuanto se publique, los participantes podrán votar y comenzará el cronómetro.",
      confirmText: "Publicar votación",
      tone: "success"
    });
    if (!accepted) return;
    setBusy($("btnPublicarPregunta"), true, "PUBLICANDO...");
    try {
      const batch = database().batch();
      const questionRef = database().collection(C.VOTACIONES).doc(question.id);
      const meetingRef = database().collection(C.JUNTAS).doc(state.reunionId);
      batch.update(questionRef, {
        estado: ESTADO.ABIERTA,
        fechaInicio: serverTimestamp(),
        fechaFin: null,
        duracionSegundos: DURACION_SEGUNDOS,
        publicadaEn: serverTimestamp(),
        publicadaPor: state.usuario.uid,
        actualizadaEn: serverTimestamp()
      });
      batch.update(meetingRef, { votacionActivaId: question.id, actualizadaEn: serverTimestamp() });
      await batch.commit();
      state.avisoRelojMostrado = false;
      showMessage("mensajeControlVotacion", "Votación publicada. El tiempo se sincronizará con Firestore.", "success");
      showAdminToast("La votación ya está publicada.", "success");
    } catch (error) {
      console.error("Error publicando pregunta:", error);
      showMessage("mensajeControlVotacion", "No se pudo publicar la pregunta. " + explainError(error));
    } finally {
      setBusy($("btnPublicarPregunta"), false);
      renderLiveControls();
    }
  }

  function setMissingEndTimes() {
    for (const q of state.preguntas) {
      if (normalize(q.estado) !== ESTADO.ABIERTA || !isTimestamp(q.fechaInicio) || isTimestamp(q.fechaFin) || state.configurandoFin.has(q.id)) continue;
      state.configurandoFin.add(q.id);
      const endMs = q.fechaInicio.toMillis() + (Number(q.duracionSegundos) || DURACION_SEGUNDOS) * 1000;
      database().collection(C.VOTACIONES).doc(q.id).update({ fechaFin: firebase.firestore.Timestamp.fromMillis(endMs), actualizadaEn: serverTimestamp() })
        .catch((error) => console.error("No se pudo establecer fechaFin:", error))
        .finally(() => state.configurandoFin.delete(q.id));
    }
  }

  function updateCountdown() {
    const output = $("cronometroVotacion");
    if (!output) return;
    const q = getOpenQuestion();
    output.classList.remove("tiempo-alerta", "tiempo-agotado");
    if (!q) {
      const selected = getSelectedQuestion();
      output.textContent = selected?.estado === ESTADO.PREPARADA ? `${DURACION_SEGUNDOS} s` : "—";
      return;
    }
    if (!isTimestamp(q.fechaFin)) {
      output.textContent = "…";
      return;
    }
    const remaining = Math.max(0, Math.ceil((q.fechaFin.toMillis() - serverNow()) / 1000));
    output.textContent = `${remaining} s`;
    if (remaining > 0 && remaining <= 10) output.classList.add("tiempo-alerta");
    if (remaining === 0) {
      output.classList.add("tiempo-agotado");
      if (!clockSynced()) {
        // Sin comparar el reloj con el servidor no se cierra solo:
        // un reloj mal puesto cerraría la votación antes de tiempo.
        if (!state.avisoRelojMostrado) {
          state.avisoRelojMostrado = true;
          showMessage("mensajeControlVotacion", "No se pudo sincronizar el reloj con el servidor, por eso la votación no se cierra sola. Ciérrela con el botón «Cerrar votación».", "warning");
          window.ADEPReloj?.sincronizar();
        }
        return;
      }
      if (!state.cierresEnProceso.has(q.id)) {
        state.cierresEnProceso.add(q.id);
        closeVote(q.id, true).catch((err) => console.error("Cierre automático fallido:", err)).finally(() => state.cierresEnProceso.delete(q.id));
      }
    }
  }

  async function closeCurrentVote(automatic = false) {
    const q = getOpenQuestion();
    if (!q) return;
    if (!automatic) {
      const accepted = await askAdminConfirmation({
        title: "Cerrar votación",
        message: "¿Cerrar esta votación ahora?",
        detail: "Los participantes ya no podrán responder a esta pregunta.",
        confirmText: "Cerrar votación",
        tone: "warning"
      });
      if (!accepted) return;
    }
    try {
      await closeVote(q.id, automatic);
      showMessage("mensajeControlVotacion", "La votación se cerró correctamente.", "success");
    } catch (error) {
      console.error("Error al cerrar votación:", error);
      showMessage("mensajeControlVotacion", "No se pudo cerrar la votación. " + explainError(error));
    }
  }

  async function closeVote(questionId, automatic) {
    const dbx = database();
    const meetingRef = dbx.collection(C.JUNTAS).doc(state.reunionId);
    const questionRef = dbx.collection(C.VOTACIONES).doc(questionId);
    await dbx.runTransaction(async (tx) => {
      const meetingDoc = await tx.get(meetingRef);
      const questionDoc = await tx.get(questionRef);
      if (!questionDoc.exists) return;
      const question = questionDoc.data();
      if (normalize(question.estado) !== ESTADO.ABIERTA) return;
      if (automatic && (!clockSynced() || !isTimestamp(question.fechaFin) || question.fechaFin.toMillis() > serverNow())) return;
      tx.update(questionRef, {
        estado: ESTADO.FINALIZADA,
        fechaCierreReal: serverTimestamp(),
        motivoCierre: automatic ? "tiempo_agotado" : "cierre_administrativo",
        cerradaPor: state.usuario?.uid || null,
        actualizadaEn: serverTimestamp()
      });
      if (meetingDoc.exists && meetingDoc.data().votacionActivaId === questionId) {
        tx.update(meetingRef, { votacionActivaId: null, actualizadaEn: serverTimestamp() });
      }
    });
  }

  // ----------------------------------------------------------
  // Votos y resultados en tiempo real
  // ----------------------------------------------------------

  function subscribeVotes() {
    if (!state.reunionId) return;
    state.stopVotos = database().collection(C.VOTOS).where("juntaId", "==", state.reunionId)
      .onSnapshot((snap) => {
        state.votos = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        renderResults();
        renderParticipation();
      }, (error) => {
        console.error("Error escuchando votos:", error);
        showMessage("mensajeResultados", "No se pudieron actualizar los resultados. " + explainError(error));
      });
  }

  function getQuestionIdForVote(vote) {
    return vote.votacionId || vote.votingId || vote.idVotacion || "";
  }

  function getVoterIdForVote(vote) {
    return vote.usuarioId || vote.userId || vote.votanteId || vote.uid || "";
  }

  function classifyVote(vote) {
    const value = normalize(vote.opcion || vote.respuesta || vote.voto || vote.tipoVoto || "").replace(/[_-]/g, " ");
    if (["favor", "a favor", "afavor"].includes(value)) return "favor";
    if (["contra", "en contra", "encontra"].includes(value)) return "contra";
    if (["abstencion", "abstención"].includes(value)) return "abstencion";
    return null;
  }

  function calculateResults(questionId) {
    const result = { favor: 0, contra: 0, abstencion: 0 };
    state.votos.filter((v) => getQuestionIdForVote(v) === questionId).forEach((v) => {
      const key = classifyVote(v);
      if (key) result[key]++;
    });
    const total = result.favor + result.contra + result.abstencion;
    return {
      counts: result,
      total,
      percentages: {
        favor: total ? Math.round(result.favor / total * 100) : 0,
        contra: total ? Math.round(result.contra / total * 100) : 0,
        abstencion: total ? Math.round(result.abstencion / total * 100) : 0
      }
    };
  }

  function getQuestionForResults() {
    const open = getOpenQuestion();
    if (open) return open;
    const selected = getSelectedQuestion();
    if (selected && normalize(selected.estado) === ESTADO.FINALIZADA) return selected;
    const finished = state.preguntas.filter((q) => normalize(q.estado) === ESTADO.FINALIZADA);
    return finished.length ? finished[finished.length - 1] : null;
  }

  function renderResults() {
    const panel = $("panelResultados");
    if (!panel) return;
    const question = getQuestionForResults();
    const sameQuestion = Boolean(question && panel.dataset.questionId === question.id);
    const priorPercentages = new Map();
    if (sameQuestion) {
      panel.querySelectorAll(".tarjeta-resultado").forEach((card) => {
        const key = ["favor", "contra", "abstencion"].find((item) => card.classList.contains(`resultado-${item}`));
        const progress = card.querySelector(".barra-progreso");
        if (key && progress) priorPercentages.set(key, Number.parseFloat(progress.style.width) || 0);
      });
    }
    panel.replaceChildren();
    if (!question) {
      panel.dataset.questionId = "";
      panel.appendChild(safeElement("p", "estado-vacio", "Los resultados aparecerán cuando una pregunta haya recibido votos."));
      return;
    }
    panel.dataset.questionId = question.id;
    const results = calculateResults(question.id);
    panel.appendChild(safeElement("h4", "titulo-pregunta-resultado", getQuestionText(question)));
    const rows = [
      { key: "favor", title: "A favor", cls: "resultado-favor" },
      { key: "contra", title: "En contra", cls: "resultado-contra" },
      { key: "abstencion", title: "Abstención", cls: "resultado-abstencion" }
    ];
    rows.forEach((row) => {
      const percent = results.percentages[row.key];
      const card = safeElement("div", `tarjeta-resultado ${row.cls}`);
      const header = safeElement("div", "resultado-encabezado");
      header.appendChild(safeElement("span", "resultado-etiqueta", row.title));
      header.appendChild(safeElement("strong", "resultado-cantidad", results.counts[row.key]));
      card.appendChild(header);
      const bar = safeElement("div", "barra-resultado");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", `Porcentaje ${row.title}`);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(percent));
      const progress = safeElement("div", "barra-progreso");
      const previousPercent = priorPercentages.has(row.key) ? priorPercentages.get(row.key) : 0;
      progress.style.width = `${previousPercent}%`;
      bar.appendChild(progress);
      requestAnimationFrame(() => {
        // El ancho parte del porcentaje previo y avanza suavemente con cada actualización.
        progress.style.width = `${percent}%`;
      });
      card.appendChild(bar);
      card.appendChild(safeElement("span", "resultado-porcentaje", `${percent} %`));
      panel.appendChild(card);
    });
    panel.appendChild(safeElement("p", "total-resultados", `Total de votos válidos: ${results.total}`));
  }

  // ----------------------------------------------------------
  // Borrado por lotes (Firestore limita cada lote a 500 operaciones)
  // ----------------------------------------------------------

  async function deleteAllWhere(collectionName, field, value) {
    const snap = await database().collection(collectionName).where(field, "==", value).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = database().batch();
      snap.docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    return snap.size;
  }

  async function existsWhere(collectionName, field, value) {
    const snap = await database().collection(collectionName).where(field, "==", value).limit(1).get();
    return !snap.empty;
  }

  // ----------------------------------------------------------
  // Gestión de usuarios
  // ----------------------------------------------------------

  function bindUserManagement() {
    $("formCrearUsuario")?.addEventListener("submit", createUser);
    $("btnCancelarEdicionUsuario")?.addEventListener("click", resetUserForm);
    $("cedulaUsuarioNuevo")?.addEventListener("input", (event) => {
      const input = event.currentTarget;
      const digits = input.value.replace(/\D/g, "").slice(0, 9);
      const formatted = formatCedulaCR(digits);
      input.value = formatted;
      input.setCustomValidity(digits.length && digits.length !== 9 ? "La cédula debe tener 9 números." : "");
      input.setAttribute("aria-invalid", digits.length && digits.length !== 9 ? "true" : "false");
    });
    $("rolUsuarioNuevo")?.addEventListener("change", updateUserRoleFields);
    $("buscarUsuario")?.addEventListener("input", renderUserList);
    $("filtroRolUsuario")?.addEventListener("change", renderUserList);
    $("listaUsuarios")?.addEventListener("click", async (event) => {
      const edit = event.target.closest("[data-edit-user]");
      if (edit) { beginUserEdit(edit.dataset.editUser); return; }
      const toggle = event.target.closest("[data-toggle-user]");
      if (toggle) await toggleUser(toggle.dataset.toggleUser);
      const remove = event.target.closest("[data-delete-user]");
      if (remove) await deleteUser(remove.dataset.deleteUser);
    });
    updateUserRoleFields();
  }

 function updateUserRoleFields() {
  const isAdmin = $("rolUsuarioNuevo")?.value === "admin";
  const isEditing = Boolean(state.editingUserId);
  const email = $("correoUsuarioNuevo");
  const representativeGroup = $("grupoTipoRepresentante");
  const passwordGroup = $("grupoContrasenaUsuario");
  const password = $("contrasenaUsuarioNuevo");

  if (representativeGroup) representativeGroup.hidden = isAdmin;
  if (email) email.required = isAdmin;

  // La contraseña solo se pide al CREAR un administrador.
  const showPassword = isAdmin && !isEditing;
  if (passwordGroup) passwordGroup.hidden = !showPassword;
  if (password) {
    password.required = showPassword;
    if (!showPassword) password.value = "";
  }
}

  async function loadUsers() {
    if (!state.usuario) return;
    const list = $("listaUsuarios");
    if (list && !state.usuarios.length) list.replaceChildren(safeElement("p", "estado-vacio", "Cargando usuarios..."));
    try {
      const snap = await database().collection(C.USUARIOS).get();
      state.usuarios = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => getUserName(a).localeCompare(getUserName(b), "es"));
      renderUserList();
    } catch (error) {
      console.error("Error cargando usuarios:", error);
      if (list) {
        list.replaceChildren();
        list.appendChild(safeElement("p", "estado-vacio", "No fue posible consultar usuarios. " + explainError(error)));
      }
    }
  }

  function getUserName(user) {
    const full = clean(user.nombreCompleto || user.nombre || user.nombreUsuario || "");
    if (full) return full;
    return [user.nombres, user.apellidos].filter(Boolean).join(" ") || "Usuario sin nombre";
  }

  function getUserRole(user) {
    const role = normalize(user.rol || user.tipoUsuario || user.tipo || user.role || "votante");
    return ["admin", "administrador"].includes(role) || user.esAdministrador === true || user.isAdmin === true ? "admin" : "votante";
  }

  function userIsEnabled(user) {
    if (user.activo === false || user.activa === false) return false;
    return !["inactivo", "inactiva", "deshabilitado", "deshabilitada", "suspendido", "suspendida"].includes(normalize(user.estado || ""));
  }

  async function createUser(event) {
    event.preventDefault();
    clearMessage("mensajeUsuario");
    const name = clean($("nombreUsuarioNuevo")?.value);
    const cedula = clean($("cedulaUsuarioNuevo")?.value).replace(/\D/g, "").slice(0, 9);
    const cedulaFormateada = formatCedulaCR(cedula);
    const filialId = $("filialUsuarioNuevo")?.value;
    const role = $("rolUsuarioNuevo")?.value;
    const email = clean($("correoUsuarioNuevo")?.value).toLowerCase();
    const tipoRepresentante = clean($("tipoRepresentanteUsuarioNuevo")?.value || "participante");
    const password = $("contrasenaUsuarioNuevo")?.value || "";
    const filial = state.filiales.find((f) => f.id === filialId);
    const isEditing = Boolean(state.editingUserId);

    if (!name || !/^\d{9}$/.test(cedula) || !filial || !["votante", "admin"].includes(role)) {
      showMessage("mensajeUsuario", "Complete el nombre, una cédula de 9 números, la filial y el tipo de usuario.");
      return;
    }
    if (!validateCustomSelect("filialUsuarioNuevo", "mensajeUsuario")) return;
    if (role === "admin" && !email) {
      showMessage("mensajeUsuario", "Para registrar un administrador debe indicar el correo de la cuenta que usará para entrar al panel.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMessage("mensajeUsuario", "Revise el correo electrónico.");
      return;
    }

    if (role === "admin" && !isEditing) {
  if (password.length < 6) {
    showMessage("mensajeUsuario", "La contraseña del administrador es obligatoria y debe tener al menos 6 caracteres.");
    $("contrasenaUsuarioNuevo")?.focus();
    return;
  }
}

    setBusy($("btnCrearUsuario"), true, isEditing ? "GUARDANDO..." : "REGISTRANDO...");
    try {
      const usersCollection = database().collection(C.USUARIOS);
      const [duplicateRawSnap, duplicateFormattedSnap, duplicateIdSnap, duplicateIdFormattedSnap] = await Promise.all([
        usersCollection.where("cedula", "==", cedula).limit(10).get(),
        usersCollection.where("cedula", "==", cedulaFormateada).limit(10).get(),
        usersCollection.where("identificacion", "==", cedula).limit(10).get(),
        usersCollection.where("identificacion", "==", cedulaFormateada).limit(10).get()
      ]);
      const duplicateDocs = new Map();
      [...duplicateRawSnap.docs, ...duplicateFormattedSnap.docs, ...duplicateIdSnap.docs, ...duplicateIdFormattedSnap.docs]
        .forEach((doc) => duplicateDocs.set(doc.id, doc));
      const duplicate = [...duplicateDocs.values()].find((doc) => doc.id !== state.editingUserId);
      if (duplicate) {
        showMessage("mensajeUsuario", "Ya existe otro usuario registrado con esa cédula.");
        return;
      }

      const profile = {
        nombreCompleto: name,
        nombre: name,
        cedula,
        filialId: filial.id,
        filialNombre: filial.name,
        filial: filial.name,
        tipoRepresentante: role === "admin" ? "no_aplica" : tipoRepresentante,
        actualizadaEn: serverTimestamp(),
        actualizadaPor: state.usuario.uid
      };

      if (isEditing) {
        const existing = state.usuarios.find((u) => u.id === state.editingUserId);
        if (!existing) throw new Error("No se encontró el usuario seleccionado para editar.");
        // El correo de una cuenta administrativa no se modifica aquí porque
        // el correo de inicio de sesión pertenece a Firebase Authentication.
        if (getUserRole(existing) === "admin") {
          profile.correo = existing.correo || existing.email || "";
        } else {
          profile.correo = email || "";
        }
        await database().collection(C.USUARIOS).doc(state.editingUserId).update(profile);
        resetUserForm();
        showMessage("mensajeUsuario", "Los datos del usuario se actualizaron correctamente.", "success");
        await loadUsers();
        return;
      }

      profile.correo = email || "";
profile.rol = role === "admin" ? "admin" : "votante";
profile.activo = true;
profile.estado = "activo";
profile.creadoEn = serverTimestamp();
profile.creadoPor = state.usuario.uid;

if (role === "admin") {
  // 1) Crear la cuenta de acceso (correo + contraseña) en Authentication.
  const newUid = await createAuthAccountForAdmin(email, password);
  // 2) Guardar el perfil con el mismo UID para que el login lo reconozca.
  try {
    await usersCollection.doc(newUid).set(profile);
  } catch (profileError) {
    console.error("La cuenta se creó pero falló el perfil:", profileError);
    showMessage("mensajeUsuario", "La cuenta de acceso se creó, pero no se pudo guardar el perfil en Firestore. " + explainError(profileError));
    return;
  }
} else {
  await usersCollection.add(profile);
}

      $("formCrearUsuario").reset();
      resetUserForm();
      updateUserRoleFields();
      showMessage("mensajeUsuario", role === "admin"
        ? "Administrador registrado. Ya puede iniciar sesión con su correo y la contraseña indicada."
        : "Usuario registrado correctamente.", "success");
      showAdminToast(role === "admin" ? "Administrador registrado correctamente." : "Usuario registrado correctamente.", "success");
      await loadUsers();
    } catch (error) {
      console.error("Error registrando/actualizando usuario:", error);
      showMessage("mensajeUsuario", "No se pudo guardar el usuario. " + explainError(error));
    } finally {
      setBusy($("btnCrearUsuario"), false);
    }
  }


// Crea la cuenta en Authentication usando una app secundaria para que
// la sesión del administrador actual NO se cierre.
async function createAuthAccountForAdmin(email, password) {
  const appName = "ADEP_AltaAdministrador";
  let secondaryApp;
  try {
    secondaryApp = firebase.app(appName);
  } catch (_) {
    secondaryApp = firebase.initializeApp(firebase.app().options, appName);
  }
  const secondaryAuth = secondaryApp.auth();
  try {
    const credential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    return credential.user.uid;
  } finally {
    await secondaryAuth.signOut().catch(() => {});
  }
}

  function beginUserEdit(id) {
    const user = state.usuarios.find((u) => u.id === id);
    if (!user) return;
    state.editingUserId = id;
    $("nombreUsuarioNuevo").value = getUserName(user);
    $("cedulaUsuarioNuevo").value = formatCedulaCR(user.cedula || user.identificacion || "");
    const storedFilialId = user.filialId || user.filial_id || user.idFilial || "";
    const legacyFilialName = normalize(user.filialNombre || user.filial || "");
    const matchedFilial = state.filiales.find((f) => f.id === storedFilialId || normalize(f.name) === legacyFilialName);
    $("filialUsuarioNuevo").value = matchedFilial?.id || "";
    if ($("tipoRepresentanteUsuarioNuevo")) {
      $("tipoRepresentanteUsuarioNuevo").value = user.tipoRepresentante || "participante";
    }
    $("rolUsuarioNuevo").value = getUserRole(user);
    $("rolUsuarioNuevo").disabled = true;
    $("correoUsuarioNuevo").value = user.correo || user.email || "";
    $("correoUsuarioNuevo").disabled = getUserRole(user) === "admin";
    updateUserRoleFields();

    $("btnCrearUsuario").textContent = "Guardar cambios";
    $("btnCancelarEdicionUsuario").hidden = false;
    clearMessage("mensajeUsuario");
    $("formCrearUsuario").scrollIntoView({ behavior: "smooth", block: "start" });
    $("nombreUsuarioNuevo").focus();
  }

  function resetUserForm() {
    state.editingUserId = null;
    if ($("formCrearUsuario")) $("formCrearUsuario").reset();
    if ($("rolUsuarioNuevo")) $("rolUsuarioNuevo").disabled = false;
    if ($("correoUsuarioNuevo")) $("correoUsuarioNuevo").disabled = false;
    if ($("btnCrearUsuario")) {
      $("btnCrearUsuario").textContent = "Registrar usuario";
      delete $("btnCrearUsuario").dataset.originalText;
    }
    if ($("btnCancelarEdicionUsuario")) $("btnCancelarEdicionUsuario").hidden = true;
    if ($("cedulaUsuarioNuevo")) {
      $("cedulaUsuarioNuevo").setCustomValidity("");
      $("cedulaUsuarioNuevo").setAttribute("aria-invalid", "false");
    }
    updateUserRoleFields();
  }

  function renderUserList() {
    const list = $("listaUsuarios");
    if (!list) return;
    list.replaceChildren();
    const search = normalize($("buscarUsuario")?.value || "");
    const roleFilter = $("filtroRolUsuario")?.value || "todos";
    const users = state.usuarios.filter((user) => {
      const role = getUserRole(user);
      const matchesRole = roleFilter === "todos" || role === roleFilter;
      const haystack = normalize(`${getUserName(user)} ${user.cedula || user.identificacion || ""} ${user.correo || user.email || ""} ${user.filialNombre || user.filial || ""} ${user.tipoRepresentante || ""}`);
      return matchesRole && haystack.includes(search);
    });

    if (!users.length) {
      list.appendChild(safeElement("p", "estado-vacio", state.usuarios.length ? "No hay usuarios que coincidan con la búsqueda." : "Todavía no hay usuarios registrados."));
      return;
    }

    users.forEach((user) => {
      const card = safeElement("article", "tarjeta-usuario");
      const info = safeElement("div", "datos-usuario");
      info.appendChild(safeElement("h4", "nombre-usuario", getUserName(user)));
      const meta = safeElement("p", "meta-usuario", `${getUserRole(user) === "admin" ? "Administrador" : "Votante"} · ${user.filialNombre || user.filial || "Sin filial"}`);
      info.appendChild(meta);
      const details = safeElement("p", "detalle-usuario", `Cédula: ${formatCedulaCR(user.cedula || user.identificacion || "") || "No indicada"}`);
      info.appendChild(details);
      if (getUserRole(user) === "votante") {
        const representativeType = representativeTypeLabel(user.tipoRepresentante);
        if (representativeType) info.appendChild(safeElement("p", "detalle-usuario", `Condición: ${representativeType}`));
      }
      const email = clean(user.correo || user.email || "");
      if (email) info.appendChild(safeElement("p", "detalle-usuario", `Correo: ${email}`));
      card.appendChild(info);

      const side = safeElement("div", "acciones-usuario");
      const enabled = userIsEnabled(user);
      const badge = safeElement("span", `etiqueta-estado ${enabled ? "estado-positivo" : "estado-neutral"}`, enabled ? "Activo" : "Deshabilitado");
      side.appendChild(badge);
      const edit = safeElement("button", "boton boton-claro boton-pequeno", "Editar datos");
      edit.type = "button"; edit.dataset.editUser = user.id; side.appendChild(edit);
      const isSelf = user.id === state.usuario?.uid || normalize(user.correo || user.email || "") === normalize(state.usuario?.email || "");
      const remove = safeElement("button", "boton boton-borde-peligro boton-pequeno", "Eliminar");
      remove.type = "button";
      remove.dataset.deleteUser = user.id;
      remove.disabled = isSelf;
      remove.title = isSelf ? "No puede eliminar la sesión administrativa actual" : "Eliminar este usuario";
      const toggle = safeElement("button", `boton ${enabled ? "boton-peligro" : "boton-principal"} boton-pequeno`, enabled ? "Deshabilitar" : "Habilitar");
      toggle.type = "button";
      toggle.dataset.toggleUser = user.id;
      toggle.disabled = isSelf;
      toggle.title = isSelf ? "No puede deshabilitar la sesión administrativa actual" : "Cambiar estado del usuario";
      side.appendChild(toggle);
      side.appendChild(remove);
      card.appendChild(side);
      list.appendChild(card);
    });
  }

  async function toggleUser(id) {
    const user = state.usuarios.find((u) => u.id === id);
    if (!user) return;
    const isSelf = id === state.usuario?.uid || normalize(user.correo || user.email || "") === normalize(state.usuario?.email || "");
    if (isSelf) {
      showMessage("mensajeUsuario", "No puede deshabilitar su propia cuenta desde esta pantalla.", "warning");
      return;
    }
    const enabled = userIsEnabled(user);
    const action = enabled ? "deshabilitar" : "habilitar";
    const accepted = await askAdminConfirmation({
      title: enabled ? "Deshabilitar usuario" : "Habilitar usuario",
      message: `¿Desea ${action} a ${getUserName(user)}?`,
      detail: enabled ? "La persona conservará su historial, pero no podrá utilizar el sistema mientras esté deshabilitada." : "La persona volverá a estar habilitada para el sistema.",
      confirmText: enabled ? "Deshabilitar" : "Habilitar",
      tone: enabled ? "danger" : "success"
    });
    if (!accepted) return;
    try {
      const next = !enabled;
      await database().collection(C.USUARIOS).doc(id).update({
        activo: next,
        estado: next ? "activo" : "inactivo",
        actualizadaEn: serverTimestamp(),
        actualizadaPor: state.usuario.uid
      });
      showMessage("mensajeUsuario", `Usuario ${next ? "habilitado" : "deshabilitado"}.`, "success");
      await loadUsers();
    } catch (error) {
      console.error("Error cambiando estado de usuario:", error);
      showMessage("mensajeUsuario", "No se pudo cambiar el estado. " + explainError(error));
    }
  }

  async function deleteUser(id) {
    const user = state.usuarios.find((u) => u.id === id);
    if (!user) return;
    const isSelf = id === state.usuario?.uid || normalize(user.correo || user.email || "") === normalize(state.usuario?.email || "");
    if (isSelf) {
      showMessage("mensajeUsuario", "No puede eliminar su propia cuenta desde esta pantalla.", "warning");
      return;
    }
    const name = getUserName(user);
    const isAdmin = getUserRole(user) === "admin";

    if (isAdmin) {
      const otherAdmins = state.usuarios.filter((u) => u.id !== id && getUserRole(u) === "admin" && userIsEnabled(u));
      if (!otherAdmins.length) {
        showMessage("mensajeUsuario", "No se puede eliminar al único administrador habilitado. Cree o habilite otro administrador primero.", "warning");
        return;
      }
    }

    try {
      const [hasVotes, hasVotesAlt, hasAttendance] = await Promise.all([
        existsWhere(C.VOTOS, "usuarioId", id),
        existsWhere(C.VOTOS, "userId", id),
        existsWhere(C.PARTICIPANTES, "usuarioId", id)
      ]);
      if (hasVotes || hasVotesAlt || hasAttendance) {
        showMessage("mensajeUsuario", `No se puede eliminar a ${name} porque ya participó o votó en alguna reunión y su historial quedaría incompleto. Use «Deshabilitar»: conserva el historial y le impide ingresar.`, "warning");
        return;
      }
    } catch (error) {
      console.error("Error comprobando el historial del usuario:", error);
      showMessage("mensajeUsuario", "No se pudo comprobar el historial del usuario, así que no se borró nada. " + explainError(error));
      return;
    }

    const accepted = await askAdminConfirmation({
      title: "Eliminar usuario",
      message: `¿Eliminar definitivamente a ${name}?`,
      detail: isAdmin
        ? "Esta acción no se puede deshacer. Su cuenta de acceso seguirá existiendo en Firebase Authentication, pero ya no podrá entrar al panel."
        : "Esta persona no tiene votos ni participación registrados. Esta acción no se puede deshacer.",
      confirmText: "Eliminar usuario",
      tone: "danger"
    });
    if (!accepted) return;

    try {
      await database().collection(C.USUARIOS).doc(id).delete();
      if (state.editingUserId === id) resetUserForm();
      showMessage("mensajeUsuario", `Se eliminó a ${name}.`, "success");
      showAdminToast("Usuario eliminado.", "success");
      await loadUsers();
    } catch (error) {
      console.error("Error eliminando usuario:", error);
      showMessage("mensajeUsuario", "No se pudo eliminar el usuario. " + explainError(error));
    }
  }

  // ----------------------------------------------------------
  // Participación
  // ----------------------------------------------------------

  function subscribeParticipants() {
    if (!state.reunionId) return;
    if (state.stopParticipantes) state.stopParticipantes();
    state.stopParticipantes = database().collection(C.PARTICIPANTES)
      .where("juntaId", "==", state.reunionId)
      .onSnapshot((snap) => {
        state.participantes = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        renderParticipation();
      }, (error) => {
        console.error("Error escuchando participantes de la reunión:", error);
        const panel = $("panelParticipacion");
        if (panel) {
          panel.replaceChildren(safeElement("p", "estado-vacio", "No se pudo cargar la lista de participantes que ingresaron con PIN. " + explainError(error)));
        }
      });
  }

  const VOTE_LABELS = { favor: "A favor", contra: "En contra", abstencion: "Abstención" };

  // Une a las personas que ingresaron (participantesJunta) con las que
  // ya votaron, para que nadie que haya votado quede fuera de la lista.
  function buildParticipationPeople() {
    const usersById = new Map(state.usuarios.map((user) => [String(user.id), user]));
    const usersByCedula = new Map(state.usuarios
      .map((user) => [String(user.cedula || user.identificacion || "").replace(/\D/g, ""), user])
      .filter(([key]) => key));
    const people = new Map();

    const ensure = (userId, cedulaDigits, base) => {
      const user = usersById.get(userId) || usersByCedula.get(cedulaDigits) || null;
      const key = String(userId || user?.id || cedulaDigits || base.entryId || "");
      if (!key) return null;
      if (!people.has(key)) {
        people.set(key, {
          key,
          userId: String(userId || user?.id || ""),
          name: "",
          cedula: "",
          filial: "",
          condition: "",
          enteredAt: null,
          registered: false,
          votes: new Map()
        });
      }
      const person = people.get(key);
      if (user) {
        person.name = person.name || getUserName(user);
        person.cedula = person.cedula || formatCedulaCR(user.cedula || user.identificacion || "");
        person.filial = person.filial || clean(user.filialNombre || user.filial || "");
        person.condition = person.condition || representativeTypeLabel(user.tipoRepresentante);
      }
      return person;
    };

    state.participantes.forEach((entry) => {
      const userId = String(entry.usuarioId || entry.userId || entry.uid || entry.votanteId || "");
      const cedulaDigits = String(entry.cedula || entry.identificacion || "").replace(/\D/g, "");
      const person = ensure(userId, cedulaDigits, { entryId: entry.id });
      if (!person) return;
      person.registered = true;
      person.name = clean(entry.nombreCompleto || entry.nombre || entry.nombreUsuario) || person.name;
      person.cedula = formatCedulaCR(entry.cedula || entry.identificacion || "") || person.cedula;
      person.filial = clean(entry.filialNombre || entry.filial) || person.filial;
      person.condition = representativeTypeLabel(entry.tipoRepresentante) || person.condition;
      person.enteredAt = entry.ingresoEn || entry.fechaIngreso || entry.creadoEn || person.enteredAt;
    });

    state.votos.forEach((vote) => {
      const voterId = String(getVoterIdForVote(vote) || "");
      const person = ensure(voterId, "", { entryId: vote.id });
      const choice = classifyVote(vote);
      const questionId = getQuestionIdForVote(vote);
      if (person && choice && questionId) person.votes.set(questionId, choice);
    });

    return [...people.values()].map((person) => ({
      ...person,
      name: person.name || "Participante sin nombre registrado"
    })).sort((a, b) =>
      a.filial.localeCompare(b.filial, "es") || a.name.localeCompare(b.name, "es"));
  }

  function voteChip(choice) {
    return safeElement("span", `voto-chip voto-chip-${choice}`, VOTE_LABELS[choice]);
  }

  function renderParticipation() {
    const panel = $("panelParticipacion");
    if (!panel) return;
    panel.replaceChildren();
    if (!state.reunionActual) {
      panel.appendChild(safeElement("p", "estado-vacio", "Seleccione una reunión para consultar la participación."));
      return;
    }

    const people = buildParticipationPeople();
    if (!people.length) {
      panel.appendChild(safeElement("p", "estado-vacio", "Todavía no hay participantes que hayan ingresado a esta reunión con su PIN. En cuanto ingresen, aparecerán aquí."));
      return;
    }

    const question = getQuestionForResults();
    const answered = question ? people.filter((person) => person.votes.has(question.id)).length : 0;
    const summary = question
      ? `Presentes: ${people.length} · Votaron en esta pregunta: ${answered} · Faltan: ${people.length - answered}`
      : `Presentes: ${people.length}`;
    panel.appendChild(safeElement("p", "resumen-participacion", summary));
    if (question) {
      panel.appendChild(safeElement("p", "participacion-pregunta", `Pregunta mostrada: «${getQuestionText(question)}» (${stateLabel(question.estado)})`));
    }

    const closedQuestions = state.preguntas.filter((q) => [ESTADO.ABIERTA, ESTADO.FINALIZADA].includes(normalize(q.estado)));
    const list = safeElement("div", "lista-participacion");
    people.forEach((person) => {
      const row = safeElement("div", "elemento-participacion");
      const info = safeElement("div", "participante-info");
      info.appendChild(safeElement("strong", "", person.name));
      const meta = [person.filial, person.condition].filter(Boolean).join(" · ");
      if (meta) info.appendChild(safeElement("span", "", meta));
      if (person.cedula) info.appendChild(safeElement("span", "", `Cédula: ${person.cedula}`));
      if (person.enteredAt) info.appendChild(safeElement("span", "", `Ingreso: ${formatDate(person.enteredAt)}`));
      else if (!person.registered) info.appendChild(safeElement("span", "", "Ingreso no registrado (solo consta su voto)"));

      if (closedQuestions.length) {
        const details = safeElement("details", "participante-detalle");
        details.appendChild(safeElement("summary", "", `Ver sus votos (${person.votes.size} de ${closedQuestions.length})`));
        const items = safeElement("ol", "participante-votos");
        closedQuestions.forEach((q) => {
          const li = safeElement("li", "");
          li.appendChild(safeElement("span", "participante-votos-pregunta", getQuestionText(q)));
          const choice = person.votes.get(q.id);
          li.appendChild(choice ? voteChip(choice) : safeElement("span", "voto-chip voto-chip-ninguno", "No votó"));
          items.appendChild(li);
        });
        details.appendChild(items);
        info.appendChild(details);
      }
      row.appendChild(info);

      const side = safeElement("div", "participante-estado");
      if (question) {
        const choice = person.votes.get(question.id);
        side.appendChild(choice ? voteChip(choice) : safeElement("span", "estado-participante estado-participante-pendiente", "Aún no vota"));
      } else {
        side.appendChild(safeElement("span", "estado-participante estado-participante-voto", "Presente"));
      }
      row.appendChild(side);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }

  // ----------------------------------------------------------
  // Gestión independiente de filiales
  // ----------------------------------------------------------

  function bindFilialManagement() {
    $("formFilial")?.addEventListener("submit", saveFilial);
    $("btnCancelarEdicionFilial")?.addEventListener("click", resetFilialForm);
    $("buscarFilial")?.addEventListener("input", renderFilialList);

    $("listaFiliales")?.addEventListener("click", async (event) => {
      const edit = event.target.closest("[data-edit-filial]");
      if (edit) {
        beginFilialEdit(edit.dataset.editFilial);
        return;
      }

      const toggle = event.target.closest("[data-toggle-filial]");
      if (toggle) {
        await toggleFilial(toggle.dataset.toggleFilial);
        return;
      }

      const remove = event.target.closest("[data-delete-filial]");
      if (remove) await deleteFilial(remove.dataset.deleteFilial);
    });
  }

  function renderFilialList() {
    const list = $("listaFiliales");
    if (!list) return;

    list.replaceChildren();
    const search = normalize($("buscarFilial")?.value || "");
    const filiales = state.todasFiliales.filter((filial) => normalize(filial.name).includes(search));

    if (!filiales.length) {
      list.appendChild(safeElement("p", "estado-vacio", state.todasFiliales.length
        ? "No hay filiales que coincidan con la búsqueda."
        : "Todavía no hay filiales registradas. Puede agregar la primera usando el formulario."));
      return;
    }

    filiales.forEach((filial) => {
      const active = filialIsEnabled(filial.data);
      const linkedUsers = state.usuarios.filter((user) => documentBelongsToFilial(user, filial)).length;
      const linkedMeetings = state.reuniones.filter((meeting) => documentBelongsToFilial(meeting, filial)).length;

      const card = safeElement("article", `tarjeta-filial${active ? "" : " filial-inactiva"}`);
      const icon = safeElement("span", "icono-tarjeta-filial", "⌂");
      icon.setAttribute("aria-hidden", "true");
      card.appendChild(icon);

      const info = safeElement("div", "datos-filial");
      info.appendChild(safeElement("h3", "nombre-filial", filial.name));
      info.appendChild(safeElement("p", "meta-filial", `${linkedUsers} usuario(s) asociado(s) · ${linkedMeetings} reunión/reuniones asociada(s)`));
      info.appendChild(safeElement("p", "detalle-filial", active
        ? "Disponible para nuevas reuniones y registros."
        : "Inactiva: se conserva la información histórica y no aparece en los formularios."));
      card.appendChild(info);

      const side = safeElement("div", "acciones-filial");
      side.appendChild(safeElement("span", `etiqueta-estado ${active ? "estado-positivo" : "estado-neutral"}`, active ? "Activa" : "Inactiva"));

      const editButton = safeElement("button", "boton boton-claro boton-pequeno", "Editar nombre");
      editButton.type = "button";
      editButton.dataset.editFilial = filial.id;
      side.appendChild(editButton);

      const toggleButton = safeElement("button", `boton ${active ? "boton-peligro" : "boton-principal"} boton-pequeno`, active ? "Desactivar" : "Reactivar");
      toggleButton.type = "button";
      toggleButton.dataset.toggleFilial = filial.id;
      side.appendChild(toggleButton);

      const deleteButton = safeElement("button", "boton boton-borde-peligro boton-pequeno", "Eliminar definitivamente");
      deleteButton.type = "button";
      deleteButton.dataset.deleteFilial = filial.id;
      deleteButton.title = "Solo se puede eliminar una filial que no tenga registros asociados";
      side.appendChild(deleteButton);

      card.appendChild(side);
      list.appendChild(card);
    });
  }

  function documentBelongsToFilial(documentData, filial) {
    const ids = [
      documentData.filialId,
      documentData.filial_id,
      documentData.idFilial
    ].filter((value) => value !== undefined && value !== null).map(String);
    const legacyNames = [
      documentData.filialNombre,
      documentData.nombreFilial,
      documentData.filial
    ].filter((value) => value !== undefined && value !== null).map(normalize);

    return ids.includes(String(filial.id)) || legacyNames.includes(normalize(filial.name));
  }

  function beginFilialEdit(id) {
    const filial = state.todasFiliales.find((item) => item.id === id);
    if (!filial) return;

    state.editingFilialId = id;
    $("nombreFilialGestion").value = filial.name;
    $("btnGuardarFilial").textContent = "Guardar cambios";
    $("btnCancelarEdicionFilial").hidden = false;
    clearMessage("mensajeFilial");
    $("formFilial").scrollIntoView({ behavior: "smooth", block: "start" });
    $("nombreFilialGestion").focus();
  }

  function resetFilialForm() {
    state.editingFilialId = null;
    $("formFilial")?.reset();
    if ($("btnGuardarFilial")) {
      $("btnGuardarFilial").textContent = "Agregar filial";
      delete $("btnGuardarFilial").dataset.originalText;
    }
    if ($("btnCancelarEdicionFilial")) $("btnCancelarEdicionFilial").hidden = true;
    clearMessage("mensajeFilial");
  }

  async function saveFilial(event) {
    event.preventDefault();
    clearMessage("mensajeFilial");

    const name = clean($("nombreFilialGestion")?.value).replace(/\s+/g, " ");
    if (!name) {
      showMessage("mensajeFilial", "Ingrese el nombre de la filial.");
      return;
    }

    if (name.length > 100) {
      showMessage("mensajeFilial", "El nombre de la filial no puede superar 100 caracteres.");
      return;
    }

    const duplicate = state.todasFiliales.find((filial) =>
      filial.id !== state.editingFilialId && normalize(filial.name) === normalize(name)
    );
    if (duplicate) {
      showMessage("mensajeFilial", `Ya existe una filial con ese nombre (${duplicate.name}). Si está inactiva, puede reactivarla.`);
      return;
    }

    const button = $("btnGuardarFilial");
    setBusy(button, true, state.editingFilialId ? "GUARDANDO..." : "AGREGANDO...");

    try {
      const filialRef = database().collection(C.FILIALES);

      if (state.editingFilialId) {
        const current = state.todasFiliales.find((filial) => filial.id === state.editingFilialId);
        if (!current) throw new Error("No se encontró la filial que intenta modificar.");

        await filialRef.doc(state.editingFilialId).update({
          nombre: name,
          nombreFilial: name,
          filial: name,
          actualizadaEn: serverTimestamp(),
          actualizadaPor: state.usuario.uid
        });

        if (normalize(current.name) !== normalize(name)) {
          await updateLinkedCurrentNames(state.editingFilialId, current.name, name);
        }

        resetFilialForm();
        await loadFiliales();
        await loadUsers();
        showMessage("mensajeFilial", "El nombre de la filial se actualizó correctamente. Los datos históricos de reuniones finalizadas se conservan como estaban.", "success");
      } else {
        await filialRef.add({
          nombre: name,
          nombreFilial: name,
          filial: name,
          activa: true,
          activo: true,
          estado: "activa",
          creadaEn: serverTimestamp(),
          creadaPor: state.usuario.uid,
          actualizadaEn: serverTimestamp(),
          actualizadaPor: state.usuario.uid
        });

        resetFilialForm();
        await loadFiliales();
        showMessage("mensajeFilial", `La filial «${name}» se agregó correctamente y ya está disponible en los formularios.`, "success");
      }
    } catch (error) {
      console.error("Error guardando la filial:", error);
      showMessage("mensajeFilial", "No se pudo guardar la filial. " + explainError(error));
    } finally {
      setBusy(button, false);
    }
  }

  async function updateLinkedCurrentNames(filialId, oldName, newName) {
    const bd = database();
    const updates = [];

    // Personas: su registro permanece independiente de la filial.
    const userDocs = await findDocumentsLinkedToFilial(C.USUARIOS, filialId, oldName);
    userDocs.forEach((doc) => updates.push({
      ref: doc.ref,
      data: {
        filialNombre: newName,
        filial: newName,
        nombreFilial: newName,
        actualizadaEn: serverTimestamp(),
        actualizadaPor: state.usuario.uid
      }
    }));

    // Solo se actualizan las reuniones que siguen preparadas o activas.
    // Reuniones finalizadas/canceladas conservan el nombre histórico.
    const meetingDocs = await findDocumentsLinkedToFilial(C.JUNTAS, filialId, oldName);
    meetingDocs.forEach((doc) => {
      if (meetingIsFinished(doc.data())) return;
      updates.push({
        ref: doc.ref,
        data: {
          filialNombre: newName,
          filial: newName,
          actualizadaEn: serverTimestamp(),
          actualizadaPor: state.usuario.uid
        }
      });
    });

    // Firestore limita cada batch a 500 escrituras; usamos bloques de 400.
    for (let index = 0; index < updates.length; index += 400) {
      const batch = bd.batch();
      updates.slice(index, index + 400).forEach((item) => batch.update(item.ref, item.data));
      await batch.commit();
    }
  }

  async function findDocumentsLinkedToFilial(collectionName, filialId, filialName) {
    const collection = database().collection(collectionName);
    const queries = [];

    ["filialId", "filial_id", "idFilial"].forEach((field) => {
      queries.push(collection.where(field, "==", filialId).get());
    });

    if (filialName) {
      ["filialNombre", "nombreFilial", "filial"].forEach((field) => {
        queries.push(collection.where(field, "==", filialName).get());
      });
    }

    const snapshots = await Promise.all(queries);
    const documents = new Map();
    snapshots.forEach((snapshot) => snapshot.docs.forEach((doc) => {
      documents.set(doc.id, doc);
    }));

    return [...documents.values()].filter((doc) => documentBelongsToFilial(doc.data(), { id: filialId, name: filialName }));
  }

  async function toggleFilial(id) {
    const filial = state.todasFiliales.find((item) => item.id === id);
    if (!filial) return;

    const enabled = filialIsEnabled(filial.data);
    const next = !enabled;

    if (enabled) {
      const unfinishedMeeting = state.reuniones.find((meeting) =>
        !meetingIsFinished(meeting) && documentBelongsToFilial(meeting, filial)
      );
      if (unfinishedMeeting) {
        showMessage("mensajeFilial", `No se puede desactivar «${filial.name}» mientras exista la reunión «${getMeetingName(unfinishedMeeting)}» sin finalizar o cancelar. Resuelva esa reunión primero para no impedir el acceso a sus participantes.`, "warning");
        return;
      }
    }

    const action = next ? "reactivar" : "desactivar";
    const detail = next
      ? "volverá a aparecer en los formularios para nuevas reuniones y registros."
      : "dejará de aparecer en los formularios. Los usuarios, reuniones y votos existentes se conservarán.";

    const accepted = await askAdminConfirmation({
      title: next ? "Reactivar filial" : "Desactivar filial",
      message: `¿Desea ${action} la filial «${filial.name}»?`,
      detail,
      confirmText: next ? "Reactivar filial" : "Desactivar filial",
      tone: next ? "success" : "warning"
    });
    if (!accepted) return;

    try {
      await database().collection(C.FILIALES).doc(id).update({
        activa: next,
        activo: next,
        estado: next ? "activa" : "inactiva",
        actualizadaEn: serverTimestamp(),
        actualizadaPor: state.usuario.uid
      });

      await loadFiliales();
      showMessage("mensajeFilial", `La filial «${filial.name}» quedó ${next ? "activa" : "inactiva"}.`, "success");
    } catch (error) {
      console.error("Error cambiando el estado de la filial:", error);
      showMessage("mensajeFilial", "No se pudo cambiar el estado de la filial. " + explainError(error));
    }
  }

  async function deleteFilial(id) {
    const filial = state.todasFiliales.find((item) => item.id === id);
    if (!filial) return;

    let counts;
    try {
      const names = [
        ["usuario(s)", C.USUARIOS],
        ["reunión(es)", C.JUNTAS],
        ["votación(es)", C.VOTACIONES],
        ["voto(s)", C.VOTOS],
        ["registro(s) de participación", C.PARTICIPANTES]
      ];
      const found = await Promise.all(names.map(([, name]) =>
        findDocumentsLinkedToFilial(name, filial.id, filial.name)
      ));
      counts = names.map(([label], index) => ({ label, total: found[index].length })).filter((item) => item.total > 0);
    } catch (error) {
      console.error("Error comprobando la filial:", error);
      showMessage("mensajeFilial", "No se pudo comprobar si la filial tiene datos asociados, así que no se borró nada. " + explainError(error));
      return;
    }

    if (counts.length) {
      const list = counts.map((item) => `${item.total} ${item.label}`).join(", ");
      const hasUsers = counts.some((item) => item.label === "usuario(s)");
      const hasMeetings = counts.some((item) => item.label === "reunión(es)");
      const steps = [];
      if (hasUsers) steps.push("elimine o cambie de filial a sus usuarios (sección «Gestionar usuarios»)");
      if (hasMeetings) steps.push("elimine sus reuniones (sección «Historial» o «Administrar reunión»)");
      showMessage("mensajeFilial", `No se puede eliminar «${filial.name}» porque tiene ${list}. Para poder borrarla, ${steps.length ? steps.join(" y ") : "elimine primero esos registros"}. Si solo quiere que deje de aparecer en los formularios, use «Desactivar».`, "warning");
      return;
    }

    const accepted = await askAdminConfirmation({
      title: "Eliminar filial",
      message: `¿Eliminar definitivamente la filial «${filial.name}»?`,
      detail: "No tiene usuarios, reuniones ni votos asociados. Esta acción no se puede deshacer.",
      confirmText: "Eliminar definitivamente",
      tone: "danger"
    });
    if (!accepted) return;

    try {
      await database().collection(C.FILIALES).doc(id).delete();
      if (state.editingFilialId === id) resetFilialForm();
      await loadFiliales();
      showMessage("mensajeFilial", `La filial «${filial.name}» se eliminó.`, "success");
      showAdminToast("Filial eliminada.", "success");
    } catch (error) {
      console.error("Error eliminando filial:", error);
      showMessage("mensajeFilial", "No se pudo eliminar la filial. " + explainError(error));
    }
  }

  // ----------------------------------------------------------
  // Historial de reuniones y detalle de resultados antiguos
  // ----------------------------------------------------------

  function bindHistory() {
    $("buscarHistorial")?.addEventListener("input", renderHistory);
    $("filtroEstadoHistorial")?.addEventListener("change", renderHistory);
    $("listaHistorial")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-history-detail]");
      if (button) await showHistoryDetail(button.dataset.historyDetail);
      const remove = event.target.closest("[data-history-delete]");
      if (remove) await deleteMeeting(remove.dataset.historyDelete);
    });
    $("btnCerrarDetalleHistorial")?.addEventListener("click", () => {
      $("detalleHistorial").hidden = true;
    });
  }

  function renderHistory() {
    const list = $("listaHistorial");
    if (!list || !state.usuario) return;
    const query = normalize($("buscarHistorial")?.value || "");
    const filter = $("filtroEstadoHistorial")?.value || "finalizadas";
    const meetings = state.reuniones.filter((meeting) => {
      if (filter === "finalizadas" && !meetingIsFinished(meeting)) return false;
      const haystack = normalize(`${getMeetingName(meeting)} ${meeting.filialNombre || meeting.filial || ""}`);
      return haystack.includes(query);
    }).sort((a, b) => {
      const created = (m) => asDate(m.creadaEn || m.createdAt || m.fechaCreacion || m.fechaReunion)?.getTime() || 0;
      return created(b) - created(a);
    });

    list.replaceChildren();
    if (!meetings.length) {
      list.appendChild(safeElement("p", "estado-vacio", filter === "finalizadas" ? "Todavía no hay reuniones finalizadas en el historial." : "No hay reuniones que coincidan con la búsqueda."));
      return;
    }

    meetings.forEach((meeting) => {
      const card = safeElement("article", "tarjeta-historial");
      const icon = safeElement("span", "icono-historial", "◷");
      icon.setAttribute("aria-hidden", "true");
      card.appendChild(icon);
      const main = safeElement("div", "historial-info");
      main.appendChild(safeElement("h3", "", getMeetingName(meeting)));
      main.appendChild(safeElement("p", "", `${meeting.filialNombre || meeting.filial || "Sin filial"} · Creada: ${formatDate(meeting.creadaEn || meeting.fechaReunion)}`));
      card.appendChild(main);
      card.appendChild(safeElement("span", `etiqueta-estado ${meetingIsFinished(meeting) ? "estado-neutral" : meetingIsActive(meeting) ? "estado-positivo" : "estado-pendiente"}`, stateLabel(meeting.estado)));
      const button = safeElement("button", "boton boton-claro", "Ver detalles");
      button.type = "button";
      button.dataset.historyDetail = meeting.id;
      card.appendChild(button);
      const remove = safeElement("button", "boton boton-borde-peligro", "Eliminar");
      remove.type = "button";
      remove.dataset.historyDelete = meeting.id;
      remove.disabled = meetingIsActive(meeting);
      remove.title = meetingIsActive(meeting) ? "Finalice o cancele la reunión para poder eliminarla" : "Eliminar la reunión y todos sus datos";
      card.appendChild(remove);
      list.appendChild(card);
    });
  }

  async function showHistoryDetail(meetingId) {
    const meeting = state.reuniones.find((m) => m.id === meetingId);
    if (!meeting) return;
    const container = $("contenidoDetalleHistorial");
    const panel = $("detalleHistorial");
    panel.hidden = false;
    $("tituloDetalleHistorial").textContent = getMeetingName(meeting);
    container.replaceChildren(safeElement("p", "texto-cargando", "Cargando las preguntas y resultados..."));
    panel.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      const [questionSnap, voteSnap] = await Promise.all([
        database().collection(C.VOTACIONES).where("juntaId", "==", meetingId).get(),
        database().collection(C.VOTOS).where("juntaId", "==", meetingId).get()
      ]);
      const questions = questionSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));
      const votes = voteSnap.docs.map((doc) => doc.data());
      state.historyCache.set(meetingId, { questions, votes });

      container.replaceChildren();
      const info = safeElement("div", "history-meta");
      info.appendChild(safeElement("p", "", `Filial: ${meeting.filialNombre || meeting.filial || "Sin filial"}`));
      info.appendChild(safeElement("p", "", `Fecha de la reunión: ${formatDate(meeting.fechaReunion)}`));
      info.appendChild(safeElement("p", "", `Estado: ${stateLabel(meeting.estado)}`));
      info.appendChild(safeElement("p", "", `Preguntas guardadas: ${questions.length}`));
      container.appendChild(info);

      if (!questions.length) {
        container.appendChild(safeElement("p", "estado-vacio", "Esta reunión no tiene preguntas registradas."));
        return;
      }

      questions.forEach((question, index) => {
        const card = safeElement("article", "tarjeta-detalle-historico-pregunta");
        const title = safeElement("h4", "", `${index + 1}. ${getQuestionText(question)}`);
        card.appendChild(title);
        card.appendChild(safeElement("p", "historial-pregunta-meta", `Estado: ${stateLabel(question.estado)} · Horario: ${question.fechaProgramada ? formatDate(question.fechaProgramada) : "Sin horario definido"}`));
        const result = { favor: 0, contra: 0, abstencion: 0 };
        votes.filter((v) => getQuestionIdForVote(v) === question.id).forEach((v) => {
          const key = classifyVote(v);
          if (key) result[key]++;
        });
        const total = result.favor + result.contra + result.abstencion;
        const row = safeElement("div", "historial-conteos");
        row.appendChild(safeElement("span", "conteo conteo-favor", `A favor: ${result.favor}`));
        row.appendChild(safeElement("span", "conteo conteo-contra", `En contra: ${result.contra}`));
        row.appendChild(safeElement("span", "conteo conteo-abstencion", `Abstención: ${result.abstencion}`));
        card.appendChild(row);
        card.appendChild(safeElement("p", "total-resultados", `Total de votos registrados: ${total}`));
        container.appendChild(card);
      });
    } catch (error) {
      console.error("Error cargando detalle del historial:", error);
      container.replaceChildren(safeElement("p", "mensaje mensaje-error", "No se pudo cargar el detalle. " + explainError(error)));
    }
  }

})();
