// =====================================================================
// Kantine – Datenbank-Tests (Phase 1)
// Voraussetzung: ./setup.sh wurde ausgeführt (frische Testdatenbank).
// Start:  npm test
// =====================================================================
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
const cfg = { host: 'localhost', user: 'kt', password: 'kt', database: 'kantine_test' };

// ---------- Hilfsfunktionen ----------------------------------------
const UID = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  kueche: '00000000-0000-4000-8000-0000000000a2',
  max: '00000000-0000-4000-8000-0000000000b1',
  anna: '00000000-0000-4000-8000-0000000000b2',
  ex: '00000000-0000-4000-8000-0000000000b3',
};
const P = {}; // Personen-IDs nach Name

const su = new Client(cfg); // Superuser: Vorbereitung und unabhängige Kontrolle
const num = (x) => Number(x);
const rund = (x) => Math.round(x * 100) / 100; // JS rechnet mit Kommazahlen ungenau; die Datenbank exakt

/** Führt fn als eingeloggter Benutzer (Rolle "authenticated") in einer Transaktion aus. */
async function als(wer, fn) {
  const c = new Client(cfg);
  await c.connect();
  try {
    await c.query('begin');
    if (wer === 'anon') {
      await c.query('set local role anon');
    } else {
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [UID[wer] ?? wer]);
    }
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

/** Erwartet einen Fehler, optional mit passender Meldung. */
async function fehler(promise, muster) {
  try {
    await promise;
  } catch (e) {
    if (muster && !muster.test(e.message)) {
      throw new Error(`Fehlermeldung "${e.message}" passt nicht zu ${muster}`);
    }
    return e;
  }
  throw new Error('Es wurde ein Fehler erwartet, es gab aber keinen');
}

const bestelle = (wer, person, positionen, requestId = randomUUID()) =>
  als(wer, async (c) =>
    (await c.query('select public.bestellung_aufgeben($1,$2,$3) as r',
      [person, requestId, JSON.stringify(positionen)])).rows[0].r);

const rpc = (wer, sql, params = []) => als(wer, async (c) => (await c.query(sql, params)).rows);
const saldo = async (pid) => num((await su.query('select guthaben from public.personen where id=$1', [pid])).rows[0].guthaben);
const neuePerson = async (kategorie, name, startsaldo = 0) => {
  const id = (await su.query(
    'insert into public.personen (kategorie, anzeigename) values ($1,$2) returning id', [kategorie, name])).rows[0].id;
  if (startsaldo) await su.query("select private.buche($1,$2,'uebernahme',null,null)", [id, startsaldo]);
  return id;
};

// ---------- Mini-Testrunner -----------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// =====================================================================
// VORBEREITUNG
// =====================================================================
async function vorbereiten() {
  await su.connect();
  for (const [name, id] of Object.entries(UID)) {
    await su.query('insert into auth.users (id, email) values ($1,$2)', [id, `${name}@kantine.invalid`]);
  }
  P.max = await neuePerson('wachabteilung', 'Max Mustermann', 10);
  P.anna = await neuePerson('wachabteilung', 'Anna Beispiel', 5);
  P.ben = await neuePerson('wachabteilung', 'Ben Test');
  P.clara = await neuePerson('wachabteilung', 'Clara Test');
  P.dirk = await neuePerson('wachabteilung', 'Dirk Test', 50);
  P.ex = await neuePerson('wachabteilung', 'Eva Ehemalig');
  P.gast = await neuePerson('gaeste', 'Gast Eins', 5);

  await su.query("select private.konto_einrichten('admin','admin')");
  await su.query("select private.konto_einrichten('kueche','kueche')");
  await su.query("select private.konto_einrichten('max','mitglied','Max Mustermann')");
  await su.query("select private.konto_einrichten('anna','mitglied','anna beispiel')"); // Groß/Klein egal
  await su.query("select private.konto_einrichten('ex','mitglied','Eva Ehemalig')");
}

// =====================================================================
// A) RECHTE
// =====================================================================
test('A1 anon: kein Zugriff auf Tabellen und Funktionen', async () => {
  await fehler(rpc('anon', 'select * from public.personen'), /permission denied/);
  await fehler(rpc('anon', 'select * from public.produkte'), /permission denied/);
  await fehler(rpc('anon', 'select * from public.ranking()'), /permission denied/);
  await fehler(rpc('anon', 'select public.tagesabschluss()'), /permission denied/);
  await fehler(rpc('anon', 'select private.rolle()'), /permission denied/);
});

test('A2 Mitglied: sieht nur die eigene Person und eigene Bestellungen', async () => {
  const r = await rpc('max', 'select id, anzeigename from public.personen');
  assert.deepEqual(r.map((x) => x.anzeigename), ['Max Mustermann']);
  await bestelle('anna', P.anna, [{ produkt_id: 11, menge: 1 }]);
  const b = await rpc('max', 'select person_id from public.bestellungen');
  assert.ok(b.every((x) => x.person_id === P.max), 'fremde Bestellung sichtbar');
  const p = await rpc('max', 'select id from public.profile');
  assert.equal(p.length, 1);
});

test('A3 Mitglied: kein direkter Zugriff auf Buchungen/Positionen/Tagesabschlüsse', async () => {
  for (const t of ['guthaben_buchungen', 'bestellpositionen', 'tagesabschluesse']) {
    await fehler(rpc('max', `select * from public.${t}`), /permission denied/);
  }
});

test('A4 Mitglied: kein direktes Schreiben (Guthaben, Preise, Bestellungen)', async () => {
  await fehler(rpc('max', 'update public.personen set guthaben = 999'), /permission denied/);
  await fehler(rpc('max', 'update public.produkte set preis = 0'), /permission denied/);
  await fehler(rpc('max', 'delete from public.produkte'), /permission denied/);
  await fehler(rpc('max', "insert into public.bestellungen (person_id, quelle, client_request_id) values ($1,'handy',gen_random_uuid())", [P.max]), /permission denied/);
  await fehler(rpc('max', "insert into public.profile (id, benutzername, rolle) values (gen_random_uuid(),'hack','admin')"), /permission denied/);
  await fehler(rpc('max', "update public.profile set rolle='admin'"), /permission denied/);
});

test('A5 Kein Schreiben für Küche und Admin direkt in Tabellen (nur über Funktionen)', async () => {
  await fehler(rpc('kueche', 'update public.personen set guthaben = 999'), /permission denied/);
  await fehler(rpc('admin', 'update public.personen set guthaben = 999'), /permission denied/);
  await fehler(rpc('admin', 'update public.produkte set preis = 0'), /permission denied/);
});

test('A6 Mitglied: alle Küchen-/Admin-Funktionen sind gesperrt', async () => {
  const sperren = [
    ['select public.tagesabschluss()', []],
    ['select * from public.einkaufsliste()', []],
    ['select public.gesamtschulden()', []],
    ['select * from public.abendessen_liste()', []],
    ['select public.backup_export()', []],
    ['select public.guthaben_aufladen($1, 10)', [P.max]],
    ['select public.produkt_preis_aendern(3, 0)', []],
    ['select public.produkt_anlegen(\'X\', 1, 0::smallint, false)', []],
    ['select public.produkt_loeschen(10)', []],
    ["select public.gast_anlegen('gaeste','X')", []],
    ['select public.gast_loeschen($1)', [P.gast]],
    ['select public.abendessen_abrechnen(false, 5)', []],
    ['select public.abendessen_eintrag_entfernen(gen_random_uuid())', []],
    ['select * from public.historie_person($1)', [P.anna]], // fremde Historie
  ];
  for (const [sql, params] of sperren) {
    await fehler(rpc('max', sql, params), /Keine Berechtigung/);
  }
});

test('A7 Mitglied: bestellt nur für sich, kein individueller Betrag', async () => {
  await fehler(bestelle('max', P.anna, [{ produkt_id: 11 }]), /Keine Berechtigung/);
  await fehler(bestelle('max', P.max, [{ individuell: true, bezeichnung: 'Hack', betrag: 1 }]), /Keine Berechtigung/);
  await fehler(bestelle('max', P.gast, [{ produkt_id: 11 }]), /Keine Berechtigung/);
});

test('A8 Küche: darf nicht aufladen, Produkte ändern oder Gäste löschen', async () => {
  await fehler(rpc('kueche', 'select public.guthaben_aufladen($1, 10)', [P.max]), /Keine Berechtigung/);
  await fehler(rpc('kueche', 'select public.produkt_preis_aendern(3, 0)'), /Keine Berechtigung/);
  await fehler(rpc('kueche', "select public.produkt_anlegen('X', 1, 0::smallint, false)"), /Keine Berechtigung/);
  await fehler(rpc('kueche', 'select public.produkt_loeschen(10)'), /Keine Berechtigung/);
  await fehler(rpc('kueche', 'select public.gast_loeschen($1)', [P.gast]), /Keine Berechtigung/);
  const prof = await rpc('kueche', 'select benutzername from public.profile');
  assert.deepEqual(prof.map((x) => x.benutzername), ['kueche'], 'Küche darf nur das eigene Profil sehen');
});

test('A9 Interne Funktionen (private.*) sind für Clients nicht aufrufbar', async () => {
  await fehler(rpc('admin', 'select private.historie_bereinigen()'), /permission denied/);
  await fehler(rpc('admin', "select private.konto_einrichten('x','admin')"), /permission denied/);
  await fehler(rpc('admin', "select private.buche($1, 100, 'aufladung', null, null)", [P.max]), /permission denied/);
  await fehler(rpc('kueche', "select private.konto_deaktivieren('max')"), /permission denied/);
});

test('A10 Gesperrtes Konto verliert sofort jeden Zugriff', async () => {
  assert.equal((await rpc('ex', 'select * from public.personen')).length, 1);
  await su.query("select private.konto_deaktivieren('ex')");
  assert.equal((await rpc('ex', 'select * from public.personen')).length, 0);
  await fehler(rpc('ex', 'select * from public.ranking()'), /Keine Berechtigung/);
  await fehler(bestelle('ex', P.ex, [{ produkt_id: 11 }]), /Keine Berechtigung/);
  const b = (await su.query("select banned_until from auth.users where id=$1", [UID.ex])).rows[0].banned_until;
  assert.ok(b && new Date(b) > new Date(), 'Login nicht gesperrt');
  await su.query("select private.konto_aktivieren('ex')");
  assert.equal((await rpc('ex', 'select * from public.personen')).length, 1);
});

test('A11 Konto-Einrichtung: Fehlermeldungen und Regeln', async () => {
  await fehler(su.query("select private.konto_einrichten('gibtsnicht','admin')"), /Kein Login/);
  await fehler(su.query("select private.konto_einrichten('max','mitglied','Unbekannt Person')"), /nicht in der Wachabteilung/);
  await fehler(su.query("select private.konto_einrichten('max','boss')"), /Rolle muss/);
  await fehler(su.query("select private.konto_einrichten('max','mitglied')"), /profile_mitglied_braucht_person/);
  // Gast kann kein Handy-Konto bekommen (nur Wachabteilung wird gefunden)
  await fehler(su.query("select private.konto_einrichten('max','mitglied','Gast Eins')"), /nicht in der Wachabteilung/);
});

// =====================================================================
// B) BESTELLUNG
// =====================================================================
test('B1 Bestellung: exakte Summe, Guthaben, Historie, Einkaufsliste', async () => {
  const vorher = await saldo(P.max); // 10.00
  const r = await bestelle('max', P.max, [
    { produkt_id: 3, menge: 3 }, // Brötchen 3 x 1.30 = 3.90
    { produkt_id: 7, menge: 2 }, // Ei 2 x 0.40 = 0.80
    { produkt_id: 1, menge: 1 }, // Kaffee 1.00 (zählt nicht in die Einkaufsliste)
  ]);
  assert.equal(num(r.summe), 5.7);
  assert.equal(num(r.neues_guthaben), 4.3);
  assert.equal(await saldo(P.max), rund(vorher - 5.7));
  const h = await rpc('max', 'select * from public.historie_person($1)', [P.max]);
  const bestell = h.filter((x) => x.aktion === 'Bestellung');
  assert.equal(bestell.length, 3);
  assert.ok(bestell.some((x) => x.details === 'Normal (3x)' && num(x.betrag) === -3.9));
  assert.ok(bestell.every((x) => num(x.neues_guthaben) === 4.3));
  const e = await rpc('kueche', 'select * from public.einkaufsliste()');
  assert.deepEqual(e.map((x) => [x.name, x.menge]), [['Normal', 3], ['Ei', 2]]);
});

test('B2 Preis kommt aus der Datenbank (Client-Preis wird ignoriert)', async () => {
  const vorher = await saldo(P.max);
  const r = await bestelle('max', P.max, [{ produkt_id: 10, menge: 1, preis: 0, einzelpreis: 0, name: 'Gratis' }]);
  assert.equal(num(r.summe), 1.2);
  assert.equal(await saldo(P.max), rund(vorher - 1.2));
});

test('B3 Preis-Snapshot: spätere Preisänderung ändert alte Bestellungen nicht', async () => {
  await rpc('admin', 'select public.produkt_preis_aendern(11, 0.50)');
  const r = await bestelle('anna', P.anna, [{ produkt_id: 11, menge: 2 }]);
  assert.equal(num(r.summe), 1.0);
  await rpc('admin', 'select public.produkt_preis_aendern(11, 0.40)');
  const h = await rpc('anna', 'select * from public.historie_person($1)', [P.anna]);
  assert.ok(h.some((x) => x.details === 'Süßes Klein (2x)' && num(x.betrag) === -1.0), 'alte Position hat falschen Preis');
  const r2 = await bestelle('anna', P.anna, [{ produkt_id: 11, menge: 2 }]);
  assert.equal(num(r2.summe), 0.8);
});

test('B4 Rundung: 3 x 0,10 EUR = exakt 0,30 EUR', async () => {
  const neu = (await rpc('admin', "select public.produkt_anlegen('Cent', 0.10, 5::smallint, false) as r"))[0].r;
  const r = await bestelle('kueche', P.ben, [{ produkt_id: neu.id, menge: 3 }]);
  assert.equal(num(r.summe), 0.3);
  assert.equal(num(r.neues_guthaben), -0.3);
  // und in der Datenbank steht exakt 0.30 (numeric, kein Fließkomma)
  assert.equal((await su.query('select guthaben::text g from public.personen where id=$1', [P.ben])).rows[0].g, '-0.30');
});

test('B5 Schulden sind erlaubt (kein Überziehungslimit)', async () => {
  await bestelle('kueche', P.clara, [{ produkt_id: 3, menge: 50 }]); // 65.00
  assert.equal(await saldo(P.clara), -65);
});

test('B6 Ungültige Warenkörbe werden abgelehnt, nichts wird gebucht', async () => {
  const vorher = await saldo(P.ben);
  const fall = [
    [[], /leer oder ungültig/],
    [[{ produkt_id: 3, menge: 0 }], /Ungültige Menge/],
    [[{ produkt_id: 3, menge: -1 }], /Ungültige Menge/],
    [[{ produkt_id: 3, menge: 100 }], /Ungültige Menge/],
    [[{ produkt_id: 3, menge: 'abc' }], /Ungültige Menge/],
    [[{ produkt_id: 3, menge: 1.5 }], /Ungültige Menge/],
    [[{ produkt_id: 999999 }], /nicht \(mehr\) verfügbar/],
    [[{ produkt_id: 'x' }], /Ungültiges Produkt/],
    [[{ foo: 1 }], /Ungültige Position/],
    [['text'], /Ungültige Position/],
  ];
  for (const [pos, muster] of fall) {
    await fehler(bestelle('kueche', P.ben, pos), muster);
  }
  await fehler(als('kueche', (c) => c.query("select public.bestellung_aufgeben($1,$2,'{\"a\":1}')", [P.ben, randomUUID()])), /leer oder ungültig/);
  await fehler(als('kueche', (c) => c.query("select public.bestellung_aufgeben($1,null,'[]')", [P.ben])), /Anfrage-ID fehlt/);
  assert.equal(await saldo(P.ben), vorher, 'Guthaben hat sich trotz Fehler geändert');
});

test('B7 Ein Fehler in der 2. Position rollt die ganze Bestellung zurück', async () => {
  const vorher = await saldo(P.ben);
  const anz = num((await su.query('select count(*) from public.bestellungen')).rows[0].count);
  await fehler(bestelle('kueche', P.ben, [{ produkt_id: 3, menge: 2 }, { produkt_id: 999999 }]), /nicht \(mehr\) verfügbar/);
  assert.equal(await saldo(P.ben), vorher);
  assert.equal(num((await su.query('select count(*) from public.bestellungen')).rows[0].count), anz);
});

test('B8 Individueller Betrag (Küche): gebucht, aber nicht in der Einkaufsliste', async () => {
  const vorher = await saldo(P.gast);
  const r = await bestelle('kueche', P.gast, [{ individuell: true, bezeichnung: 'Eis', betrag: 2.5 }]);
  assert.equal(num(r.summe), 2.5);
  assert.equal(await saldo(P.gast), rund(vorher - 2.5));
  const h = await rpc('kueche', 'select * from public.historie_person($1)', [P.gast]);
  assert.ok(h.some((x) => x.details === 'Eis' && num(x.betrag) === -2.5));
  const nameOhne = await bestelle('kueche', P.gast, [{ individuell: true, betrag: 1 }]);
  assert.equal(num(nameOhne.summe), 1);
  const h2 = await rpc('kueche', 'select details from public.historie_person($1)', [P.gast]);
  assert.ok(h2.some((x) => x.details === 'Individueller Betrag'));
  for (const betrag of [0, -1, 'abc', 501, 1.234, null]) {
    await fehler(bestelle('kueche', P.gast, [{ individuell: true, betrag }]), /gültigen Betrag/);
  }
});

test('B9 Idempotenz: gleiche Anfrage-ID bucht nur einmal', async () => {
  const id = randomUUID();
  const vorher = await saldo(P.ben);
  const r1 = await bestelle('kueche', P.ben, [{ produkt_id: 7, menge: 5 }], id); // 2.00
  const r2 = await bestelle('kueche', P.ben, [{ produkt_id: 7, menge: 5 }], id);
  assert.equal(r1.wiederholt, false);
  assert.equal(r2.wiederholt, true);
  assert.equal(r1.bestellung_id, r2.bestellung_id);
  assert.equal(await saldo(P.ben), rund(vorher - 2));
  await fehler(bestelle('kueche', P.dirk, [{ produkt_id: 7 }], id), /bereits für eine andere Person/);
});

test('B10 Nicht verfügbare Personen: gelöschter Gast, unbekannte ID', async () => {
  await fehler(bestelle('kueche', randomUUID(), [{ produkt_id: 3 }]), /nicht gefunden/);
});

// =====================================================================
// C) ABENDESSEN
// =====================================================================
test('C1 Abendessen: kostet beim Bestellen 0, ein Eintrag pro Person', async () => {
  const vorher = await saldo(P.anna);
  const r = await bestelle('kueche', P.anna, [{ produkt_id: 8 }, { produkt_id: 3 }]);
  assert.equal(num(r.summe), 1.3); // nur das Brötchen
  assert.equal(r.abendessen_vorgemerkt, true);
  assert.equal(await saldo(P.anna), rund(vorher - 1.3));
  // zweites Mal (vegetarisch): kein zweiter Eintrag, der erste bleibt bestehen
  await bestelle('anna', P.anna, [{ produkt_id: 9 }]);
  const l = await rpc('kueche', 'select * from public.abendessen_liste()');
  const eintraege = l.filter((x) => x.person_id === P.anna);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].vegetarisch, false);
  // Abendessen taucht nie in der Einkaufsliste auf
  const e = await rpc('kueche', 'select * from public.einkaufsliste()');
  assert.ok(!e.some((x) => /Abendessen/.test(x.name)));
  // Historie: Abendessen-Position mit 0,00
  const h = await rpc('anna', 'select * from public.historie_person($1)', [P.anna]);
  assert.ok(h.some((x) => x.details === 'Abendessen Normal' && num(x.betrag) === 0));
});

test('C2 Abendessen abrechnen: getrennt nach Normal/Vegetarisch, nie doppelt', async () => {
  await bestelle('max', P.max, [{ produkt_id: 9 }]); // vegetarisch
  await bestelle('kueche', P.dirk, [{ produkt_id: 8 }]); // normal
  const a0 = await saldo(P.anna), m0 = await saldo(P.max), d0 = await saldo(P.dirk);

  const r = (await rpc('kueche', 'select public.abendessen_abrechnen(false, 6.5) as r'))[0].r;
  assert.equal(r.personen, 2); // Anna + Dirk
  assert.equal(num(r.summe), 13);
  assert.equal(await saldo(P.anna), rund(a0 - 6.5));
  assert.equal(await saldo(P.dirk), rund(d0 - 6.5));
  assert.equal(await saldo(P.max), m0, 'Vegetarier darf noch nicht belastet sein');

  await fehler(rpc('kueche', 'select public.abendessen_abrechnen(false, 6.5)'), /Keine normalen Abendessen/);
  assert.equal(await saldo(P.anna), rund(a0 - 6.5), 'doppelte Abbuchung!');

  await rpc('kueche', 'select public.abendessen_abrechnen(true, 5.5)');
  assert.equal(await saldo(P.max), rund(m0 - 5.5));

  const h = await rpc('max', 'select * from public.historie_person($1)', [P.max]);
  assert.ok(h.some((x) => x.aktion === 'Abendessen-Abrechnung' && x.details === 'Abendessen (Vegetarisch)' && num(x.betrag) === -5.5));
  assert.equal((await rpc('kueche', 'select * from public.abendessen_liste()')).length, 0);
});

test('C3 Abendessen: ungültige Preise werden abgelehnt', async () => {
  for (const p of [0, -1, null, 101]) {
    await fehler(rpc('kueche', 'select public.abendessen_abrechnen(false, $1)', [p]), /gültigen Preis/);
  }
});

test('C4 Eintrag entfernen: ohne Abbuchung, nur einmal', async () => {
  await bestelle('kueche', P.ben, [{ produkt_id: 8 }]);
  const eintrag = (await rpc('kueche', 'select * from public.abendessen_liste()')).find((x) => x.person_id === P.ben);
  const vorher = await saldo(P.ben);
  await rpc('kueche', 'select public.abendessen_eintrag_entfernen($1)', [eintrag.id]);
  await fehler(rpc('kueche', 'select public.abendessen_eintrag_entfernen($1)', [eintrag.id]), /nicht \(mehr\)/);
  assert.equal(await saldo(P.ben), vorher);
  await fehler(rpc('kueche', 'select public.abendessen_abrechnen(false, 6)'), /Keine normalen/);
});

// =====================================================================
// D) TAGESABSCHLUSS
// =====================================================================
test('D1 Tagesabschluss: Einkaufsliste auf 0, Abendessen verworfen, Guthaben unverändert', async () => {
  await bestelle('kueche', P.dirk, [{ produkt_id: 3, menge: 2 }, { produkt_id: 9 }]);
  const vorher = await saldo(P.dirk);
  const offen = (await rpc('kueche', 'select * from public.einkaufsliste()')).map((x) => [x.name, x.menge]);
  assert.ok(offen.length > 0);

  const r = (await rpc('kueche', 'select public.tagesabschluss() as r'))[0].r;
  assert.ok(r.bestellungen > 0);
  assert.deepEqual(r.einkaufsliste.map((x) => [x.name, x.menge]), offen, 'Snapshot weicht von der Einkaufsliste ab');
  assert.equal(r.abendessen_verworfen.length, 1);
  assert.equal(r.abendessen_verworfen[0].name, 'Dirk Test');

  assert.equal((await rpc('kueche', 'select * from public.einkaufsliste()')).length, 0);
  assert.equal((await rpc('kueche', 'select * from public.abendessen_liste()')).length, 0);
  assert.equal(await saldo(P.dirk), vorher, 'Tagesabschluss darf kein Guthaben ändern');
  const snap = (await su.query('select snapshot from public.tagesabschluesse where id=$1', [r.id])).rows[0].snapshot;
  assert.ok(!JSON.stringify(snap).includes('Dirk'), 'Snapshot enthält Namen');

  // Neue Bestellung nach dem Abschluss zählt wieder ab 0
  await bestelle('kueche', P.dirk, [{ produkt_id: 7, menge: 4 }]);
  const e = await rpc('kueche', 'select * from public.einkaufsliste()');
  assert.deepEqual(e.map((x) => [x.name, x.menge]), [['Ei', 4]]);
  // Verlauf (Historie) bleibt nach dem Abschluss erhalten
  const h = await rpc('kueche', 'select * from public.historie_person($1)', [P.dirk]);
  assert.ok(h.some((x) => x.details === 'Normal (2x)'));
});

test('D2 Tagesabschluss ist nur für Küche/Admin', async () => {
  await fehler(rpc('max', 'select public.tagesabschluss()'), /Keine Berechtigung/);
  await fehler(rpc('anon', 'select public.tagesabschluss()'), /permission denied/);
  await rpc('admin', 'select public.tagesabschluss()');
});

// =====================================================================
// E) VERWALTUNG
// =====================================================================
test('E1 Aufladen (Admin): Guthaben, Historie, Eingabeprüfung', async () => {
  const vorher = await saldo(P.max);
  const r = (await rpc('admin', 'select public.guthaben_aufladen($1, 20.005) as r', [P.max]))[0].r;
  assert.equal(num(r.betrag), 20.01);
  assert.equal(await saldo(P.max), Math.round((vorher + 20.01) * 100) / 100);
  const h = await rpc('max', 'select * from public.historie_person($1)', [P.max]);
  assert.ok(h.some((x) => x.aktion === 'Einzahlung' && num(x.betrag) === 20.01));
  for (const b of [0, -5, null, 10001]) {
    await fehler(rpc('admin', 'select public.guthaben_aufladen($1, $2)', [P.max, b]), /gültigen positiven Betrag/);
  }
  await fehler(rpc('admin', 'select public.guthaben_aufladen($1, 5)', [randomUUID()]), /nicht gefunden/);
});

test('E2 Produkte (Admin): anlegen, Einkaufsliste, Schutz, Löschen', async () => {
  const neu = (await rpc('admin', "select public.produkt_anlegen('Apfelschorle Süß', 1.5, 0::smallint, true) as r"))[0].r;
  const p = (await su.query('select * from public.produkte where id=$1', [neu.id])).rows[0];
  assert.equal(p.typ, 'apfelschorle_suess');
  assert.equal(p.zaehlt_einkaufsliste, true);
  await bestelle('kueche', P.ben, [{ produkt_id: neu.id, menge: 2 }]);
  assert.ok((await rpc('kueche', 'select * from public.einkaufsliste()')).some((x) => x.name === 'Apfelschorle Süß' && x.menge === 2));

  // ein neues Produkt darf nie ungewollt zum Abendessen werden
  const tarn = (await rpc('admin', "select public.produkt_anlegen('Abendessen Normal', 1, 3::smallint, true) as r"))[0].r;
  const t = (await su.query('select typ, ist_abendessen from public.produkte where id=$1', [tarn.id])).rows[0];
  assert.equal(t.ist_abendessen, false);

  // Abendessen ist geschützt
  await fehler(rpc('admin', 'select public.produkt_loeschen(8)'), /nicht gelöscht werden/);
  await fehler(rpc('admin', 'select public.produkt_loeschen(9)'), /nicht gelöscht werden/);

  // normales Produkt löschen: weg aus der Auswahl, Historie bleibt
  await rpc('admin', 'select public.produkt_loeschen($1)', [neu.id]);
  assert.ok(!(await rpc('max', 'select id from public.produkte')).some((x) => x.id === String(neu.id)));
  await fehler(bestelle('kueche', P.ben, [{ produkt_id: neu.id }]), /nicht \(mehr\) verfügbar/);
  const h = await rpc('kueche', 'select * from public.historie_person($1)', [P.ben]);
  assert.ok(h.some((x) => x.details === 'Apfelschorle Süß (2x)'));

  // Eingabeprüfung
  await fehler(rpc('admin', "select public.produkt_anlegen('', 1, 0::smallint, false)"), /Produktnamen/);
  await fehler(rpc('admin', "select public.produkt_anlegen('A', -1, 0::smallint, false)"), /gültigen Preis/);
  await fehler(rpc('admin', "select public.produkt_anlegen('A', 1, 9::smallint, false)"), /Kategorie/);
  await fehler(rpc('admin', 'select public.produkt_preis_aendern(3, -1)'), /gültigen Preis/);
  await fehler(rpc('admin', 'select public.produkt_preis_aendern(99999, 1)'), /nicht gefunden/);
});

test('E3 Gäste: max. 12 Plätze, Anlegen durch Küche, Löschen nur Admin', async () => {
  const ids = [];
  for (let i = 1; i <= 12; i++) {
    ids.push((await rpc('kueche', "select public.gast_anlegen('azubi', $1) as r", ['Azubi ' + i]))[0].r.id);
  }
  await fehler(rpc('kueche', "select public.gast_anlegen('azubi', 'Azubi 13')"), /Alle 12 Plätze/);
  // andere Kategorie ist unabhängig
  await rpc('kueche', "select public.gast_anlegen('notarzt', 'Dr. Eins')");
  await fehler(rpc('kueche', "select public.gast_anlegen('wachabteilung', 'Hack')"), /Ungültige Kategorie/);
  await fehler(rpc('kueche', "select public.gast_anlegen('azubi', '   ')"), /Namen/);

  // Gast mit offenem Abendessen löschen -> Eintrag verschwindet, Bestellen nicht mehr möglich
  await bestelle('kueche', ids[0], [{ produkt_id: 8 }]);
  assert.ok((await rpc('kueche', 'select * from public.abendessen_liste()')).some((x) => x.person_id === ids[0]));
  await rpc('admin', 'select public.gast_loeschen($1)', [ids[0]]);
  assert.ok(!(await rpc('kueche', 'select * from public.abendessen_liste()')).some((x) => x.person_id === ids[0]));
  await fehler(bestelle('kueche', ids[0], [{ produkt_id: 3 }]), /nicht gefunden oder nicht mehr aktiv/);
  await fehler(rpc('admin', 'select public.gast_loeschen($1)', [ids[0]]), /nicht gefunden/);
  await fehler(rpc('admin', 'select public.gast_loeschen($1)', [P.max]), /nicht gefunden/); // Wache nicht löschbar

  // Platz ist wieder frei
  await rpc('kueche', "select public.gast_anlegen('azubi', 'Azubi 13')");
  await fehler(rpc('kueche', "select public.gast_anlegen('azubi', 'Azubi 14')"), /Alle 12 Plätze/);
});

// =====================================================================
// F) RANKING, BACKUP, HISTORIE
// =====================================================================
test('F1 Ranking: Top 3 Schulden/Guthaben, nur Wachabteilung, nur Name+Guthaben', async () => {
  await su.query("select private.buche($1,-500,'uebernahme',null,null)", [P.gast]); // Gast mit hohen Schulden
  const wache = (await su.query("select anzeigename, guthaben from public.personen where kategorie='wachabteilung' and aktiv")).rows
    .map((x) => ({ name: x.anzeigename, g: num(x.guthaben) }));
  const erwSchuld = wache.filter((x) => x.g < 0).sort((a, b) => a.g - b.g || a.name.localeCompare(b.name)).slice(0, 3);
  const erwPlus = wache.filter((x) => x.g > 0).sort((a, b) => b.g - a.g || a.name.localeCompare(b.name)).slice(0, 3);

  for (const wer of ['max', 'kueche', 'admin']) {
    const r = await rpc(wer, 'select * from public.ranking()');
    assert.deepEqual(Object.keys(r[0]).sort(), ['art', 'guthaben', 'name', 'platz']);
    const s = r.filter((x) => x.art === 'schulden');
    const g = r.filter((x) => x.art === 'guthaben');
    assert.deepEqual(s.map((x) => [x.platz, x.name, num(x.guthaben)]), erwSchuld.map((x, i) => [i + 1, x.name, x.g]));
    assert.deepEqual(g.map((x) => [x.platz, x.name, num(x.guthaben)]), erwPlus.map((x, i) => [i + 1, x.name, x.g]));
    assert.ok(!r.some((x) => x.name === 'Gast Eins'), 'Gast im Ranking');
    assert.ok(s.length <= 3 && g.length <= 3);
  }
});

test('F2 Gesamtschulden = Summe der negativen Guthaben aktiver Personen', async () => {
  const erw = num((await su.query('select coalesce(sum(-guthaben),0) s from public.personen where aktiv and guthaben<0')).rows[0].s);
  const r = (await rpc('kueche', 'select public.gesamtschulden() as s'))[0].s;
  assert.equal(num(r), erw);
  assert.ok(erw > 0);
});

test('F3 Backup-Export: vollständig, nur Küche/Admin', async () => {
  const b = (await rpc('kueche', 'select public.backup_export() as b'))[0].b;
  assert.equal(b.version, 'supabase-1');
  const anzPers = num((await su.query('select count(*) from public.personen')).rows[0].count);
  assert.equal(b.personen.length, anzPers);
  assert.equal(b.produkt_kategorien.length, 6);
  assert.ok(b.produkte.length >= 12);
  assert.ok(Array.isArray(b.einkaufsliste) && Array.isArray(b.abendessen_offen) && b.historie_30_tage.length > 0);
  const max = b.personen.find((p) => p.anzeigename === 'Max Mustermann');
  assert.equal(num(max.guthaben), await saldo(P.max));
  await fehler(rpc('max', 'select public.backup_export()'), /Keine Berechtigung/);
});

test('F4 Konsistenz: Guthaben == Summe aller Buchungen (vor der Bereinigung)', async () => {
  const r = await su.query(`
    select p.anzeigename, p.guthaben, coalesce(sum(g.betrag),0) as summe,
           (select saldo_danach from public.guthaben_buchungen x where x.person_id=p.id order by x.id desc limit 1) as letzter
      from public.personen p left join public.guthaben_buchungen g on g.person_id=p.id
     group by p.id`);
  for (const x of r.rows) {
    assert.equal(num(x.guthaben), num(x.summe), `Summe passt nicht für ${x.anzeigename}`);
    if (x.letzter !== null) assert.equal(num(x.guthaben), num(x.letzter), `Saldo-Kette gebrochen für ${x.anzeigename}`);
  }
});

test('F5 30-Tage-Bereinigung: alte Historie weg, Guthaben bleiben', async () => {
  // Person, deren GESAMTE Aktivität 40 Tage her ist (so entsteht alte Historie in echt)
  const alt = await neuePerson('wachabteilung', 'Alt Person', 10);
  const o = await bestelle('kueche', alt, [{ produkt_id: 7, menge: 1 }]); // Ei 0,40 -> 9,60
  await su.query("update public.bestellungen set erstellt_am = now() - interval '40 days' where id=$1", [o.bestellung_id]);
  await su.query("update public.guthaben_buchungen set erstellt_am = now() - interval '40 days' where person_id=$1", [alt]);
  // Dirk: nur seine erste Buchung (Übernahme) ist alt, danach gibt es neuere
  await su.query("update public.guthaben_buchungen set erstellt_am = now() - interval '40 days' where art='uebernahme' and person_id=$1", [P.dirk]);
  // gelöschter Gast, dessen Historie älter als 30 Tage ist -> wird endgültig entfernt
  const gid = (await rpc('kueche', "select public.gast_anlegen('bdienst','Alt Gast') as r"))[0].r.id;
  await rpc('admin', 'select public.gast_loeschen($1)', [gid]);
  await su.query("update public.personen set deaktiviert_am = now() - interval '40 days' where id=$1", [gid]);

  // Die Historie-Ansicht zeigt >30 Tage alte Einträge schon vor der Bereinigung nicht mehr
  assert.equal((await rpc('kueche', 'select * from public.historie_person($1)', [alt])).length, 0);

  const vorher = new Map((await su.query('select id, guthaben from public.personen')).rows.map((x) => [x.id, num(x.guthaben)]));
  const r = (await su.query('select private.historie_bereinigen() as r')).rows[0].r;
  assert.ok(r.buchungen >= 3 && r.bestellungen >= 1 && r.personen >= 1, JSON.stringify(r));
  assert.equal((await su.query('select count(*) from public.bestellpositionen where bestellung_id=$1', [o.bestellung_id])).rows[0].count, '0');
  assert.equal((await su.query('select count(*) from public.guthaben_buchungen where person_id=$1', [alt])).rows[0].count, '0');
  assert.equal((await su.query('select count(*) from public.personen where id=$1', [gid])).rows[0].count, '0', 'alter gelöschter Gast nicht entfernt');

  // WICHTIG: kein Guthaben darf sich durch die Bereinigung ändern
  const nachher = (await su.query('select id, guthaben from public.personen')).rows;
  for (const x of nachher) assert.equal(num(x.guthaben), vorher.get(x.id), 'Guthaben hat sich verändert');
  assert.equal(await saldo(alt), 9.6, 'Guthaben der Person ohne Historie muss erhalten bleiben');
});

// =====================================================================
// G) PARALLELITÄT
// =====================================================================
test('G1 25 gleichzeitige Bestellungen derselben Person: nichts geht verloren', async () => {
  const p = await neuePerson('wachabteilung', 'Parallel Eins', 100);
  const res = await Promise.allSettled(
    Array.from({ length: 25 }, () => bestelle('kueche', p, [{ produkt_id: 3, menge: 1 }])));
  assert.ok(res.every((x) => x.status === 'fulfilled'), res.find((x) => x.status === 'rejected')?.reason?.message);
  assert.equal(await saldo(p), rund(100 - 25 * 1.3));
  const anz = (await su.query("select count(*) from public.guthaben_buchungen where person_id=$1 and art='bestellung'", [p])).rows[0].count;
  assert.equal(anz, '25');
});

test('G2 12 gleichzeitige Wiederholungen derselben Anfrage: genau eine Bestellung', async () => {
  const p = await neuePerson('wachabteilung', 'Parallel Zwei', 100);
  const id = randomUUID();
  const res = await Promise.allSettled(
    Array.from({ length: 12 }, () => bestelle('kueche', p, [{ produkt_id: 3, menge: 2 }], id)));
  assert.ok(res.every((x) => x.status === 'fulfilled'), res.find((x) => x.status === 'rejected')?.reason?.message);
  assert.equal(res.filter((x) => x.value.wiederholt === false).length, 1);
  assert.equal(await saldo(p), rund(100 - 2.6));
  assert.equal((await su.query('select count(*) from public.bestellungen where client_request_id=$1', [id])).rows[0].count, '1');
});

test('G3 Abendessen: 8 gleichzeitige Abrechnungen belasten jeden nur einmal', async () => {
  const pers = [];
  for (let i = 1; i <= 6; i++) pers.push(await neuePerson('wachabteilung', 'Abend Person ' + i, 0));
  for (const p of pers) await bestelle('kueche', p, [{ produkt_id: 8 }]);
  await rpc('kueche', 'select public.tagesabschluss()'); // altes verwerfen
  for (const p of pers) await bestelle('kueche', p, [{ produkt_id: 8 }]);
  const res = await Promise.allSettled(
    Array.from({ length: 8 }, () => rpc('kueche', 'select public.abendessen_abrechnen(false, 6.5) as r')));
  const ok = res.filter((x) => x.status === 'fulfilled');
  const bad = res.filter((x) => x.status === 'rejected');
  assert.equal(ok.length, 1, 'genau eine Abrechnung darf durchgehen');
  assert.ok(bad.every((x) => /Keine normalen Abendessen/.test(x.reason.message)), bad.map((x) => x.reason.message).join('|'));
  assert.equal(ok[0].value[0].r.personen, 6);
  for (const p of pers) assert.equal(await saldo(p), -6.5);
});

test('G4 Tagesabschluss parallel zu 30 Bestellungen: jede Position zählt genau einmal', async () => {
  const pers = [];
  for (let i = 1; i <= 6; i++) pers.push(await neuePerson('wachabteilung', 'TA Person ' + i, 0));
  await rpc('kueche', 'select public.tagesabschluss()');
  const eier0 = await su.query("select coalesce(sum(menge),0) s from public.bestellpositionen where produkt_id=7");

  const jobs = [];
  for (let i = 0; i < 30; i++) jobs.push(bestelle('kueche', pers[i % 6], [{ produkt_id: 7, menge: 1 }]));
  const abschl = [];
  for (let i = 0; i < 4; i++) abschl.push(rpc('admin', 'select public.tagesabschluss() as r').then((r) => r[0].r));
  const res = await Promise.allSettled([...jobs, ...abschl]);
  const fehl = res.filter((x) => x.status === 'rejected');
  assert.equal(fehl.length, 0, fehl.map((x) => x.reason.message).join('|'));

  const imSnapshot = res.slice(30).flatMap((x) => x.value.einkaufsliste).filter((x) => x.name === 'Ei').reduce((s, x) => s + x.menge, 0);
  const offen = (await rpc('kueche', "select * from public.einkaufsliste()")).filter((x) => x.name === 'Ei').reduce((s, x) => s + x.menge, 0);
  assert.equal(imSnapshot + offen, 30, `Ei-Zählung stimmt nicht (Snapshots ${imSnapshot} + offen ${offen})`);
  // jede der 30 Bestellungen gehört zu genau einem Zustand (offen oder genau ein Abschluss)
  const verwaist = (await su.query(`select count(*) c from public.bestellungen b
      where b.tagesabschluss_id is not null and not exists (select 1 from public.tagesabschluesse t where t.id=b.tagesabschluss_id)`)).rows[0].c;
  assert.equal(verwaist, '0');
});

test('G5 Gemischte Last (Bestellungen + Abendessen + Abrechnung + Abschluss): keine Verklemmung', async () => {
  const pers = [];
  for (let i = 1; i <= 8; i++) pers.push(await neuePerson('wachabteilung', 'Mix Person ' + i, 20));
  const start = (await Promise.all(pers.map(saldo))).reduce((a, b) => a + b, 0);
  const jobs = [];
  for (let i = 0; i < 24; i++) {
    const p = pers[i % 8];
    jobs.push(bestelle('kueche', p, i % 3 === 0 ? [{ produkt_id: 8 }, { produkt_id: 7, menge: 1 }] : [{ produkt_id: 7, menge: 1 }]));
  }
  for (let i = 0; i < 3; i++) jobs.push(rpc('kueche', 'select public.abendessen_abrechnen(false, 5)'));
  for (let i = 0; i < 2; i++) jobs.push(rpc('admin', 'select public.tagesabschluss()'));
  jobs.push(rpc('kueche', 'select * from public.abendessen_liste()'));
  jobs.push(rpc('kueche', 'select public.backup_export()'));
  const res = await Promise.allSettled(jobs);
  const unerwartet = res.filter((x) => x.status === 'rejected' && !/Keine normalen Abendessen/.test(x.reason.message));
  assert.equal(unerwartet.length, 0, unerwartet.map((x) => x.reason.code + ' ' + x.reason.message).join('|'));
  // Geld-Bilanz: Start - 24 Eier (je 0,40) - abgerechnetes Abendessen
  const abgerechnet = num((await su.query(`select coalesce(sum(preis),0) s from public.abendessen_eintraege where person_id = any($1) and status='abgerechnet'`, [pers])).rows[0].s);
  const ende = (await Promise.all(pers.map(saldo))).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(ende * 100), Math.round((start - 24 * 0.4 - abgerechnet) * 100));
});

test('G6 Gäste anlegen: gleichzeitig nie mehr als 12 Plätze', async () => {
  const res = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => rpc('kueche', "select public.gast_anlegen('fahrer_bdienst', $1)", ['F ' + i])));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 12);
  assert.ok(res.filter((x) => x.status === 'rejected').every((x) => /Alle 12 Plätze/.test(x.reason.message)));
});

test('H1 Schluss-Check: Saldo-Kette und Summen über ALLE Personen konsistent', async () => {
  const r = await su.query(`
    select p.anzeigename, p.guthaben,
           (select saldo_danach from public.guthaben_buchungen x where x.person_id=p.id order by x.id desc limit 1) as letzter
      from public.personen p`);
  for (const x of r.rows) if (x.letzter !== null) assert.equal(num(x.guthaben), num(x.letzter), x.anzeigename);
  const kaputt = (await su.query(`select count(*) c from public.bestellungen b
     where b.summe <> coalesce((select sum(case when bp.ist_abendessen then 0 else bp.einzelpreis*bp.menge end)
                                  from public.bestellpositionen bp where bp.bestellung_id=b.id),0)`)).rows[0].c;
  assert.equal(kaputt, '0', 'Bestellsumme stimmt nicht mit den Positionen überein');
});

// =====================================================================
// LAUFEN LASSEN
// =====================================================================
let fehlgeschlagen = 0;
try {
  await vorbereiten();
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}  (${Date.now() - t0} ms)`);
    } catch (e) {
      fehlgeschlagen++;
      console.log(`  ✗ ${t.name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }
} finally {
  await su.end();
}
console.log(`\n${tests.length - fehlgeschlagen} von ${tests.length} Tests bestanden.`);
process.exit(fehlgeschlagen ? 1 : 0);
