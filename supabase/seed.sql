-- =====================================================================
-- Kantine – Start-Produkte (entsprechen den Standardwerten der alten App)
-- Nur für ein NEUES/Test-Projekt. Bei der echten Migration (Phase 3)
-- werden Produkte und Preise aus dem Backup der alten App übernommen.
-- =====================================================================

insert into public.produkte (id, kategorie_id, name, preis, typ, zaehlt_einkaufsliste) overriding system value values
    ( 1, 0, 'Kaffeeflatrate',          1.00, 'sonstiges',              false),
    ( 2, 0, 'Cola/Fanta/Limo',         1.30, 'sonstiges',              false),
    ( 3, 1, 'Normal',                  1.30, 'brötchen_normal',        true),
    ( 4, 1, 'Sunny',                   1.50, 'brötchen_sunny',         true),
    ( 5, 1, 'Roggen',                  1.70, 'brötchen_roggen',        true),
    ( 6, 1, 'Mehrkorn',                1.70, 'brötchen_mehrkorn',      true),
    ( 7, 2, 'Ei',                      0.40, 'ei',                     true),
    ( 8, 3, 'Abendessen Normal',       0.00, 'abendessen_normal',      false),
    ( 9, 3, 'Abendessen Vegetarisch',  0.00, 'abendessen_vegetarisch', false),
    (10, 4, 'Kuchen/Eis',              1.20, 'sonstiges',              false),
    (11, 5, 'Süßes Klein',             0.40, 'sonstiges',              false),
    (12, 5, 'Süßes Groß',              0.80, 'sonstiges',              false)
on conflict (id) do nothing;

-- Zähler so setzen, dass neue Produkte ab der nächsten freien ID vergeben werden
select setval(pg_get_serial_sequence('public.produkte', 'id'),
              greatest((select max(id) from public.produkte), 1));
