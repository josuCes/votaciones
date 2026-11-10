/* ============================================================
   ADEP V2.1 — RELOJ DEL SERVIDOR
   Archivo: reloj-servidor.js

   PROBLEMA QUE RESUELVE
   ------------------------------------------------------------
   La hora de fin de cada votación (fechaFin) se calcula con la
   hora del SERVIDOR de Firebase, pero antes se comparaba contra
   Date.now(), que es la hora del TELÉFONO o la computadora.
   Si un solo dispositivo tenía la hora adelantada, creía que la
   votación ya había terminado y la cerraba para todos.

   CÓMO FUNCIONA
   ------------------------------------------------------------
   1. Escribe una marca de tiempo del servidor en la colección
      "relojServidor" y la vuelve a leer.
   2. Calcula la diferencia entre el reloj del servidor y el del
      dispositivo (offset). Hace 2 mediciones y usa la más precisa.
   3. ADEPReloj.ahora() devuelve la hora del servidor estimada.
   4. Se vuelve a sincronizar cada 5 minutos y al recuperar la
      conexión.

   Si la sincronización falla, estaSincronizado() devuelve false.
   En ese caso ningún dispositivo debe cerrar votaciones por
   tiempo; el administrador puede cerrarlas manualmente.

   REGLAS DE FIRESTORE (etapa final)
   ------------------------------------------------------------
   Habrá que permitir crear/actualizar documentos en
   relojServidor/{id} que solo contengan el campo "t".
============================================================ */

(function () {
  'use strict';

  const COLECCION = 'relojServidor';
  const MUESTRAS = 2;
  const REPETIR_CADA_MS = 5 * 60 * 1000;

  const reloj = {
    offsetMs: 0,
    sincronizado: false,
    intentoTerminado: false,
    ultimaSincronizacion: 0,
    enCurso: null
  };

  function identificadorEquipo() {
    const nuevo = () =>
      'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try {
      let id = sessionStorage.getItem('adepRelojId');
      if (!id) {
        id = nuevo();
        sessionStorage.setItem('adepRelojId', id);
      }
      return id;
    } catch (_) {
      return nuevo();
    }
  }

  async function medirUnaVez(ref) {
    const t0 = Date.now();
    await ref.set({ t: firebase.firestore.FieldValue.serverTimestamp() });
    const tEscritura = Date.now();
    const doc = await ref.get({ source: 'server' });
    const t1 = Date.now();

    const marca = doc.data() && doc.data().t;
    if (!marca || typeof marca.toMillis !== 'function') {
      throw new Error('El servidor no devolvió la marca de tiempo.');
    }

    // El servidor puso su hora aproximadamente a la mitad de la escritura.
    const estimadoLocal = (t0 + tEscritura) / 2;

    return {
      offset: marca.toMillis() - estimadoLocal,
      error: t1 - t0
    };
  }

  async function sincronizar() {
    if (reloj.enCurso) return reloj.enCurso;

    reloj.enCurso = (async () => {
      try {
        if (typeof db === 'undefined' || !db || typeof firebase === 'undefined') {
          throw new Error('Firestore no está disponible.');
        }

        const ref = db.collection(COLECCION).doc(identificadorEquipo());
        let mejor = null;

        for (let i = 0; i < MUESTRAS; i++) {
          const muestra = await medirUnaVez(ref);
          if (!mejor || muestra.error < mejor.error) mejor = muestra;
        }

        reloj.offsetMs = mejor.offset;
        reloj.sincronizado = true;
        reloj.ultimaSincronizacion = Date.now();
      } catch (error) {
        console.warn('ADEP: no se pudo sincronizar el reloj con el servidor.', error);
        // Se conserva el último offset conocido, si lo había.
      } finally {
        reloj.intentoTerminado = true;
        reloj.enCurso = null;
      }
      return reloj.sincronizado;
    })();

    return reloj.enCurso;
  }

  window.ADEPReloj = {
    sincronizar,
    ahora: () => Date.now() + reloj.offsetMs,
    estaSincronizado: () => reloj.sincronizado,
    // true cuando ya hubo al menos un intento (aunque haya fallado).
    intentoTerminado: () => reloj.intentoTerminado,
    desfaseMs: () => reloj.offsetMs
  };

  function iniciar() {
    sincronizar();
    window.setInterval(sincronizar, REPETIR_CADA_MS);
    window.addEventListener('online', sincronizar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
