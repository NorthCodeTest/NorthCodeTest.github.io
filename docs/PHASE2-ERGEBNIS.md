# Phase 2 – Frontend: Ergebnis

Stand: 23.10.2026 · **Browser-Test: 25 von 25 bestanden** (echte `index.html` in Chromium, echte
Datenbank-Funktionen aus Phase 1; nur der Supabase-Client ist im Test nachgebaut).
**Noch nicht gegen ein echtes Supabase-Projekt probiert.**

## Aufbau

Eine Seite (`index.html`), eine URL. Das **Konto** entscheidet nach der Anmeldung:

| Konto-Rolle | Ansicht |
|---|---|
| `mitglied` | Handy: Guthaben, Ranking, Bestellen, Historie |
| `kueche` / `admin` | Tablet: Kategorien, Bestellen, Küche, Verwaltung |

| Datei | Aufgabe |
|---|---|
| `js/config.js` | URL, Publishable Key |
| `js/api.js` | **einzige** Stelle, die mit Supabase spricht; deutsche Fehlermeldungen |
| `js/start.js` | Anmeldung, Rollenwahl |
| `js/handy.js`, `css/handy.css` | Handy-Ansicht |
| `js/tablet.js` | Tablet-Startseite, Personen, Gäste, Bestellen |
| `js/kueche.js` | Küche: Einkaufsliste, Abendessen, Gesamtschulden, Tagesabschluss |
| `js/verwaltung.js` | Admin-Login, Aufladen, Produkte, Backup, Design |
| `styles.css` | unverändert aus der alten App |
| `js/vendor/supabase.js` | Supabase-Bibliothek (lokal, v2.117.1) |

## Online stellen (GitHub Pages)

1. Supabase einrichten und Konten anlegen: `docs/SUPABASE-SETUP.md`.
2. In `js/config.js` **Project URL** und **Publishable Key** eintragen (nie den „secret“/„service_role“-Key).
3. Dateien dieses Ordners (ohne `supabase/`, `alt/`, `docs/` – diese dürfen aber auch mit hochgeladen werden)
   in dein GitHub-Repository legen. `index.html` muss im Hauptordner liegen.
4. Repository → Settings → Pages → Branch `main`, Ordner `/ (root)`. Nach 1–2 Minuten ist die URL aktiv.
5. In Supabase unter Authentication → URL Configuration die GitHub-Pages-Adresse als Site URL eintragen.
6. Tablet: Adresse öffnen, mit dem Küchen-Konto anmelden (bleibt gespeichert). Handys: eigenes Konto.

## Prüfliste nach dem ersten Start (mit echtem Projekt)

- [ ] Anmeldung mit Handy-Konto → Handy-Ansicht; mit Küchen-Konto → Tablet
- [ ] Am Handy bestellen → am Tablet erscheint es in Küche/Einkaufsliste (live)
- [ ] Gast anlegen, bestellen; Tagesabschluss lädt Backup-Datei auf das iPad
- [ ] Verwaltung: Admin-Anmeldung, Guthaben aufladen, Preis ändern
- [ ] Security Advisor (siehe SUPABASE-SETUP, Abschnitt 8)

## Abweichungen zur alten App

1. Anmeldung mit Konto statt festem Passwort `admin123` (Verwaltung: Benutzername + Passwort).
2. „Wachabteilung bearbeiten“ entfällt (Kollegen = Konten im Dashboard).
3. „Backup wiederherstellen“ entfällt (kommt als Skript in Phase 3).
4. Tagesabschluss setzt nur zurück, wenn das Backup erzeugt werden konnte.
5. Einkaufsliste und Preise rechnet die Datenbank (Cent-genau).

## Tests selbst ausführen

```
cd supabase/tests && npm install && ./setup.sh && node e2e.mjs
```
(braucht lokal PostgreSQL 16 und Chromium; optional, nur für Entwicklung)
