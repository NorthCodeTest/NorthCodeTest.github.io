# Phase 1 – Datenbank: Ergebnis

Stand: 17.10.2026 · getestet auf PostgreSQL 16 (lokal, mit Supabase-Nachbildung) · **noch nicht
auf einem echten Supabase-Projekt ausgeführt**.

## Was fertig ist

| Bereich | Datei |
|---|---|
| Tabellen | `supabase/migrations/…0100_schema.sql` |
| Rollen + Row Level Security | `…0200_rls.sql` |
| Fachlogik als Funktionen | `…0300_funktionen.sql` |
| Rechte (GRANT/REVOKE) | `…0400_rechte.sql` |
| Realtime + tägliche 30-Tage-Bereinigung | `…0500_realtime_cron.sql` |
| Start-Produkte (nur Test) | `supabase/seed.sql` |
| 42 automatische Tests | `supabase/tests/` |
| Einrichtung im Dashboard | `docs/SUPABASE-SETUP.md` |
| Unveränderte aktuelle App (Rückfall) | `alt/` |

**Testergebnis: 42 von 42 bestanden** – Rechte (anonym / Kollege / Küche / Admin / gesperrt),
Bestellregeln, Cent-genaue Beträge, Preis-Snapshot, Doppelbestellungs-Schutz, Abendessen,
Tagesabschluss, Aufladen, Produkte, Gäste, Ranking, Backup-Export, 30-Tage-Bereinigung und
Parallelität (25 gleichzeitige Bestellungen, 12 gleichzeitige Wiederholungen derselben
Bestellung, 8 gleichzeitige Abendessen-Abrechnungen, Tagesabschluss während laufender
Bestellungen, gemischte Last ohne Verklemmung).
Zusätzlich habe ich drei Fehler absichtlich eingebaut (Sperre entfernt, Schreibrecht erteilt,
Abendessen-Doppelbuchung): Die Tests haben jeden davon erkannt.

## Datenmodell

```
personen ──< bestellungen ──< bestellpositionen >── produkte >── produkt_kategorien
   │  └────< guthaben_buchungen (Historie, Saldo nach jeder Buchung)
   └────< abendessen_eintraege (offen / abgerechnet / entfernt / verworfen)
profile  (auth.users ↔ Rolle ↔ optional Person)       tagesabschluesse (Snapshot ohne Namen)
```

* `personen.guthaben` ist der Kontostand und wird **nur** von den Funktionen geändert.
* Jede Änderung schreibt eine Zeile in `guthaben_buchungen` (mit `saldo_danach`).
  Die Zeilen werden nach 30 Tagen gelöscht, **der Kontostand bleibt**.
* `bestellpositionen` speichert Name und Preis **zum Bestellzeitpunkt**.
* Die **Einkaufsliste ist abgeleitet** (Summe der offenen Positionen) – es gibt keinen Zähler,
  der auseinanderlaufen kann.
* Gäste & Co.: `personen`-Zeilen ohne Konto, höchstens 12 aktive pro Kategorie
  (wie die 12 „Leeren Plätze“). „Löschen“ = deaktivieren; nach 30 Tagen werden sie samt
  Historie endgültig entfernt.

## Schnittstelle für das Frontend (Phase 2)

Alle Schreibzugriffe nur per `supabase.rpc('name', {…})`. Fehler kommen als deutsche Meldung
(`error.message`), Berechtigungsfehler mit Code `42501`.

| Funktion | Parameter | Wer | Zweck |
|---|---|---|---|
| `bestellung_aufgeben` | `p_person_id`, `p_request_id` (neue UUID je Klick), `p_positionen` | alle | Bestellen. Positionen: `{produkt_id, menge}`; Küche/Admin zusätzlich `{individuell:true, bezeichnung, betrag}` |
| `ranking` | – | alle | Top 3 Schulden/Guthaben der Wachabteilung (`art`, `platz`, `name`, `guthaben`) |
| `historie_person` | `p_person_id` | alle (Kollege nur eigene) | letzte 30 Tage, eine Zeile je Position wie bisher |
| `einkaufsliste` | – | Küche, Admin | `name`, `menge` |
| `gesamtschulden` | – | Küche, Admin | Summe |
| `abendessen_liste` | – | Küche, Admin | offene Einträge mit Namen |
| `abendessen_abrechnen` | `p_vegetarisch`, `p_preis` | Küche, Admin | je Typ, nie doppelt |
| `abendessen_eintrag_entfernen` | `p_eintrag_id` | Küche, Admin | ohne Abbuchung |
| `tagesabschluss` | – | Küche, Admin | liefert Snapshot |
| `backup_export` | – | Küche, Admin | JSON für den iPad-Download |
| `gast_anlegen` | `p_kategorie`, `p_name` | Küche, Admin | max. 12 je Kategorie |
| `gast_loeschen` | `p_person_id` | Admin | |
| `guthaben_aufladen` | `p_person_id`, `p_betrag` | Admin | |
| `produkt_preis_aendern` / `produkt_anlegen` / `produkt_loeschen` | siehe SQL | Admin | |

Direkt lesbar (`supabase.from(…).select()`, durch RLS begrenzt): `produkte`,
`produkt_kategorien`, `personen` (Kollege: nur sich selbst; Küche/Admin: alle), `profile`
(nur eigenes; Admin alle), `bestellungen` und `abendessen_eintraege` (nur als Realtime-Signal).

**Idempotenz:** Das Frontend erzeugt pro „Jetzt bestellen“-Klick **eine** `p_request_id` und
verwendet dieselbe bei jeder Wiederholung (z. B. nach Verbindungsabbruch). Die Datenbank bucht
dann nie doppelt. Erst die Antwort der Datenbank gilt als „bestellt“.

## Abweichungen und bewusste Entscheidungen

Bitte kurz prüfen – alles andere ist 1:1 wie in der aktuellen App.

1. **Keine Edge Function für Konten.** Gegenüber meinem ersten Plan: Konten legst du im
   Dashboard an und verknüpfst sie per SQL-Einzeiler (`private.konto_einrichten`). Das ist
   einfacher zu lernen, braucht keinen geheimen Schlüssel im Code und entspricht deiner Vorgabe
   „nichts Neues bauen“ (die alte App hatte auch keine Konten-Oberfläche). Eine eigene
   Oberfläche dafür wäre später nachrüstbar.
2. **„Backup wiederherstellen“-Knopf entfällt in der Verwaltung.** Ein Restore aus einer Datei
   ersetzt in der Cloud-Datenbank *alle* Daten und gehört nicht in einen Knopf am Tablet. Das
   Einlesen eines alten Backups (Migration, im Notfall auch Restore) mache ich in Phase 3 als
   Skript. **Das Backup-Erstellen bleibt** (Verwaltung + Tagesabschluss). → *Brauchst du den
   Knopf zwingend? Dann baue ich einen Admin-Restore nach.*
3. **Küche = fest angemeldetes Tablet-Konto** statt „völlig offen“ (Begründung in der
   Einrichtungsanleitung). Im Alltag keine Passworteingabe.
4. **Produkt „löschen“ blendet aus**, statt hart zu löschen, damit alte Historie lesbar bleibt.
   In der Oberfläche sieht es genauso aus. Abendessen bleibt geschützt.
5. **Fehler der alten App, die dabei behoben sind:**
   * Ein gelöschter Gast mit offenem Abendessen ließ einen Eintrag stehen, der später den
     falschen Platz belasten konnte → der Eintrag wird jetzt mit entfernt.
   * Der Neuer-Stand-Betrag („Neues Guthaben“) in der Historie war bei Bestellungen mit
     mehreren Positionen ungenau → jetzt der Stand nach der gesamten Bestellung.
   * Preise rechnen exakt in Cent (keine Fließkomma-Rundung mehr).
6. **Bestehende Eigenheiten bewusst übernommen:** Bestellt jemand am selben Tag zweimal
   Abendessen, bleibt der **erste** Eintrag (normal/vegetarisch) bestehen. Der Tagesabschluss
   verwirft noch nicht abgerechnete Abendessen (wie bisher). Neue Produkte mit „In
   Einkaufsliste zählen“ bekommen den Typ aus dem Namen.
7. **Reihenfolge der Einkaufsliste** folgt der Produktliste (Normal, Sunny, Roggen, Mehrkorn,
   Ei) statt der alten internen Reihenfolge.
8. **Farbschema-Auswahl** (neu in deiner aktuellen Version) bleibt eine reine Geräte-Einstellung
   im Browser (`localStorage`) – dafür braucht es keine Datenbank.

## Noch nicht geprüft (braucht ein echtes Supabase-Projekt)

* Die Login-Pseudo-Adresse `…@kantine.invalid` wird von Supabase Auth akzeptiert (sehr
  wahrscheinlich; falls nicht, genügt es, die Domain an **einer** Stelle zu ändern:
  `private.login_domain()`).
* `pg_cron` und Realtime auf dem echten Projekt.
* Der Security Advisor (siehe Setup-Anleitung, Abschnitt 8).

→ Nächster Schritt: Test-Projekt `kantine-test` anlegen, die 5 Dateien einspielen und mit
echten Logins durchspielen. Danach Phase 2 (Frontend) und Phase 3 (Datenübernahme).

## Ausblick

* **Phase 2 – Frontend:** `alt/` bleibt unverändert; die neue App erhält eine Datenzugriffs-
  schicht (`js/api.js`), Anmeldung, Handy-Ansicht (Bestellen, Guthaben, Historie, Ranking),
  Tablet mit Küchen-Konto und Verwaltung mit Admin-Login, Realtime-Aktualisierung, sichere
  Anzeige von Namen (kein HTML-Einschleusen) und verständliche Fehlermeldungen.
* **Phase 3 – Datenübernahme:** Skript liest das JSON-Backup (Version 3.3) der alten App,
  prüft es, übernimmt Produkte, Personen und Guthaben (als „Übernahme“-Buchung) und erstellt
  einen Abgleichsbericht (Backup-Stand gegen Datenbank-Stand je Person).
