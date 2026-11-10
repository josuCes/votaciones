
/* ============================================================
   ADEP V2.0 — SISTEMA COMPLETO DEL VOTANTE
   Archivo: votante.js

   RESPONSABILIDADES
   ------------------------------------------------------------
   1. Cargar las filiales de Firebase.
   2. Solicitar cédula, filial y PIN.
   3. Validar el participante y su reunión.
   4. Mantener la sesión durante la participación.
   5. Verificar que la reunión siga activa.
   6. Escuchar las preguntas en tiempo real.
   7. Mostrar las preguntas publicadas por el administrador.
   8. Permitir una respuesta por participante y pregunta.
   9. Registrar los votos en Firestore.
   10. Utilizar una fecha de cierre compartida.
   11. Impedir nuevos votos después del cierre local.
   12. Cerrar votaciones vencidas cuando sea posible.
   13. Mostrar resultados actualizados.
   14. Regresar a la pantalla de espera entre preguntas.
   15. Controlar errores y cambios de conexión.

   ARCHIVOS UTILIZADOS
   ------------------------------------------------------------
   index.html
   votante.html
   firebase-config.js
   estilos.css

   COLECCIONES
   ------------------------------------------------------------
   filiales
   usuarios
   juntas
   votaciones
   votos

   IMPORTANTE
   ------------------------------------------------------------
   La validación del navegador no sustituye las reglas
   de seguridad de Firestore ni una validación de servidor.
============================================================ */


(() => {
    "use strict";


    // ========================================================
    // 1. CONFIGURACIÓN GENERAL
    // ========================================================

    const COLECCIONES = {
        FILIALES: "filiales",
        USUARIOS: "usuarios",
        JUNTAS: "juntas",
        VOTACIONES: "votaciones",
        VOTOS: "votos"
    };

    const CLAVE_SESION = "adepV2SesionVotante";

    const DURACION_VOTACION_SEGUNDOS = 60;

    const ESTADOS = {
        REUNION_ACTIVA: "activa",
        REUNION_FINALIZADA: "finalizada",

        PREGUNTA_PREPARADA: "preparada",
        VOTACION_ABIERTA: "abierta",
        VOTACION_FINALIZADA: "finalizada"
    };

    const $ = (id) => document.getElementById(id);

    // Hora del servidor (ver reloj-servidor.js). Si ese archivo no
    // cargó, se usa el reloj del dispositivo como último recurso.
    const ahoraServidor = () =>
        window.ADEPReloj ? window.ADEPReloj.ahora() : Date.now();

    const relojSincronizado = () =>
        Boolean(window.ADEPReloj && window.ADEPReloj.estaSincronizado());

    // Hasta que el reloj se haya comparado con el servidor (o haya
    // fallado el intento) no se declara vencida ninguna votación.
    const relojListoParaVencer = () =>
        !window.ADEPReloj ||
        window.ADEPReloj.estaSincronizado() ||
        window.ADEPReloj.intentoTerminado();

    // Margen para que el administrador cierre primero la votación.
    const MARGEN_CIERRE_VOTANTE_MS = 3000;


    // ========================================================
    // 2. ESTADO DE LA APLICACIÓN
    // ========================================================

    const estado = {
        pagina: null,

        sesion: null,

        filiales: [],
        reunion: null,
        preguntas: [],
        votos: [],

        votacionActualId: null,
        votacionActual: null,

        votoPropio: null,
        yaVoto: false,
        comprobandoVoto: false,

        generacionVotacion: 0,

        // Impide reabrir visualmente una pregunta cuyo
        // tiempo ya terminó en este navegador.
        votacionesVencidas: new Set(),

        // Evita repetir cierres simultáneos.
        cierresEnProceso: new Set(),

        finalesConfigurados: new Set(),

        suscripcionReunion: null,
        suscripcionPreguntas: null,
        suscripcionVotos: null,

        intervalo: null,

        conectado: navigator.onLine
    };


    // ========================================================
    // 3. INICIO DE LA APLICACIÓN
    // ========================================================

    document.addEventListener(
        "DOMContentLoaded",
        iniciarAplicacion
    );


    function iniciarAplicacion() {
        conectarEventosDeConectividad();

        if (!firebaseDisponible()) {
            mostrarErrorInicial(
                "No se pudo iniciar Firebase. " +
                "Revise firebase-config.js y los scripts de Firebase."
            );

            return;
        }

        const formularioIngreso = $("formIngresoVotante");

        if (formularioIngreso) {
            estado.pagina = "ingreso";
            iniciarPaginaIngreso();

            return;
        }

        if ($("panelVotacion") || $("panelEspera")) {
            estado.pagina = "votante";
            iniciarPaginaVotante();

            return;
        }

        console.warn(
            "ADEP V2.0: esta página no contiene " +
            "los elementos de ingreso ni de votación."
        );
    }


    function firebaseDisponible() {
        return (
            typeof firebase !== "undefined" &&
            typeof db !== "undefined" &&
            db !== null &&
            typeof firebase.firestore === "function"
        );
    }


    function obtenerBaseDatos() {
        if (!firebaseDisponible()) {
            throw new Error(
                "Firebase no está disponible."
            );
        }

        return db;
    }


    function obtenerMarcaTiempoServidor() {
        return firebase.firestore.FieldValue.serverTimestamp();
    }


    function obtenerTimestamp(fecha) {
        return firebase.firestore.Timestamp.fromDate(fecha);
    }


    // ========================================================
    // 4. FUNCIONES GENERALES DE TEXTO Y FECHA
    // ========================================================

    function normalizarTexto(valor) {
        return String(valor ?? "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
    }

    function formatearCedulaIngresoIndex(valor) {
    const digitos = String(valor ?? "")
        .replace(/\D/g, "")
        .slice(0, 9);

    if (digitos.length <= 1) return digitos;
    if (digitos.length <= 5) {
        return `${digitos.slice(0, 1)}-${digitos.slice(1)}`;
    }
    return `${digitos.slice(0, 1)}-${digitos.slice(1, 5)}-${digitos.slice(5, 9)}`;
}

function configurarFormatoCedulaIngresoIndex() {
    // Debe coincidir con el identificador que usa votante.js.
    const input = document.getElementById("cedula");
    if (!input) return;

    // Evita conectar el evento dos veces al mismo elemento.
    if (input.dataset.formatoCedulaIndexInicializado === "true") return;
    input.dataset.formatoCedulaIndexInicializado = "true";

    input.inputMode = "numeric";
    input.maxLength = 11;
    input.pattern = "[0-9]-[0-9]{4}-[0-9]{4}";
    input.placeholder = "1-1111-1111";
    input.required = true;

    input.addEventListener("input", () => {
        const digitos = input.value.replace(/\D/g, "").slice(0, 9);
        input.value = formatearCedulaIngresoIndex(digitos);

        const incompleta = digitos.length !== 9;
        input.setCustomValidity(
            incompleta && digitos.length > 0
                ? "La cédula debe tener exactamente 9 números."
                : ""
        );
        input.setAttribute("aria-invalid", incompleta && digitos.length > 0 ? "true" : "false");
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", configurarFormatoCedulaIngresoIndex);
} else {
    configurarFormatoCedulaIngresoIndex();
}

    function textoSeguro(valor) {
        return String(valor ?? "").trim();
    }


    function obtenerFecha(valor) {
        if (!valor) {
            return null;
        }

        if (typeof valor.toDate === "function") {
            return valor.toDate();
        }

        if (valor instanceof Date) {
            return valor;
        }

        const fecha = new Date(valor);

        return Number.isNaN(fecha.getTime())
            ? null
            : fecha;
    }


    function esTimestampFirestore(valor) {
        return Boolean(
            valor &&
            typeof valor.toMillis === "function"
        );
    }


    function fechaLegible(valor) {
        const fecha = obtenerFecha(valor);

        if (!fecha) {
            return "Sin fecha";
        }

        return new Intl.DateTimeFormat("es-CR", {
            dateStyle: "medium",
            timeStyle: "short"
        }).format(fecha);
    }


    function crearElemento(etiqueta, clase, contenido) {
        const elemento = document.createElement(etiqueta);

        if (clase) {
            elemento.className = clase;
        }

        if (contenido !== undefined && contenido !== null) {
            elemento.textContent = String(contenido);
        }

        return elemento;
    }


    function mostrarMensaje(id, texto, tipo = "error") {
        const elemento = $(id);

        if (!elemento) {
            return;
        }

        elemento.textContent = texto;
        elemento.hidden = false;

        elemento.classList.remove(
            "mensaje-error",
            "mensaje-exito",
            "mensaje-aviso"
        );

        if (tipo === "exito") {
            elemento.classList.add("mensaje-exito");
        } else if (tipo === "aviso") {
            elemento.classList.add("mensaje-aviso");
        } else {
            elemento.classList.add("mensaje-error");
        }
    }


    function limpiarMensaje(id) {
        const elemento = $(id);

        if (!elemento) {
            return;
        }

        elemento.textContent = "";
        elemento.hidden = true;

        elemento.classList.remove(
            "mensaje-error",
            "mensaje-exito",
            "mensaje-aviso"
        );
    }


    function cambiarBoton(boton, ocupado, texto = "PROCESANDO...") {
        if (!boton) {
            return;
        }

        if (ocupado) {
            if (!boton.dataset.textoOriginal) {
                boton.dataset.textoOriginal =
                    boton.textContent.trim();
            }

            boton.disabled = true;
            boton.textContent = texto;
        } else {
            boton.disabled = false;

            if (boton.dataset.textoOriginal) {
                boton.textContent =
                    boton.dataset.textoOriginal;

                delete boton.dataset.textoOriginal;
            }
        }
    }


    function obtenerMensajeError(error) {
        const codigo = error?.code || "";

        const mensajes = {
            "permission-denied":
                "La operación fue rechazada por los permisos de Firebase.",

            "unavailable":
                "Firebase no está disponible en este momento.",

            "network-request-failed":
                "No se pudo establecer una conexión con el servidor.",

            "failed-precondition":
                "La operación requiere una condición de Firebase que todavía no se cumple.",

            "deadline-exceeded":
                "La conexión tardó demasiado. Inténtelo de nuevo."
        };

        return mensajes[codigo] ||
            error?.message ||
            "Ocurrió un problema inesperado.";
    }


    // ========================================================
    // 5. IDENTIFICACIÓN DE FILIALES Y REUNIONES
    // ========================================================

    function nombreDeFilial(datos) {
        return textoSeguro(
            datos.nombre ||
            datos.nombreFilial ||
            datos.filial ||
            datos.nombreCompleto ||
            ""
        );
    }


    function nombreDeReunion(datos) {
        return textoSeguro(
            datos.nombre ||
            datos.nombreReunion ||
            datos.titulo ||
            "Reunión"
        );
    }


    function nombreDePregunta(datos) {
        return textoSeguro(
            datos.titulo ||
            datos.pregunta ||
            datos.textoPregunta ||
            datos.tema ||
            "Pregunta"
        );
    }


    function filialHabilitada(datos) {
        if (
            datos.activo === false ||
            datos.activa === false
        ) {
            return false;
        }

        const estadoFilial = normalizarTexto(
            datos.estado || ""
        );

        if (
            estadoFilial &&
            ![
                "activa",
                "activo",
                "habilitada",
                "habilitado",
                "disponible"
            ].includes(estadoFilial)
        ) {
            return false;
        }

        return true;
    }


    function reunionEstaActiva(datos) {
        if (!datos) {
            return false;
        }

        if (
            datos.activo === false ||
            datos.activa === false
        ) {
            return false;
        }

        const estadoReunion = normalizarTexto(
            datos.estado ||
            datos.estadoJunta ||
            datos.estadoReunion ||
            ""
        );

        if (
            [
                "finalizada",
                "finalizado",
                "cancelada",
                "cancelado",
                "cerrada",
                "cerrado"
            ].includes(estadoReunion)
        ) {
            return false;
        }

        if (
            [
                "activa",
                "activo",
                "abierta",
                "abierto",
                "en curso",
                "encurso"
            ].includes(estadoReunion)
        ) {
            return true;
        }

        return (
            datos.activa === true ||
            datos.activo === true
        );
    }


    function reunionFinalizada(datos) {
        const valor = normalizarTexto(
            datos?.estado ||
            datos?.estadoJunta ||
            datos?.estadoReunion ||
            ""
        );

        return [
            "finalizada",
            "finalizado",
            "cancelada",
            "cancelado",
            "cerrada",
            "cerrado"
        ].includes(valor);
    }


    function filialPerteneceAReunion(datos, filialId, filialNombre) {
        const identificadores = [
            datos.filialId,
            datos.filial_id,
            datos.idFilial,
            datos.filial,
            datos.nucleoId,
            datos.nucleo_id,
            datos.nucleo
        ]
            .filter(
                (valor) =>
                    valor !== undefined &&
                    valor !== null &&
                    String(valor).trim() !== ""
            )
            .map((valor) => String(valor).trim());

        return identificadores.some((valor) => {
            return (
                valor === String(filialId) ||
                normalizarTexto(valor) ===
                    normalizarTexto(filialNombre)
            );
        });
    }


    // ========================================================
    // 6. NORMALIZACIÓN DE LA CÉDULA
    // ========================================================

    function normalizarCedula(valor) {
        return String(valor ?? "")
            .trim()
            .replace(/[\s-]/g, "");
    }


    function variantesCedula(valorOriginal) {
        const original = String(valorOriginal ?? "").trim();
        const normalizada = normalizarCedula(original);

        const variantes = [original, normalizada];

        // Compatibilidad con registros que guardaron la
        // cédula como valor numérico en Firestore.
        if (/^\d+$/.test(normalizada)) {
            const numero = Number(normalizada);

            if (
                Number.isSafeInteger(numero) &&
                !variantes.includes(numero)
            ) {
                variantes.push(numero);
            }
        }

        return [
            ...new Set(variantes.filter(
                (valor) => valor !== ""
            ))
        ];
    }


    // ========================================================
    // 7. INICIO DE INDEX.HTML
    // ========================================================

    async function iniciarPaginaIngreso() {
        const formulario = $("formIngresoVotante");
        const boton = $("btnIngresar");
        const selector = $("filial");

        if (
            !formulario ||
            !selector ||
            !$("pinReunion") ||
            !$("cedula")
        ) {
            mostrarMensaje(
                "mensajeIngreso",
                "No se encontraron todos los campos de ingreso."
            );

            return;
        }

        formulario.addEventListener(
            "submit",
            gestionarIngreso
        );

        $("cedula").addEventListener(
            "input",
            limpiarMensajeDeIngreso
        );

        $("pinReunion").addEventListener(
            "input",
            limpiarMensajeDeIngreso
        );

        selector.addEventListener(
            "change",
            limpiarMensajeDeIngreso
        );

        cambiarBoton(
            boton,
            true,
            "CARGANDO..."
        );

        selector.disabled = true;
        $("pinReunion").disabled = true;
        $("cedula").disabled = true;

        try {
            await cargarFiliales();

            if (estado.filiales.length > 0) {
                selector.disabled = false;
                $("pinReunion").disabled = false;
                $("cedula").disabled = false;

                cambiarBoton(boton, false);
            }

        } catch (error) {
            console.error(
                "Error al inicializar el ingreso:",
                error
            );

            mostrarMensaje(
                "mensajeIngreso",
                "No fue posible cargar las filiales. " +
                obtenerMensajeError(error)
            );

            cambiarBoton(boton, false);
        }
    }


    function limpiarMensajeDeIngreso() {
        limpiarMensaje("mensajeIngreso");
    }


    async function cargarFiliales() {
        const selector = $("filial");

        const resultado = await obtenerBaseDatos()
            .collection(COLECCIONES.FILIALES)
            .get();

        estado.filiales = resultado.docs
            .map((documento) => {
                const datos = documento.data();

                return {
                    id: documento.id,
                    datos: datos,
                    nombre: nombreDeFilial(datos)
                };
            })
            .filter((filial) => {
                return (
                    filial.nombre &&
                    filialHabilitada(filial.datos)
                );
            })
            .sort((a, b) =>
                a.nombre.localeCompare(
                    b.nombre,
                    "es"
                )
            );

        selector.replaceChildren();

        const inicial = document.createElement("option");

        inicial.value = "";
        inicial.textContent = estado.filiales.length
            ? "Seleccione su filial"
            : "No hay filiales disponibles";

        selector.appendChild(inicial);

        for (const filial of estado.filiales) {
            const opcion = document.createElement("option");

            opcion.value = filial.id;
            opcion.textContent = filial.nombre;

            selector.appendChild(opcion);
        }

        if (estado.filiales.length === 0) {
            selector.disabled = true;

            throw new Error(
                "No hay filiales habilitadas en Firestore."
            );
        }
    }


    // ========================================================
    // 8. BUSCAR Y VALIDAR AL PARTICIPANTE
    // ========================================================

    async function buscarUsuarioPorCedula(cedulaOriginal) {
        const bd = obtenerBaseDatos();

        const valores = variantesCedula(cedulaOriginal);

        const campos = [
            "cedula",
            "identificacion",
            "numeroCedula",
            "documentoIdentidad"
        ];

        const encontrados = new Map();

        /*
           Se consultan campos concretos en vez de descargar
           toda la colección de usuarios.
        */

        for (const campo of campos) {
            for (const valor of valores) {
                const resultado = await bd
                    .collection(COLECCIONES.USUARIOS)
                    .where(campo, "==", valor)
                    .limit(10)
                    .get();

                for (const documento of resultado.docs) {
                    encontrados.set(
                        documento.id,
                        {
                            id: documento.id,
                            datos: documento.data()
                        }
                    );
                }
            }
        }

        const cedulaNormalizada =
            normalizarCedula(cedulaOriginal);

        return [...encontrados.values()].find(
            (usuario) => {
                const datos = usuario.datos;

                const valorAlmacenado =
                    datos.cedula ??
                    datos.identificacion ??
                    datos.numeroCedula ??
                    datos.documentoIdentidad ??
                    "";

                return (
                    normalizarCedula(valorAlmacenado) ===
                    cedulaNormalizada
                );
            }
        ) || null;
    }


    function usuarioEsAdministrador(datos) {
        const rol = normalizarTexto(
            datos.rol ||
            datos.tipoUsuario ||
            datos.tipo ||
            datos.role ||
            ""
        );

        const roles = Array.isArray(datos.roles)
            ? datos.roles.map(normalizarTexto)
            : [];

        return (
            rol === "admin" ||
            rol === "administrador" ||
            roles.includes("admin") ||
            roles.includes("administrador") ||
            datos.esAdministrador === true ||
            datos.isAdmin === true ||
            datos.administrador === true
        );
    }


    function usuarioEstaHabilitado(datos) {
        if (
            datos.activo === false ||
            datos.activa === false
        ) {
            return false;
        }

        const estadoUsuario = normalizarTexto(
            datos.estado || ""
        );

        if (
            [
                "inactivo",
                "inactiva",
                "deshabilitado",
                "deshabilitada",
                "suspendido",
                "suspendida",
                "bloqueado",
                "bloqueada"
            ].includes(estadoUsuario)
        ) {
            return false;
        }

        return true;
    }


    function usuarioPerteneceAFilial(
        datos,
        filialId,
        filialNombre
    ) {
        return filialPerteneceAReunion(
            datos,
            filialId,
            filialNombre
        );
    }


    function obtenerNombreUsuario(datos) {
        const completo = textoSeguro(
            datos.nombreCompleto ||
            datos.nombre ||
            datos.nombreUsuario ||
            datos.displayName ||
            ""
        );

        if (completo) {
            return completo;
        }

        const compuesto = [
            datos.nombres,
            datos.apellidos
        ].filter(Boolean).join(" ");

        return compuesto || "Participante";
    }


    async function validarUsuarioParaReunion(
        cedula,
        filialId,
        filialNombre
    ) {
        const usuario = await buscarUsuarioPorCedula(cedula);

        if (!usuario) {
            throw new Error(
                "La cédula no está registrada o los datos no coinciden."
            );
        }

        if (!usuarioEstaHabilitado(usuario.datos)) {
            throw new Error(
                "Este usuario no está habilitado para participar."
            );
        }

        if (usuarioEsAdministrador(usuario.datos)) {
            throw new Error(
                "Las cuentas administrativas no pueden votar."
            );
        }

        if (
            !usuarioPerteneceAFilial(
                usuario.datos,
                filialId,
                filialNombre
            )
        ) {
            throw new Error(
                "La cédula no está asociada a la filial seleccionada."
            );
        }

        return usuario;
    }


    // ========================================================
    // 9. BUSCAR REUNIÓN ACTIVA ÚNICAMENTE POR PIN
    // ========================================================

    /*
       La filial seleccionada identifica al votante, NO a la reunión.
       Todos los miembros pueden reunirse en una misma ubicación
       aunque estén registrados en filiales diferentes.

       Por eso, el PIN identifica la junta activa sin compararla
       con la filial del usuario.
    */
    async function buscarReunionActiva(pin) {
        const bd = obtenerBaseDatos();

        const resultado = await bd
            .collection(COLECCIONES.JUNTAS)
            .where("pin", "==", pin)
            .get();

        const candidatas = resultado.docs
            .map((documento) => ({
                id: documento.id,
                datos: documento.data()
            }))
            .filter((reunion) => reunionEstaActiva(reunion.datos));

        // El PIN debe identificar una sola reunión activa en
        // todo el sistema, independientemente de su ubicación.
        if (candidatas.length > 1) {
            throw new Error(
                "Hay varias reuniones activas con ese PIN. " +
                "El administrador debe asignar un PIN único a cada reunión."
            );
        }

        return candidatas[0] || null;
    }


    // ========================================================
    // 10. PROCESAR EL INGRESO
    // ========================================================

    async function gestionarIngreso(evento) {
        evento.preventDefault();

        limpiarMensaje("mensajeIngreso");

        const selector = $("filial");
        const campoCedula = $("cedula");
        const campoPin = $("pinReunion");

        const boton = $("btnIngresar");

        const filialId = selector.value;

        const pin = campoPin.value.trim();

        const cedulaOriginal = campoCedula.value.trim();

        const cedula = normalizarCedula(cedulaOriginal);

        if (!filialId) {
            mostrarMensaje(
                "mensajeIngreso",
                "Seleccione su filial."
            );

            selector.focus();

            return;
        }

        if (!cedula) {
            mostrarMensaje(
                "mensajeIngreso",
                "Ingrese su número de cédula."
            );

            campoCedula.focus();

            return;
        }

        if (!/^[0-9]{4}$/.test(pin)) {
            mostrarMensaje(
                "mensajeIngreso",
                "El PIN debe contener exactamente cuatro números."
            );

            campoPin.focus();

            return;
        }

        const filial = estado.filiales.find(
            (elemento) => elemento.id === filialId
        );

        if (!filial) {
            mostrarMensaje(
                "mensajeIngreso",
                "La filial seleccionada ya no está disponible."
            );

            return;
        }

        cambiarBoton(
            boton,
            true,
            "VERIFICANDO..."
        );

        selector.disabled = true;
        campoCedula.disabled = true;
        campoPin.disabled = true;

        try {
            // 1. Verificar que exista una reunión activa mediante
            //    el PIN. La reunión puede haberse creado en otra filial.
            const reunion = await buscarReunionActiva(pin);

            if (!reunion) {
                throw new Error(
                    "No se encontró una reunión activa con ese PIN."
                );
            }

            // 2. Verificar que la persona esté registrada.
            const usuario = await validarUsuarioParaReunion(
                cedulaOriginal,
                filialId,
                filial.nombre
            );

            // 3. Guardar únicamente los datos necesarios.
            // No guardamos el PIN ni la cédula en la sesión.
            const sesion = {
                juntaId: reunion.id,

                filialId: filial.id,
                filialNombre: filial.nombre,

                usuarioId: usuario.id,
                usuarioNombre: obtenerNombreUsuario(
                    usuario.datos
                ),

                fechaIngreso: new Date().toISOString()
            };

            sessionStorage.setItem(
                CLAVE_SESION,
                JSON.stringify(sesion)
            );

            // 4. Entrar a la pantalla del participante.
            window.location.href = "votante.html";

        } catch (error) {
            console.error(
                "No fue posible ingresar:",
                error
            );

            mostrarMensaje(
                "mensajeIngreso",
                error.message ||
                "No se pudo verificar el acceso."
            );

        } finally {
            selector.disabled = false;
            campoCedula.disabled = false;
            campoPin.disabled = false;

            cambiarBoton(boton, false);
        }
    }


    // ========================================================
    // 11. LEER LA SESIÓN DEL PARTICIPANTE
    // ========================================================

    function obtenerSesion() {
        try {
            const texto = sessionStorage.getItem(
                CLAVE_SESION
            );

            if (!texto) {
                return null;
            }

            const sesion = JSON.parse(texto);

            if (
                !sesion ||
                !sesion.juntaId ||
                !sesion.filialId ||
                !sesion.usuarioId
            ) {
                return null;
            }

            return sesion;

        } catch (error) {
            console.error(
                "Error al leer la sesión:",
                error
            );

            return null;
        }
    }


    // ========================================================
    // 12. INICIO DE LA PÁGINA DE VOTACIÓN
    // ========================================================

    async function iniciarPaginaVotante() {
        estado.sesion = obtenerSesion();

        conectarEventosVotante();

        if (!estado.sesion) {
            sessionStorage.removeItem(CLAVE_SESION);

            window.location.replace("index.html");

            return;
        }

        mostrarEstadoConexion();

        configurarPantallaInicial();

        try {
            await verificarSesionActual();

            escucharReunion();
            escucharPreguntas();
            escucharVotos();

            estado.intervalo = window.setInterval(
                actualizarPantalla,
                250
            );

        } catch (error) {
            console.error(
                "Error al iniciar el participante:",
                error
            );

            mostrarAvisoVotante(
                "No se pudo verificar la reunión",
                "Regrese al inicio e intente ingresar nuevamente."
            );
        }
    }


    function conectarEventosVotante() {
        $("btnSalirReunion")?.addEventListener(
            "click",
            salirDeLaReunion
        );

        $("btnVotarFavor")?.addEventListener(
            "click",
            () => registrarVoto("favor")
        );

        $("btnVotarContra")?.addEventListener(
            "click",
            () => registrarVoto("contra")
        );

        $("btnVotarAbstencion")?.addEventListener(
            "click",
            () => registrarVoto("abstencion")
        );
    }


    function configurarPantallaInicial() {
        const sesion = estado.sesion;

        if ($("nombreFilial")) {
            $("nombreFilial").textContent =
                sesion.filialNombre || "Verificando...";
        }

        if ($("nombreReunionVotante")) {
            $("nombreReunionVotante").textContent =
                "Verificando reunión...";
        }

        if ($("estadoVotante")) {
            $("estadoVotante").textContent =
                "Comprobando su acceso...";
        }

        if ($("panelEspera")) {
            $("panelEspera").hidden = false;
        }

        if ($("panelVotacion")) {
            $("panelVotacion").hidden = true;
        }

        if ($("panelResultadosVotante")) {
            $("panelResultadosVotante").hidden = true;
        }

        if ($("panelAvisoVotante")) {
            $("panelAvisoVotante").hidden = true;
        }
    }


    // ========================================================
    // 13. VERIFICAR QUE LA SESIÓN SIGA SIENDO VÁLIDA
    // ========================================================

    async function verificarSesionActual() {
        const bd = obtenerBaseDatos();
        const sesion = estado.sesion;

        const usuarioRef = bd
            .collection(COLECCIONES.USUARIOS)
            .doc(sesion.usuarioId);

        const reunionRef = bd
            .collection(COLECCIONES.JUNTAS)
            .doc(sesion.juntaId);

        const resultados = await Promise.all([
            usuarioRef.get(),
            reunionRef.get()
        ]);

        const documentoUsuario = resultados[0];
        const documentoReunion = resultados[1];

        if (!documentoUsuario.exists) {
            throw new Error(
                "El usuario ya no existe en el registro."
            );
        }

        if (!documentoReunion.exists) {
            throw new Error(
                "La reunión ya no existe."
            );
        }

        const usuario = documentoUsuario.data();
        const reunion = documentoReunion.data();

        if (
            !usuarioEstaHabilitado(usuario) ||
            usuarioEsAdministrador(usuario)
        ) {
            throw new Error(
                "La cuenta ya no está habilitada para votar."
            );
        }

        if (
            !usuarioPerteneceAFilial(
                usuario,
                sesion.filialId,
                sesion.filialNombre
            )
        ) {
            throw new Error(
                "La cuenta ya no pertenece a la filial seleccionada."
            );
        }

        if (!reunionEstaActiva(reunion)) {
            throw new Error(
                "La reunión no está activa o ya fue finalizada."
            );
        }

        estado.reunion = {
            id: documentoReunion.id,
            ...reunion
        };

        actualizarDatosReunion();

        registrarIngresoEnReunion(usuario);

        return true;
    }


    // Deja constancia de que esta persona entró a la reunión.
    // Alimenta "Participación de la reunión" en el panel del
    // administrador. Si falla, el votante puede seguir votando.
    function registrarIngresoEnReunion(usuario) {
        if (typeof window.ADEPRegistrarIngresoJunta !== "function") {
            console.warn(
                "ADEP: registro-ingreso-junta.js no está cargado; " +
                "la participación no se registrará."
            );

            return;
        }

        const sesion = estado.sesion;

        window.ADEPRegistrarIngresoJunta({
            juntaId: sesion.juntaId,
            usuarioId: sesion.usuarioId,
            nombre: obtenerNombreUsuario(usuario),
            cedula:
                usuario.cedula ??
                usuario.identificacion ??
                usuario.numeroCedula ??
                usuario.documentoIdentidad ??
                "",
            tipoRepresentante: usuario.tipoRepresentante || "",
            filialId: sesion.filialId,
            filialNombre: sesion.filialNombre
        }).catch((error) => {
            console.error(
                "No se pudo registrar el ingreso a la reunión:",
                error
            );
        });
    }


    // ========================================================
    // 14. ACTUALIZAR LOS DATOS MOSTRADOS DE LA REUNIÓN
    // ========================================================

    function actualizarDatosReunion() {
        const reunion = estado.reunion;

        if (!reunion) {
            return;
        }

        if ($("nombreFilial")) {
            $("nombreFilial").textContent =
                estado.sesion.filialNombre;
        }

        if ($("nombreReunionVotante")) {
            $("nombreReunionVotante").textContent =
                nombreDeReunion(reunion);
        }
    }


    // ========================================================
    // 15. ESCUCHAR CAMBIOS DE LA REUNIÓN
    // ========================================================

    function escucharReunion() {
        const reunionRef = obtenerBaseDatos()
            .collection(COLECCIONES.JUNTAS)
            .doc(estado.sesion.juntaId);

        estado.suscripcionReunion = reunionRef.onSnapshot(
            (documento) => {
                if (!documento.exists) {
                    mostrarAvisoVotante(
                        "Reunión no encontrada",
                        "La reunión ya no está disponible."
                    );

                    return;
                }

                estado.reunion = {
                    id: documento.id,
                    ...documento.data()
                };

                actualizarDatosReunion();
                actualizarPantalla();

            },
            (error) => {
                console.error(
                    "Error al escuchar la reunión:",
                    error
                );

                mostrarMensaje(
                    "mensajeVotante",
                    "No se pudo actualizar la información. " +
                    obtenerMensajeError(error),
                    "error"
                );
            }
        );
    }


    // ========================================================
    // 16. ESCUCHAR LAS PREGUNTAS EN TIEMPO REAL
    // ========================================================

    function escucharPreguntas() {
        estado.suscripcionPreguntas = obtenerBaseDatos()
            .collection(COLECCIONES.VOTACIONES)
            .where("juntaId", "==", estado.sesion.juntaId)
            .onSnapshot(
                (snapshot) => {
                    estado.preguntas = snapshot.docs
                        .map((documento) => ({
                            id: documento.id,
                            ...documento.data()
                        }))
                        .sort((a, b) => {
                            return (
                                (Number(a.orden) || 0) -
                                (Number(b.orden) || 0)
                            );
                        });

                    configurarFechasFinales();

                    actualizarPantalla();
                },
                (error) => {
                    console.error(
                        "Error al recibir las preguntas:",
                        error
                    );

                    mostrarMensaje(
                        "mensajeVotante",
                        "No se pudieron cargar las preguntas. " +
                        obtenerMensajeError(error)
                    );
                }
            );
    }


    function obtenerVotacionActivaSinFiltrar() {
        const reunion = estado.reunion;

        if (!reunion) {
            return null;
        }

        const activaId = reunion.votacionActivaId;

        if (activaId) {
            return estado.preguntas.find(
                (pregunta) =>
                    pregunta.id === activaId &&
                    normalizarTexto(pregunta.estado) ===
                        ESTADOS.VOTACION_ABIERTA
            ) || null;
        }

        // Compatibilidad con reuniones anteriores que todavía
        // no tengan votacionActivaId, siempre que exista solo
        // una pregunta abierta.
        const abiertas = estado.preguntas.filter(
            (pregunta) =>
                normalizarTexto(pregunta.estado) ===
                ESTADOS.VOTACION_ABIERTA
        );

        return abiertas.length === 1
            ? abiertas[0]
            : null;
    }


    // ========================================================
    // 17. ASEGURAR UNA FECHA DE CIERRE COMPARTIDA
    // ========================================================

    /*
       admin.js guarda fechaInicio utilizando serverTimestamp()
       y luego establece fechaFin = fechaInicio + 60 segundos.

       Si el navegador administrativo se cierra en medio
       de esa operación, este participante puede intentar
       completar fechaFin para que la pregunta no quede abierta
       sin límite de tiempo.

       Esta operación sirve para el prototipo. En producción,
       la fecha debería establecerla un servidor confiable.
    */

    function configurarFechasFinales() {
        for (const pregunta of estado.preguntas) {
            if (
                normalizarTexto(pregunta.estado) !==
                ESTADOS.VOTACION_ABIERTA
            ) {
                continue;
            }

            if (
                esTimestampFirestore(pregunta.fechaFin) ||
                !esTimestampFirestore(pregunta.fechaInicio)
            ) {
                continue;
            }

            if (
                estado.finalesConfigurados.has(pregunta.id)
            ) {
                continue;
            }

            estado.finalesConfigurados.add(pregunta.id);

            asegurarFechaFinal(pregunta.id)
                .catch((error) => {
                    console.error(
                        "No se pudo configurar la fecha final:",
                        error
                    );
                })
                .finally(() => {
                    estado.finalesConfigurados.delete(
                        pregunta.id
                    );
                });
        }
    }


    async function asegurarFechaFinal(votacionId) {
        const bd = obtenerBaseDatos();

        const referencia = bd
            .collection(COLECCIONES.VOTACIONES)
            .doc(votacionId);

        await bd.runTransaction(async (transaccion) => {
            const documento = await transaccion.get(
                referencia
            );

            if (!documento.exists) {
                return;
            }

            const pregunta = documento.data();

            if (
                normalizarTexto(pregunta.estado) !==
                ESTADOS.VOTACION_ABIERTA
            ) {
                return;
            }

            if (esTimestampFirestore(pregunta.fechaFin)) {
                return;
            }

            if (!esTimestampFirestore(pregunta.fechaInicio)) {
                return;
            }

            const duracion =
                Number(pregunta.duracionSegundos) ||
                DURACION_VOTACION_SEGUNDOS;

            const finMs =
                pregunta.fechaInicio.toMillis() +
                duracion * 1000;

            transaccion.update(referencia, {
                fechaFin:
                    firebase.firestore.Timestamp.fromMillis(
                        finMs
                    ),

                actualizadaEn:
                    obtenerMarcaTiempoServidor()
            });
        });
    }


    // ========================================================
    // 18. ESCUCHAR LOS VOTOS
    // ========================================================

    function escucharVotos() {
        estado.suscripcionVotos = obtenerBaseDatos()
            .collection(COLECCIONES.VOTOS)
            .where("juntaId", "==", estado.sesion.juntaId)
            .onSnapshot(
                (snapshot) => {
                    estado.votos = snapshot.docs.map(
                        (documento) => ({
                            id: documento.id,
                            ...documento.data()
                        })
                    );

                    detectarVotoPropio();

                    actualizarPantalla();

                },
                (error) => {
                    console.error(
                        "Error al escuchar los votos:",
                        error
                    );

                    mostrarMensaje(
                        "mensajeVotante",
                        "No se pudieron actualizar los resultados. " +
                        obtenerMensajeError(error)
                    );
                }
            );
    }


    // ========================================================
    // 19. IDENTIFICAR EL VOTO DEL PARTICIPANTE
    // ========================================================

    function obtenerVotacionIdDelVoto(voto) {
        return (
            voto.votacionId ||
            voto.votingId ||
            voto.idVotacion ||
            ""
        );
    }


    function obtenerUsuarioIdDelVoto(voto) {
        return (
            voto.usuarioId ||
            voto.userId ||
            voto.votanteId ||
            voto.uid ||
            ""
        );
    }


    function obtenerIdDocumentoVoto(votacionId, usuarioId) {
        return `${votacionId}__${usuarioId}`;
    }


    function detectarVotoPropio() {
        if (
            !estado.votacionActualId ||
            !estado.sesion?.usuarioId
        ) {
            return;
        }

        const voto = estado.votos.find(
            (elemento) => {
                return (
                    obtenerVotacionIdDelVoto(elemento) ===
                        estado.votacionActualId &&
                    String(
                        obtenerUsuarioIdDelVoto(elemento)
                    ) === String(estado.sesion.usuarioId)
                );
            }
        );

        if (voto) {
            estado.votoPropio = voto;
            estado.yaVoto = true;
            estado.comprobandoVoto = false;
        }
    }


    async function cargarVotoExistente(
        votacionId,
        generacion
    ) {
        const documentoId = obtenerIdDocumentoVoto(
            votacionId,
            estado.sesion.usuarioId
        );

        try {
            const documento = await obtenerBaseDatos()
                .collection(COLECCIONES.VOTOS)
                .doc(documentoId)
                .get();

            // Si el participante ya cambió a otra pregunta,
            // ignoramos los resultados de esta consulta.
            if (
                estado.generacionVotacion !== generacion ||
                estado.votacionActualId !== votacionId
            ) {
                return;
            }

            if (documento.exists) {
                estado.votoPropio = {
                    id: documento.id,
                    ...documento.data()
                };

                estado.yaVoto = true;
            }

            detectarVotoPropio();

        } catch (error) {
            console.error(
                "Error al comprobar si ya votó:",
                error
            );

            mostrarMensaje(
                "mensajeVotante",
                "No fue posible comprobar si ya existe una respuesta. " +
                "Por seguridad, no habilitaremos los botones hasta confirmar.",
                "error"
            );

        } finally {
            if (
                estado.generacionVotacion === generacion &&
                estado.votacionActualId === votacionId
            ) {
                estado.comprobandoVoto = false;
                actualizarPantalla();
            }
        }
    }


    // ========================================================
    // 20. CAMBIAR ENTRE PREGUNTAS
    // ========================================================

    function establecerVotacionActual(pregunta) {
        const nuevoId = pregunta?.id || null;

        if (nuevoId === estado.votacionActualId) {
            estado.votacionActual = pregunta || null;

            return;
        }

        estado.generacionVotacion++;

        estado.votacionActualId = nuevoId;
        estado.votacionActual = pregunta || null;

        estado.votoPropio = null;
        estado.yaVoto = false;

        estado.comprobandoVoto = Boolean(nuevoId);

        if (!nuevoId) {
            return;
        }

        const generacion = estado.generacionVotacion;

        // Revisar si este participante ya respondió
        // antes de habilitar los botones.
        cargarVotoExistente(
            nuevoId,
            generacion
        );
    }


    // ========================================================
    // 21. PANTALLA PRINCIPAL SEGÚN EL ESTADO DE LA REUNIÓN
    // ========================================================

    function actualizarPantalla() {
        if (estado.pagina !== "votante") {
            return;
        }

        const reunion = estado.reunion;

        if (!reunion) {
            if ($("estadoVotante")) {
                $("estadoVotante").textContent =
                    "Conectando con la reunión...";
            }

            return;
        }

        actualizarDatosReunion();

        if (!reunionEstaActiva(reunion)) {
            mostrarAvisoVotante(
                reunionFinalizada(reunion)
                    ? "La reunión ha finalizado"
                    : "La reunión no está activa",
                reunionFinalizada(reunion)
                    ? "El administrador ha finalizado la reunión."
                    : "La reunión no está disponible para votar."
            );

            return;
        }

        const pregunta = obtenerVotacionActivaSinFiltrar();

        if (pregunta) {
            const fechaFin = pregunta.fechaFin;

            if (
                esTimestampFirestore(fechaFin) &&
                fechaFin.toMillis() <= ahoraServidor() &&
                relojListoParaVencer()
            ) {
                marcarVotacionVencida(pregunta.id);

                mostrarPantallaEspera(
                    "El tiempo de esta votación terminó. " +
                    "Esperando la siguiente pregunta."
                );

                intentarCerrarVotacionPorTiempo(
                    pregunta.id
                );

                return;
            }

            establecerVotacionActual(pregunta);

            renderizarPantallaVotacion(pregunta);

            return;
        }

        establecerVotacionActual(null);

        mostrarPantallaEspera(
            "Está dentro de la reunión. " +
            "Esperando la próxima votación."
        );
    }


    function marcarVotacionVencida(votacionId) {
        estado.votacionesVencidas.add(votacionId);
    }


    // ========================================================
    // 22. MOSTRAR LA PANTALLA DE ESPERA
    // ========================================================

    function mostrarPantallaEspera(texto) {
        if ($("panelEspera")) {
            $("panelEspera").hidden = false;
        }

        if ($("panelVotacion")) {
            $("panelVotacion").hidden = true;
        }

        if ($("panelResultadosVotante")) {
            $("panelResultadosVotante").hidden = true;
        }

        if ($("panelAvisoVotante")) {
            $("panelAvisoVotante").hidden = true;
        }

        if ($("estadoVotante")) {
            $("estadoVotante").textContent = texto;
        }

        if ($("btnSalirReunion")) {
            $("btnSalirReunion").disabled = false;
        }

        limpiarMensaje("mensajeVotante");
    }


    // ========================================================
    // 23. MOSTRAR UNA VOTACIÓN ACTIVA
    // ========================================================

    function renderizarPantallaVotacion(pregunta) {
        if ($("panelEspera")) {
            $("panelEspera").hidden = true;
        }

        if ($("panelAvisoVotante")) {
            $("panelAvisoVotante").hidden = true;
        }

        if ($("panelVotacion")) {
            $("panelVotacion").hidden = false;
        }

        if ($("textoPreguntaVotante")) {
            $("textoPreguntaVotante").textContent =
                nombreDePregunta(pregunta);
        }

        if ($("preguntaResultadosVotante")) {
            $("preguntaResultadosVotante").textContent =
                nombreDePregunta(pregunta);
        }

        const fechaFinValida =
            esTimestampFirestore(pregunta.fechaFin);

        const tiempoRestante = fechaFinValida
            ? Math.max(
                0,
                Math.ceil(
                    (pregunta.fechaFin.toMillis() - ahoraServidor()) /
                    1000
                )
            )
            : null;

        const puedeVotar =
            fechaFinValida &&
            tiempoRestante > 0 &&
            !estado.yaVoto &&
            !estado.comprobandoVoto &&
            estado.conectado &&
            reunionEstaActiva(estado.reunion);

        actualizarBotonesDeVoto(puedeVotar);

        if ($("opcionesVoto")) {
            $("opcionesVoto").hidden = estado.yaVoto;
        }

        if ($("confirmacionVoto")) {
            $("confirmacionVoto").hidden = !estado.yaVoto;
        }

        if ($("estadoVotacionVotante")) {
            if (estado.comprobandoVoto) {
                $("estadoVotacionVotante").textContent =
                    "Verificando su respuesta...";
            } else if (estado.yaVoto) {
                $("estadoVotacionVotante").textContent =
                    "Su respuesta ya fue registrada.";
            } else if (!estado.conectado) {
                $("estadoVotacionVotante").textContent =
                    "Sin conexión. Reconectando...";
            } else if (!fechaFinValida) {
                $("estadoVotacionVotante").textContent =
                    "Preparando el tiempo de votación...";
            } else {
                $("estadoVotacionVotante").textContent =
                    "¡Es su turno de votar!";
            }
        }

        if ($("estadoVotante")) {
            $("estadoVotante").textContent =
                estado.yaVoto
                    ? "Su respuesta está registrada."
                    : "Hay una votación abierta.";
        }

        if (
            estado.yaVoto &&
            estado.votoPropio &&
            $("textoConfirmacionVoto")
        ) {
            $("textoConfirmacionVoto").textContent =
                textoDeRespuesta(
                    estado.votoPropio.opcion ||
                    estado.votoPropio.respuesta ||
                    estado.votoPropio.voto
                );
        }

        renderizarCronometro(pregunta);

        // Los resultados se muestran al participante después
        // de registrar su respuesta, mientras la votación siga
        // abierta. Se actualizan al recibir nuevos votos.
        if ($("panelResultadosVotante")) {
            $("panelResultadosVotante").hidden =
                !estado.yaVoto;
        }

        if (estado.yaVoto) {
            renderizarResultadosVotante(pregunta);
        }

        if (
            !fechaFinValida &&
            normalizarTexto(pregunta.estado) ===
                ESTADOS.VOTACION_ABIERTA
        ) {
            asegurarFechaFinal(pregunta.id)
                .catch((error) => {
                    console.error(
                        "No fue posible sincronizar el cierre:",
                        error
                    );
                });
        }

        if (!estado.conectado) {
            mostrarMensaje(
                "mensajeVotante",
                "Perdió la conexión. Espere a que se restablezca " +
                "antes de intentar votar.",
                "aviso"
            );
        } else if (
            estado.yaVoto ||
            !estado.comprobandoVoto
        ) {
            // No ocultamos mensajes de error de una operación
            // pendiente. El usuario puede volver a intentarlo.
            const mensaje = $("mensajeVotante");

            if (mensaje?.classList.contains("mensaje-aviso")) {
                limpiarMensaje("mensajeVotante");
            }
        }
    }


    function textoDeRespuesta(valor) {
        const tipo = normalizarTexto(valor);

        if (tipo === "favor" || tipo === "a favor") {
            return "Su voto a favor ha sido registrado.";
        }

        if (tipo === "contra" || tipo === "en contra") {
            return "Su voto en contra ha sido registrado.";
        }

        if (
            tipo === "abstencion" ||
            tipo === "abstención"
        ) {
            return "Su abstención ha sido registrada.";
        }

        return "Su respuesta ha sido registrada.";
    }


    // ========================================================
    // 24. CONTROL DE LOS BOTONES DE VOTO
    // ========================================================

    function actualizarBotonesDeVoto(puedeVotar) {
        const ids = [
            "btnVotarFavor",
            "btnVotarContra",
            "btnVotarAbstencion"
        ];

        for (const id of ids) {
            const boton = $(id);

            if (boton) {
                boton.disabled = !puedeVotar;
            }
        }

        if ($("btnSalirReunion")) {
            $("btnSalirReunion").disabled = false;
        }
    }


    // ========================================================
    // 25. CRONÓMETRO COMPARTIDO
    // ========================================================

    function renderizarCronometro(pregunta) {
        const cronometro = $("cronometroVotacion");

        if (!cronometro) {
            return;
        }

        cronometro.classList.remove(
            "tiempo-alerta",
            "tiempo-agotado"
        );

        if (!esTimestampFirestore(pregunta.fechaFin)) {
            cronometro.textContent = "…";
            cronometro.setAttribute(
                "aria-label",
                "Sincronizando el tiempo restante"
            );

            return;
        }

        const restante = Math.max(
            0,
            Math.ceil(
                (
                    pregunta.fechaFin.toMillis() -
                    ahoraServidor()
                ) / 1000
            )
        );

        cronometro.textContent = `${restante} s`;

        cronometro.setAttribute(
            "aria-label",
            `Quedan ${restante} segundos`
        );

        if (restante <= 10 && restante > 0) {
            cronometro.classList.add("tiempo-alerta");
        }

        if (restante <= 0) {
            cronometro.classList.add("tiempo-agotado");

            actualizarBotonesDeVoto(false);
        }
    }


    // ========================================================
    // 26. REGISTRAR UN VOTO
    // ========================================================

    async function registrarVoto(opcion) {
        limpiarMensaje("mensajeVotante");

        const opcionesValidas = [
            "favor",
            "contra",
            "abstencion"
        ];

        if (!opcionesValidas.includes(opcion)) {
            mostrarMensaje(
                "mensajeVotante",
                "La opción de voto no es válida."
            );

            return;
        }

        if (!estado.sesion || !estado.votacionActualId) {
            mostrarMensaje(
                "mensajeVotante",
                "No hay una votación disponible."
            );

            return;
        }

        if (estado.yaVoto) {
            mostrarMensaje(
                "mensajeVotante",
                "Su respuesta ya fue registrada. " +
                "No puede votar dos veces en la misma pregunta.",
                "aviso"
            );

            return;
        }

        if (
            estado.comprobandoVoto ||
            !estado.conectado
        ) {
            mostrarMensaje(
                "mensajeVotante",
                "Espere a que se verifique su conexión y su registro."
            );

            return;
        }

        const pregunta = estado.preguntas.find(
            (elemento) =>
                elemento.id === estado.votacionActualId
        );

        if (
            !pregunta ||
            !esTimestampFirestore(pregunta.fechaFin)
        ) {
            mostrarMensaje(
                "mensajeVotante",
                "La votación todavía no está lista. Espere un momento."
            );

            return;
        }

        if (
            pregunta.fechaFin.toMillis() <= ahoraServidor() &&
            relojListoParaVencer()
        ) {
            actualizarBotonesDeVoto(false);

            marcarVotacionVencida(pregunta.id);

            mostrarPantallaEspera(
                "El tiempo para votar ha terminado."
            );

            intentarCerrarVotacionPorTiempo(pregunta.id);

            return;
        }

        if (
            !reunionEstaActiva(estado.reunion) ||
            normalizarTexto(pregunta.estado) !==
                ESTADOS.VOTACION_ABIERTA
        ) {
            mostrarMensaje(
                "mensajeVotante",
                "Esta votación ya no está abierta."
            );

            return;
        }

        // Evitar que se envíen dos operaciones simultáneas
        // desde el mismo navegador.
        actualizarBotonesDeVoto(false);

        cambiarBoton(
            $("btnVotarFavor"),
            false
        );

        try {
            const resultado = await guardarVotoTransaccional(
                pregunta.id,
                opcion
            );

            if (!resultado.ok) {
                mostrarMensaje(
                    "mensajeVotante",
                    resultado.mensaje,
                    "aviso"
                );

                actualizarPantalla();

                return;
            }

            estado.yaVoto = true;

            estado.votoPropio = {
                id: obtenerIdDocumentoVoto(
                    pregunta.id,
                    estado.sesion.usuarioId
                ),

                juntaId: estado.sesion.juntaId,
                votacionId: pregunta.id,
                usuarioId: estado.sesion.usuarioId,

                opcion: opcion,
                respuesta: opcion
            };

            mostrarMensaje(
                "mensajeVotante",
                "Su voto fue registrado correctamente.",
                "exito"
            );

            actualizarPantalla();

        } catch (error) {
            console.error(
                "Error al guardar el voto:",
                error
            );

            mostrarMensaje(
                "mensajeVotante",
                "No fue posible registrar su respuesta. " +
                obtenerMensajeError(error) +
                " Puede intentar de nuevo si la votación continúa abierta."
            );

            actualizarPantalla();
        }
    }


    // ========================================================
    // 27. GUARDAR EL VOTO CON UNA TRANSACCIÓN
    // ========================================================

    async function guardarVotoTransaccional(
        votacionId,
        opcion
    ) {
        const bd = obtenerBaseDatos();

        const sesion = estado.sesion;

        const reunionRef = bd
            .collection(COLECCIONES.JUNTAS)
            .doc(sesion.juntaId);

        const preguntaRef = bd
            .collection(COLECCIONES.VOTACIONES)
            .doc(votacionId);

        /*
           El identificador determinista significa que la misma
           persona utiliza el mismo documento de voto para la
           misma pregunta, incluso si abre otra pestaña.

           Formato:
           ID_VOTACION__ID_USUARIO

           No se guarda la cédula dentro del voto.
        */

        const documentoVotoId = obtenerIdDocumentoVoto(
            votacionId,
            sesion.usuarioId
        );

        const votoRef = bd
            .collection(COLECCIONES.VOTOS)
            .doc(documentoVotoId);

        return bd.runTransaction(async (transaccion) => {
            // Leer todo antes de comenzar a escribir.
            const resultadoVoto = await transaccion.get(
                votoRef
            );

            const resultadoReunion = await transaccion.get(
                reunionRef
            );

            const resultadoPregunta = await transaccion.get(
                preguntaRef
            );

            if (resultadoVoto.exists) {
                return {
                    ok: false,
                    mensaje:
                        "Ya existe un voto suyo en esta pregunta."
                };
            }

            if (
                !resultadoReunion.exists ||
                !resultadoPregunta.exists
            ) {
                return {
                    ok: false,
                    mensaje:
                        "La reunión o la votación ya no existe."
                };
            }

            const reunion = resultadoReunion.data();
            const pregunta = resultadoPregunta.data();

            if (!reunionEstaActiva(reunion)) {
                return {
                    ok: false,
                    mensaje:
                        "La reunión ya no está activa."
                };
            }

            if (
                reunion.votacionActivaId !== votacionId
            ) {
                return {
                    ok: false,
                    mensaje:
                        "Esta pregunta ya no es la votación activa."
                };
            }

            if (
                normalizarTexto(pregunta.estado) !==
                ESTADOS.VOTACION_ABIERTA
            ) {
                return {
                    ok: false,
                    mensaje:
                        "La votación está cerrada."
                };
            }

            if (
                pregunta.juntaId !== sesion.juntaId
            ) {
                return {
                    ok: false,
                    mensaje:
                        "La pregunta no corresponde a esta reunión."
                };
            }

            if (
                !esTimestampFirestore(pregunta.fechaFin)
            ) {
                return {
                    ok: false,
                    mensaje:
                        "La votación todavía está sincronizando su tiempo."
                };
            }

            // Control de tiempo de la interfaz.
            // En producción, esta condición debe estar respaldada
            // por reglas de seguridad que usen request.time.
            if (
                pregunta.fechaFin.toMillis() <= ahoraServidor()
            ) {
                return {
                    ok: false,
                    mensaje:
                        "El tiempo de votación ya terminó."
                };
            }

            // La respuesta se registra una única vez mediante
            // el documento determinista de este participante.
            transaccion.set(votoRef, {
                juntaId: sesion.juntaId,

                filialId: sesion.filialId,

                votacionId: votacionId,

                usuarioId: sesion.usuarioId,

                opcion: opcion,
                respuesta: opcion,

                registradoEn: obtenerMarcaTiempoServidor()
            });

            return {
                ok: true,
                mensaje: "Voto registrado."
            };
        });
    }


    // ========================================================
    // 28. CERRAR UNA VOTACIÓN CUANDO TERMINA EL TIEMPO
    // ========================================================

    async function intentarCerrarVotacionPorTiempo(
        votacionId
    ) {
        if (estado.cierresEnProceso.has(votacionId)) {
            return;
        }

        // Un dispositivo cuyo reloj no se pudo comparar con el
        // servidor NUNCA debe cerrar una votación por tiempo.
        // Eso causaba cierres anticipados para todos.
        if (!relojSincronizado()) {
            return;
        }

        estado.cierresEnProceso.add(votacionId);

        try {
            const bd = obtenerBaseDatos();

            const reunionRef = bd
                .collection(COLECCIONES.JUNTAS)
                .doc(estado.sesion.juntaId);

            const preguntaRef = bd
                .collection(COLECCIONES.VOTACIONES)
                .doc(votacionId);

            await bd.runTransaction(async (transaccion) => {
                // Leer primero ambos documentos.
                const documentoReunion =
                    await transaccion.get(reunionRef);

                const documentoPregunta =
                    await transaccion.get(preguntaRef);

                if (
                    !documentoReunion.exists ||
                    !documentoPregunta.exists
                ) {
                    return;
                }

                const reunion = documentoReunion.data();
                const pregunta = documentoPregunta.data();

                if (
                    normalizarTexto(pregunta.estado) !==
                    ESTADOS.VOTACION_ABIERTA
                ) {
                    return;
                }

                if (
                    !esTimestampFirestore(pregunta.fechaFin) ||
                    pregunta.fechaFin.toMillis() +
                        MARGEN_CIERRE_VOTANTE_MS > ahoraServidor()
                ) {
                    return;
                }

                transaccion.update(preguntaRef, {
                    estado: ESTADOS.VOTACION_FINALIZADA,

                    fechaCierreReal:
                        obtenerMarcaTiempoServidor(),

                    motivoCierre: "tiempo_agotado",

                    actualizadaEn:
                        obtenerMarcaTiempoServidor()
                });

                if (
                    reunion.votacionActivaId === votacionId
                ) {
                    transaccion.update(reunionRef, {
                        votacionActivaId: null,

                        actualizadaEn:
                            obtenerMarcaTiempoServidor()
                    });
                }
            });

        } catch (error) {
            console.error(
                "No fue posible guardar el cierre de la votación:",
                error
            );

            /*
               Aunque la pantalla puede regresar a espera al llegar
               el tiempo límite, el cambio persistente de estado
               debe guardarse en Firestore. Si las reglas no
               permiten esta escritura, el administrador tendrá
               que cerrar la votación o habrá que implementar un
               proceso confiable en el servidor.
            */
        } finally {
            estado.cierresEnProceso.delete(votacionId);
        }
    }


    // ========================================================
    // 29. INTERPRETAR LAS RESPUESTAS
    // ========================================================

    function clasificarRespuesta(voto) {
        const valor = normalizarTexto(
            voto.opcion ||
            voto.respuesta ||
            voto.voto ||
            voto.tipoVoto ||
            ""
        ).replace(/[_-]/g, " ");

        if (
            [
                "favor",
                "a favor",
                "afavor"
            ].includes(valor)
        ) {
            return "favor";
        }

        if (
            [
                "contra",
                "en contra",
                "encontra"
            ].includes(valor)
        ) {
            return "contra";
        }

        if (
            [
                "abstencion"
            ].includes(valor)
        ) {
            return "abstencion";
        }

        return null;
    }


    // ========================================================
    // 30. OBTENER LOS VOTOS DE UNA PREGUNTA
    // ========================================================

    function obtenerVotosDePregunta(votacionId) {
        return estado.votos.filter((voto) => {
            return (
                obtenerVotacionIdDelVoto(voto) ===
                votacionId
            );
        });
    }


    function calcularResultados(votacionId) {
        const votos = obtenerVotosDePregunta(votacionId);

        const conteo = {
            favor: 0,
            contra: 0,
            abstencion: 0
        };

        for (const voto of votos) {
            const tipo = clasificarRespuesta(voto);

            if (tipo) {
                conteo[tipo]++;
            }
        }

        const total =
            conteo.favor +
            conteo.contra +
            conteo.abstencion;

        return {
            conteo,
            total,

            porcentajes: {
                favor: total
                    ? Math.round(
                        conteo.favor / total * 100
                    )
                    : 0,

                contra: total
                    ? Math.round(
                        conteo.contra / total * 100
                    )
                    : 0,

                abstencion: total
                    ? Math.round(
                        conteo.abstencion / total * 100
                    )
                    : 0
            }
        };
    }


    // ========================================================
    // 31. MOSTRAR LOS RESULTADOS AL VOTANTE
    // ========================================================

    function renderizarResultadosVotante(pregunta) {
        if (
            !pregunta ||
            !estado.yaVoto ||
            !$("panelResultadosVotante")
        ) {
            return;
        }

        const resultados = calcularResultados(pregunta.id);

        actualizarResultado(
            "FavorVotante",
            resultados.conteo.favor,
            resultados.porcentajes.favor
        );

        actualizarResultado(
            "ContraVotante",
            resultados.conteo.contra,
            resultados.porcentajes.contra
        );

        actualizarResultado(
            "AbstencionVotante",
            resultados.conteo.abstencion,
            resultados.porcentajes.abstencion
        );

        if ($("totalVotosVotante")) {
            $("totalVotosVotante").textContent =
                String(resultados.total);
        }

        if ($("preguntaResultadosVotante")) {
            $("preguntaResultadosVotante").textContent =
                nombreDePregunta(pregunta);
        }

        if ($("mensajeResultadosVotante")) {
            $("mensajeResultadosVotante").textContent =
                "Los resultados se actualizan mientras " +
                "la votación permanezca abierta.";
        }

        if ($("estadoSiguienteVotacion")) {
            $("estadoSiguienteVotacion").textContent =
                "Cuando termine el tiempo, volverá a la " +
                "pantalla de espera.";
        }
    }


    function actualizarResultado(sufijo, cantidad, porcentaje) {
        const elementoCantidad = $(
            `resultado${sufijo}`
        );

        const elementoPorcentaje = $(
            `porcentaje${sufijo}`
        );

        const barra = $(
            `barra${sufijo}`
        );

        const progreso = $(
            `progreso${sufijo}`
        );

        if (elementoCantidad) {
            elementoCantidad.textContent = String(cantidad);
        }

        if (elementoPorcentaje) {
            elementoPorcentaje.textContent =
                `${porcentaje} %`;
        }

        if (progreso) {
            progreso.style.width = `${porcentaje}%`;
        }

        if (barra) {
            barra.setAttribute(
                "aria-valuenow",
                String(porcentaje)
            );
        }
    }


    // ========================================================
    // 32. AVISOS DE LA PÁGINA DEL VOTANTE
    // ========================================================

    function mostrarAvisoVotante(titulo, texto) {
        if ($("panelEspera")) {
            $("panelEspera").hidden = true;
        }

        if ($("panelVotacion")) {
            $("panelVotacion").hidden = true;
        }

        if ($("panelResultadosVotante")) {
            $("panelResultadosVotante").hidden = true;
        }

        if ($("panelAvisoVotante")) {
            $("panelAvisoVotante").hidden = false;
        }

        if ($("tituloAvisoVotante")) {
            $("tituloAvisoVotante").textContent = titulo;
        }

        if ($("textoAvisoVotante")) {
            $("textoAvisoVotante").textContent = texto;
        }

        actualizarBotonesDeVoto(false);

        // Invalidar la sesión si la reunión ya no es válida.
        sessionStorage.removeItem(CLAVE_SESION);

        estado.sesion = null;
    }


    function mostrarErrorInicial(texto) {
        console.error("ADEP V2.0:", texto);

        if ($("mensajeIngreso")) {
            mostrarMensaje(
                "mensajeIngreso",
                texto,
                "error"
            );

            return;
        }

        if ($("panelAvisoVotante")) {
            mostrarAvisoVotante(
                "No se pudo iniciar el sistema",
                texto
            );
        }
    }


    // ========================================================
    // 33. CONECTIVIDAD
    // ========================================================

    function conectarEventosDeConectividad() {
        window.addEventListener("online", () => {
            estado.conectado = true;

            mostrarEstadoConexion();

            if (estado.pagina === "votante") {
                actualizarPantalla();
            }
        });

        window.addEventListener("offline", () => {
            estado.conectado = false;

            mostrarEstadoConexion();

            if (estado.pagina === "votante") {
                actualizarBotonesDeVoto(false);

                mostrarMensaje(
                    "mensajeVotante",
                    "Se perdió la conexión. " +
                    "Sus botones de voto están temporalmente deshabilitados.",
                    "aviso"
                );
            }
        });
    }


    function mostrarEstadoConexion() {
        const indicador = $("indicadorConexion");

        if (!indicador) {
            return;
        }

        indicador.classList.remove(
            "conectado",
            "desconectado"
        );

        if (estado.conectado) {
            indicador.textContent = "Conexión disponible";

            indicador.classList.add("conectado");
        } else {
            indicador.textContent = "Sin conexión";

            indicador.classList.add("desconectado");
        }
    }


    // ========================================================
    // 34. SALIR DE LA REUNIÓN
    // ========================================================

    function salirDeLaReunion() {
        const confirmar = confirm(
            "¿Desea salir de la reunión?\n\n" +
            "Para volver a participar deberá ingresar nuevamente."
        );

        if (!confirmar) {
            return;
        }

        limpiarSuscripciones();

        sessionStorage.removeItem(CLAVE_SESION);

        window.location.replace("index.html");
    }


    // ========================================================
    // 35. LIMPIAR LAS SUSCRIPCIONES DE FIRESTORE
    // ========================================================

    function limpiarSuscripciones() {
        if (estado.suscripcionReunion) {
            estado.suscripcionReunion();
            estado.suscripcionReunion = null;
        }

        if (estado.suscripcionPreguntas) {
            estado.suscripcionPreguntas();
            estado.suscripcionPreguntas = null;
        }

        if (estado.suscripcionVotos) {
            estado.suscripcionVotos();
            estado.suscripcionVotos = null;
        }

        if (estado.intervalo) {
            window.clearInterval(estado.intervalo);
            estado.intervalo = null;
        }
    }


    window.addEventListener(
        "beforeunload",
        limpiarSuscripciones
    );


})();
