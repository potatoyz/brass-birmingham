// Side info panels (this round / next-round order / persistent log) at three
// sizes. Plays a solo game vs 3 AI until round 2 with mixed turn status, then
// checks the panels against the rules engine and takes screenshots.
//   cp test/ui3-info.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ node /workspace/shottool/ui3-info.mjs
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
await page.evaluate(() => { __bb3d.fx.speed = 0; });
// play my turns with the AI's choice until round 2 and I am not first
for (let guard = 0; guard < 60; guard++) {
    await page.waitForFunction(() => __bb3d.myTurn(), { timeout: 30000 });
    const st = await page.evaluate(() => ({ round: __bb3d.state.round, ci: __bb3d.state.currentPlayerIndex, acts: __bb3d.state.actionsThisTurn }));
    if (st.round >= 2 && st.ci >= 1 && st.acts === 0) break;
    const v = await page.evaluate(() => {
        const a = __bb3d, s = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
        const d = AIPlayer.chooseAction(s, new GameLogic(s), a.me, 'normal');
        a.net.send({ t: 'action', version: a.version, ...d }); return a.version;
    });
    await page.waitForFunction(v => __bb3d.version !== v, { timeout: 8000 }, v);
    await sleep(200);
}
await sleep(800);
const check = () => page.evaluate(() => {
    const a = __bb3d, s = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
    const spent = s.turnOrder.map(p => s.moneySpentThisRound[p] || 0);
    s.endRound();                                   // the real rule decides the next order
    const r = a.board.boardRect(), L = document.querySelector('#info-l'), R = document.querySelector('#info-r');
    const lr = L.getBoundingClientRect(), rr = R.getBoundingClientRect();
    const rows = [...document.querySelectorAll('#round-box .ir')].map(e => +e.dataset.pid);
    const nrows = [...document.querySelectorAll('#next-box .nr')].map(e => +e.dataset.pid);
    const fs = [...document.querySelectorAll('#info-l *, #info-r *, .opp *')].filter(e => !e.closest('.ob') && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent)
        .map(e => parseFloat(getComputedStyle(e).fontSize));
    return {
        wide: document.body.classList.contains('wide-info'), order: a.roundInfo.order, next: a.roundInfo.next, engineNext: s.turnOrder, spent, uiSpent: a.roundInfo.spent,
        status: a.roundInfo.status, rows, nrows, board: r, lr: { l: lr.left, r: lr.right, t: lr.top, b: lr.bottom }, rr: { l: rr.left, r: rr.right },
        logTs: document.querySelectorAll('#log .le time').length, logN: (a.msg.log || []).length, dockN: document.querySelectorAll('#log-dock .le').length,
        firstLogNewest: (a.msg.log[0] || {}).ts >= (a.msg.log[a.msg.log.length - 1] || {}).ts,
        oppIdx: document.querySelectorAll('.opp .oi').length, oppIdxVisible: [...document.querySelectorAll('.opp .oi')].some(e => e.offsetParent),
        minFont: Math.min(...fs),
    };
});
let c = await check();
console.log(JSON.stringify(c));
ok('1920: wide side panels on', c.wide);
ok('next-round order == engine endRound()', JSON.stringify(c.next) === JSON.stringify(c.engineNext), `${c.next} vs ${c.engineNext}, spent ${c.spent}`);
ok('round panel lists current turn order', JSON.stringify(c.rows) === JSON.stringify(c.order));
ok('next panel lists predicted order', JSON.stringify(c.nrows) === JSON.stringify(c.next));
ok('status mix done/cur/wait', c.status.includes('done') && c.status.includes('cur'), c.status.join(','));
ok('panels sit beside the board without covering it', c.lr.r <= c.board.left + 1 && c.rr.l >= c.board.right - 1 && c.board.left - c.lr.r < 40 && c.rr.l - c.board.right < 40, JSON.stringify({ lr: c.lr, rr: c.rr, b: c.board }));
ok('persistent log docked with timestamps, newest first', c.dockN > 3 && c.logTs >= c.dockN && c.firstLogNewest);
ok('font size ≥ 14px in panels and chips (excl. colour-badge glyphs)', c.minFont >= 14, `min ${c.minFont}`);
await page.screenshot({ path: `${SHOTS}/ui3-1920.png` });

await page.setViewport({ width: 1280, height: 800 }); await sleep(900);
c = await check();
ok('1280: falls back to compact (no side panels)', !c.wide);
ok('1280: opponent chips show order index + spent', c.oppIdxVisible);
await page.screenshot({ path: `${SHOTS}/ui3-1280.png` });
await page.click('#btn-log'); await sleep(300);
await page.screenshot({ path: `${SHOTS}/ui3-1280-log.png` });
await page.click('#btn-log');

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(900);
c = await check();
ok('phone: compact, order index visible', !c.wide && c.oppIdxVisible);
ok('font size ≥ 14px (phone)', c.minFont >= 14, `min ${c.minFont}`);
await page.screenshot({ path: `${SHOTS}/ui3-mobile.png` });
ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const fail = results.filter(r => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);
