// Browser-Test (Phase 2): echte index.html in Chromium, Datenbank = echtes SQL aus Phase 1.
// Nur der Supabase-Client ist ersetzt (mock), alles andere läuft wie im Betrieb.
// Start: ./setup.sh && node e2e.mjs
import pg from 'pg';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(20, Number);
const cfg = { host: 'localhost', user: 'kt', password: 'kt', database: 'kantine_test' };
const ROOT = path.resolve('..', '..');
const SHOT = process.env.SHOT_DIR || '/tmp/kantine-shots';
fs.mkdirSync(SHOT, { recursive: true });

const su = new pg.Client(cfg);
await su.connect();
const q = async (s, a) => (await su.query(s, a)).rows;

// ---------- Testdaten ----------
const UID = { admin: '00000000-0000-4000-8000-0000000000a1', kueche: '00000000-0000-4000-8000-0000000000a2',
              max: '00000000-0000-4000-8000-0000000000b1', anna: '00000000-0000-4000-8000-0000000000b2' };
for (const [n, id] of Object.entries(UID)) await q('insert into auth.users (id,email) values ($1,$2)', [id, `${n}@kantine.invalid`]);
const np = async (k, n, g = 0) => (await q('insert into public.personen (kategorie,anzeigename,guthaben) values ($1,$2,$3) returning id', [k, n, g]))[0].id;
await np('wachabteilung', 'Max Mustermann', 10); await np('wachabteilung', 'Anna Beispiel', 5);
await np('wachabteilung', 'Dirk Test', 50); await np('wachabteilung', 'Schulden Sven', -12.5);
await q("select private.konto_einrichten('admin','admin')");
await q("select private.konto_einrichten('kueche','kueche')");
await q("select private.konto_einrichten('max','mitglied','Max Mustermann')");
await q("select private.konto_einrichten('anna','mitglied','Anna Beispiel')");

// ---------- Datenbank-Brücke ----------
async function db(m) {
  if (m.kind === 'login') {
    const name = m.email.split('@')[0];
    const u = UID[name];
    if (!u || m.password !== name) return { error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
    return { uid: u };
  }
  const c = new pg.Client(cfg); await c.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [m.uid]);
    let data;
    if (m.kind === 'select') {
      assert.match(m.table, /^[a-z_]+$/); assert.match(m.cols, /^[a-z_, ]+$/);
      const w = m.filters.map((f, i) => { assert.match(f[0], /^[a-z_]+$/); return `${f[0]} = $${i + 1}`; });
      const ord = m.order ? ` order by ${m.order.replace(/[^a-z_]/g, '')}` : '';
      const r = await c.query(`select ${m.cols} from public.${m.table}${w.length ? ' where ' + w.join(' and ') : ''}${ord}`, m.filters.map((f) => f[1]));
      data = m.single ? (r.rows[0] ?? null) : r.rows;
    } else {
      assert.match(m.name, /^[a-z_]+$/);
      const keys = Object.keys(m.args || {});
      const call = `public.${m.name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const vals = keys.map((k) => (m.args[k] !== null && typeof m.args[k] === 'object' ? JSON.stringify(m.args[k]) : m.args[k]));
      const set = (await su.query('select proretset from pg_proc where proname=$1 and pronamespace=$2::regnamespace', [m.name, 'public']))[0] ?? null;
      const isSet = (await su.query('select bool_or(proretset) s from pg_proc where proname=$1 and pronamespace=$2::regnamespace', [m.name, 'public'])).rows[0].s;
      if (isSet) data = (await c.query(`select * from ${call}`, vals)).rows;
      else data = (await c.query(`select ${call} as r`, vals)).rows[0].r;
    }
    await c.query('commit');
    return { data };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    return { error: { message: e.message, code: e.code, status: 400 } };
  } finally { await c.end(); }
}

// ---------- Mock-Client im Browser ----------
const MOCK = `
(function () {
  function createClient(url, key, opts) {
    const persist = !!(opts.auth && opts.auth.persistSession), sk = opts.auth.storageKey;
    let uid = null; try { if (persist) uid = localStorage.getItem(sk); } catch (e) {}
    const subs = [];
    const emit = (ev) => subs.forEach((f) => f(ev, null));
    class Q { constructor(t){this.t=t;this.f=[];this.o=null;this.s=false;this.cols='*';}
      select(c){this.cols=c;return this;} eq(c,v){this.f.push([c,v]);return this;} order(c){this.o=c;return this;}
      maybeSingle(){this.s=true;return this;}
      then(res,rej){return window.__db({kind:'select',uid,table:this.t,cols:this.cols,filters:this.f,order:this.o,single:this.s}).then((r)=>res(r.error?{data:null,error:r.error,status:r.error.status}:{data:r.data,error:null}),rej);} }
    return {
      auth: {
        async signInWithPassword({email,password}) { const r = await window.__db({kind:'login',email,password});
          if (r.error) return {data:null,error:r.error}; uid=r.uid; try{ if(persist) localStorage.setItem(sk,uid);}catch(e){}
          emit('SIGNED_IN'); return {data:{session:{user:{id:uid}}},error:null}; },
        async getSession() { return {data:{session: uid?{user:{id:uid}}:null}}; },
        async signOut() { uid=null; try{localStorage.removeItem(sk);}catch(e){} emit('SIGNED_OUT'); return {error:null}; },
        onAuthStateChange(f){ subs.push(f); return {data:{subscription:{}}}; },
        async updateUser(){ return {error:null}; }
      },
      from(t){ return new Q(t); },
      rpc(name,args){ return window.__db({kind:'rpc',uid,name,args}).then((r)=>r.error?{data:null,error:r.error,status:r.error.status}:{data:r.data,error:null}); },
      channel(){ const ch={on(){return ch;},subscribe(cb){ if(cb)cb('SUBSCRIBED'); return ch;}}; return ch; },
      removeChannel(){}
    };
  }
  window.supabase = { createClient };
})();`;

// ---------- Statischer Server ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || p.startsWith('/supabase') || p.startsWith('/alt/') && false || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(f);
  res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;

// config.js und vendor/supabase.js ersetzen (Test-Werte + Mock)
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
async function seite(viewport) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const pgz = await ctx.newPage();
  const fehlerListe = [];
  pgz.on('pageerror', (e) => fehlerListe.push('pageerror: ' + e.message));
  pgz.on('console', (m) => { if (m.type() === 'error') fehlerListe.push('console: ' + m.text()); });
  pgz.on('dialog', (d) => d.accept());
  await pgz.exposeFunction('__db', db);
  await pgz.route('**/js/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  await pgz.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript',
    body: "window.KANTINE_CONFIG={SUPABASE_URL:'https://test.supabase.co',SUPABASE_KEY:'sb_publishable_testtesttesttesttest',LOGIN_DOMAIN:'kantine.invalid'};" }));
  pgz.fehler = fehlerListe;
  return pgz;
}
async function login(p, n, pw = n) { await p.fill('#l-name', n); await p.fill('#l-pw', pw); await p.click('#l-btn'); }
const sichtbar = (p, s) => p.locator(s).first().isVisible();
let ok = 0;
const meldungLeeren = (p) => p.evaluate(() => { const m = document.getElementById('meldung'); m.className = 'meldung'; m.style.display = 'none'; });
async function klickM(p, sel, typ = 'erfolg', opt) {          // klicken und auf die NEUE Meldung warten
  await meldungLeeren(p); await p.click(sel, opt); await p.waitForSelector('#meldung.' + typ, { state: 'visible' });
}
const karteVon = (p, n) => p.locator('.produkt-karte').filter({ has: p.locator('.produkt-name', { hasText: new RegExp('^' + n + '$') }) });
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '\n     ', e.message.split('\n').slice(0,6).join(' | ')); process.exitCode = 1; }
}

// ================= HANDY =================
console.log('Handy (390x844)');
const h = await seite({ width: 390, height: 844 });
await h.goto(BASE + '/');
await test('Start zeigt Login', async () => { await h.waitForSelector('#login:not(.hidden)'); await h.screenshot({ path: SHOT + '/01-handy-login.png' }); });
await test('falsches Passwort wird abgelehnt', async () => {
  await login(h, 'max', 'falsch');
  await h.waitForSelector('#meldung.fehler');
  assert.match(await h.textContent('#meldung'), /falsch/);
});
await test('Login Max: Handy-Ansicht, Guthaben 10.00 €, Ranking', async () => {
  await login(h, 'max');
  await h.waitForSelector('#handy:not(.hidden) #h-guthaben');
  await h.waitForFunction(() => document.getElementById('h-guthaben').textContent.includes('10.00'));
  assert.ok(await sichtbar(h, '#h-schulden'), 'Schulden-Ranking fehlt');
  assert.match(await h.textContent('#h-schulden'), /Schulden Sven/);
  assert.match(await h.textContent('#h-guthaben-top'), /Dirk Test/);
  assert.ok(!(await h.locator('#individueller-betrag-input').isVisible().catch(() => false)), 'kein individueller Betrag am Handy');
  assert.ok(!(await h.locator('#t-btn-kueche').isVisible()), 'keine Küche am Handy');
});
await test('Bestellen: 2× Normal + 1× Ei = 3.00 €', async () => {
  const k = (n) => karteVon(h, n);
  await k('Normal').locator('[data-d="1"]').first().click(); await k('Normal').locator('[data-d="1"]').first().click();
  await k('Ei').locator('[data-d="1"]').click();
  assert.equal((await h.textContent('#h-summe')).trim(), '3.00');
  await h.screenshot({ path: SHOT + '/02-handy-warenkorb.png', fullPage: true });
  await klickM(h, '#h-bestellen-btn', 'erfolg');
  assert.match(await h.textContent('#h-guthaben'), /7\.00/);
  assert.equal((await q("select guthaben::float g from personen where anzeigename='Max Mustermann'"))[0].g, 7);
});
await test('Abendessen kostet 0 € und wird vorgemerkt; keine Doppelbuchung', async () => {
  await karteVon(h, 'Abendessen Vegetarisch').locator('[data-d="1"]').click();
  await klickM(h, '#h-bestellen-btn', 'erfolg');
  assert.match(await h.textContent('#h-guthaben'), /7\.00/);
  assert.equal((await q("select count(*)::int n from abendessen_eintraege where status='offen'"))[0].n, 1);
});
await test('Historie zeigt Einträge', async () => {
  await h.click('#h-hist-kopf');
  const t = await h.textContent('#h-hist-inhalt');
  assert.match(t, /Normal \(2x\)/); assert.match(t, /Neues Guthaben/);
  await h.screenshot({ path: SHOT + '/03-handy-historie.png', fullPage: true });
});
await test('Doppelklick auf Bestellen bucht nur einmal', async () => {
  await karteVon(h, 'Ei').locator('[data-d="1"]').click();
  await meldungLeeren(h);
  await h.evaluate(() => { const b = document.getElementById('h-bestellen-btn'); b.click(); b.click(); });
  await h.waitForSelector('#meldung.erfolg', { state: 'visible' });
  assert.equal((await q("select guthaben::float g from personen where anzeigename='Max Mustermann'"))[0].g, 6.6);
});
await test('Abmelden führt zum Login; Seite neu laden bleibt ausgeloggt', async () => {
  await h.click('#h-abmelden'); await h.waitForSelector('#login:not(.hidden)');
  await h.reload(); await h.waitForSelector('#login:not(.hidden)');
});
await test('Sitzung bleibt nach Neuladen bestehen (Anna)', async () => {
  await login(h, 'anna'); await h.waitForSelector('#handy:not(.hidden) #h-guthaben');
  await h.reload(); await h.waitForSelector('#handy:not(.hidden) #h-guthaben');
  assert.match(await h.textContent('#h-anzeigename'), /Anna Beispiel/);
  assert.match(await h.textContent('#h-guthaben'), /5\.00/);
});
await test('Keine JavaScript-Fehler (Handy)', async () => assert.deepEqual(h.fehler, []));

// ================= TABLET =================
console.log('Tablet (1024x768)');
const t = await seite({ width: 1024, height: 768 });
await t.goto(BASE + '/');
await test('Küchen-Konto landet im Tablet mit 6 Kategorien', async () => {
  await login(t, 'kueche');
  await t.waitForSelector('#tablet:not(.hidden) #startseite:not(.hidden)');
  assert.equal(await t.locator('.kategorie-btn[data-kat]').count(), 6);
  await t.screenshot({ path: SHOT + '/04-tablet-start.png' });
});
await test('Wachabteilung: Personen nach Nachname, Ranking sichtbar', async () => {
  await t.click('[data-kat="wachabteilung"]');
  const namen = await t.locator('#benutzer-liste .benutzer-name').allTextContents();
  assert.deepEqual(namen, ['Anna Beispiel', 'Max Mustermann', 'Schulden Sven', 'Dirk Test']);
  assert.match(await t.textContent('#schulden-warnung-box'), /Schulden Sven/);
  assert.match(await t.textContent('#guthaben-top-box'), /Dirk Test/);
  await t.screenshot({ path: SHOT + '/05-tablet-wachabteilung.png' });
});
await test('Bestellen am Tablet inkl. individuellem Betrag', async () => {
  await t.locator('.benutzer-karte', { hasText: 'Dirk Test' }).click();
  await karteVon(t, 'Sunny').locator('[data-d="1"]').click();
  await t.fill('#individueller-betrag-input', '2.50'); await t.fill('#individueller-bezeichnung-input', 'Eis extra');
  await t.click('#t-indiv-btn');
  assert.equal((await t.textContent('#summe-anzeige')).trim(), '4.00');
  await klickM(t, '#t-bestellen-btn', 'erfolg');
  assert.match(await t.textContent('#guthaben-anzeige'), /46\.00/);
  await t.screenshot({ path: SHOT + '/06-tablet-bestellen.png', fullPage: true });
});
await test('Gast anlegen: 12 Plätze, Name wird nicht als HTML ausgeführt', async () => {
  await t.click('#t-zurueck-liste'); await t.click('#t-zurueck-start'); await t.click('[data-kat="gaeste"]');
  assert.equal(await t.locator('.benutzer-karte.platzhalter').count(), 12);
  await t.fill('#platzhalter-name-input', '<img src=x onerror="window.xss=1">Gast');
  await t.click('#t-name-speichern');
  await t.waitForSelector('#bestell-bereich:not(.hidden)');
  assert.equal(await t.evaluate(() => window.xss), undefined);
  assert.match(await t.textContent('#aktueller-benutzer'), /<img/);
  await karteVon(t, 'Kaffeeflatrate').locator('[data-d="1"]').click();
  await klickM(t, '#t-bestellen-btn', 'erfolg');
  await t.click('#t-zurueck-liste');
  assert.equal(await t.locator('.benutzer-karte.platzhalter').count(), 11);
});
await test('Küche: Einkaufsliste, Abendessen, Gesamtschulden', async () => {
  await t.click('#t-zurueck-start'); await t.click('#t-btn-kueche');
  await t.waitForSelector('#koch-bereich:not(.hidden) .einkaufsitem');
  const txt = await t.textContent('#einkaufsliste-anzeige');
  assert.match(txt, /Normal.*2 Stück/s); assert.match(txt, /Sunny.*1 Stück/s); assert.match(txt, /Ei.*2 Stück/s);
  assert.match(await t.textContent('#abendessen-liste'), /Max Mustermann/);
  assert.match(await t.textContent('#schulden-betrag'), /13\.50/);
  await t.screenshot({ path: SHOT + '/07-tablet-kueche.png', fullPage: true });
});
await test('Abendessen abrechnen (Vegetarisch 5.50 €)', async () => {
  await t.fill('#abendessen-preis-vegetarisch', '5.50');
  await klickM(t, '[data-abrechnen="v"]', 'erfolg');
  assert.equal((await q("select guthaben::float g from personen where anzeigename='Max Mustermann'"))[0].g, 1.1);
  assert.match(await t.textContent('#abendessen-liste'), /Noch keine Abendessen/);
});
await test('Tagesabschluss: Backup-Download, Einkaufsliste leer', async () => {
  const dl = t.waitForEvent('download');
  await t.click('#k-tagesabschluss');
  const d = await dl; assert.match(d.suggestedFilename(), /^kantine-backup-\d{4}-\d\d-\d\d\.json$/);
  const json = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
  assert.ok(json.version);
  await t.waitForFunction(() => /Noch keine Bestellungen/.test(document.getElementById('einkaufsliste-anzeige').textContent));
});
await test('Verwaltung: falsches Passwort, dann Admin-Login', async () => {
  await t.click('#k-zurueck'); await t.click('#t-btn-verwaltung');
  await t.waitForSelector('#v-login:not(.hidden)');
  await t.fill('#v-name', 'admin'); await t.fill('#v-pw', 'falsch'); await klickM(t, '#v-login-btn', 'fehler');
  await t.fill('#v-name', 'admin'); await t.fill('#v-pw', 'admin'); await t.click('#v-login-btn');
  await t.waitForSelector('#v-kategorie:not(.hidden)');
  await t.screenshot({ path: SHOT + '/08-verwaltung.png', fullPage: true });
});
await test('Küchenkonto allein kann nichts verwalten (Rechte in der DB)', async () => {
  const r = await db({ kind: 'rpc', uid: UID.kueche, name: 'guthaben_aufladen', args: { p_person_id: (await q("select id from personen limit 1"))[0].id, p_betrag: 5 } });
  assert.ok(r.error && r.error.code === '42501');
});
await test('Guthaben aufladen (+20 für Anna)', async () => {
  await t.click('[data-vkat="wachabteilung"]');
  const karte = t.locator('.guthaben-verwaltung-karte', { hasText: 'Anna Beispiel' });
  await karte.locator('input').fill('20'); await meldungLeeren(t); await karte.locator('[data-aufladen]').click();
  await t.waitForSelector('#meldung.erfolg', { state: 'visible' });
  await t.waitForFunction(() => /25\.00/.test([...document.querySelectorAll('.guthaben-verwaltung-karte')].find((k) => k.textContent.includes('Anna')).textContent));
  assert.equal((await q("select guthaben::float g from personen where anzeigename='Anna Beispiel'"))[0].g, 25);
});
await test('Preis ändern, Produkt anlegen und löschen', async () => {
  await t.click('[data-v="zurKategorie"]:visible'); await t.click('#v-preise-btn');
  await t.fill('[data-preis="7"]', '0.50'); await klickM(t, '[data-pset="7"]', 'erfolg');
  assert.equal((await q('select preis::float p from produkte where id=7'))[0].p, 0.5);
  await t.fill('#v-neu-name', 'Apfelschorle'); await t.fill('#v-neu-preis', '1.50');
  await t.selectOption('#v-neu-kat', '0'); await t.click('#v-neu-btn');
  await t.waitForFunction(() => document.getElementById('v-preise-liste').textContent.includes('Apfelschorle'));
  const neu = t.locator('.preis-item', { hasText: 'Apfelschorle' });
  await neu.locator('[data-pdel]').click();
  await t.waitForFunction(() => !document.getElementById('v-preise-liste').textContent.includes('Apfelschorle'));
  assert.ok(await t.locator('.preis-item', { hasText: 'Abendessen Normal' }).textContent().then((x) => x.includes('Geschützt')));
});
await test('Design wechseln, Verwaltung verlassen', async () => {
  await t.click('[data-v="zurKategorie"]:visible'); await t.click('[data-design="anthrazit"]');
  assert.equal(await t.evaluate(() => document.documentElement.getAttribute('data-theme')), 'anthrazit');
  await t.screenshot({ path: SHOT + '/09-design-anthrazit.png' });
  await t.click('[data-v="ende"]:visible'); await t.waitForSelector('#startseite:not(.hidden)');
  await t.click('#t-btn-verwaltung'); await t.waitForSelector('#v-login:not(.hidden)');   // Admin-Sitzung wurde beendet
});
await test('Keine JavaScript-Fehler (Tablet)', async () => assert.deepEqual(t.fehler, []));

// ================= Handy-Konto auf dem Tablet-Weg: Rollen =================
console.log('Rollen');
const r = await seite({ width: 390, height: 844 });
await test('Admin-Konto in der Haupt-Anmeldung öffnet das Tablet', async () => {
  await r.goto(BASE + '/'); await login(r, 'admin');
  await r.waitForSelector('#tablet:not(.hidden) #startseite:not(.hidden)');
});
await test('Handy-Ansicht ist auf 390px ohne Seiten-Scrollbalken', async () => {
  const h2 = await seite({ width: 390, height: 844 });
  await h2.goto(BASE + '/'); await login(h2, 'max'); await h2.waitForSelector('#h-guthaben');
  assert.ok(await h2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'horizontaler Überlauf');
});

console.log(`\n${ok} Prüfungen bestanden${process.exitCode ? ' – ES GIBT FEHLER' : ''}. Bilder: ${SHOT}`);
await browser.close(); server.close(); await su.end();
