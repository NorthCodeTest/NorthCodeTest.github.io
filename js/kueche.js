/* ========================================
   KÜCHEN-BEREICH (am Tablet, ohne extra Passwort)

   Einkaufsliste, Abendessen abrechnen, Gesamtschulden, Tagesabschluss.
   Hängt sich über Tablet.hooks.kueche in tablet.js ein und baut den
   eigenen Bereich selbst in die Seite (#t-app).
   Die Datenbank rechnet und sperrt; hier wird nur angezeigt.
   ======================================== */
(function () {
    'use strict';
    if (!window.Tablet) return;
    const T = window.Tablet;
    const $ = (id) => document.getElementById(id);
    const esc = T.esc, euro = T.euro;
    const ID = 'koch-bereich';

    let stopLive = null;
    let laeuft = false;

    /* ----- Bereich in die Seite einfügen (Aufbau/Klassen wie die alte App) ----- */
    function bauen() {
        if ($(ID)) return;
        const div = document.createElement('div');
        div.id = ID;
        div.className = 'hidden';
        div.innerHTML =
            '<button class="zurück-btn" id="k-zurueck">← Zurück</button>' +
            '<h1>👨‍🍳 Küchen-Bereich</h1>' +
            '<div class="einkaufsliste"><h2>📋 Einkaufsliste</h2><div id="einkaufsliste-anzeige"></div>' +
            '<button class="danger" id="k-tagesabschluss" style="margin-top:20px;width:100%;padding:15px">' +
            '🗑️ Tagesabschluss (Einkaufsliste/Tagesbestellungen auf 0 setzen &amp; Backup)</button></div>' +
            '<div class="einkaufsliste" style="background:#fff3cd;border:2px solid #ffc107">' +
            '<h2>🍽️ Abendessen abrechnen</h2><div id="abendessen-liste"></div></div>' +
            '<div class="schulden-box"><h2>💰 Gesamtschulden</h2><div class="schulden-betrag" id="schulden-betrag">0.00 €</div></div>';
        $('t-app').appendChild(div);
        T.bereiche.push(ID);
        $('k-zurueck').onclick = verlassen;
        $('k-tagesabschluss').onclick = tagesabschluss;
        $('abendessen-liste').addEventListener('click', klickAbendessen);
    }

    /* ----- Öffnen / Verlassen ----- */
    async function oeffnen() {
        bauen();
        T.bereich(ID);
        await alleLaden();
        liveStarten();
    }
    function verlassen() {
        if (stopLive) { stopLive(); stopLive = null; }
        T.zurStartseite();
    }
    function liveStarten() {
        if (stopLive) stopLive();
        let t;
        stopLive = API.abonnieren(['bestellungen', 'abendessen_eintraege', 'personen'], () => {
            clearTimeout(t);
            t = setTimeout(() => { if (!laeuft) alleLaden(true); }, 500);
        });
    }
    function fehler(e) {
        if (e.sitzungAbgelaufen) { T.meldung('Anmeldung abgelaufen. Bitte neu laden und anmelden.', 'fehler'); return; }
        T.meldung(esc(e.message), 'fehler');
    }

    /* ----- Anzeigen ----- */
    async function alleLaden(still) {
        try {
            const [liste, abend, schulden] = await Promise.all([API.einkaufsliste(), API.abendessenListe(), API.gesamtschulden()]);
            einkaufslisteZeigen(liste);
            abendessenZeigen(abend);
            $('schulden-betrag').textContent = euro(Math.abs(schulden));
        } catch (e) { if (!still) fehler(e); }
    }
    function einkaufslisteZeigen(liste) {
        const z = liste.filter((x) => x.menge > 0);
        $('einkaufsliste-anzeige').innerHTML = z.length ? z.map((x) =>
            '<div class="einkaufsitem"><span class="einkaufsitem-name">' + esc(x.name) +
            '</span><span class="einkaufsitem-menge">' + x.menge + ' Stück</span></div>').join('')
            : '<p style="text-align:center;color:#95a5a6">Noch keine Bestellungen</p>';
    }
    function abendessenZeigen(eintraege) {
        const box = $('abendessen-liste');
        // Preisfelder nicht verlieren, wenn live nachgeladen wird
        const merk = { n: ($('abendessen-preis-normal') || {}).value || '', v: ($('abendessen-preis-vegetarisch') || {}).value || '' };
        if (!eintraege.length) {
            box.innerHTML = '<p style="text-align:center;color:#95a5a6">Noch keine Abendessen-Bestellungen</p>';
            return;
        }
        const normal = eintraege.filter((e) => !e.vegetarisch).length;
        const veg = eintraege.length - normal;
        const feld = (id, titel, anz, platz) =>
            '<div style="flex:1;min-width:220px;background:#fff3cd;padding:15px;border-radius:8px;border:2px solid #ffc107">' +
            '<label style="display:block;font-weight:bold;margin-bottom:8px">' + titel + ' (' + anz + ' Personen) – Preis pro Person:</label>' +
            '<input type="number" id="' + id + '" placeholder="' + platz + '" step="0.01" inputmode="decimal" ' +
            'style="width:100%;padding:10px;font-size:16px;border:2px solid #ffc107;border-radius:5px;margin-bottom:10px;box-sizing:border-box">' +
            '<button class="primary" data-abrechnen="' + (id.endsWith('vegetarisch') ? 'v' : 'n') + '" ' +
            'style="width:100%;padding:15px;font-size:16px">✅ ' + (id.endsWith('vegetarisch') ? 'Vegetarisch' : 'Normal') + ' abbuchen</button></div>';
        box.innerHTML = '<div style="margin-bottom:15px">' + eintraege.map((e) =>
            '<div class="einkaufsitem"><span class="einkaufsitem-name">' + (e.vegetarisch ? '🥗' : '🍽️') + ' ' + esc(e.anzeigename) + '</span>' +
            '<span style="display:flex;align-items:center;gap:10px"><span class="einkaufsitem-menge">' +
            (e.vegetarisch ? '(Vegetarisch)' : '(Normal)') + '</span>' +
            '<button class="danger" data-loeschen="' + esc(e.id) + '" data-name="' + esc(e.anzeigename) + '" ' +
            'style="padding:4px 10px;font-size:12px;min-width:auto" title="Person aus Liste entfernen (kein Essen)">🗑️</button></span></div>').join('') +
            '</div><div style="background:#ecf0f1;padding:10px;border-radius:8px;margin-bottom:15px;text-align:center">' +
            '<strong>Gesamt: ' + eintraege.length + ' Personen</strong><br><span style="font-size:14px;color:#7f8c8d">' +
            normal + ' × Normal | ' + veg + ' × Vegetarisch</span></div>' +
            '<div style="display:flex;gap:15px;flex-wrap:wrap">' +
            feld('abendessen-preis-normal', '🍽️ Normal', normal, 'z.B. 6.50') +
            feld('abendessen-preis-vegetarisch', '🥗 Vegetarisch', veg, 'z.B. 5.50') + '</div>';
        if ($('abendessen-preis-normal')) $('abendessen-preis-normal').value = merk.n;
        if ($('abendessen-preis-vegetarisch')) $('abendessen-preis-vegetarisch').value = merk.v;
    }

    /* ----- Aktionen ----- */
    function klickAbendessen(e) {
        const l = e.target.closest('[data-loeschen]');
        if (l) return eintragEntfernen(l.dataset.loeschen, l.dataset.name);
        const a = e.target.closest('[data-abrechnen]');
        if (a) return abrechnen(a.dataset.abrechnen === 'v');
    }
    async function eintragEntfernen(id, name) {
        if (laeuft) return;
        if (!confirm('"' + name + '" aus der Abendessen-Liste entfernen?\n\nEs wird KEIN Betrag abgebucht.')) return;
        laeuft = true;
        try {
            await API.abendessenEintragEntfernen(id);
            T.meldung('"' + esc(name) + '" wurde aus der Abendessen-Liste entfernt.', 'erfolg');
        } catch (e) { fehler(e); }
        finally { laeuft = false; alleLaden(true); }
    }
    async function abrechnen(vegetarisch) {
        if (laeuft) return;
        const feld = $(vegetarisch ? 'abendessen-preis-vegetarisch' : 'abendessen-preis-normal');
        const preis = parseFloat(feld.value);
        if (!preis || isNaN(preis) || preis <= 0) { T.meldung('Bitte einen gültigen Preis eingeben!', 'fehler'); return; }
        const bez = vegetarisch ? 'Vegetarisch' : 'Normal';
        let anz;
        try {
            anz = (await API.abendessenListe()).filter((x) => !!x.vegetarisch === vegetarisch).length;   // aktueller Stand
        } catch (e) { fehler(e); return; }
        if (!anz) { T.meldung('Keine ' + (vegetarisch ? 'vegetarischen' : 'normalen') + ' Abendessen zum Abrechnen vorhanden!', 'fehler'); alleLaden(true); return; }
        if (!confirm('Wirklich ' + preis.toFixed(2) + ' € von ' + anz + ' Personen (' + bez + ') abbuchen?\n\nGesamtsumme: ' + (Math.round(preis * 100) * anz / 100).toFixed(2) + ' €')) return;
        laeuft = true;
        try {
            const r = await API.abendessenAbrechnen(vegetarisch, preis);
            feld.value = '';
            T.meldung('✅ Abendessen (' + bez + ') abgerechnet!<br>' + r.personen + ' Personen × ' + euro(r.preis) +
                ' = ' + euro(r.summe) + ' abgebucht', 'erfolg');
        } catch (e) {
            // Unklarer Ausgang: erst Stand ansehen, nicht blind wiederholen
            fehler(e);
            if (e.unsicher) T.meldung(esc(e.message) + ' Bitte Liste prüfen, bevor du erneut abbuchst.', 'fehler');
        } finally { laeuft = false; alleLaden(true); }
    }

    /* ----- Tagesabschluss: erst Backup, dann zurücksetzen ----- */
    function datei(daten) {
        const blob = new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kantine-backup-' + new Date().toISOString().split('T')[0] + '.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }
    async function tagesabschluss() {
        if (laeuft) return;
        if (!confirm('Wirklich Tagesabschluss durchführen?\n\n- Einkaufsliste wird auf 0 gesetzt\n- Alle Tagesübersichten werden geleert\n- Backup wird heruntergeladen\n- Bestätigen mit LADEN')) return;
        laeuft = true;
        try {
            let backup;
            try { backup = await API.backupExport(); datei(backup); }
            catch (e) {                              // ohne Backup wird NICHT zurückgesetzt
                T.meldung('❌ Backup nicht möglich, Tagesabschluss abgebrochen: ' + esc(e.message), 'fehler');
                return;
            }
            await API.tagesabschluss();
            T.meldung('Tagesabschluss durchgeführt! Backup wurde heruntergeladen. Einkaufsliste und Abendessen-Liste auf 0 gesetzt.', 'erfolg');
        } catch (e) { fehler(e); }
        finally { laeuft = false; alleLaden(true); }
    }

    T.hooks.kueche = oeffnen;
})();
