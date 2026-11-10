/* ============================================================
   ADEP V2.0 — CONFIRMACIONES DEL VOTANTE
   Archivo: votante-confirmacion.js

   Este archivo NO modifica votante.js. Funciona "por encima":

   1. Cuando la persona toca A FAVOR / EN CONTRA / ABSTENCIÓN,
      se muestra una ventana: "¿Está seguro?" con ACEPTAR y
      REGRESAR. Solo si acepta, se ejecuta el clic original,
      y votante.js registra el voto exactamente igual que antes.

   2. Cuando toca SALIR DE LA REUNIÓN, se muestra una ventana
      propia (en lugar del cuadro feo del navegador). Al aceptar,
      votante.js ejecuta su salida normal.

   Si este archivo falla o se quita del HTML, el sistema sigue
   funcionando como antes (sin ventana de confirmación).
============================================================ */

(() => {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const modal = $("modalConfirmacion");
    const tarjeta = $("modalTarjeta");

    if (!modal || !tarjeta) {
        return;
    }

    const elementos = {
        icono: $("modalIcono"),
        titulo: $("modalTitulo"),
        eleccion: $("modalEleccion"),
        pregunta: $("modalPregunta"),
        texto: $("modalTexto"),
        tiempo: $("modalTiempo"),
        aceptar: $("modalBtnAceptar"),
        regresar: $("modalBtnRegresar")
    };

    if (!elementos.aceptar || !elementos.regresar) {
        return;
    }

    // Tiempo mínimo antes de poder pulsar ACEPTAR. Evita que un
    // doble toque accidental confirme el voto sin querer.
    const RETARDO_ACEPTAR_MS = 700;

    const TIPOS_VOTO = {
        favor: {
            titulo: "¿Está seguro de que está a favor?",
            eleccion: "A FAVOR",
            icono: "✓"
        },
        contra: {
            titulo: "¿Está seguro de que está en contra?",
            eleccion: "EN CONTRA",
            icono: "✕"
        },
        abstencion: {
            titulo: "¿Está seguro de que desea abstenerse?",
            eleccion: "ABSTENCIÓN",
            icono: "—"
        }
    };

    let modo = null;          // "voto" | "salir" | null
    let botonOrigen = null;
    let focoPrevio = null;
    let omitirInterceptor = false;
    let temporizadorAceptar = null;
    let temporizadorVigilancia = null;


    // ========================================================
    // ABRIR Y CERRAR
    // ========================================================

    function abrirModal() {
        focoPrevio = document.activeElement;

        modal.hidden = false;
        document.body.classList.add("modal-abierto");

        // Retardo de seguridad para ACEPTAR.
        elementos.aceptar.disabled = true;

        window.clearTimeout(temporizadorAceptar);

        temporizadorAceptar = window.setTimeout(() => {
            elementos.aceptar.disabled = false;
        }, RETARDO_ACEPTAR_MS);

        // El foco inicia en REGRESAR (la opción más segura).
        elementos.regresar.focus();

        window.clearInterval(temporizadorVigilancia);

        temporizadorVigilancia = window.setInterval(
            vigilarVotacion,
            300
        );
    }


    function cerrarModal() {
        window.clearTimeout(temporizadorAceptar);
        window.clearInterval(temporizadorVigilancia);

        modal.hidden = true;
        document.body.classList.remove("modal-abierto");

        modo = null;

        const anterior = focoPrevio;

        botonOrigen = null;
        focoPrevio = null;

        if (anterior && typeof anterior.focus === "function") {
            try {
                anterior.focus();
            } catch (error) {
                /* El elemento pudo haberse ocultado. */
            }
        }
    }


    // ========================================================
    // CONFIGURAR EL CONTENIDO SEGÚN EL TIPO
    // ========================================================

    function abrirConfirmacionDeVoto(boton) {
        const tipo = TIPOS_VOTO[boton.dataset.voto];

        if (!tipo) {
            return false;
        }

        modo = "voto";
        botonOrigen = boton;

        tarjeta.dataset.tipo = boton.dataset.voto;

        elementos.icono.textContent = tipo.icono;
        elementos.titulo.textContent = tipo.titulo;

        elementos.eleccion.textContent = tipo.eleccion;
        elementos.eleccion.hidden = false;

        const textoPregunta =
            $("textoPreguntaVotante")?.textContent.trim() || "";

        elementos.pregunta.textContent = textoPregunta;
        elementos.pregunta.hidden = !textoPregunta;

        elementos.texto.textContent =
            "Una vez aceptado, no podrá cambiar su voto.";

        elementos.tiempo.hidden = false;
        actualizarTiempo();

        elementos.aceptar.textContent = "✓ ACEPTAR";
        elementos.regresar.textContent = "← REGRESAR";

        abrirModal();

        return true;
    }


    function abrirConfirmacionDeSalida(boton) {
        modo = "salir";
        botonOrigen = boton;

        tarjeta.dataset.tipo = "salir";

        elementos.icono.textContent = "!";
        elementos.titulo.textContent =
            "¿Desea salir de la reunión?";

        elementos.eleccion.hidden = true;
        elementos.pregunta.hidden = true;
        elementos.tiempo.hidden = true;

        elementos.texto.textContent =
            "Para volver a participar deberá ingresar nuevamente.";

        elementos.aceptar.textContent = "SÍ, SALIR";
        elementos.regresar.textContent = "← QUEDARME AQUÍ";

        abrirModal();
    }


    // ========================================================
    // TIEMPO RESTANTE DENTRO DE LA VENTANA
    // ========================================================

    function actualizarTiempo() {
        const cronometro = $("cronometroVotacion");

        if (!cronometro || !elementos.tiempo) {
            return;
        }

        const texto = cronometro.textContent.trim();

        elementos.tiempo.textContent =
            texto && texto !== "…"
                ? `Tiempo restante: ${texto}`
                : "";
    }


    // Si la votación se cierra o el tiempo se agota mientras la
    // ventana está abierta, la ventana se cierra sola.
    function vigilarVotacion() {
        if (modo !== "voto") {
            return;
        }

        const panel = $("panelVotacion");
        const opciones = $("opcionesVoto");

        const votacionDisponible =
            panel && !panel.hidden &&
            opciones && !opciones.hidden &&
            botonOrigen && !botonOrigen.disabled;

        if (!votacionDisponible) {
            cerrarModal();

            return;
        }

        actualizarTiempo();
    }


    // ========================================================
    // EJECUTAR LA ACCIÓN ORIGINAL (la de votante.js)
    // ========================================================

    function ejecutarClicOriginal(boton, aceptarConfirmNativo) {
        const confirmOriginal = window.confirm;

        omitirInterceptor = true;

        // votante.js usa confirm() al salir. Como ya preguntamos
        // con nuestra ventana, se responde "sí" automáticamente
        // solo durante este clic.
        if (aceptarConfirmNativo) {
            window.confirm = () => true;
        }

        try {
            boton.click();
        } finally {
            omitirInterceptor = false;
            window.confirm = confirmOriginal;
        }
    }


    function aceptar() {
        if (!modo || !botonOrigen || elementos.aceptar.disabled) {
            return;
        }

        const boton = botonOrigen;
        const tipo = modo;

        cerrarModal();

        ejecutarClicOriginal(boton, tipo === "salir");
    }


    // ========================================================
    // EVENTOS
    // ========================================================

    // Se escucha en la fase de captura para actuar ANTES que
    // los eventos creados por votante.js.
    document.addEventListener(
        "click",
        (evento) => {
            if (omitirInterceptor) {
                return;
            }

            const objetivo = evento.target;

            if (!(objetivo instanceof Element)) {
                return;
            }

            const botonVoto = objetivo.closest(
                ".boton-voto[data-voto]"
            );

            if (botonVoto) {
                if (botonVoto.disabled) {
                    return;
                }

                evento.preventDefault();
                evento.stopImmediatePropagation();

                abrirConfirmacionDeVoto(botonVoto);

                return;
            }

            const botonSalir = objetivo.closest(
                "#btnSalirReunion"
            );

            if (botonSalir) {
                evento.preventDefault();
                evento.stopImmediatePropagation();

                abrirConfirmacionDeSalida(botonSalir);
            }
        },
        true
    );


    elementos.aceptar.addEventListener("click", aceptar);

    elementos.regresar.addEventListener("click", cerrarModal);


    // Tocar fuera de la tarjeta equivale a REGRESAR (opción segura).
    modal.addEventListener("click", (evento) => {
        if (evento.target === modal) {
            cerrarModal();
        }
    });


    document.addEventListener("keydown", (evento) => {
        if (modal.hidden) {
            return;
        }

        if (evento.key === "Escape") {
            evento.preventDefault();
            cerrarModal();

            return;
        }

        // Mantener el foco dentro de la ventana.
        if (evento.key === "Tab") {
            const focoPosible = [
                elementos.aceptar,
                elementos.regresar
            ].filter((boton) => !boton.disabled);

            if (focoPosible.length === 0) {
                evento.preventDefault();

                return;
            }

            const primero = focoPosible[0];
            const ultimo = focoPosible[focoPosible.length - 1];

            if (
                evento.shiftKey &&
                document.activeElement === primero
            ) {
                evento.preventDefault();
                ultimo.focus();
            } else if (
                !evento.shiftKey &&
                document.activeElement === ultimo
            ) {
                evento.preventDefault();
                primero.focus();
            } else if (
                !modal.contains(document.activeElement)
            ) {
                evento.preventDefault();
                primero.focus();
            }
        }
    });

})();
