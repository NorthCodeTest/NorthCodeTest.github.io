-- =====================================================================
-- Kantine – Rechte (GRANT/REVOKE)
--
-- Supabase vergibt auf neue Tabellen/Funktionen standardmäßig großzügige
-- Rechte an "anon" (nicht angemeldet) und "authenticated". Hier wird
-- alles zuerst entzogen und dann nur das Nötige freigegeben.
--
--  * anon (nicht angemeldet): gar nichts.
--  * authenticated: nur LESEN auf wenige Tabellen (zusätzlich durch RLS
--    eingeschränkt) und AUSFÜHREN der freigegebenen Funktionen.
--  * Schreiben in Tabellen: niemand – nur die Funktionen (SECURITY DEFINER).
-- =====================================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on
    public.produkt_kategorien,
    public.produkte,
    public.personen,
    public.profile,
    public.bestellungen,
    public.abendessen_eintraege
  to authenticated;

grant execute on function
    public.bestellung_aufgeben(uuid, uuid, jsonb),
    public.ranking(),
    public.einkaufsliste(),
    public.gesamtschulden(),
    public.abendessen_liste(),
    public.historie_person(uuid),
    public.abendessen_abrechnen(boolean, numeric),
    public.abendessen_eintrag_entfernen(uuid),
    public.tagesabschluss(),
    public.backup_export(),
    public.guthaben_aufladen(uuid, numeric),
    public.produkt_preis_aendern(bigint, numeric),
    public.produkt_anlegen(text, numeric, smallint, boolean),
    public.produkt_loeschen(bigint),
    public.gast_anlegen(text, text),
    public.gast_loeschen(uuid)
  to authenticated;

-- Schema "private": nur die beiden Rollen-Helfer müssen für RLS aufrufbar sein
revoke all on schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.rolle(), private.person_id() to authenticated;
