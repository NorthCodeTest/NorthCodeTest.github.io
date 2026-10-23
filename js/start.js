/* ========================================
   START: Anmeldung und Rollenwahl

   Eine Seite, eine URL. Das Konto entscheidet:
     mitglied      -> Handy-Ansicht
     kueche/admin  -> Tablet (Kategorien, Küche, Verwaltung)
   Das Farbschema (Geräte-Einstellung) wird hier einmal geladen.
   ======================================== */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const ANSICHTEN = ['login', 'start-hinweis', 'handy', 'tablet'];

    function zeige(id) { ANSICHTEN.forEach((x) => $(x).classList.toggle('hidden', x !== id)); }
    function hinweis(text) { $('start-hinweis').textContent = text; zeige('start-hinweis'); }

    let meldungTimer;
    function meldung(text, typ) {
        const m = $('meldung');
        m.className = 'meldung ' + typ;
        m.textContent = text;
        m.style.display = 'block';
        clearTimeout(meldungTimer);
        meldungTimer = setTimeout(() => { m.style.display = 'none'; }, 5000);
    }

    function designLaden() {
        try {
            const t = localStorage.getItem('design');
            if (t && t !== 'klassisch') document.documentElement.setAttribute('data-theme', t);
        } catch (e) { /* Standard-Farben */ }
    }

    function zeigeLogin() {
        window.Handy.stopp(); window.Tablet.stopp();
        zeige('login');
    }

    /* Rolle des Kontos bestimmt die Ansicht */
    async function weiterleiten(profil) {
        if (!profil || !profil.aktiv) {
            await API.abmelden();
            meldung('Dieses Konto ist nicht aktiv.', 'fehler');
            return;
        }
        if (profil.rolle === 'mitglied') { zeige('handy'); await window.Handy.start(profil); }
        else if (profil.rolle === 'kueche' || profil.rolle === 'admin') { zeige('tablet'); await window.Tablet.start(profil); }
        else { await API.abmelden(); meldung('Für dieses Konto ist keine Rolle eingerichtet. Bitte beim Admin melden.', 'fehler'); }
    }

    async function einloggen() {
        const btn = $('l-btn');
        btn.disabled = true;
        try {
            const profil = await API.anmelden($('l-name').value, $('l-pw').value);
            $('l-pw').value = '';
            await weiterleiten(profil);
        } catch (e) { meldung(e.message, 'fehler'); }
        finally { btn.disabled = false; }
    }

    window.Start = { zeigeLogin };

    designLaden();
    $('l-btn').onclick = einloggen;
    $('l-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') einloggen(); });

    if (!API.konfiguriert) {
        hinweis('Die App ist noch nicht verbunden: Bitte URL und Key in js/config.js eintragen.');
        return;
    }
    API.init();
    API.beiAbmeldung(zeigeLogin);
    API.sitzungProfil().then((p) => (p ? weiterleiten(p) : zeige('login'))).catch(() => zeige('login'));
})();
