# Kantine – Umbau auf Supabase

| Ordner / Datei | Inhalt |
|---|---|
| `index.html`, `styles.css`, `css/`, `js/` | **Die neue App** (eine Seite für Handy und Tablet) |
| `js/config.js` | Hier URL und Publishable Key von Supabase eintragen |
| `alt/` | Die bisherige App (localStorage), **unverändert** – Rückfall bis zur erfolgreichen Umstellung |
| `supabase/migrations/` | Datenbank: Tabellen, Rechte, Funktionen (der Reihe nach einspielen) |
| `supabase/seed.sql` | Standard-Produkte (nur für ein Test-Projekt) |
| `supabase/tests/` | Automatische Tests: Datenbank (`npm test`) und Browser (`node e2e.mjs`) |
| `docs/SUPABASE-SETUP.md` | **Hier anfangen:** Supabase einrichten, Kollegen und Konten verwalten |
| `docs/PHASE2-ERGEBNIS.md` | Frontend: Aufbau, Online stellen (GitHub Pages), Prüfliste |
| `docs/PHASE1-ERGEBNIS.md` | Datenbank: Schnittstelle, Abweichungen |

Stand: Phase 1 (Datenbank) und Phase 2 (Frontend) fertig und getestet. Phase 3 (Datenübernahme
aus dem Backup der alten App) folgt nach deiner Freigabe.
