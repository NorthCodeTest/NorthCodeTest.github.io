/* ========================================
   DATENZUGRIFFSSCHICHT (window.API)

   Hier - und nur hier - spricht die App mit Supabase.
   app.js ruft nur die Funktionen von API auf und kennt
   keine Tabellen, Schlüssel oder SQL-Funktionen.

   WICHTIGE GRUNDSÄTZE
   - Schreiben passiert ausschließlich über Datenbank-Funktionen (rpc).
     Preise und Rechte prüft die Datenbank, nie der Browser.
   - Jeder Aufruf liefert entweder ein Ergebnis oder wirft einen ApiFehler
     mit einer verständlichen deutschen Meldung.
   - ApiFehler.unsicher = true bedeutet: Es ist UNKLAR, ob die Datenbank
     die Aktion noch ausgeführt hat (z.B. Verbindungsabbruch).
     Bei Bestellungen ist das unkritisch, weil dieselbe Anfrage-ID nie
     doppelt gebucht wird (siehe app.js, bestellungAbschliessen).
   ======================================== */
(function () {
    'use strict';

    const cfg = window.KANTINE_CONFIG || {};
    const konfiguriert =
        typeof cfg.SUPABASE_URL === 'string' && /^https:\/\/.+/.test(cfg.SUPABASE_URL) &&
        !/DEIN-PROJEKT/.test(cfg.SUPABASE_URL) &&
        typeof cfg.SUPABASE_KEY === 'string' && cfg.SUPABASE_KEY.length > 20 &&
        !/DEIN-PUBLISHABLE/.test(cfg.SUPABASE_KEY) &&
        typeof window.supabase !== 'undefined';

    const ZEITLIMIT_MS = 20000;

    /* ----- Fehlerklasse ----- */
    class ApiFehler extends Error {
        constructor(message, opts) {
            super(message);
            const o = opts || {};
            this.name = 'ApiFehler';
            this.unsicher = !!o.unsicher;               // Ausgang unklar (Netz/Server)
            this.sitzungAbgelaufen = !!o.sitzungAbgelaufen;
            this.code = o.code || '';
        }
    }

    const NETZ_TEXT = 'Keine Verbindung zum Server. Bitte Internetverbindung prüfen und erneut versuchen.';

    function istNetzfehler(error, status) {
        const msg = String((error && error.message) || error || '');
        return status === 0 ||
            /failed to fetch|networkerror|network request failed|load failed|abort|timeout|timed out|fetch/i.test(msg);
    }

    /* Übersetzt Fehler von Supabase in ApiFehler.
       Meldungen aus unseren Datenbank-Funktionen sind bereits deutsch und werden unverändert gezeigt. */
    function uebersetze(error, status) {
        const msg = String((error && error.message) || '');
        const code = String((error && error.code) || '');

        if (istNetzfehler(error, status) && !code) {
            return new ApiFehler(NETZ_TEXT, { unsicher: true });
        }
        if (code === '42501') {
            return new ApiFehler('Keine Berechtigung.', { code });
        }
        if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(msg)) {
            return new ApiFehler('Deine Anmeldung ist abgelaufen. Bitte neu anmelden.',
                { sitzungAbgelaufen: true, code });
        }
        if (code === 'PGRST202' || code === '42883' || code === '42P01') {
            return new ApiFehler('Die Datenbank ist noch nicht vollständig eingerichtet (Funktion oder Tabelle fehlt).', { code });
        }
        if (status >= 500) {
            return new ApiFehler('Der Server hat einen Fehler gemeldet. Bitte in einem Moment erneut versuchen.',
                { unsicher: true, code });
        }
        return new ApiFehler(msg || 'Unbekannter Fehler.', { code });
    }

    /* Wartet auf einen Supabase-Aufruf und wirft bei Fehlern einen ApiFehler. */
    async function ausfuehren(aufruf) {
        let res;
        try {
            res = await aufruf;
        } catch (e) {
            throw uebersetze(e, 0);
        }
        if (res && res.error) {
            throw uebersetze(res.error, res.status);
        }
        return res ? res.data : null;
    }

    /* fetch mit Zeitlimit: ein hängender Aufruf wird nach 20 s abgebrochen
       (wird als "unsicher" gewertet, die Anfrage-ID schützt vor Doppelbuchung). */
    function fetchMitZeitlimit(url, optionen) {
        const steuerung = new AbortController();
        const opt = Object.assign({}, optionen || {});
        if (opt.signal) {
            if (opt.signal.aborted) steuerung.abort();
            else opt.signal.addEventListener('abort', () => steuerung.abort(), { once: true });
        }
        opt.signal = steuerung.signal;
        const timer = setTimeout(() => steuerung.abort(), ZEITLIMIT_MS);
        return fetch(url, opt).finally(() => clearTimeout(timer));
    }

    const z = (x) => (x === null || x === undefined ? 0 : Number(x));

    /* ----- Clients -----
       client      = der Haupt-Login dieses Geräts (Handy-Konto ODER Küchen-Tablet).
                     Die Sitzung wird im Browser gespeichert und bleibt nach Neustart bestehen.
       adminClient = Zweit-Login nur für die Verwaltung am Tablet.
                     Die Sitzung liegt NUR im Arbeitsspeicher (verschwindet beim Neuladen)
                     und wird beim Verlassen der Verwaltung beendet. */
    let client = null;
    let adminClient = null;

    function clientenErzeugen() {
        if (client) return;
        const gemeinsam = { global: { fetch: fetchMitZeitlimit } };
        client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, Object.assign({
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'kantine-login' },
            realtime: { params: { eventsPerSecond: 5 } }
        }, gemeinsam));
        adminClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, Object.assign({
            auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'kantine-verwaltung' }
        }, gemeinsam));
    }

    function emailAus(benutzername) {
        return benutzername + '@' + cfg.LOGIN_DOMAIN;
    }

    function benutzernameGueltig(name) {
        return /^[a-z0-9][a-z0-9._-]{1,29}$/.test(name);
    }

    function loginFehler(error) {
        const code = String((error && error.code) || '');
        const status = error && error.status;
        if (code === 'user_banned') return new ApiFehler('Dieses Konto ist gesperrt.');
        if (istNetzfehler(error, status) || status === 0) return new ApiFehler(NETZ_TEXT, { unsicher: true });
        if (status >= 500) return new ApiFehler('Der Server hat einen Fehler gemeldet. Bitte später erneut versuchen.');
        if (status === 429 || code === 'over_request_rate_limit') {
            return new ApiFehler('Zu viele Versuche. Bitte kurz warten und erneut versuchen.');
        }
        return new ApiFehler('Benutzername oder Passwort ist falsch.');
    }

    async function profilLaden(c) {
        const { data: s } = await c.auth.getSession();
        const uid = s && s.session && s.session.user && s.session.user.id;
        if (!uid) return null;
        const p = await ausfuehren(
            c.from('profile').select('id, benutzername, rolle, person_id, aktiv').eq('id', uid).maybeSingle());
        return p || { id: uid, benutzername: '', rolle: null, person_id: null, aktiv: false };
    }

    async function anmeldenMit(c, benutzername, passwort) {
        const name = String(benutzername || '').trim().toLowerCase();
        if (!benutzernameGueltig(name) || !passwort) {
            throw new ApiFehler('Benutzername oder Passwort ist falsch.');
        }
        let res;
        try {
            res = await c.auth.signInWithPassword({ email: emailAus(name), password: passwort });
        } catch (e) {
            throw new ApiFehler(NETZ_TEXT, { unsicher: true });
        }
        if (res.error) throw loginFehler(res.error);
        return profilLaden(c);
    }

    /* Wird "Abmelden" gedrückt, während das Netz weg ist, soll das Gerät trotzdem lokal abgemeldet sein. */
    async function lokalAbmelden(c) {
        try {
            await c.auth.signOut({ scope: 'local' });
        } catch (e) { /* lokal ist ohnehin abgemeldet */ }
    }

    /* ----- Realtime -----
       Meldet über "tabelle" zurück, wenn sich dort etwas ändert. Jedes Gerät bekommt nur
       Zeilen, die es per Regel sehen darf. status() meldet den Verbindungszustand. */
    function abonnieren(tabellen, beiAenderung, status) {
        const kanal = client.channel('kantine-' + Math.random().toString(36).slice(2, 8));
        tabellen.forEach((t) => {
            kanal.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => beiAenderung(t));
        });
        kanal.subscribe((s) => { if (status) status(s); });
        return () => { try { client.removeChannel(kanal); } catch (e) { /* egal */ } };
    }

    /* ----- Öffentliche Schnittstelle ----- */
    const API = {
        ApiFehler,
        konfiguriert,

        /* --- Anmeldung --- */
        init() { if (konfiguriert) clientenErzeugen(); },
        sitzungProfil() { return profilLaden(client); },
        anmelden(benutzername, passwort) { return anmeldenMit(client, benutzername, passwort); },
        abmelden() { return lokalAbmelden(client); },
        beiAbmeldung(callback) {
            client.auth.onAuthStateChange((event) => {
                // Nicht direkt in der Callback-Funktion weiterarbeiten (Supabase-Empfehlung)
                if (event === 'SIGNED_OUT') setTimeout(callback, 0);
            });
        },
        async passwortAendern(neuesPasswort) {
            let res;
            try { res = await client.auth.updateUser({ password: neuesPasswort }); }
            catch (e) { throw new ApiFehler(NETZ_TEXT, { unsicher: true }); }
            if (res.error) {
                const msg = String(res.error.message || '');
                if (/same|different/i.test(msg)) throw new ApiFehler('Das neue Passwort muss sich vom alten unterscheiden.');
                if (/at least|weak|short|password/i.test(msg)) throw new ApiFehler('Das Passwort ist zu schwach oder zu kurz (mindestens 8 Zeichen).');
                throw uebersetze(res.error, res.status);
            }
        },

        /* --- Verwaltung (Zweit-Login nur im Arbeitsspeicher) --- */
        adminDirekt(profil) { return !!profil && profil.rolle === 'admin'; },
        async adminAnmelden(benutzername, passwort) {
            const p = await anmeldenMit(adminClient, benutzername, passwort);
            if (!p || p.rolle !== 'admin' || !p.aktiv) {
                await lokalAbmelden(adminClient);
                throw new ApiFehler('Dieses Konto hat keine Verwaltungsrechte.');
            }
            return p;
        },
        async adminAbmelden() { await lokalAbmelden(adminClient); },
        async adminAngemeldet() {
            const { data } = await adminClient.auth.getSession();
            return !!(data && data.session);
        },

        /* --- Lesen --- */
        async produkteLaden() {
            const [kat, prod] = await Promise.all([
                ausfuehren(client.from('produkt_kategorien').select('id, name, sortierung').order('sortierung')),
                ausfuehren(client.from('produkte')
                    .select('id, kategorie_id, name, preis, typ, zaehlt_einkaufsliste, ist_abendessen')
                    .eq('aktiv', true).order('id'))
            ]);
            return {
                kategorien: kat || [],
                produkte: (prod || []).map((p) => Object.assign({}, p, { preis: z(p.preis) }))
            };
        },
        /* Küche/Admin: alle aktiven Personen. Kollege: nur die eigene. */
        async personenLaden() {
            const rows = await ausfuehren(client.from('personen')
                .select('id, kategorie, anzeigename, guthaben').eq('aktiv', true).order('anzeigename'));
            return (rows || []).map((p) => Object.assign({}, p, { guthaben: z(p.guthaben) }));
        },
        async ranking() {
            const rows = await ausfuehren(client.rpc('ranking'));
            const r = { schulden: [], guthaben: [] };
            (rows || []).forEach((x) => {
                (x.art === 'schulden' ? r.schulden : r.guthaben)
                    .push({ platz: x.platz, name: x.name, guthaben: z(x.guthaben) });
            });
            return r;
        },
        async historie(personId) {
            const rows = await ausfuehren(client.rpc('historie_person', { p_person_id: personId }));
            return (rows || []).map((h) => Object.assign({}, h, { betrag: z(h.betrag), neues_guthaben: z(h.neues_guthaben) }));
        },
        async einkaufsliste() {
            const rows = await ausfuehren(client.rpc('einkaufsliste'));
            return (rows || []).map((r) => ({ name: r.name, menge: z(r.menge) }));
        },
        async gesamtschulden() { return z(await ausfuehren(client.rpc('gesamtschulden'))); },
        abendessenListe() { return ausfuehren(client.rpc('abendessen_liste')).then((r) => r || []); },
        backupExport() { return ausfuehren(client.rpc('backup_export')); },

        /* --- Schreiben: Bestellen und Küche (Haupt-Login) --- */
        async bestellen(personId, anfrageId, positionen) {
            const r = await ausfuehren(client.rpc('bestellung_aufgeben', {
                p_person_id: personId, p_request_id: anfrageId, p_positionen: positionen
            }));
            return { summe: z(r.summe), neuesGuthaben: z(r.neues_guthaben),
                     abendessen: !!r.abendessen_vorgemerkt, wiederholt: !!r.wiederholt };
        },
        gastAnlegen(kategorie, name) {
            return ausfuehren(client.rpc('gast_anlegen', { p_kategorie: kategorie, p_name: name }));
        },
        async abendessenAbrechnen(vegetarisch, preis) {
            const r = await ausfuehren(client.rpc('abendessen_abrechnen', { p_vegetarisch: vegetarisch, p_preis: preis }));
            return { personen: z(r.personen), preis: z(r.preis), summe: z(r.summe) };
        },
        async abendessenEintragEntfernen(id) {
            await ausfuehren(client.rpc('abendessen_eintrag_entfernen', { p_eintrag_id: id }));
        },
        tagesabschluss() { return ausfuehren(client.rpc('tagesabschluss')); },

        /* --- Schreiben: nur Verwaltung (Admin-Login) --- */
        async guthabenAufladen(personId, betrag) {
            const r = await ausfuehren(adminClient.rpc('guthaben_aufladen', { p_person_id: personId, p_betrag: betrag }));
            return { betrag: z(r.betrag), neuesGuthaben: z(r.neues_guthaben) };
        },
        async produktPreisAendern(id, preis) {
            const r = await ausfuehren(adminClient.rpc('produkt_preis_aendern', { p_id: id, p_preis: preis }));
            return { name: r.name, alterPreis: z(r.alter_preis), neuerPreis: z(r.neuer_preis) };
        },
        produktAnlegen(name, preis, kategorieId, zaehltEinkaufsliste) {
            return ausfuehren(adminClient.rpc('produkt_anlegen', {
                p_name: name, p_preis: preis, p_kategorie_id: kategorieId, p_zaehlt_einkaufsliste: !!zaehltEinkaufsliste
            }));
        },
        async produktLoeschen(id) { await ausfuehren(adminClient.rpc('produkt_loeschen', { p_id: id })); },
        async gastLoeschen(personId) { await ausfuehren(adminClient.rpc('gast_loeschen', { p_person_id: personId })); },

        /* --- Live-Aktualisierung --- */
        abonnieren
    };

    window.API = API;
})();
