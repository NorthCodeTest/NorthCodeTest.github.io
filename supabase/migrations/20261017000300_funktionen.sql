-- =====================================================================
-- Kantine – Funktionen (die einzige Schreib-Schnittstelle für Clients)
--
-- Alle Funktionen laufen mit den Rechten des Besitzers (SECURITY DEFINER),
-- prüfen aber ZUERST die Rolle des Aufrufers. search_path ist leer,
-- deshalb sind alle Objekte voll qualifiziert (public.xyz).
--
-- Geldbeträge werden immer in der Datenbank gerechnet (numeric, exakt),
-- Preise liest die Datenbank selbst aus "produkte" – nie vom Client.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Interne Hilfsfunktion: Guthaben ändern + Buchung schreiben
-- (nur von anderen Funktionen aufrufbar)
-- ---------------------------------------------------------------------
create or replace function private.buche(
    p_person      uuid,
    p_betrag      numeric,
    p_art         text,
    p_bestellung  uuid,
    p_bezeichnung text
) returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
    v_saldo numeric(10,2);
begin
    update public.personen
       set guthaben = guthaben + round(p_betrag, 2)
     where id = p_person
    returning guthaben into v_saldo;

    if not found then
        raise exception 'Person nicht gefunden';
    end if;

    insert into public.guthaben_buchungen
        (person_id, art, betrag, saldo_danach, bestellung_id, bezeichnung, erstellt_von)
    values
        (p_person, p_art, round(p_betrag, 2), v_saldo, p_bestellung, p_bezeichnung, (select auth.uid()));

    return v_saldo;
end
$$;

-- ---------------------------------------------------------------------
-- BESTELLUNG AUFGEBEN
--   p_positionen: [{"produkt_id": 3, "menge": 2}, ...]
--                 Küche/Admin zusätzlich:
--                 {"individuell": true, "bezeichnung": "Eis", "betrag": 2.5}
--   p_request_id: vom Client erzeugte UUID. Wird dieselbe ID nochmals
--                 gesendet (z.B. nach Verbindungsabbruch), wird NICHT
--                 doppelt gebucht, sondern das erste Ergebnis geliefert.
-- Alles (Bestellung, Positionen, Guthaben, Abendessen-Liste) passiert in
-- EINER Transaktion: entweder komplett oder gar nicht.
-- ---------------------------------------------------------------------
create or replace function public.bestellung_aufgeben(
    p_person_id  uuid,
    p_request_id uuid,
    p_positionen jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_rolle      text := private.erfordere(array['admin','kueche','mitglied']);
    v_eigene     uuid := private.person_id();
    v_person     public.personen%rowtype;
    v_vorhanden  public.bestellungen%rowtype;
    v_bestellung uuid;
    v_pos        jsonb;
    v_prod       public.produkte%rowtype;
    v_menge      integer;
    v_preis      numeric(8,2);
    v_bez        text;
    v_summe      numeric(10,2) := 0;
    v_hat_abend  boolean := false;
    v_veg        boolean := false;
    v_saldo      numeric(10,2);
begin
    if p_request_id is null then
        raise exception 'Anfrage-ID fehlt';
    end if;
    if p_positionen is null or jsonb_typeof(p_positionen) <> 'array'
       or jsonb_array_length(p_positionen) not between 1 and 50 then
        raise exception 'Der Warenkorb ist leer oder ungültig';
    end if;

    -- Ein Kollege darf ausschließlich für sich selbst bestellen
    if v_rolle = 'mitglied' and p_person_id is distinct from v_eigene then
        raise exception 'Keine Berechtigung' using errcode = '42501';
    end if;

    -- Person sperren: gleichzeitige Bestellungen derselben Person laufen nacheinander
    select * into v_person from public.personen where id = p_person_id for update;
    if not found or not v_person.aktiv then
        raise exception 'Person nicht gefunden oder nicht mehr aktiv';
    end if;

    -- Wiederholte Anfrage? Dann das erste Ergebnis zurückgeben, nichts neu buchen.
    select * into v_vorhanden from public.bestellungen where client_request_id = p_request_id;
    if found then
        if v_vorhanden.person_id <> p_person_id then
            raise exception 'Anfrage-ID wurde bereits für eine andere Person verwendet';
        end if;
        return jsonb_build_object(
            'bestellung_id', v_vorhanden.id,
            'summe', v_vorhanden.summe,
            'neues_guthaben', v_person.guthaben,
            'abendessen_vorgemerkt', exists (
                select 1 from public.bestellpositionen bp
                 where bp.bestellung_id = v_vorhanden.id and bp.ist_abendessen),
            'wiederholt', true);
    end if;

    insert into public.bestellungen (person_id, erfasst_von, quelle, client_request_id)
    values (p_person_id, (select auth.uid()),
            case when v_rolle = 'mitglied' then 'handy' else 'tablet' end,
            p_request_id)
    returning id into v_bestellung;

    for v_pos in select jsonb_array_elements(p_positionen) loop
        if jsonb_typeof(v_pos) <> 'object' then
            raise exception 'Ungültige Position im Warenkorb';
        end if;

        -- Menge prüfen (Standard 1)
        if v_pos ? 'menge' then
            if (v_pos->>'menge') !~ '^[0-9]{1,2}$' then
                raise exception 'Ungültige Menge';
            end if;
            v_menge := (v_pos->>'menge')::integer;
        else
            v_menge := 1;
        end if;
        if v_menge < 1 or v_menge > 99 then
            raise exception 'Ungültige Menge';
        end if;

        if v_pos ? 'produkt_id' then
            -- Normales Produkt: Name und Preis kommen aus der Datenbank
            if (v_pos->>'produkt_id') !~ '^[0-9]{1,18}$' then
                raise exception 'Ungültiges Produkt';
            end if;
            select * into v_prod from public.produkte
             where id = (v_pos->>'produkt_id')::bigint and aktiv;
            if not found then
                raise exception 'Ein Produkt ist nicht (mehr) verfügbar. Bitte Seite neu laden.';
            end if;

            -- Abendessen kostet beim Bestellen nichts (wird abends abgerechnet)
            v_preis := case when v_prod.ist_abendessen then 0 else v_prod.preis end;

            insert into public.bestellpositionen
                (bestellung_id, produkt_id, bezeichnung, einzelpreis, menge,
                 zaehlt_einkaufsliste, ist_abendessen, ist_individuell)
            values
                (v_bestellung, v_prod.id, v_prod.name, v_preis, v_menge,
                 v_prod.zaehlt_einkaufsliste and not v_prod.ist_abendessen,
                 v_prod.ist_abendessen, false);

            if v_prod.ist_abendessen then
                v_hat_abend := true;
                if v_prod.typ = 'abendessen_vegetarisch' then
                    v_veg := true;
                end if;
            end if;

        elsif (v_pos->>'individuell') = 'true' then
            -- Individueller Betrag: nur am Tablet (Küche/Admin)
            if v_rolle = 'mitglied' then
                raise exception 'Keine Berechtigung' using errcode = '42501';
            end if;
            if coalesce(v_pos->>'betrag', '') !~ '^[0-9]{1,4}(\.[0-9]{1,2})?$' then
                raise exception 'Bitte einen gültigen Betrag eingeben';
            end if;
            v_preis := (v_pos->>'betrag')::numeric;
            if v_preis <= 0 or v_preis > 500 then
                raise exception 'Bitte einen gültigen Betrag eingeben';
            end if;
            v_menge := 1;
            v_bez := left(coalesce(nullif(btrim(v_pos->>'bezeichnung'), ''), 'Individueller Betrag'), 60);

            insert into public.bestellpositionen
                (bestellung_id, produkt_id, bezeichnung, einzelpreis, menge,
                 zaehlt_einkaufsliste, ist_abendessen, ist_individuell)
            values
                (v_bestellung, null, v_bez, v_preis, 1, false, false, true);
        else
            raise exception 'Ungültige Position im Warenkorb';
        end if;

        v_summe := v_summe + v_preis * v_menge;
    end loop;

    -- Abendessen-Liste: pro Person nur ein offener Eintrag (der erste bleibt bestehen)
    if v_hat_abend then
        insert into public.abendessen_eintraege (person_id, vegetarisch)
        select p_person_id, v_veg
        where not exists (
            select 1 from public.abendessen_eintraege e
             where e.person_id = p_person_id and e.status = 'offen');
    end if;

    update public.bestellungen set summe = v_summe where id = v_bestellung;
    v_saldo := private.buche(p_person_id, -v_summe, 'bestellung', v_bestellung, null);

    return jsonb_build_object(
        'bestellung_id', v_bestellung,
        'summe', v_summe,
        'neues_guthaben', v_saldo,
        'abendessen_vorgemerkt', v_hat_abend,
        'wiederholt', false);
end
$$;

-- ---------------------------------------------------------------------
-- RANKING (Top 3 Schulden / Top 3 Guthaben, nur Wachabteilung)
-- Liefert ausschließlich Name + Guthaben – für alle angemeldeten Benutzer.
-- ---------------------------------------------------------------------
create or replace function public.ranking()
returns table (art text, platz integer, name text, guthaben numeric)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    perform private.erfordere(array['admin','kueche','mitglied']);

    return query
    select 'schulden'::text,
           (row_number() over (order by p.guthaben, p.anzeigename))::integer,
           p.anzeigename, p.guthaben::numeric
      from public.personen p
     where p.kategorie = 'wachabteilung' and p.aktiv and p.guthaben < 0
     order by p.guthaben, p.anzeigename
     limit 3;

    return query
    select 'guthaben'::text,
           (row_number() over (order by p.guthaben desc, p.anzeigename))::integer,
           p.anzeigename, p.guthaben::numeric
      from public.personen p
     where p.kategorie = 'wachabteilung' and p.aktiv and p.guthaben > 0
     order by p.guthaben desc, p.anzeigename
     limit 3;
end
$$;

-- ---------------------------------------------------------------------
-- EINKAUFSLISTE (abgeleitet aus den noch nicht abgeschlossenen Bestellungen)
-- Zählt nur Produkte mit "In Einkaufsliste zählen"; Abendessen nie.
-- ---------------------------------------------------------------------
create or replace function public.einkaufsliste()
returns table (name text, menge integer)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    perform private.erfordere(array['admin','kueche']);

    return query
    select bp.bezeichnung, sum(bp.menge)::integer
      from public.bestellpositionen bp
      join public.bestellungen b on b.id = bp.bestellung_id
     where b.tagesabschluss_id is null
       and bp.zaehlt_einkaufsliste
       and not bp.ist_abendessen
     group by bp.bezeichnung
     order by min(bp.produkt_id), bp.bezeichnung;
end
$$;

-- ---------------------------------------------------------------------
-- GESAMTSCHULDEN (Summe aller negativen Guthaben aktiver Personen)
-- ---------------------------------------------------------------------
create or replace function public.gesamtschulden()
returns numeric
language plpgsql stable security definer set search_path = ''
as $$
declare
    v numeric;
begin
    perform private.erfordere(array['admin','kueche']);
    select coalesce(sum(-p.guthaben), 0) into v
      from public.personen p
     where p.aktiv and p.guthaben < 0;
    return v;
end
$$;

-- ---------------------------------------------------------------------
-- ABENDESSEN-LISTE (offene Einträge, mit Namen)
-- ---------------------------------------------------------------------
create or replace function public.abendessen_liste()
returns table (id uuid, person_id uuid, anzeigename text, kategorie text,
               vegetarisch boolean, erstellt_am timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    perform private.erfordere(array['admin','kueche']);

    return query
    select e.id, e.person_id, p.anzeigename, p.kategorie, e.vegetarisch, e.erstellt_am
      from public.abendessen_eintraege e
      join public.personen p on p.id = e.person_id
     where e.status = 'offen'
     order by e.erstellt_am, e.id;
end
$$;

-- ---------------------------------------------------------------------
-- HISTORIE einer Person (letzte 30 Tage, neueste zuerst)
-- Bestellungen erscheinen wie in der alten App je Position.
-- Mitglied: nur die eigene. Küche/Admin: jede Person.
-- ---------------------------------------------------------------------
create or replace function public.historie_person(p_person_id uuid)
returns table (zeitpunkt timestamptz, aktion text, details text,
               betrag numeric, neues_guthaben numeric)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
    v_rolle text := private.erfordere(array['admin','kueche','mitglied']);
begin
    if v_rolle = 'mitglied' and p_person_id is distinct from private.person_id() then
        raise exception 'Keine Berechtigung' using errcode = '42501';
    end if;

    return query
    select x.zeitpunkt, x.aktion, x.details, x.betrag, x.neues_guthaben
      from (
        -- Bestellungen: eine Zeile je Position
        select b.erstellt_am as zeitpunkt,
               'Bestellung'::text as aktion,
               (bp.bezeichnung || case when bp.menge > 1 then ' (' || bp.menge || 'x)' else '' end) as details,
               (case when bp.ist_abendessen then 0 else -(bp.einzelpreis * bp.menge) end)::numeric as betrag,
               coalesce(g.saldo_danach, 0)::numeric as neues_guthaben,
               bp.id as sortierung
          from public.bestellungen b
          join public.bestellpositionen bp on bp.bestellung_id = b.id
          left join public.guthaben_buchungen g
                 on g.bestellung_id = b.id and g.art = 'bestellung'
         where b.person_id = p_person_id
           and b.erstellt_am >= now() - interval '30 days'
        union all
        -- Aufladungen, Abendessen-Abrechnungen, Übernahme
        select g.erstellt_am,
               case g.art when 'aufladung' then 'Einzahlung'
                          when 'abendessen' then 'Abendessen-Abrechnung'
                          else 'Übernahme' end,
               case g.art when 'aufladung' then 'Guthaben aufgeladen'
                          when 'abendessen' then coalesce(g.bezeichnung, 'Abendessen')
                          else 'Guthaben aus der alten App übernommen' end,
               g.betrag::numeric,
               g.saldo_danach::numeric,
               g.id
          from public.guthaben_buchungen g
         where g.person_id = p_person_id
           and g.art <> 'bestellung'
           and g.erstellt_am >= now() - interval '30 days'
      ) x
     order by x.zeitpunkt desc, x.sortierung desc;
end
$$;

-- ---------------------------------------------------------------------
-- ABENDESSEN ABRECHNEN (getrennt für Normal / Vegetarisch)
-- Zweimal klicken bucht NICHT doppelt: abgerechnete Einträge sind danach
-- nicht mehr "offen".
-- ---------------------------------------------------------------------
create or replace function public.abendessen_abrechnen(p_vegetarisch boolean, p_preis numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_preis numeric(8,2);
    v_bez   text;
    v_e     public.abendessen_eintraege%rowtype;
    v_anz   integer := 0;
begin
    perform private.erfordere(array['admin','kueche']);

    if p_vegetarisch is null then
        raise exception 'Typ fehlt';
    end if;
    if p_preis is null or p_preis <= 0 or p_preis > 100 then
        raise exception 'Bitte einen gültigen Preis eingeben';
    end if;
    v_preis := round(p_preis, 2);
    v_bez := case when p_vegetarisch then 'Abendessen (Vegetarisch)' else 'Abendessen (Normal)' end;

    -- Zuerst die Personen in fester Reihenfolge sperren (verhindert Verklemmungen
    -- mit gleichzeitig eingehenden Bestellungen)
    perform 1 from public.personen
     where id in (select person_id from public.abendessen_eintraege
                   where status = 'offen' and vegetarisch = p_vegetarisch)
     order by id for update;

    for v_e in
        select * from public.abendessen_eintraege
         where status = 'offen' and vegetarisch = p_vegetarisch
         order by person_id
         for update
    loop
        perform private.buche(v_e.person_id, -v_preis, 'abendessen', null, v_bez);
        update public.abendessen_eintraege
           set status = 'abgerechnet', preis = v_preis, erledigt_am = now()
         where id = v_e.id;
        v_anz := v_anz + 1;
    end loop;

    if v_anz = 0 then
        raise exception 'Keine % Abendessen zum Abrechnen vorhanden',
            case when p_vegetarisch then 'vegetarischen' else 'normalen' end;
    end if;

    return jsonb_build_object('personen', v_anz, 'preis', v_preis, 'summe', v_anz * v_preis);
end
$$;

-- Eintrag aus der Abendessen-Liste entfernen, OHNE Abbuchung
create or replace function public.abendessen_eintrag_entfernen(p_eintrag_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    perform private.erfordere(array['admin','kueche']);

    update public.abendessen_eintraege
       set status = 'entfernt', erledigt_am = now()
     where id = p_eintrag_id and status = 'offen';

    if not found then
        raise exception 'Eintrag ist nicht (mehr) in der Liste';
    end if;
end
$$;

-- ---------------------------------------------------------------------
-- HISTORIE-BEREINIGUNG: löscht alles, was älter als 30 Tage ist.
-- Die Guthaben (personen.guthaben) bleiben davon unberührt.
-- Wird täglich per Cron und bei jedem Tagesabschluss ausgeführt.
-- ---------------------------------------------------------------------
create or replace function private.historie_bereinigen()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_grenze  timestamptz := now() - interval '30 days';
    v_buch    integer;
    v_best    integer;
    v_abend   integer;
    v_pers    integer;
begin
    delete from public.guthaben_buchungen where erstellt_am < v_grenze;
    get diagnostics v_buch = row_count;

    delete from public.bestellungen where erstellt_am < v_grenze;   -- Positionen folgen per Cascade
    get diagnostics v_best = row_count;

    delete from public.abendessen_eintraege
     where status <> 'offen' and erstellt_am < v_grenze;
    get diagnostics v_abend = row_count;

    -- Gelöschte Gäste, deren Historie nun komplett weg ist, endgültig entfernen
    delete from public.personen p
     where not p.aktiv
       and p.kategorie <> 'wachabteilung'
       and p.deaktiviert_am < v_grenze
       and not exists (select 1 from public.profile pr where pr.person_id = p.id)
       and not exists (select 1 from public.guthaben_buchungen g where g.person_id = p.id)
       and not exists (select 1 from public.bestellungen b where b.person_id = p.id)
       and not exists (select 1 from public.abendessen_eintraege e where e.person_id = p.id);
    get diagnostics v_pers = row_count;

    return jsonb_build_object('buchungen', v_buch, 'bestellungen', v_best,
                              'abendessen', v_abend, 'personen', v_pers);
end
$$;

-- ---------------------------------------------------------------------
-- TAGESABSCHLUSS (Küche, ohne Passwort – wie bisher)
--  * Einkaufsliste/Tagesbestellungen werden "abgeschlossen" (auf 0)
--  * Offene Abendessen-Einträge werden verworfen (wie in der alten App)
--  * Historie älter als 30 Tage wird gelöscht
--  * Ein Snapshot wird gespeichert (ohne Namen/Guthaben)
-- Das vollständige JSON-Backup holt der Client vorher über backup_export().
-- ---------------------------------------------------------------------
create or replace function public.tagesabschluss()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_id      uuid := gen_random_uuid();
    v_ids     uuid[];
    v_anz     integer;
    v_umsatz  numeric;
    v_liste   jsonb;
    v_abend   jsonb;
    v_bereinigt jsonb;
begin
    perform private.erfordere(array['admin','kueche']);

    -- Zwei Tagesabschlüsse gleichzeitig werden nacheinander ausgeführt
    perform pg_advisory_xact_lock(hashtext('kantine_tagesabschluss'));

    insert into public.tagesabschluesse (id, durchgefuehrt_von)
    values (v_id, (select auth.uid()));

    -- Alle noch offenen Bestellungen abschließen. Die Snapshot-Zahlen werden aus
    -- genau diesen Bestellungen berechnet, damit nichts "dazwischen rutscht".
    with u as (
        update public.bestellungen
           set tagesabschluss_id = v_id
         where tagesabschluss_id is null
        returning id, summe
    )
    select coalesce(array_agg(id), '{}'), count(*), coalesce(sum(summe), 0)
      into v_ids, v_anz, v_umsatz
      from u;

    select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'menge', x.menge)
                              order by x.ord, x.name), '[]'::jsonb)
      into v_liste
      from (
        select bp.bezeichnung as name, sum(bp.menge)::integer as menge, min(bp.produkt_id) as ord
          from public.bestellpositionen bp
         where bp.bestellung_id = any (v_ids)
           and bp.zaehlt_einkaufsliste and not bp.ist_abendessen
         group by bp.bezeichnung
      ) x;

    with a as (
        update public.abendessen_eintraege
           set status = 'verworfen', erledigt_am = now()
         where status = 'offen'
        returning person_id, vegetarisch
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'name', p.anzeigename, 'kategorie', p.kategorie, 'vegetarisch', a.vegetarisch)), '[]'::jsonb)
      into v_abend
      from a join public.personen p on p.id = a.person_id;

    v_bereinigt := private.historie_bereinigen();

    update public.tagesabschluesse
       set snapshot = jsonb_build_object(
               'bestellungen', v_anz,
               'umsatz', v_umsatz,
               'einkaufsliste', v_liste,
               'abendessen_verworfen', jsonb_array_length(v_abend))
     where id = v_id;

    return jsonb_build_object(
        'id', v_id,
        'bestellungen', v_anz,
        'umsatz', v_umsatz,
        'einkaufsliste', v_liste,
        'abendessen_verworfen', v_abend,
        'bereinigt', v_bereinigt);
end
$$;

-- ---------------------------------------------------------------------
-- BACKUP-EXPORT: alle Daten als JSON (der Client lädt sie als Datei
-- herunter, sie landet wie bisher in den Dateien des iPads / iCloud).
-- ---------------------------------------------------------------------
create or replace function public.backup_export()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
    perform private.erfordere(array['admin','kueche']);

    return jsonb_build_object(
        'version', 'supabase-1',
        'erstellt_am', now(),
        'personen', (select coalesce(jsonb_agg(to_jsonb(p) order by p.kategorie, p.anzeigename), '[]'::jsonb)
                       from public.personen p),
        'produkt_kategorien', (select coalesce(jsonb_agg(to_jsonb(k) order by k.sortierung), '[]'::jsonb)
                                 from public.produkt_kategorien k),
        'produkte', (select coalesce(jsonb_agg(to_jsonb(pr) order by pr.id), '[]'::jsonb)
                       from public.produkte pr),
        'einkaufsliste', (select coalesce(jsonb_agg(jsonb_build_object('name', e.name, 'menge', e.menge)), '[]'::jsonb)
                            from public.einkaufsliste() e),
        'abendessen_offen', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'name', a.anzeigename, 'kategorie', a.kategorie, 'vegetarisch', a.vegetarisch)), '[]'::jsonb)
                               from public.abendessen_liste() a),
        'historie_30_tage', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'person', p.anzeigename, 'kategorie', p.kategorie, 'art', g.art,
                                   'betrag', g.betrag, 'saldo_danach', g.saldo_danach,
                                   'bezeichnung', g.bezeichnung, 'zeitpunkt', g.erstellt_am)
                                 order by g.erstellt_am), '[]'::jsonb)
                               from public.guthaben_buchungen g
                               join public.personen p on p.id = g.person_id));
end
$$;

-- ---------------------------------------------------------------------
-- VERWALTUNG (nur Admin): Guthaben aufladen
-- ---------------------------------------------------------------------
create or replace function public.guthaben_aufladen(p_person_id uuid, p_betrag numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_betrag numeric(10,2);
    v_person public.personen%rowtype;
    v_saldo  numeric(10,2);
begin
    perform private.erfordere(array['admin']);

    if p_betrag is null or p_betrag <= 0 or p_betrag > 10000 then
        raise exception 'Bitte einen gültigen positiven Betrag eingeben';
    end if;
    v_betrag := round(p_betrag, 2);

    select * into v_person from public.personen where id = p_person_id for update;
    if not found or not v_person.aktiv then
        raise exception 'Person nicht gefunden oder nicht mehr aktiv';
    end if;

    v_saldo := private.buche(p_person_id, v_betrag, 'aufladung', null, 'Guthaben aufgeladen');
    return jsonb_build_object('betrag', v_betrag, 'neues_guthaben', v_saldo);
end
$$;

-- ---------------------------------------------------------------------
-- VERWALTUNG (nur Admin): Produkte
-- ---------------------------------------------------------------------
create or replace function public.produkt_preis_aendern(p_id bigint, p_preis numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_alt  numeric(8,2);
    v_name text;
begin
    perform private.erfordere(array['admin']);

    if p_preis is null or p_preis < 0 or p_preis > 1000 then
        raise exception 'Bitte einen gültigen Preis eingeben';
    end if;

    select preis, name into v_alt, v_name from public.produkte where id = p_id and aktiv for update;
    if not found then
        raise exception 'Produkt nicht gefunden';
    end if;

    update public.produkte set preis = round(p_preis, 2) where id = p_id;
    return jsonb_build_object('name', v_name, 'alter_preis', v_alt, 'neuer_preis', round(p_preis, 2));
end
$$;

create or replace function public.produkt_anlegen(
    p_name text, p_preis numeric, p_kategorie_id smallint, p_zaehlt_einkaufsliste boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_name text := btrim(coalesce(p_name, ''));
    v_typ  text := 'sonstiges';
    v_id   bigint;
begin
    perform private.erfordere(array['admin']);

    if char_length(v_name) not between 1 and 60 then
        raise exception 'Bitte einen Produktnamen eingeben';
    end if;
    if p_preis is null or p_preis < 0 or p_preis > 1000 then
        raise exception 'Bitte einen gültigen Preis eingeben';
    end if;
    if not exists (select 1 from public.produkt_kategorien where id = p_kategorie_id) then
        raise exception 'Bitte eine Kategorie auswählen';
    end if;

    if coalesce(p_zaehlt_einkaufsliste, false) then
        -- wie in der alten App: Typ aus dem Namen ableiten ("Apfelschorle" -> "apfelschorle")
        v_typ := left(regexp_replace(
                    replace(replace(replace(replace(lower(v_name), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss'),
                    '[^a-z0-9]', '_', 'g'), 50);
        -- Schutz: ein neues Produkt darf nie versehentlich zum "Abendessen" werden
        if v_typ in ('abendessen_normal', 'abendessen_vegetarisch') then
            v_typ := v_typ || '_x';
        end if;
    end if;

    insert into public.produkte (kategorie_id, name, preis, typ, zaehlt_einkaufsliste)
    values (p_kategorie_id, v_name, round(p_preis, 2), v_typ, coalesce(p_zaehlt_einkaufsliste, false))
    returning id into v_id;

    return jsonb_build_object('id', v_id, 'name', v_name);
end
$$;

-- "Löschen" blendet das Produkt aus; bestehende Historie bleibt lesbar.
-- Abendessen-Produkte sind geschützt (wie in der alten App).
create or replace function public.produkt_loeschen(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v public.produkte%rowtype;
begin
    perform private.erfordere(array['admin']);

    select * into v from public.produkte where id = p_id and aktiv for update;
    if not found then
        raise exception 'Produkt nicht gefunden';
    end if;
    if v.ist_abendessen then
        raise exception 'Abendessen-Produkte können nicht gelöscht werden';
    end if;

    update public.produkte set aktiv = false where id = p_id;
end
$$;

-- ---------------------------------------------------------------------
-- GÄSTE (Gäste, Azubis, Notarzt, B-Dienst, Fahrer B-Dienst)
-- Wie bisher: höchstens 12 Plätze pro Kategorie.
-- Anlegen: Küche + Admin (am Tablet, ohne Passwort). Löschen: nur Admin.
-- ---------------------------------------------------------------------
create or replace function public.gast_anlegen(p_kategorie text, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
    v_name text := btrim(coalesce(p_name, ''));
    v_id   uuid;
begin
    perform private.erfordere(array['admin','kueche']);

    if p_kategorie is null or p_kategorie not in ('bdienst','fahrer_bdienst','notarzt','azubi','gaeste') then
        raise exception 'Ungültige Kategorie';
    end if;
    if char_length(v_name) not between 1 and 60 then
        raise exception 'Bitte einen Namen eingeben';
    end if;

    perform pg_advisory_xact_lock(hashtext('kantine_gast_' || p_kategorie));

    if (select count(*) from public.personen where kategorie = p_kategorie and aktiv) >= 12 then
        raise exception 'Alle 12 Plätze sind belegt';
    end if;

    insert into public.personen (kategorie, anzeigename)
    values (p_kategorie, v_name)
    returning id into v_id;

    return jsonb_build_object('id', v_id, 'anzeigename', v_name, 'kategorie', p_kategorie, 'guthaben', 0);
end
$$;

create or replace function public.gast_loeschen(p_person_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v public.personen%rowtype;
begin
    perform private.erfordere(array['admin']);

    select * into v from public.personen where id = p_person_id for update;
    if not found or not v.aktiv or v.kategorie = 'wachabteilung' then
        raise exception 'Person nicht gefunden';
    end if;

    update public.personen set aktiv = false, deaktiviert_am = now() where id = p_person_id;

    -- Offenes Abendessen dieser Person entfernen (in der alten App blieb hier ein
    -- Eintrag stehen, der später den falschen Platz belasten konnte)
    update public.abendessen_eintraege
       set status = 'entfernt', erledigt_am = now()
     where person_id = p_person_id and status = 'offen';
end
$$;

-- =====================================================================
-- KONTEN-VERWALTUNG (nur per SQL-Editor im Dashboard, NICHT über die API)
-- Siehe docs/SUPABASE-SETUP.md
-- =====================================================================

-- Die Pseudo-E-Mail-Domain für Benutzernamen-Logins steht NUR HIER (und in
-- js/config.js, Phase 2). Supabase kennt nur E-Mail+Passwort; der Benutzername
-- "max" wird intern zu "max@kantine.invalid". Es werden nie E-Mails verschickt.
create or replace function private.login_domain() returns text
language sql immutable set search_path = ''
as $$ select 'kantine.invalid'::text $$;

-- Verknüpft einen im Dashboard angelegten Login (benutzername@kantine.invalid)
-- mit Rolle und Person. Beispiel:
--   select private.konto_einrichten('max', 'mitglied', 'Max Mustermann');
--   select private.konto_einrichten('kueche', 'kueche');
--   select private.konto_einrichten('jannis', 'admin', 'Jannis Mustermann');
create or replace function private.konto_einrichten(
    p_benutzername text, p_rolle text, p_personenname text default null
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_name   text := lower(btrim(p_benutzername));
    v_user   uuid;
    v_person uuid;
begin
    select id into v_user from auth.users where lower(email) = v_name || '@' || private.login_domain();
    if v_user is null then
        raise exception 'Kein Login "%" gefunden. Zuerst im Dashboard unter Authentication > Users anlegen (E-Mail: %@%).',
            v_name, v_name, private.login_domain();
    end if;

    if p_rolle not in ('admin','kueche','mitglied') then
        raise exception 'Rolle muss admin, kueche oder mitglied sein';
    end if;

    if p_personenname is not null then
        select id into v_person from public.personen
         where kategorie = 'wachabteilung' and aktiv
           and lower(btrim(anzeigename)) = lower(btrim(p_personenname));
        if v_person is null then
            raise exception 'Person "%" nicht in der Wachabteilung gefunden. Name genau wie in der Tabelle "personen" angeben.',
                p_personenname;
        end if;
    end if;

    insert into public.profile (id, benutzername, rolle, person_id, aktiv)
    values (v_user, v_name, p_rolle, v_person, true)
    on conflict (id) do update
       set benutzername = excluded.benutzername,
           rolle = excluded.rolle,
           person_id = excluded.person_id,
           aktiv = true;

    update auth.users set banned_until = null where id = v_user;

    return 'OK: ' || v_name || ' als ' || p_rolle
        || coalesce(' (' || p_personenname || ')', '') || ' eingerichtet';
end
$$;

-- Sperrt ein Konto sofort: Datenzugriff weg (profile.aktiv) + Login gesperrt.
create or replace function private.konto_deaktivieren(p_benutzername text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_name text := lower(btrim(p_benutzername));
    v_user uuid;
begin
    select id into v_user from public.profile where benutzername = v_name;
    if v_user is null then
        raise exception 'Konto "%" nicht gefunden', v_name;
    end if;

    update public.profile set aktiv = false where id = v_user;
    update auth.users set banned_until = now() + interval '100 years' where id = v_user;
    return 'OK: ' || v_name || ' ist gesperrt';
end
$$;

create or replace function private.konto_aktivieren(p_benutzername text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
    v_name text := lower(btrim(p_benutzername));
    v_user uuid;
begin
    select id into v_user from public.profile where benutzername = v_name;
    if v_user is null then
        raise exception 'Konto "%" nicht gefunden', v_name;
    end if;

    update public.profile set aktiv = true where id = v_user;
    update auth.users set banned_until = null where id = v_user;
    return 'OK: ' || v_name || ' ist wieder aktiv';
end
$$;
