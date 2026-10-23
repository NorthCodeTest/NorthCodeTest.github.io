/* ========================================
   HANDY-ANSICHT (Kollegen bestellen am eigenen Handy)

   Zeigt: Login, eigenes Guthaben, Ranking (Wachabteilung),
   Produkte + Warenkorb, Bestellen, Historie (30 Tage).
   Kein individueller Betrag (bewusst, "clean halten").
   Spricht nur über window.API mit der Datenbank.
   ======================================== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const euro = (n) => Number(n).toFixed(2) + ' €';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    let profil = null;
    let person = null;           // { id, anzeigename, guthaben }
    let produkte = [];           // aktive Produkte
    let kategorien = [];
    let warenkorb = {};          // produktId -> Menge
    let anfrageId = null;        // eine ID je Bestellversuch (gegen Doppelbuchung)
    let laeuft = false;
    let stopRealtime = null;

    /* ----- Meldungen ----- */
    let meldungTimer;
    function meldung(text, typ) {
        const m = $('meldung');
        m.className = 'meldung ' + typ;
        m.textContent = text;
        m.style.display = 'block';
        clearTimeout(meldungTimer);
        meldungTimer = setTimeout(() => { m.style.display = 'none'; }, 5000);
    }

    /* ----- Farbschema (Geräte-Einstellung wie in der alten App) ----- */
    function designLaden() {
        try {
            const t = localStorage.getItem('design');
            if (t && t !== 'klassisch') document.documentElement.setAttribute('data-theme', t);
        } catch (e) { /* ohne Speicher: Standard */ }
    }

    /* ----- Ansichten ----- */
    function zeige(id) {
        ['h-bestellen', 'h-hinweis'].forEach((x) => $(x).classList.toggle('hidden', x !== id));
    }
    function hinweis(text) { $('h-hinweis').textContent = text; zeige('h-hinweis'); }

    /* ----- Ranking (Aufbau/Klassen wie in der alten App) ----- */
    function rankingBox(boxId, titel, zeilen, klasse, platzPrefix) {
        const box = $(boxId);
        if (!zeilen.length) { box.className = 'hidden'; box.innerHTML = ''; return; }
        box.className = 'schulden-warnung-box ' + klasse;
        box.innerHTML = '<div class="schulden-warnung-titel">' + titel + '</div>' + zeilen.map((z, i) =>
            '<div class="schulden-warnung-zeile ' + platzPrefix + (i + 1) + '"><span>' + esc(z.name) +
            '</span><span>' + euro(z.guthaben) + '</span></div>').join('');
    }
    async function rankingLaden() {
        try {
            const r = await API.ranking();
            rankingBox('h-schulden', '⚠️ Höchste Schulden', r.schulden, '', 'schulden-warnung-platz-');
            rankingBox('h-guthaben-top', '💰 Höchstes Guthaben', r.guthaben, 'guthaben-top-box', 'guthaben-top-platz-');
        } catch (e) { /* Ranking ist Zusatz: Fehler nicht aufdringlich zeigen */ }
    }

    /* ----- Produkte & Warenkorb ----- */
    function produkteZeichnen() {
        const c = $('h-produkte');
        c.innerHTML = '';
        kategorien.forEach((k) => {
            const ps = produkte.filter((p) => p.kategorie_id === k.id);
            if (!ps.length) return;
            const div = document.createElement('div');
            div.className = 'produkt-kategorie';
            div.innerHTML = '<h3>' + esc(k.name) + '</h3><div class="produkt-liste">' + ps.map((p) =>
                '<div class="produkt-karte"><div><div class="produkt-name">' + esc(p.name) +
                '</div><div class="produkt-preis">' + euro(p.preis) + '</div></div>' +
                '<div class="menge-steuerung"><button class="menge-btn" data-id="' + p.id + '" data-d="-1" aria-label="weniger">−</button>' +
                '<span class="menge-anzeige" id="h-m-' + p.id + '">' + (warenkorb[p.id] || 0) + '</span>' +
                '<button class="menge-btn" data-id="' + p.id + '" data-d="1" aria-label="mehr">+</button></div></div>').join('') + '</div>';
            c.appendChild(div);
        });
    }
    function menge(id, d) {
        const neu = Math.max(0, Math.min(50, (warenkorb[id] || 0) + d));
        if (neu) warenkorb[id] = neu; else delete warenkorb[id];
        anfrageId = null;                       // geänderter Warenkorb = neuer Bestellversuch
        const el = $('h-m-' + id); if (el) el.textContent = neu;
        warenkorbZeichnen();
    }
    function warenkorbZeichnen() {
        const ids = Object.keys(warenkorb);
        let summe = 0;
        $('h-warenkorb').innerHTML = ids.length ? ids.map((id) => {
            const p = produkte.find((x) => x.id === Number(id));
            if (!p) return '';
            const s = Math.round(p.preis * 100) * warenkorb[id] / 100;
            summe += Math.round(p.preis * 100) * warenkorb[id];
            return '<div class="h-wk-zeile"><span>' + warenkorb[id] + '× ' + esc(p.name) + '</span><span>' + euro(s) + '</span></div>';
        }).join('') : '<div class="h-leer">Dein Warenkorb ist leer.</div>';
        $('h-summe').textContent = (summe / 100).toFixed(2);
    }

    /* ----- Bestellen ----- */
    async function bestellen() {
        if (laeuft) return;
        const positionen = Object.keys(warenkorb).map((id) => ({ produkt_id: Number(id), menge: warenkorb[id] }));
        if (!positionen.length) { meldung('Bitte zuerst Produkte auswählen.', 'fehler'); return; }
        if (!anfrageId) anfrageId = crypto.randomUUID();
        laeuft = true; $('h-bestellen-btn').disabled = true;
        try {
            const r = await API.bestellen(person.id, anfrageId, positionen);
            warenkorb = {}; anfrageId = null;
            produkteZeichnen(); warenkorbZeichnen();
            person.guthaben = r.neuesGuthaben;
            guthabenZeichnen();
            meldung(r.wiederholt ? 'Diese Bestellung war bereits gespeichert.' :
                '✅ Bestellung gespeichert' + (r.abendessen ? ' (Abendessen wird abends abgerechnet)' : '') +
                '. Summe: ' + euro(r.summe), 'erfolg');
            rankingLaden(); historieLaden();
        } catch (e) {
            if (e.sitzungAbgelaufen) { await abgemeldet(); return; }
            // Bei unklarem Ausgang bleibt die Anfrage-ID: erneutes Tippen bucht nie doppelt.
            meldung(e.message + (e.unsicher ? ' Tippe erneut auf „Jetzt bestellen“ – es wird nicht doppelt gebucht.' : ''), 'fehler');
        } finally {
            laeuft = false; $('h-bestellen-btn').disabled = false;
        }
    }

    /* ----- Guthaben & Historie ----- */
    function guthabenZeichnen() {
        const el = $('h-guthaben');
        el.textContent = euro(person.guthaben);
        el.className = 'guthaben-betrag' + (person.guthaben < 0 ? ' guthaben-negativ' : '');
    }
    async function historieLaden() {
        try {
            const h = await API.historie(person.id);
            $('h-hist-badge').textContent = h.length + ' Eintrag' + (h.length !== 1 ? 'e' : '');
            $('h-hist-inhalt').innerHTML = h.length ? h.map((e) => {
                const pos = e.betrag >= 0;
                const d = new Date(e.zeitpunkt);
                return '<div class="tages-bestellung" style="border-left:3px solid ' + (pos ? '#27ae60' : '#e74c3c') + '">' +
                    '<div style="display:flex;justify-content:space-between;margin-bottom:5px">' +
                    '<span style="color:#7f8c8d;font-size:12px">' + d.toLocaleDateString('de-DE') + ' ' +
                    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + '</span>' +
                    '<span class="' + (pos ? 'guthaben-positiv' : 'guthaben-negativ') + '" style="font-weight:bold;font-size:14px">' +
                    (pos ? '+' : '') + euro(e.betrag) + '</span></div>' +
                    '<div class="tages-bestellung-produkte"><strong>' + esc(e.aktion) + ':</strong> ' + esc(e.details) + '</div>' +
                    '<div style="color:#95a5a6;font-size:11px">Neues Guthaben: ' + euro(e.neues_guthaben) + '</div></div>';
            }).join('') : '<div class="tagesuebersicht-leer">Noch keine Bestellungen in den letzten 30 Tagen</div>';
        } catch (e) { /* Historie ist Zusatz */ }
    }
    function historieUmschalten() {
        const offen = $('h-hist-inhalt').classList.toggle('hidden') === false;
        $('h-hist').classList.toggle('offen', offen);
    }

    /* ----- Daten laden / Live-Aktualisierung ----- */
    async function datenLaden() {
        const [pr, ps] = await Promise.all([API.produkteLaden(), API.personenLaden()]);
        kategorien = pr.kategorien; produkte = pr.produkte;
        person = ps.find((p) => p.id === profil.person_id) || null;
        if (!person) throw new API.ApiFehler('Zu deinem Konto ist noch keine Person verknüpft. Bitte beim Admin melden.');
        $('h-anzeigename').textContent = person.anzeigename;
        guthabenZeichnen(); produkteZeichnen(); warenkorbZeichnen();
        await Promise.all([rankingLaden(), historieLaden()]);
    }
    function liveStarten() {
        if (stopRealtime) stopRealtime();
        let t;
        stopRealtime = API.abonnieren(['personen', 'produkte'], async () => {
            clearTimeout(t);                       // viele Änderungen -> ein Neuladen
            t = setTimeout(async () => {
                try {
                    const ps = await API.personenLaden();
                    const neu = ps.find((p) => p.id === profil.person_id);
                    if (neu) { person.guthaben = neu.guthaben; guthabenZeichnen(); }
                    const pr = await API.produkteLaden();
                    kategorien = pr.kategorien; produkte = pr.produkte; produkteZeichnen();
                    rankingLaden(); historieLaden();
                } catch (e) { /* nächste Änderung versucht es erneut */ }
            }, 400);
        });
    }

    /* ----- Start / Ende (Anmeldung und Rollenwahl macht js/start.js) ----- */
    async function starten() {
        try {
            await datenLaden();
            zeige('h-bestellen'); liveStarten();
        } catch (e) { hinweis(e.message); }
    }
    async function abgemeldet() {
        if (stopRealtime) { stopRealtime(); stopRealtime = null; }
        profil = person = null; warenkorb = {}; anfrageId = null;
        if (window.Start) window.Start.zeigeLogin();
    }

    $('h-abmelden').onclick = () => API.abmelden();
    $('h-bestellen-btn').onclick = bestellen;
    $('h-hist-kopf').onclick = historieUmschalten;
    $('h-produkte').addEventListener('click', (e) => {
        const b = e.target.closest('.menge-btn');
        if (b) menge(Number(b.dataset.id), Number(b.dataset.d));
    });

    window.Handy = {
        start(p) { profil = p; return starten(); },
        stopp() {
            if (stopRealtime) { stopRealtime(); stopRealtime = null; }
            profil = person = null; warenkorb = {}; anfrageId = null;
        }
    };
})();
