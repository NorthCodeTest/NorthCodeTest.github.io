# Supabase einrichten und verwalten

Diese Anleitung zeigt, was du **selbst im Supabase-Dashboard** einstellen musst und wie du
später Kollegen, Konten und Gäste verwaltest. Alles ist so aufgebaut, dass du es mit
Kopieren-und-Einfügen schaffst. Menünamen im Dashboard ändern sich manchmal leicht – der Sinn
bleibt gleich.

> **Wichtig:** Zuerst alles in einem **Test-Projekt** ausprobieren (Name z. B. `kantine-test`).
> Das echte Projekt legst du erst an, wenn der Test sauber lief. Mit dem kostenlosen Plan darfst
> du (Stand meines Wissens) zwei Projekte gleichzeitig aktiv haben.

---

## 1. Projekt anlegen

1. supabase.com → **New project**
2. **Name:** `kantine-test` (später `kantine`)
3. **Database password:** langes Passwort, im Passwortmanager speichern (wird im Alltag nie gebraucht)
4. **Region:** `Frankfurt (eu-central-1)` – die Daten bleiben in der EU
5. Warten, bis das Projekt bereit ist (1–2 Minuten)

## 2. Einstellungen im Dashboard (einmalig)

**Authentication → Sign In / Providers** (bzw. *Settings*)

| Einstellung | Wert | Warum |
|---|---|---|
| **Allow new users to sign up** | **AUS** | Niemand darf sich selbst registrieren. Konten legst nur du an. |
| **Allow anonymous sign-ins** | **AUS** | Ohne Login geht gar nichts. |
| Email → **Confirm email** | **AUS** | Die „E-Mail-Adressen“ sind nur Platzhalter, es kommen nie Mails an. |
| Email → **Minimum password length** | mind. **8** | Passwörter der Kollegen |

Alle anderen Anmeldearten (Google, GitHub, Magic Link …) **aus** lassen.

## 3. Datenbank einspielen (5 Dateien + Testdaten)

1. **SQL Editor** → **New query**
2. Nacheinander den **kompletten Inhalt** dieser Dateien einfügen und mit **Run** ausführen –
   **in genau dieser Reihenfolge**:
   1. `supabase/migrations/20261017000100_schema.sql`
   2. `supabase/migrations/20261017000200_rls.sql`
   3. `supabase/migrations/20261017000300_funktionen.sql`
   4. `supabase/migrations/20261017000400_rechte.sql`
   5. `supabase/migrations/20261017000500_realtime_cron.sql`
3. **Nur im Test-Projekt:** zuletzt `supabase/seed.sql` (die 12 Standard-Produkte).
   Im echten Projekt kommen Produkte und Preise später aus deinem Backup (Phase 3).
4. Jede Datei muss mit **„Success“** enden. Bei einem Fehler: nicht weitermachen, mir die
   Meldung schicken.

### Prüfen, ob alles da ist

```sql
select count(*) from public.produkt_kategorien;   -- soll 6 sein
select count(*) from public.produkte;             -- Test-Projekt mit seed: 12
select jobname, schedule from cron.job;           -- soll 'kantine-historie-bereinigen' zeigen
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime';             -- soll 4 Tabellen zeigen
```

* **Keine Zeile bei `cron.job`?** → **Database → Extensions** → `pg_cron` einschalten, dann
  nur diesen Teil nochmal ausführen:
  ```sql
  select cron.schedule('kantine-historie-bereinigen', '15 3 * * *',
                       'select private.historie_bereinigen()');
  ```
  Auch ohne diesen Job wird die Historie bei **jedem Tagesabschluss** bereinigt.

## 4. Schlüssel für die App (öffentlich, darf in den Code)

**Project Settings → API Keys** (und **Data API / API URL**):

| Was | Wohin | Geheim? |
|---|---|---|
| **Project URL** (`https://xxxx.supabase.co`) | `js/config.js` (Phase 2) | nein |
| **Publishable key** (`sb_publishable_…`, früher „anon key“) | `js/config.js` (Phase 2) | nein – er ist für den Browser gedacht |
| **Secret key / service_role key** | **NIEMALS** in die App, nirgends einfügen | **ja!** |

Die Sicherheit kommt nicht vom Schlüssel, sondern von den Regeln in der Datenbank (RLS +
Funktionen). Ohne Anmeldung kann der öffentliche Schlüssel gar nichts.

---

## 5. Kollegen und Konten verwalten

### Das Prinzip

* Eine **Person** (Name + Guthaben) steht in der Tabelle `personen`.
* Ein **Konto** (Login mit Benutzername + Passwort) ist optional und hängt an einer Person.
* Supabase kennt nur E-Mail + Passwort. Darum wird aus dem Benutzernamen `max` intern
  `max@kantine.invalid`. Die Kollegen merken davon nichts und geben nur `max` ein.
* Gäste, Azubis, Notarzt, B-Dienst und Fahrer B-Dienst haben **kein Konto** – sie werden am
  Tablet wie bisher mit Namen angelegt.

### Neuen Kollegen anlegen (3 Schritte)

**Schritt 1 – Person eintragen** (SQL Editor). Mehrere auf einmal geht auch:

```sql
insert into public.personen (kategorie, anzeigename) values
  ('wachabteilung', 'Max Mustermann'),
  ('wachabteilung', 'Erika Beispiel');
```

*Der Anzeigename ist, was am Tablet und im Ranking steht. Die Sortierung am Tablet erfolgt wie
bisher nach dem **letzten Wort** (Nachname), also „Vorname Nachname“ schreiben.*

**Schritt 2 – Login anlegen** (Dashboard)

**Authentication → Users → Add user → Create new user**

* **Email:** `max@kantine.invalid`   (Benutzername klein geschrieben, dann `@kantine.invalid`)
* **Password:** ein Startpasswort
* **Auto Confirm User:** ✔ anhaken

**Schritt 3 – Login mit der Person verknüpfen** (SQL Editor)

```sql
select private.konto_einrichten('max', 'mitglied', 'Max Mustermann');
```

Die Antwort lautet `OK: max als mitglied (Max Mustermann) eingerichtet`. Der Name muss genau wie
in Schritt 1 geschrieben sein (Groß-/Kleinschreibung egal).

> Benutzernamen: 2–30 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.
> Keine Umlaute, keine Leerzeichen (z. B. `max.mustermann`).

### Die zwei besonderen Konten (einmalig)

| Konto | Zweck | Anlegen |
|---|---|---|
| `kueche` | das **Tablet in der Küche**, dauerhaft angemeldet – ersetzt „Küche ohne Passwort“ | Login `kueche@kantine.invalid` anlegen, dann `select private.konto_einrichten('kueche', 'kueche');` |
| `admin` | **deine Verwaltung** (Aufladen, Produkte, Gäste löschen) | Login `admin@kantine.invalid` anlegen, dann `select private.konto_einrichten('admin', 'admin');` |

Soll dein eigener Handy-Login zugleich Admin sein, verknüpfe ihn mit deiner Person:
`select private.konto_einrichten('jannis', 'admin', 'Jannis Nachname');`

**Warum ein Küchen-Konto?** Wäre die Küche komplett offen (ohne jeden Login), könnte jeder, der
die Internetadresse kennt, Bestellungen für andere auslösen oder abrechnen. Das Tablet meldet
sich deshalb **einmal** an und bleibt angemeldet – im Alltag tippt niemand ein Passwort. Geht
das Tablet verloren oder wird Safari-Speicher gelöscht, sperrst du das Konto (siehe unten) und
meldest das Tablet neu an.

### Konto sperren, entsperren

```sql
select private.konto_deaktivieren('max');   -- sofort: kein Zugriff mehr auf Daten, Login gesperrt
select private.konto_aktivieren('max');     -- wieder frei
```

Das **Guthaben der Person bleibt erhalten**, es wird nur das Handy-Login gesperrt.
Scheidet jemand aus, lässt du die Person in der Tabelle stehen, bis das Guthaben geklärt ist.

### Passwort vergessen / zurücksetzen

Die Platzhalter-Adressen können keine E-Mails empfangen, „Passwort vergessen“ per Mail gibt es
also nicht. So setzt du ein neues Passwort:

1. **Authentication → Users** → den Benutzer (`max@kantine.invalid`) **löschen**
2. Neu anlegen (Schritt 2 oben) mit dem neuen Passwort
3. `select private.konto_einrichten('max', 'mitglied', 'Max Mustermann');`

Person, Guthaben und Historie bleiben dabei unberührt – nur das Login wird ersetzt.
*(In Phase 2 bauen wir „Eigenes Passwort ändern“ in die Handy-Ansicht ein.)*

### Person komplett entfernen (selten)

Normalerweise nicht nötig. Wer ausscheidet: Konto sperren, Guthaben auszahlen/ausgleichen, dann
in **Table Editor → personen** die Spalte `aktiv` auf `false` setzen. Dann erscheint die Person
nirgends mehr.

---

## 6. Kontrolle: Wer darf was?

| | Kollege (Handy) | Küche (Tablet) | Admin |
|---|:-:|:-:|:-:|
| Produkte/Preise ansehen | ✅ | ✅ | ✅ |
| Eigene Bestellung, eigenes Guthaben, eigene Historie | ✅ | – | ✅ |
| Ranking (nur Name + Guthaben) | ✅ | ✅ | ✅ |
| Für Kollegen/Gäste am Tablet bestellen, individueller Betrag | ❌ | ✅ | ✅ |
| Gast anlegen | ❌ | ✅ | ✅ |
| Einkaufsliste, Abendessen-Liste, Gesamtschulden | ❌ | ✅ | ✅ |
| Abendessen abrechnen / Eintrag entfernen | ❌ | ✅ | ✅ |
| Tagesabschluss + Backup-Export | ❌ | ✅ | ✅ |
| Guthaben aufladen | ❌ | ❌ | ✅ |
| Produkte und Preise ändern, Produkt löschen | ❌ | ❌ | ✅ |
| Gast löschen | ❌ | ❌ | ✅ |
| Konten anlegen/sperren | nur du im SQL Editor / Dashboard | | |

Das gilt **in der Datenbank**, nicht nur in der Oberfläche: Auch wer die App mit Browser-Werkzeugen
manipuliert, bekommt „Keine Berechtigung“.

## 7. Backups (kostenloser Plan)

* **Automatische Datenbank-Backups sind im kostenlosen Plan nach meinem Kenntnisstand nicht
  enthalten.** Bitte unter *Project Settings → Billing / Database → Backups* prüfen.
* Dein verlässliches Backup ist deshalb – wie bisher – die **JSON-Datei beim Tagesabschluss** am
  iPad (landet in iCloud). Bitte weiter jeden Tag machen.
* Kostenlose Projekte werden bei **längerer Nichtnutzung pausiert** (Stand meines Wissens nach
  etwa einer Woche). Im Alltag mit täglicher Nutzung kein Thema; vor einem langen Urlaub kurz
  einmal die App öffnen. Ein pausiertes Projekt lässt sich im Dashboard per **Restore project**
  wieder aufwecken.

## 8. Hinweise im „Security Advisor“

Unter **Advisors → Security Advisor** zeigt Supabase eventuell Hinweise wie *„SECURITY DEFINER
function is executable by signed-in users“* zu den Funktionen `bestellung_aufgeben`,
`tagesabschluss` usw. **Das ist beabsichtigt:** Diese Funktionen sind die einzige Schreib-
Schnittstelle und prüfen als Allererstes die Rolle des Aufrufers (siehe Tests in
`supabase/tests`). Wichtig wären dagegen Hinweise wie *„RLS disabled“* oder *„table is publicly
accessible“* – die darfst du **nicht** sehen. Wenn doch, bitte melden.

## 9. Tests ausführen (optional, für später)

Die Datenbank-Tests laufen auf einem lokalen PostgreSQL (nicht auf deinem Supabase-Projekt).
Sie bilden Supabase mit einer kleinen Hilfsdatei nach und prüfen Rechte, Fachregeln und
gleichzeitige Zugriffe:

```bash
cd supabase
./tests/setup.sh        # frische Testdatenbank + alle Migrationen
cd tests && npm install && npm test
```
