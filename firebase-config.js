/*
 * ADEP V2.1
 * Conexión con Firebase y Firestore
 */

// Configuración del proyecto Firebase
const firebaseConfig = {
    apiKey: "AIzaSyAoAMz_G_3V_j9rWnVjPJWvSAxS-QndOag",
    authDomain: "adep-votacion.firebaseapp.com",
    projectId: "adep-votacion",
    storageBucket: "adep-votacion.firebasestorage.app",
    messagingSenderId: "781830113414",
    appId: "1:781830113414:web:b3269e678fd9a7c42be907",
    measurementId: "G-T8GLR2NM00"
};

// Inicializar Firebase una sola vez
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

// Referencias principales
const db = firebase.firestore();
const auth = firebase.auth();

console.log("ADEP V2.1: Firebase inicializado correctamente.");
console.log("Proyecto:", firebase.app().options.projectId);
