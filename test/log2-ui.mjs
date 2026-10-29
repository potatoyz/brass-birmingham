// Detailed log UI: plays a solo game vs 3 AI for a few rounds, then checks the
// docked log (1920) and the popup log (1280 / phone) render the server's
// structured details (money chips, resource sources, flips, income) and screenshots.
//   cp test/log2-ui.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ node /workspace/shottool/log2-ui.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const SHOTS = process.env.SHOTS || '/workspace/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [], results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE + '?test=1', { waitUntil: 'networkidle0' });
await page.type('#name', '我');
await page.click('[data-solo][data-create="4"]');
await page.waitForFunction(() => window.__bb3d && __bb3d.state, { timeout: 20000 });
await page.evaluate(() => { __bb3d.fx.speed = 0; if (__bb3d.fx.mode !== undefined) __bb3d.fx.mode = 'off'; });
for (let guard = 0; guard < 80; guard++) {
    await page.waitForFunction(() => __bb3d.myTurn(), { timeout: 60000 });
    const st = await page.evaluate(() => ({ round: __bb3d.state.round, acts: __bb3d.state.actionsThisTurn, n: (__bb3d.msg.log || []).filter(e => e.d && (e.d.res || e.d.flips)).length }));
    if (st.round >= 4 && st.acts === 0 && st.n >= 3) break;
    const v = await page.evaluate(() => {
        const a = __bb3d, s = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
        const d = AIPlayer.chooseAction(s, new GameLogic(s), a.me, 'normal');
        a.net.send({ t: 'action', version: a.version, ...d }); return a.version;
    });
    await page.waitForFunction(v => __bb3d.version !== v, { timeout: 8000 }, v);
}
await sleep(600);
const info = await page.evaluate(() => {
    const L = __bb3d.msg.log, dock = document.querySelector('#log-dock');
    const withD = L.filter(e => e.d);
    const rows = [...dock.querySelectorAll('.le')];
    const fs = [...dock.querySelectorAll('.ld .dx, .lm span')].map(e => parseFloat(getComputedStyle(e).fontSize));
    return {
        withD: withD.length, acts: [...new Set(withD.map(e => e.d.act))],
        hasDetailRows: dock.querySelectorAll('.le .ld').length, costChips: dock.querySelectorAll('b.cost').length, gainChips: dock.querySelectorAll('b.gain').length,
        resRows: [...dock.querySelectorAll('.ld .dx')].filter(e => e.textContent.includes('←')).length,
        sample: rows.filter(r => r.querySelector('.ld')).slice(0, 4).map(r => r.innerText.replace(/\s+/g, ' ')),
        incomeRound: L.some(e => e.type === 'income' && e.d && e.d.income), minFont: Math.min(...fs),
        costColor: (() => { const b = dock.querySelector('b.cost'); return b && getComputedStyle(b).color; })(),
        gainColor: (() => { const b = dock.querySelector('b.gain'); return b && getComputedStyle(b).color; })(),
    };
});
console.log(JSON.stringify(info, null, 1));
ok('server sent structured details', info.withD >= 5, info.acts.join(','));
ok('dock shows detail lines', info.hasDetailRows >= 5);
ok('resource sources shown (x←from)', info.resRows >= 1);
ok('spend red / gain green chips', info.costChips > 0 && info.gainChips > 0 && info.costColor !== info.gainColor, `${info.costColor} / ${info.gainColor}`);
ok('round income entry with per-player amounts', info.incomeRound);
ok('detail font ≥ 14px', info.minFont >= 14, `min ${info.minFont}`);
// click folds / unfolds
const folded = await page.evaluate(() => { const le = document.querySelector('#log-dock .le.has-d'); le.click(); const a = le.classList.contains('fold') && getComputedStyle(le.querySelector('.ld')).display === 'none'; le.click(); return a && !le.classList.contains('fold'); });
ok('click toggles detail fold', folded);
await page.screenshot({ path: `${SHOTS}/log2-1920.png` });
const dockEl = await page.$('#log-dock'); await dockEl.screenshot({ path: `${SHOTS}/log2-dock-zoom.png` });
await page.setViewport({ width: 1280, height: 800 }); await sleep(800);
await page.click('#btn-log'); await sleep(400);
ok('popup log shows details', await page.evaluate(() => document.querySelectorAll('#log .le .ld').length >= 5));
await page.screenshot({ path: `${SHOTS}/log2-1280-popup.png` });
await page.click('#btn-log'); await sleep(200);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(800);
await page.evaluate(() => document.body.classList.add('show-log')); await sleep(400);
ok('phone popup shows details', await page.evaluate(() => document.querySelectorAll('#log .le .ld').length >= 5));
await page.screenshot({ path: `${SHOTS}/log2-mobile.png` });
ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const fail = results.filter(r => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);
