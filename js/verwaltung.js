/* ========================================
   VERWALTUNG (am Tablet, mit Admin-Login)

   Guthaben aufladen, Gäste löschen, Produkte (Preis / neu / löschen),
   Backup erstellen, Design (Farbschema).
   Der Admin-Login gilt nur bis zum Verlassen der Verwaltung oder dem
   Neuladen der Seite (er wird nie gespeichert).
   Entfallen gegenüber der alten App: "Wachabteilung bearbeiten"
   (Konten legst du im Supabase-Dashboard an) und "Backup wiederherstellen".
   ======================================== */
(function () {
    'use strict';
    if (!window.Tablet) return;
    const T = window.Tablet;
    const $ = (id) => document.getElementById(id);
    const esc = T.esc, euro = T.euro;

    const TITEL = { wachabteilung: 'Wachabteilung', bdienst: 'B-Dienst', fahrer_bdienst: 'Fahrer B-Dienst',
                    notarzt: 'Notarzt', azubi: 'Auszubildende', gaeste: 'Gäste' };
    const LOESCHBAR = ['gaeste', 'notarzt', 'azubi', 'bdienst', 'fahrer_bdienst'];
    const SEITEN = ['v-login', 'v-kategorie', 'v-personen', 'v-preise'];
    const DESIGNS = [
        ['klassisch', 'Klassisch', ['#667eea', '#34495e', '#27ae60']],
        ['anthrazit', 'Anthrazit &amp; Petrol', ['#2d3748', '#1a202c', '#319795']],
        ['sandbeige', 'Warmes Sandbeige', ['#a47551', '#8f6342', '#6f8f5b']],
        ['salbeigruen', 'Frisches Salbeigrün', ['#4f7d6e', '#3f6a5c', '#3f8f78']]
    ];

    let kat = null;
    let laeuft = false;

    /* ----- Aufbau (Klassen wie in der alten App) ----- */
    function bauen() {
        if ($('v-login')) return;
        const katBtns = Object.keys(TITEL).map((k) =>
            '<button class="kategorie-btn" data-vkat="' + k + '">' + TITEL[k] + '</button>').join('');
        const stil = 'width:400px;max-width:100%;background:#ecf0f1;border-color:#95a5a6';
        const trenner = 'display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:40px;padding-top:30px;border-top:2px solid #ecf0f1';
        const designs = DESIGNS.map((d) =>
            '<button id="design-btn-' + d[0] + '" class="design-option" data-design="' + d[0] + '">' +
            '<span class="design-swatches">' + d[2].map((c) => '<span class="design-swatch" style="background:' + c + '"></span>').join('') +
            '</span><span class="design-option-name">' + d[1] + '</span></button>').join('');

        const html =
            '<div id="v-login" class="hidden"><button class="zurück-btn" data-v="ende">← Zurück</button>' +
            '<h1>⚙️ Verwaltung</h1><div class="admin-section"><h2>Admin-Anmeldung</h2>' +
            '<input type="text" id="v-name" placeholder="Benutzername" autocomplete="off" autocapitalize="none" autocorrect="off">' +
            '<input type="password" id="v-pw" placeholder="Passwort" autocomplete="off">' +
            '<button class="primary" id="v-login-btn">Anmelden</button></div></div>' +

            '<div id="v-kategorie" class="hidden"><button class="zurück-btn" data-v="ende">← Guthaben-Verwaltung verlassen</button>' +
            '<h1>💳 Guthaben verwalten</h1><div class="kategorie-grid">' + katBtns + '</div>' +
            '<div style="' + trenner + '"><button class="kategorie-btn" id="v-preise-btn" style="' + stil + '">💶 Preisverwaltung</button></div>' +
            '<div style="' + trenner + '"><h3 style="color:#7f8c8d;margin-bottom:8px">💾 Datensicherung</h3>' +
            '<button class="kategorie-btn" id="v-backup-btn" style="width:400px;max-width:100%;background:#3498db;border-color:#2980b9;color:white">💾 Backup erstellen</button>' +
            '<p style="color:#95a5a6;font-size:13px;max-width:500px;margin:15px auto 0;text-align:center"><strong>Tipp:</strong> ' +
            'Das Backup landet als Datei auf dem iPad (und in der iCloud). Die Daten selbst liegen sicher in der Datenbank.</p></div>' +
            '<div style="' + trenner + '"><h3 style="color:#7f8c8d;margin-bottom:8px">🎨 Design</h3>' +
            '<div class="design-optionen">' + designs + '</div>' +
            '<p style="color:#95a5a6;font-size:13px;max-width:500px;margin:5px auto 0;text-align:center">Gilt für alle, die diese App auf diesem Gerät öffnen.</p></div></div>' +

            '<div id="v-personen" class="hidden"><button class="zurück-btn" data-v="zurKategorie">← Zurück zu Kategorien</button>' +
            '<h1 id="v-personen-titel">Guthaben verwalten</h1><div id="v-personen-liste"></div></div>' +

            '<div id="v-preise" class="hidden"><button class="zurück-btn" data-v="zurKategorie">← Zurück</button>' +
            '<h1>💶 Produktverwaltung</h1><p style="text-align:center;color:#7f8c8d;font-size:14px;margin-bottom:25px">Preise ändern, Produkte hinzufügen oder löschen</p>' +
            '<div id="v-preise-liste"></div>' +
            '<div class="gast-eingabe" style="max-width:600px;margin:30px auto 0;background:#e8f5e9;border:2px solid #4caf50"><h2>➕ Neues Produkt hinzufügen</h2>' +
            '<input type="text" id="v-neu-name" placeholder="Produktname (z.B. Apfelschorle)" autocomplete="off" autocorrect="off" autocapitalize="words" style="margin-bottom:10px">' +
            '<input type="number" id="v-neu-preis" placeholder="Preis in € (z.B. 1.50)" step="0.01" inputmode="decimal" autocomplete="off" style="margin-bottom:10px">' +
            '<select id="v-neu-kat" style="width:100%;padding:12px;font-size:16px;border:2px solid #bdc3c7;border-radius:8px;margin-bottom:10px"></select>' +
            '<div style="margin-bottom:15px;text-align:left"><label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:15px">' +
            '<input type="checkbox" id="v-neu-liste" style="width:20px;height:20px;cursor:pointer"><span>📋 In Einkaufsliste zählen (z.B. Brötchen, Eier)</span></label>' +
            '<p style="color:#7f8c8d;font-size:13px;margin:5px 0 0 30px">Wenn aktiviert, wird das Produkt in der Küchen-Einkaufsliste gezählt</p></div>' +
            '<button class="success" id="v-neu-btn" style="width:100%">➕ Produkt hinzufügen</button></div></div>';

        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        while (wrap.firstChild) $('t-app').appendChild(wrap.firstChild);
        SEITEN.forEach((s) => T.bereiche.push(s));

        $('t-app').addEventListener('click', (e) => {
            const b = e.target.closest('[data-v]');
            if (b && b.dataset.v === 'ende') verlassen();
            if (b && b.dataset.v === 'zurKategorie') seite('v-kategorie');
            const k = e.target.closest('[data-vkat]');
            if (k) personenOeffnen(k.dataset.vkat);
            const d = e.target.closest('[data-design]');
            if (d) designAnwenden(d.dataset.design);
        });
        $('v-login-btn').onclick = einloggen;
        $('v-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') einloggen(); });
        $('v-preise-btn').onclick = preiseOeffnen;
        $('v-backup-btn').onclick = backup;
        $('v-neu-btn').onclick = produktAnlegen;
        $('v-personen-liste').addEventListener('click', klickPersonen);
        $('v-preise-liste').addEventListener('click', klickPreise);
    }
    function seite(id) { T.bereich(id); }

    /* ----- Öffnen / Anmelden / Verlassen ----- */
    async function oeffnen() {
        bauen();
        designMarkieren(aktuellesDesign());
        let schon = false;
        try { schon = await API.adminAngemeldet(); } catch (e) { /* neu anmelden */ }
        seite(schon ? 'v-kategorie' : 'v-login');
    }
    async function einloggen() {
        const btn = $('v-login-btn'); btn.disabled = true;
        try {
            await API.adminAnmelden($('v-name').value, $('v-pw').value);
            $('v-pw').value = '';
            T.meldung('Erfolgreich angemeldet', 'erfolg');
            seite('v-kategorie');
        } catch (e) { T.meldung(esc(e.message), 'fehler'); $('v-pw').value = ''; }
        finally { btn.disabled = false; }
    }
    async function verlassen() {
        try { await API.adminAbmelden(); } catch (e) { /* lokal ohnehin weg */ }
        $('v-name').value = ''; $('v-pw').value = '';
        T.zurStartseite();
    }
    function fehler(e) {
        if (e.sitzungAbgelaufen) { T.meldung('Verwaltungs-Anmeldung abgelaufen. Bitte neu anmelden.', 'fehler'); seite('v-login'); return; }
        T.meldung(esc(e.message), 'fehler');
    }

    /* ----- Guthaben ----- */
    function personenOeffnen(k) {
        kat = k;
        $('v-personen-titel').textContent = TITEL[k] + ' - Guthaben verwalten';
        seite('v-personen');
        personenZeichnen();
    }
    function nachname(n) { return n.split(' ').pop().toLowerCase(); }
    function personenZeichnen() {
        const liste = $('v-personen-liste');
        const ps = T.personen().filter((p) => p.kategorie === kat)
            .sort((a, b) => nachname(a.anzeigename).localeCompare(nachname(b.anzeigename)));
        liste.innerHTML = ps.length ? ps.map((p) =>
            '<div class="guthaben-verwaltung-karte"><h3>' + esc(p.anzeigename) + '</h3>' +
            '<div style="font-size:20px;margin:10px 0" class="' + (p.guthaben >= 0 ? 'guthaben-positiv' : 'guthaben-negativ') + '">Aktuell: ' + euro(p.guthaben) + '</div>' +
            '<div class="guthaben-eingabe"><input type="number" data-betrag="' + esc(p.id) + '" placeholder="Betrag (z.B. 20.00)" step="0.01" inputmode="decimal">' +
            '<button class="success" data-aufladen="' + esc(p.id) + '">Aufladen</button></div>' +
            (LOESCHBAR.includes(kat) ? '<button class="danger" data-loeschen="' + esc(p.id) + '" style="width:100%;margin-top:10px;padding:10px;font-size:14px">Person löschen</button>' : '') +
            '</div>').join('') : '<p style="text-align:center;color:#95a5a6">Keine Personen in dieser Kategorie.</p>';
    }
    async function klickPersonen(e) {
        const a = e.target.closest('[data-aufladen]');
        const l = e.target.closest('[data-loeschen]');
        if (!a && !l || laeuft) return;
        const id = (a || l).dataset[a ? 'aufladen' : 'loeschen'];
        const p = T.personen().find((x) => x.id === id);
        if (!p) return;
        if (a) {
            const feld = document.querySelector('[data-betrag="' + id + '"]');
            const betrag = parseFloat(feld.value);
            if (isNaN(betrag) || betrag <= 0) { T.meldung('Bitte einen gültigen positiven Betrag eingeben!', 'fehler'); return; }
            laeuft = true;
            try {
                const r = await API.guthabenAufladen(id, betrag);
                T.meldung(euro(r.betrag) + ' wurden aufgeladen!', 'erfolg');
            } catch (er) { fehler(er); }
            finally { laeuft = false; await neu(personenZeichnen); }
        } else {
            if (!confirm('Wirklich "' + p.anzeigename + '" löschen?\n\nWird zu leerem Platzhalter.')) return;
            laeuft = true;
            try { await API.gastLoeschen(id); T.meldung('Person wurde gelöscht!', 'erfolg'); }
            catch (er) { fehler(er); }
            finally { laeuft = false; await neu(personenZeichnen); }
        }
    }
    async function neu(zeichnen) {
        try { await T.neuLaden(); } catch (e) { /* alter Stand bleibt sichtbar */ }
        zeichnen();
    }

    /* ----- Produkte ----- */
    function preiseOeffnen() { seite('v-preise'); preiseZeichnen(); }
    function preiseZeichnen() {
        const d = T.produkte();
        $('v-neu-kat').innerHTML = '<option value="">-- Kategorie wählen --</option>' +
            d.kategorien.map((k) => '<option value="' + k.id + '">' + esc(k.name) + '</option>').join('');
        $('v-preise-liste').innerHTML = d.kategorien.map((k) => {
            const ps = d.produkte.filter((p) => p.kategorie_id === k.id);
            return '<div class="preis-kategorie"><h3>' + esc(k.name) + '</h3><div class="preis-grid">' + ps.map((p) => {
                const del = p.ist_abendessen
                    ? '<span style="color:#95a5a6;font-size:12px;padding:5px 10px">🔒 Geschützt</span>'
                    : '<button class="danger" data-pdel="' + p.id + '" style="padding:5px 10px;font-size:12px;min-width:auto" title="Produkt löschen">🗑️</button>';
                return '<div class="preis-item"><div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:5px">' +
                    '<div class="preis-item-name">' + ((p.zaehlt_einkaufsliste || p.ist_abendessen) ? '📋 ' : '') + esc(p.name) + '</div>' + del + '</div>' +
                    '<div class="preis-item-aktuell">Aktuell: <strong>' + euro(p.preis) + '</strong></div>' +
                    '<div class="preis-eingabe"><input type="number" data-preis="' + p.id + '" placeholder="Neuer Preis" step="0.01" inputmode="decimal" value="' + p.preis.toFixed(2) + '">' +
                    '<button data-pset="' + p.id + '">✓</button></div></div>';
            }).join('') + '</div></div>';
        }).join('');
    }
    async function klickPreise(e) {
        const s = e.target.closest('[data-pset]');
        const d = e.target.closest('[data-pdel]');
        if ((!s && !d) || laeuft) return;
        const id = Number((s || d).dataset[s ? 'pset' : 'pdel']);
        const p = T.produkte().produkte.find((x) => x.id === id);
        if (!p) return;
        if (s) {
            const preis = parseFloat(document.querySelector('[data-preis="' + id + '"]').value);
            if (isNaN(preis) || preis < 0) { T.meldung('Bitte einen gültigen Preis eingeben!', 'fehler'); return; }
            laeuft = true;
            try {
                const r = await API.produktPreisAendern(id, preis);
                T.meldung('Preis für "' + esc(r.name) + '" wurde von ' + euro(r.alterPreis) + ' auf ' + euro(r.neuerPreis) + ' geändert!', 'erfolg');
            } catch (er) { fehler(er); }
            finally { laeuft = false; await neu(preiseZeichnen); }
        } else {
            if (p.ist_abendessen) { T.meldung('⚠️ Abendessen-Produkte können nicht gelöscht werden!<br>Sie sind für die Abendessen-Abrechnung erforderlich.', 'fehler'); return; }
            if (!confirm('Produkt "' + p.name + '" wirklich löschen?\n\nDies kann nicht rückgängig gemacht werden!')) return;
            laeuft = true;
            try { await API.produktLoeschen(id); T.meldung('✅ Produkt "' + esc(p.name) + '" wurde gelöscht!', 'erfolg'); }
            catch (er) { fehler(er); }
            finally { laeuft = false; await neu(preiseZeichnen); }
        }
    }
    async function produktAnlegen() {
        if (laeuft) return;
        const name = $('v-neu-name').value.trim();
        const preis = parseFloat($('v-neu-preis').value);
        const katId = parseInt($('v-neu-kat').value, 10);
        if (!name) { T.meldung('Bitte einen Produktnamen eingeben!', 'fehler'); return; }
        if (isNaN(preis) || preis < 0) { T.meldung('Bitte einen gültigen Preis eingeben!', 'fehler'); return; }
        if (isNaN(katId)) { T.meldung('Bitte eine Kategorie auswählen!', 'fehler'); return; }
        laeuft = true;
        try {
            await API.produktAnlegen(name, preis, katId, $('v-neu-liste').checked);
            $('v-neu-name').value = ''; $('v-neu-preis').value = ''; $('v-neu-kat').value = ''; $('v-neu-liste').checked = false;
            T.meldung('✅ Produkt "' + esc(name) + '" wurde hinzugefügt!', 'erfolg');
        } catch (er) { fehler(er); }
        finally { laeuft = false; await neu(preiseZeichnen); }
    }

    /* ----- Backup (Datei auf dem iPad) ----- */
    async function backup() {
        if (laeuft) return;
        laeuft = true;
        try {
            const daten = await API.backupExport();
            const blob = new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'kantine-backup-' + new Date().toISOString().split('T')[0] + '.json';
            a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            T.meldung('✅ Backup erfolgreich erstellt! Datei wurde heruntergeladen.', 'erfolg');
        } catch (e) { T.meldung('❌ Backup fehlgeschlagen: ' + esc(e.message), 'fehler'); }
        finally { laeuft = false; }
    }

    /* ----- Design (nur dieses Gerät, localStorage) ----- */
    function aktuellesDesign() { try { return localStorage.getItem('design') || 'klassisch'; } catch (e) { return 'klassisch'; } }
    function designMarkieren(t) {
        document.querySelectorAll('.design-option').forEach((b) => b.classList.toggle('aktiv', b.id === 'design-btn-' + t));
    }
    function designAnwenden(t) {
        document.body.removeAttribute('data-theme');
        if (t === 'klassisch') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('design', t); } catch (e) { /* nur dieses Mal */ }
        designMarkieren(t);
    }

    T.hooks.verwaltung = oeffnen;
})();
