// Brewery output shown by era: the industry mat / full industry board / build
// preview say "产出 1 桶啤酒" in the Canal Era and "产出 2 桶啤酒" in the Rail Era
// (engine rule), built breweries show "运河 1 / 铁路 2". Screenshots beer-*.png.
//   cp test/beer-ui.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ node /workspace/shottool/beer-ui.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const SHOTS = process.env.SHOTS || '/workspace/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [], results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE + '?test=1', { waitUntil: 'networkidle0' });
await page.type('#name', '我');
await page.click('[data-solo][data-create="2"]');
await page.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelector('#mat .mtile[data-type="brewery"]'), { timeout: 20000 });
await page.evaluate(() => { __bb3d.fx.setMode('off'); });
const matInfo = () => page.$eval('#mat .mtile[data-type="brewery"]', e => e.dataset.info);
const hoverShot = async (sel, file) => {
    const el = await page.$(sel); await el.evaluate(e => e.scrollIntoView({ block: 'center' })); await sleep(300); const b = await el.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await sleep(900);
    const txt = await page.evaluate(() => { const p = document.querySelector('#preview'); return p && getComputedStyle(p).display !== 'none' ? p.innerText : ''; });
    await page.screenshot({ path: `${SHOTS}/${file}` });
    await page.mouse.move(5, 300); await sleep(200);
    return txt;
};
const canal = await matInfo();
ok('canal era mat: 产出 1 桶啤酒', /产出 1 桶啤酒/.test(canal), canal.split('\n')[0]);
ok('canal hover preview shows 1 barrel', /产出 1 桶啤酒/.test(await hoverShot('#mat .mtile[data-type="brewery"]', 'beer-canal-mat.png')));
// play (my turns via the engine's AI) until the Rail Era
for (let guard = 0; guard < 200; guard++) {
    if (await page.evaluate(() => __bb3d.state.era === 'rail')) break;
    await page.waitForFunction(() => __bb3d.myTurn() || __bb3d.state.era === 'rail', { timeout: 60000 });
    if (await page.evaluate(() => __bb3d.state.era === 'rail')) break;
    const v = await page.evaluate(() => {
        const a = __bb3d, s = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
        const d = AIPlayer.chooseAction(s, new GameLogic(s), a.me, 'normal');
        a.net.send({ t: 'action', version: a.version, ...d }); return a.version;
    });
    await page.waitForFunction(v => __bb3d.version !== v, { timeout: 8000 }, v);
}
await page.waitForFunction(() => __bb3d.state.era === 'rail' && __bb3d.myTurn(), { timeout: 60000 });
// dismiss the Canal-Era scoring dialog
await sleep(600);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => /继续/.test(b.textContent) && b.offsetParent); if (b) b.click(); });
await sleep(800);
const rail = await page.$('#mat .mtile[data-type="brewery"]') ? await matInfo() : '';
ok('rail era mat: 产出 2 桶啤酒', /产出 2 桶啤酒/.test(rail), rail.split('\n')[0]);
if (rail) ok('rail hover preview shows 2 barrels', /产出 2 桶啤酒/.test(await hoverShot('#mat .mtile[data-type="brewery"]', 'beer-rail-mat.png')));
// full industry board
await page.evaluate(() => __bb3d.openBoardModal(__bb3d.me)); await sleep(600);
const bts = await page.$$eval('.bt[data-info]', els => els.filter(e => /酿酒厂/.test(e.dataset.cap)).map(e => e.dataset.info.split('\n')[0]));
ok('full board: every brewery level says 2 barrels', bts.length >= 3 && bts.every(t => /产出 2 桶啤酒/.test(t)), `${bts.length} levels`);
const bsel = await page.evaluate(() => { const el = [...document.querySelectorAll('.bt[data-info]')].find(e => /酿酒厂/.test(e.dataset.cap) && !e.classList.contains('out')); if (!el) return null; el.id = 'bt-beer'; return '#bt-beer'; });
if (bsel) await hoverShot(bsel, 'beer-rail-board.png');
await page.evaluate(() => { const c = document.querySelector('#modal [data-close], .modal [data-close]'); if (c) c.click(); else document.body.click(); }); await sleep(400);
// engine: every rail-era brewery on the board was built with 2 (check via server log details)
const built = await page.evaluate(() => {
    const s = __bb3d.state, out = [];
    for (const [k, t] of Object.entries({ ...s.boardIndustries, ...(s.breweryFarmTiles || {}) })) if (t && t.type === 'brewery') out.push({ k, lv: t.tileData.level, cubes: t.resourceCubes, flipped: t.flipped, dataCubes: t.tileData.resourceCubes });
    return out;
});
console.log('breweries on board', JSON.stringify(built));
ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const fail = results.filter(r => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);
