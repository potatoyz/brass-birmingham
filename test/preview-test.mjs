// Card / tile hover preview must always sit fully inside the viewport and never
// cover the hand. Repro of "preview slides off the bottom": the box was measured
// before its <img> loaded, so it grew downward past the viewport afterwards.
//   cp test/preview-test.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ node /workspace/shottool/preview-test.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const SHOTS = process.env.SHOTS || '/workspace/shots';
const TAG = process.env.TAG || 'after';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [], results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(BASE + '?test=1', { waitUntil: 'networkidle0' });
await page.type('#name', '我');
await page.click('[data-solo][data-create="4"]');
await page.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelectorAll('#hand .card').length, { timeout: 20000 });
await sleep(1000);
const cdp = await page.target().createCDPSession();
const inspect = () => page.evaluate(() => {
    const pv = document.querySelector('#preview'), r = pv.getBoundingClientRect(), img = pv.querySelector('img');
    const hand = [...document.querySelectorAll('#hand .card')].map(c => c.getBoundingClientRect());
    const over = hand.some(h => !(r.right <= h.left || r.left >= h.right || r.bottom <= h.top || r.top >= h.bottom));
    return { shown: !pv.hidden, l: r.left, t: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, imgDone: img ? img.complete : true, coversHand: over };
});
const inside = s => s.shown && s.l >= 0 && s.t >= 0 && s.r <= s.vw + 0.5 && s.b <= s.vh + 0.5;
const sizes = [
    ['1920', { width: 1920, height: 1080 }], ['1280', { width: 1280, height: 800 }], ['1366x650', { width: 1366, height: 650 }],
    ['1024x600', { width: 1024, height: 600 }], ['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
let shot = false;
for (const [tag, vp] of sizes) {
    await page.setViewport(vp); await sleep(700);
    // isMobile changes reload the page: wait for the rejoin (slow over a real network)
    await page.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelectorAll('#hand .card').length > 0, { timeout: 30000 }); await sleep(300);
    const touch = !!vp.hasTouch;
    let bad = 0, n = 0, worst = null;
    for (let round = 0; round < 3; round++) {
        // fresh image fetches each round (cold cache, slow network) = the "sometimes" case
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 250, downloadThroughput: 400 * 1024, uploadThroughput: 400 * 1024 });
        const cards = await page.$$('#hand .card');
        for (let i = 0; i < cards.length; i++) {
            const b = await cards[i].boundingBox(); if (!b) continue;
            if (touch) {
                await page.evaluate(i => { const el = document.querySelectorAll('#hand .card')[i]; const t = new Touch({ identifier: 1, target: el, clientX: 1, clientY: 1 }); el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], bubbles: true })); }, i);
                await sleep(500);
            } else if (round === 2) { await page.mouse.move(b.x + b.width / 2, b.y + 10, { steps: 2 }); await sleep(30); }   // fast sweep
            else { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }); await sleep(120); }
            // let the image finish, then check where the box ended up
            await page.waitForFunction(() => { const i = document.querySelector('#preview img'); return !i || i.complete; }, { timeout: 15000 }).catch(() => {});
            await sleep(80);
            const s = await inspect(); n++;
            if (!inside(s) || s.coversHand) { bad++; worst = worst || s; if (!shot) { shot = true; await page.screenshot({ path: `${SHOTS}/preview-${TAG}-${tag}-broken.png` }); } }
            if (touch) await page.evaluate(i => { const el = document.querySelectorAll('#hand .card')[i]; el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true })); }, i);
        }
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    }
    // hover while a board animation plays
    if (!touch) {
        await page.evaluate(() => __bb3d.board && __bb3d.board.resetView && __bb3d.board.resetView());
        const b = await (await page.$('#hand .card')).boundingBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await sleep(400);
        const s = await inspect(); n++; if (!inside(s) || s.coversHand) { bad++; worst = worst || s; }
    }
    // final screenshot with the last preview visible
    const cards = await page.$$('#hand .card'); const b = await cards[Math.min(4, cards.length - 1)].boundingBox();
    if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
    else await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(touch ? 700 : 400);
    await page.screenshot({ path: `${SHOTS}/preview-${TAG}-${tag}.png` });
    if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    ok(`${tag}: preview fully inside viewport & off the hand (${n} hovers)`, bad === 0, worst ? `${bad} bad, e.g. ${JSON.stringify(worst)}` : '');
    await page.mouse.move(5, 300); await sleep(200);
}
// the preview never eats clicks on the hand
await page.setViewport({ width: 1280, height: 800 }); await sleep(600);
// leaving phone emulation reloads the page (isMobile change): wait for the rejoin
await page.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelector('#hand .card'), { timeout: 30000 }); await sleep(300);
const pe = await page.$eval('#preview', e => getComputedStyle(e).pointerEvents);
ok('preview has pointer-events:none', pe === 'none');
const c0 = await (await page.$('#hand .card')).boundingBox();
await page.mouse.click(c0.x + c0.width / 2, c0.y + c0.height / 2); await sleep(300);
ok('click on hovered card still selects it', await page.evaluate(() => !!document.querySelector('#hand .card.sel')));
ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const fail = results.filter(r => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);
