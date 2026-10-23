-- =====================================================================
-- Kantine – Rollen-Helfer und Row Level Security
--
-- Rollen:  admin   = Verwaltung (Jannis)
--          kueche  = das Tablet in der Küche (dauerhaft angemeldet)
--          mitglied= Kollege am Handy (sieht nur sich selbst)
--
-- Ein deaktiviertes Profil (aktiv = false) hat KEINE Rolle mehr und
-- verliert sofort jeden Zugriff – auch mit noch gültigem Login-Token.
-- =====================================================================

-- Helfer liegen im Schema "private" (wird von der API nicht freigegeben)
create or replace function private.rolle() returns text
language sql stable security definer set search_path = ''
as $$
    select p.rolle from public.profile p
    where p.id = (select auth.uid()) and p.aktiv
$$;

create or replace function private.person_id() returns uuid
language sql stable security definer set search_path = ''
as $$
    select p.person_id from public.profile p
    where p.id = (select auth.uid()) and p.aktiv
$$;

-- Wirft einen Fehler, wenn die Rolle des Aufrufers nicht erlaubt ist.
-- Gibt die Rolle zurück, damit Funktionen sie weiterverwenden können.
create or replace function private.erfordere(p_rollen text[]) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
    v_rolle text := private.rolle();
begin
    if v_rolle is null or not (v_rolle = any (p_rollen)) then
        raise exception 'Keine Berechtigung' using errcode = '42501';
    end if;
    return v_rolle;
end
$$;

-- ---------------------------------------------------------------------
-- RLS einschalten (ohne Policy = niemand außer den Funktionen darf etwas)
-- ---------------------------------------------------------------------
alter table public.personen             enable row level security;
alter table public.profile              enable row level security;
alter table public.produkt_kategorien   enable row level security;
alter table public.produkte             enable row level security;
alter table public.bestellungen         enable row level security;
alter table public.bestellpositionen    enable row level security;
alter table public.guthaben_buchungen   enable row level security;
alter table public.abendessen_eintraege enable row level security;
alter table public.tagesabschluesse     enable row level security;

-- Produkte & Kategorien: jeder angemeldete (aktive) Benutzer darf lesen
create policy produkt_kategorien_lesen on public.produkt_kategorien
    for select to authenticated
    using (private.rolle() is not null);

create policy produkte_lesen on public.produkte
    for select to authenticated
    using (private.rolle() is not null and aktiv);

-- Personen: Küche/Admin sehen alle, ein Mitglied nur sich selbst
create policy personen_lesen on public.personen
    for select to authenticated
    using (
        private.rolle() in ('kueche','admin')
        or id = private.person_id()
    );

-- Profile: jeder sieht das eigene, Admin alle
create policy profile_lesen on public.profile
    for select to authenticated
    using (
        id = (select auth.uid())
        or private.rolle() = 'admin'
    );

-- Bestellungen: Küche/Admin alle (für Realtime-Hinweise), Mitglied nur eigene
create policy bestellungen_lesen on public.bestellungen
    for select to authenticated
    using (
        private.rolle() in ('kueche','admin')
        or person_id = private.person_id()
    );

-- Abendessen-Liste: nur Küche/Admin
create policy abendessen_lesen on public.abendessen_eintraege
    for select to authenticated
    using (private.rolle() in ('kueche','admin'));

-- bestellpositionen, guthaben_buchungen, tagesabschluesse: bewusst KEINE
-- Policy. Gelesen wird nur über die Funktionen (historie_person, ...).
-- Schreiben darf grundsätzlich niemand direkt (siehe Rechte-Migration).
