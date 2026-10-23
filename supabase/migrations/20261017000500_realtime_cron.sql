-- =====================================================================
-- Kantine – Realtime und tägliche Bereinigung
-- =====================================================================

-- Realtime: Änderungen an diesen Tabellen werden an angemeldete Geräte
-- gemeldet (jeweils nur Zeilen, die das Gerät per RLS sehen darf).
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        alter publication supabase_realtime
            add table public.bestellungen, public.abendessen_eintraege,
                      public.personen, public.produkte;
    end if;
end
$$;

-- Täglich um 03:15 Uhr UTC: Historie älter als 30 Tage löschen.
-- Falls pg_cron nicht aktivierbar ist, bricht die Migration NICHT ab;
-- die Bereinigung läuft dann trotzdem bei jedem Tagesabschluss.
do $$
begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
        create extension if not exists pg_cron;
        perform cron.schedule('kantine-historie-bereinigen', '15 3 * * *',
                              'select private.historie_bereinigen()');
    end if;
exception when others then
    raise warning 'pg_cron konnte nicht eingerichtet werden (%). Bitte siehe docs/SUPABASE-SETUP.md', sqlerrm;
end
$$;
