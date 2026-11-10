
// ======================================================
// ADEP V2.1 - CONEXIÓN CON SUPABASE
// ======================================================


const SUPABASE_ANON_KEY = "sb_publishable_1m24iveJEt86s6fZ1dvVBA_z4se0RMm";

const SUPABASE_URL = "https://lmulxrablrwsbycwjzkm.supabase.co";

window.supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

console.log("Conexión con Supabase inicializada correctamente.");
