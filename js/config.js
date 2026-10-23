/* ========================================
   KONFIGURATION (öffentliche Werte)

   Diese zwei Werte findest du im Supabase-Dashboard unter
   Project Settings -> API (Project URL) bzw. API Keys (Publishable key).
   Beide sind für den Browser gedacht und dürfen hier stehen.

   NIEMALS hier eintragen: "secret key" / "service_role key" / Datenbank-Passwort.
   Die Sicherheit kommt aus den Regeln in der Datenbank, nicht aus der Geheimhaltung
   dieser Werte. Siehe docs/SUPABASE-SETUP.md, Abschnitt 4.
   ======================================== */
window.KANTINE_CONFIG = {
    SUPABASE_URL: 'https://heqiiigxuhsuxvkpgldf.supabase.co',
    SUPABASE_KEY: 'sb_publishable_YiKe35VCMC_2qDZHJkCUlw_xbIFP1RE',

    // Aus dem Benutzernamen "max" wird intern "max@kantine.invalid".
    // Muss identisch sein mit private.login_domain() in der Datenbank.
    LOGIN_DOMAIN: 'kantine.invalid'
};
