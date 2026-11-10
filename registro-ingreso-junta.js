/*
 * ADEP V2.1 — Registro de ingreso a una reunión.
 *
 * votante.js lo llama justo después de validar la sesión del votante
 * (cédula + PIN ya comprobados). El panel de administración consulta
 * la colección `participantesJunta` para mostrar la participación.
 *
 * - Un solo documento por persona y reunión: entrar de nuevo no crea
 *   duplicados y NO borra la hora del primer ingreso.
 * - No se guarda el PIN.
 */
(function () {
  'use strict';

  window.ADEPRegistrarIngresoJunta = async function ADEPRegistrarIngresoJunta(datos) {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
      throw new Error('Firestore no está disponible. Revise firebase-config.js.');
    }
    if (!datos || !String(datos.juntaId || '').trim()) {
      throw new Error('Falta el identificador de la reunión.');
    }

    const juntaId = String(datos.juntaId).trim();
    const usuarioId = String(datos.usuarioId || datos.userId || '').trim();
    const cedula = String(datos.cedula || datos.identificacion || '').replace(/\D/g, '').slice(0, 9);
    const clave = usuarioId || cedula;
    if (!clave) {
      throw new Error('Se necesita el identificador del participante o su cédula.');
    }

    const safeKey = clave.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ref = db.collection('participantesJunta').doc(`${juntaId}_${safeKey}`);
    const stamp = firebase.firestore.FieldValue.serverTimestamp();

    const registro = {
      juntaId,
      usuarioId: usuarioId || null,
      nombreCompleto: String(datos.nombre || datos.nombreCompleto || '').trim(),
      cedula,
      tipoRepresentante: String(datos.tipoRepresentante || '').trim(),
      filialId: String(datos.filialId || '').trim() || null,
      filialNombre: String(datos.filialNombre || datos.filial || '').trim(),
      ultimoAccesoEn: stamp,
      actualizadaEn: stamp
    };

    // La hora del primer ingreso solo se escribe la primera vez.
    const existente = await ref.get();
    if (!existente.exists) registro.ingresoEn = stamp;

    await ref.set(registro, { merge: true });
    return ref.id;
  };
})();
