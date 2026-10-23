/* ========================================
   TABLET-STARTSEITE (Kategorien, Personenwahl, Gäste, Bestellen)

   Das Tablet ist mit dem Küchen-Konto angemeldet (bleibt gespeichert).
   Ablauf wie in der alten App: Kategorie -> Person -> Bestellen.
   Gäste/Azubi/Notarzt/B-Dienst/Fahrer B-Dienst: 12 Plätze, Name eingeben.
   Küche und Verwaltung klinken sich später über Tablet.hooks ein.
   ======================================== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const euro = (n) => Number(n).toFixed(2) + ' €';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const TITEL = { wachabteilung: 'Wachabteilung', bdienst: 'B-Dienst', fahrer_bdienst: 'Fahrer B-Dienst',
                    notarzt: 'Notarzt', azubi: 'Auszubildende', gaeste: 'Gäste' };
    const MIT_PLAETZEN = ['gaeste', 'notarzt', 'azubi', 'bdienst', 'fahrer_bdienst'];
    const MAX_PLAETZE = 12;
    const BEREICHE = ['startseite', 'benutzer-auswahl', 'bestell-bereich'];

    let profil = null;
    let personen = [];           // alle aktiven Personen
    let kategorien = [], produkte = [];
    let kat = null;              // gewählte Kategorie
    let person = null;           // gewählte Person
    let warenkorb = [];          // { produktId | null, name, preis, menge, individuell }
    let anfrageId = null;
    let laeuft = false;
    let stopRealtime = null;

    /* ----- Hilfen ----- */
    let meldungTimer;
    function meldung(text, typ) {
        const m = $('meldung');
        m.className = 'meldung ' + typ;
        m.innerHTML = text;                      // nur eigene, bereits maskierte Texte
        m.style.display = 'block';
        clearTimeout(meldungTimer);
        meldungTimer = setTimeout(() => { m.style.display = 'none'; }, 5000);
    }
    function designLaden() {
        try {
            const t = localStorage.getItem('design');
            if (t && t !== 'klassisch') document.documentElement.setAttribute('data-theme', t);
        } catch (e) { /* Standard */ }
    }
    function zeige(id) {
        ['t-hinweis', 't-app'].forEach((x) => $(x).classList.toggle('hidden', x !== id));
    }
    function bereich(id) {
        BEREICHE.forEach((b) => $(b).classList.toggle('hidden', b !== id));
    }
    function hinweis(text) { $('t-hinweis').textContent = text; zeige('t-hinweis'); }
    function nachname(n) { return n.split(' ').pop().toLowerCase(); }
    function inKategorie() {
        return personen.filter((p) => p.kategorie === kat)
            .sort((a, b) => nachname(a.anzeigename).localeCompare(nachname(b.anzeigename)));
    }

    /* ----- Ranking (nur Wachabteilung; wie alte App aus den Personen berechnet) ----- */
    function rankingBox(id, titel, zeilen, klasse, prefix) {
        const box = $(id);
        if (!zeilen.length) { box.className = 'hidden'; box.innerHTML = ''; return; }
        box.className = 'schulden-warnung-box ' + klasse;
        box.innerHTML = '<div class="schulden-warnung-titel">' + titel + '</div>' + zeilen.map((p, i) =>
            '<div class="schulden-warnung-zeile ' + prefix + (i + 1) + '"><span>' + esc(p.anzeigename) +
            '</span><span>' + euro(p.guthaben) + '</span></div>').join('');
    }
    function rankingZeigen() {
        if (kat !== 'wachabteilung') {
            $('schulden-warnung-box').className = 'hidden';
            $('guthaben-top-box').className = 'hidden';
            return;
        }
        const w = personen.filter((p) => p.kategorie === 'wachabteilung');
        rankingBox('schulden-warnung-box', '⚠️ Höchste Schulden',
            w.filter((p) => p.guthaben < 0).sort((a, b) => a.guthaben - b.guthaben).slice(0, 3), '', 'schulden-warnung-platz-');
        rankingBox('guthaben-top-box', '💰 Höchstes Guthaben',
            w.filter((p) => p.guthaben > 0).sort((a, b) => b.guthaben - a.guthaben).slice(0, 3), 'guthaben-top-box', 'guthaben-top-platz-');
    }

    /* ----- Navigation ----- */
    function zurStartseite() { kat = null; person = null; warenkorb = []; anfrageId = null; bereich('startseite'); }
    function zurListe() {
        person = null; warenkorb = []; anfrageId = null;
        bereich('benutzer-auswahl');
        listeZeichnen(); rankingZeigen();
    }
    function kategorieWaehlen(k) {
        kat = k;
        bereich('benutzer-auswahl');
        $('kategorie-titel').textContent = TITEL[k];
        $('platzhalter-eingabe-bereich').classList.toggle('hidden', !MIT_PLAETZEN.includes(k));
        rankingZeigen(); listeZeichnen();
    }

    /* ----- Personenliste ----- */
    function listeZeichnen() {
        const liste = $('benutzer-liste');
        liste.innerHTML = '';
        inKategorie().forEach((p) => {
            const karte = document.createElement('div');
            karte.className = 'benutzer-karte';
            karte.onclick = () => personWaehlen(p);
            karte.innerHTML = '<div class="benutzer-name">' + esc(p.anzeigename) + '</div>' +
                '<div class="benutzer-guthaben ' + (p.guthaben >= 0 ? 'guthaben-positiv' : 'guthaben-negativ') + '">' +
                euro(p.guthaben) + '</div>';
            liste.appendChild(karte);
        });
        if (MIT_PLAETZEN.includes(kat)) {          // freie Plätze bis 12, ans Ende
            for (let i = inKategorie().length; i < MAX_PLAETZE; i++) {
                const karte = document.createElement('div');
                karte.className = 'benutzer-karte platzhalter';
                karte.innerHTML = '<div class="benutzer-name">Leerer Platz</div>' +
                    '<div class="benutzer-guthaben" style="color:#95a5a6;font-size:14px">Unten Name eingeben</div>';
                liste.appendChild(karte);
            }
        }
    }
    async function nameSpeichern() {
        const name = $('platzhalter-name-input').value.trim();
        if (!name) { meldung('Bitte einen Namen eingeben!', 'fehler'); return; }
        if (inKategorie().length >= MAX_PLAETZE) { meldung('Alle 12 Plätze sind belegt!', 'fehler'); return; }
        try {
            const neu = await API.gastAnlegen(kat, name);
            $('platzhalter-name-input').value = '';
            personen.push({ id: neu.id, kategorie: kat, anzeigename: neu.anzeigename, guthaben: 0 });
            personWaehlen(personen[personen.length - 1]);
        } catch (e) { fehler(e); }
    }

    /* ----- Bestellseite ----- */
    function personWaehlen(p) {
        person = p; warenkorb = []; anfrageId = null;
        bereich('bestell-bereich');
        $('aktueller-benutzer').textContent = p.anzeigename;
        guthabenZeichnen(); produkteZeichnen(); warenkorbZeichnen(); historieLaden();
        $('benutzer-historie-inhalt').classList.add('hidden');
        $('benutzer-historie-accordeon').classList.remove('offen');
    }
    function guthabenZeichnen() { $('guthaben-anzeige').textContent = euro(person.guthaben); }
    function produkteZeichnen() {
        const c = $('produkte-container');
        c.innerHTML = '';
        kategorien.forEach((k) => {
            const ps = produkte.filter((p) => p.kategorie_id === k.id);
            if (!ps.length) return;
            const div = document.createElement('div');
            div.className = 'produkt-kategorie';
            div.innerHTML = '<h3>' + esc(k.name) + '</h3><div class="produkt-liste">' + ps.map((p) =>
                '<div class="produkt-karte"><div class="produkt-name">' + esc(p.name) + '</div>' +
                '<div class="produkt-preis">' + euro(p.preis) + '</div>' +
                '<div class="menge-steuerung"><button class="menge-btn" data-id="' + p.id + '" data-d="-1">−</button>' +
                '<span class="menge-anzeige" id="menge-' + p.id + '">' + mengeVon(p.id) + '</span>' +
                '<button class="menge-btn" data-id="' + p.id + '" data-d="1">+</button></div></div>').join('') + '</div>';
            c.appendChild(div);
        });
    }
    function mengeVon(id) { const w = warenkorb.find((x) => x.produktId === id); return w ? w.menge : 0; }
    function mengeAendern(id, d) {
        const p = produkte.find((x) => x.id === id);
        if (!p) return;
        let w = warenkorb.find((x) => x.produktId === id);
        if (!w && d > 0) { w = { produktId: id, name: p.name, preis: p.preis, menge: 0 }; warenkorb.push(w); }
        if (!w) return;
        w.menge = Math.max(0, Math.min(50, w.menge + d));
        if (!w.menge) warenkorb = warenkorb.filter((x) => x !== w);
        anfrageId = null;
        const el = $('menge-' + id); if (el) el.textContent = mengeVon(id);
        warenkorbZeichnen();
    }
    function individuellHinzufuegen() {
        const betrag = parseFloat($('individueller-betrag-input').value);
        if (isNaN(betrag) || betrag <= 0) { meldung('Bitte einen gültigen Betrag eingeben!', 'fehler'); return; }
        const name = $('individueller-bezeichnung-input').value.trim() || 'Individueller Betrag';
        warenkorb.push({ produktId: null, name: name, preis: Math.round(betrag * 100) / 100, menge: 1, individuell: true });
        anfrageId = null;
        $('individueller-betrag-input').value = ''; $('individueller-bezeichnung-input').value = '';
        warenkorbZeichnen();
    }
    function warenkorbZeichnen() {
        let cent = 0;
        $('warenkorb').innerHTML = warenkorb.length ? warenkorb.map((w) => {
            cent += Math.round(w.preis * 100) * w.menge;
            return '<div class="warenkorb-item"><div><strong>' + w.menge + '× ' + esc(w.name) + '</strong></div></div>';
        }).join('') : '<p style="color:#95a5a6;text-align:center;padding:20px">Warenkorb ist leer</p>';
        $('summe-anzeige').textContent = (cent / 100).toFixed(2);
    }

    /* ----- Bestellen (die Datenbank rechnet; Abendessen = 0 €, Einkaufsliste automatisch) ----- */
    async function bestellen() {
        if (laeuft) return;
        if (!warenkorb.length) { meldung('Warenkorb ist leer!', 'fehler'); return; }
        const positionen = warenkorb.map((w) => w.individuell
            ? { individuell: true, bezeichnung: w.name, betrag: w.preis }
            : { produkt_id: w.produktId, menge: w.menge });
        if (!anfrageId) anfrageId = crypto.randomUUID();
        laeuft = true; $('t-bestellen-btn').disabled = true;
        try {
            const r = await API.bestellen(person.id, anfrageId, positionen);
            person.guthaben = r.neuesGuthaben;
            warenkorb = []; anfrageId = null;
            produkteZeichnen(); warenkorbZeichnen(); guthabenZeichnen(); historieLaden();
            meldung(r.wiederholt ? 'Diese Bestellung war bereits gespeichert.' :
                'Bestellung erfolgreich! Summe: ' + euro(r.summe) + '<br>Neues Guthaben: ' + euro(r.neuesGuthaben) +
                (r.abendessen ? '<br>🍽️ <strong>Abendessen vorgemerkt!</strong> Wird später abgerechnet.' : ''), 'erfolg');
        } catch (e) {
            fehler(e, e.unsicher ? ' Bitte erneut auf „Jetzt bestellen“ tippen – es wird nicht doppelt gebucht.' : '');
        } finally { laeuft = false; $('t-bestellen-btn').disabled = false; }
    }
    function fehler(e, zusatz) {
        if (e.sitzungAbgelaufen) { abgemeldet(); return; }
        meldung(esc(e.message) + (zusatz || ''), 'fehler');
    }

    /* ----- Historie ----- */
    async function historieLaden() {
        const id = person && person.id;
        try {
            const h = await API.historie(id);
            if (!person || person.id !== id) return;       // inzwischen andere Person
            $('benutzer-historie-badge').textContent = h.length + ' Eintrag' + (h.length !== 1 ? 'e' : '');
            $('benutzer-historie-liste').innerHTML = h.length ? h.map((e) => {
                const pos = e.betrag >= 0, d = new Date(e.zeitpunkt);
                return '<div class="tages-bestellung" style="border-left:3px solid ' + (pos ? '#27ae60' : '#e74c3c') + '">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">' +
                    '<span style="color:#7f8c8d;font-size:12px">' + d.toLocaleDateString('de-DE') + ' ' +
                    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + '</span>' +
                    '<span class="' + (pos ? 'guthaben-positiv' : 'guthaben-negativ') + '" style="font-weight:bold;font-size:14px">' +
                    (pos ? '+' : '') + euro(e.betrag) + '</span></div>' +
                    '<div class="tages-bestellung-produkte" style="margin-bottom:3px"><strong>' + esc(e.aktion) + ':</strong> ' + esc(e.details) + '</div>' +
                    '<div style="color:#95a5a6;font-size:11px">Neues Guthaben: ' + euro(e.neues_guthaben) + '</div></div>';
            }).join('') : '<div class="tagesuebersicht-leer">Noch keine Bestellungen in den letzten 30 Tagen</div>';
        } catch (e) { /* Zusatzanzeige */ }
    }
    function historieUmschalten() {
        const offen = $('benutzer-historie-inhalt').classList.toggle('hidden') === false;
        $('benutzer-historie-accordeon').classList.toggle('offen', offen);
    }

    /* ----- Daten laden + Live-Aktualisierung ----- */
    async function datenLaden() {
        const [pr, ps] = await Promise.all([API.produkteLaden(), API.personenLaden()]);
        kategorien = pr.kategorien; produkte = pr.produkte; personen = ps;
    }
    function liveStarten() {
        if (stopRealtime) stopRealtime();
        let t;
        stopRealtime = API.abonnieren(['personen', 'produkte'], () => {
            clearTimeout(t);
            t = setTimeout(async () => {
                if (laeuft) return;
                try {
                    await datenLaden();
                    if (person) {                        // Guthaben der offenen Person nachziehen
                        const neu = personen.find((p) => p.id === person.id);
                        if (neu) { person = neu; guthabenZeichnen(); } else { zurStartseite(); return; }
                        produkteZeichnen();
                    } else if (kat) { listeZeichnen(); rankingZeigen(); }
                } catch (e) { /* nächste Änderung versucht es erneut */ }
            }, 400);
        });
    }

    /* ----- Start / Ende (Anmeldung und Rollenwahl macht js/start.js) ----- */
    async function starten() {
        try {
            await datenLaden();
            zeige('t-app'); zurStartseite(); liveStarten();
        } catch (e) { hinweis(e.message); }
    }
    function stopp() {
        if (stopRealtime) { stopRealtime(); stopRealtime = null; }
        profil = person = kat = null; warenkorb = []; personen = [];
    }
    function abgemeldet() { stopp(); if (window.Start) window.Start.zeigeLogin(); }

    /* Einhängepunkte für Küche und Verwaltung */
    const Tablet = window.Tablet = {
        hooks: {},
        meldung, esc, euro, bereich, bereiche: BEREICHE,
        profil: () => profil,
        personen: () => personen,
        produkte: () => ({ kategorien, produkte }),
        neuLaden: datenLaden,
        zurStartseite,
        start(p) { profil = p; return starten(); },
        stopp
    };

    document.querySelectorAll('.kategorie-btn[data-kat]').forEach((b) => { b.onclick = () => kategorieWaehlen(b.dataset.kat); });
    $('t-zurueck-start').onclick = zurStartseite;
    $('t-zurueck-liste').onclick = zurListe;
    $('t-name-speichern').onclick = nameSpeichern;
    $('platzhalter-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') nameSpeichern(); });
    $('t-indiv-btn').onclick = individuellHinzufuegen;
    $('t-bestellen-btn').onclick = bestellen;
    $('t-hist-kopf').onclick = historieUmschalten;
    $('produkte-container').addEventListener('click', (e) => {
        const b = e.target.closest('.menge-btn');
        if (b) mengeAendern(Number(b.dataset.id), Number(b.dataset.d));
    });
    const hook = (name, text) => () => (Tablet.hooks[name] ? Tablet.hooks[name]() : meldung(text, 'fehler'));
    $('t-btn-kueche').onclick = hook('kueche', 'Küche nicht geladen.');
    $('t-btn-verwaltung').onclick = hook('verwaltung', 'Verwaltung nicht geladen.');
})();
