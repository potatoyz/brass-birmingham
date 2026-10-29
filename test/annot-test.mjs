// Board annotations: two desktop browsers + one phone (spectator) in one room.
// A pings and draws, B and the phone see it; clear removes it everywhere;
// server limits, reconnect snapshot, no rooms.json / game-state side effects.
// Run (puppeteer-core lives in /workspace/shottool):
//   cp test/annot-test.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ DATA_DIR=/tmp/bbtest-data node /workspace/shottool/annot-test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const DATA_DIR = process.env.DATA_DIR || '';
const SHOTS = process.env.SHOTS || '/workspace/shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launch = () => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args });
const errors = [], results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };

async function mkPage(browser, tag, vp, url) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`); });
    page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: 'networkidle0' });
    return page;
}
const annState = p => p.evaluate(() => {
    const a = __bb3d.annot, c = document.querySelector('#annot-layer');
    return { strokes: [...a.strokes.values()].map(s => ({ seat: s.seat, n: s.pts.length / 2, mine: s.mine, keep: s.keep })), pings: a.pings.map(p => ({ seat: p.seat, name: p.name })), dsStrokes: +c.dataset.strokes, dsPings: +c.dataset.pings };
});
// overlay pixel (canvas px) at a client point: is it close to the given CSS colour?
const pixelAt = (p, x, y) => p.evaluate((x, y) => {
    const c = document.querySelector('#annot-layer'), r = c.getBoundingClientRect(), k = c.width / r.width;
    let best = null;
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        const d = c.getContext('2d').getImageData(Math.round((x - r.left) * k) + dx, Math.round((y - r.top) * k) + dy, 1, 1).data;
        if (!best || d[3] > best[3]) best = [...d];
    }
    return best;
}, x, y);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const near = (px, h, tol = 40) => px && px[3] > 200 && hex(h).every((v, i) => Math.abs(v - px[i]) <= tol);
const uvScreen = (p, u, v) => p.evaluate((u, v) => { const b = __bb3d.board, q = b.uvToScreen(u, v), r = b.renderer.domElement.getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; }, u, v);

const bA = await launch(), bB = await launch(), bM = await launch();
const A = await mkPage(bA, 'A', { width: 1280, height: 800 }, BASE + '?test=1');
await A.type('#name', '甲·Alice');
await A.click('[data-create="2"]:not([data-solo])');
await A.waitForFunction(() => document.querySelector('#lobby-code').textContent.length === 4);
const code = await A.$eval('#lobby-code', e => e.textContent);
const B = await mkPage(bB, 'B', { width: 1280, height: 800 }, `${BASE}?room=${code}&test=1`);
await B.type('#name', '乙·Bob'); await B.click('#join');
await A.waitForFunction(() => !document.querySelector('#lobby-start').disabled);
await A.click('#lobby-start');
for (const p of [A, B]) await p.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelector('#annot-layer'), { timeout: 20000 });
await sleep(1200);
const PC = ['#a46cf5', '#f5c518'];
const v0 = await A.evaluate(() => __bb3d.version);

// ---- 1. ping via tool button
await A.click('#an-ping');
ok('ping tool toggles on', await A.$eval('#an-ping', e => e.classList.contains('on')));
const tgt = await uvScreen(A, 0.5, 0.45);
await A.mouse.click(tgt.x, tgt.y);
await B.waitForFunction(() => __bb3d.annot.pings.length > 0, { timeout: 4000 });
await sleep(350);
let sb = await annState(B);
ok('B sees A ping with seat + name', sb.pings[0].seat === 0 && /Alice/.test(sb.pings[0].name), JSON.stringify(sb.pings[0]));
const bp = await uvScreen(B, 0.5, 0.45);
ok('ping drawn in A colour on B overlay', near(await pixelAt(B, bp.x, bp.y), PC[0]), JSON.stringify(await pixelAt(B, bp.x, bp.y)));
ok('ping-mode tap did not select a board target', await A.evaluate(() => __bb3d.ix.slot == null && __bb3d.ix.mode === 'idle'));
await Promise.all([A.screenshot({ path: `${SHOTS}/annot-ping-A.png` }), B.screenshot({ path: `${SHOTS}/annot-ping-B.png` })]);
await B.waitForFunction(() => __bb3d.annot.pings.length === 0, { timeout: 6000 });
ok('ping disappears after ~4 s', true);
await A.click('#an-ping');   // off

// ---- 2. Alt+click ping without a tool
const alt = await uvScreen(A, 0.3, 0.6);
await A.keyboard.down('Alt'); await A.mouse.click(alt.x, alt.y); await A.keyboard.up('Alt');
await B.waitForFunction(() => __bb3d.annot.pings.length > 0, { timeout: 4000 });
ok('Alt+click sends a ping', true);

// ---- 3. pen stroke
await A.click('#an-pen');
ok('pen tool on + sub tools shown', await A.evaluate(() => document.querySelector('#an-pen').classList.contains('on') && !document.querySelector('#an-clear').hidden));
const pts = [[0.30, 0.30], [0.40, 0.36], [0.50, 0.33], [0.60, 0.42], [0.66, 0.55]];
const sp = [];
for (const [u, v] of pts) sp.push(await uvScreen(A, u, v));
const camBefore = await A.evaluate(() => __bb3d.board.camera.position.toArray());
await A.mouse.move(sp[0].x, sp[0].y); await A.mouse.down();
for (let i = 1; i < sp.length; i++) for (let k = 1; k <= 8; k++) { await A.mouse.move(sp[i - 1].x + (sp[i].x - sp[i - 1].x) * k / 8, sp[i - 1].y + (sp[i].y - sp[i - 1].y) * k / 8); await sleep(12); }
await A.mouse.up();
const camAfter = await A.evaluate(() => __bb3d.board.camera.position.toArray());
ok('pen drag does not pan the camera', camBefore.every((v, i) => Math.abs(v - camAfter[i]) < 1e-6));
await B.waitForFunction(() => [...__bb3d.annot.strokes.values()].some(s => !s.live && s.pts.length > 20), { timeout: 4000 });
sb = await annState(B);
ok('B receives the whole stroke', sb.strokes.length === 1 && sb.strokes[0].seat === 0 && sb.strokes[0].n >= 20, JSON.stringify(sb.strokes));
await sleep(200);
let mid = await uvScreen(B, 0.5, 0.33);
ok('stroke drawn in A colour on B overlay', near(await pixelAt(B, mid.x, mid.y), PC[0]), JSON.stringify(await pixelAt(B, mid.x, mid.y)));
await Promise.all([A.screenshot({ path: `${SHOTS}/annot-pen-A.png` }), B.screenshot({ path: `${SHOTS}/annot-pen-B.png` })]);
// B zooms + pans: stroke must follow the board
await B.evaluate(() => { const b = __bb3d.board; b.zoom(0.6); b.centerOn('slot', [...b.slotMeshes.keys()][5]); });
await sleep(300);
mid = await uvScreen(B, 0.5, 0.33);
ok('stroke follows B camera zoom/pan', near(await pixelAt(B, mid.x, mid.y), PC[0]), JSON.stringify(mid));
await B.screenshot({ path: `${SHOTS}/annot-pen-B-zoomed.png` });
await B.evaluate(() => __bb3d.board.resetView());

// ---- 4. B draws too (own colour), then A clears mine -> only B's stays
await B.click('#an-pen');
const q1 = await uvScreen(B, 0.2, 0.75), q2 = await uvScreen(B, 0.45, 0.8);
await B.mouse.move(q1.x, q1.y); await B.mouse.down();
for (let k = 1; k <= 12; k++) { await B.mouse.move(q1.x + (q2.x - q1.x) * k / 12, q1.y + (q2.y - q1.y) * k / 12); await sleep(12); }
await B.mouse.up();
await A.waitForFunction(() => [...__bb3d.annot.strokes.values()].some(s => s.seat === 1 && !s.live), { timeout: 4000 });
const am = await uvScreen(A, 0.33, 0.775);
ok('A sees B stroke in B colour', near(await pixelAt(A, am.x, am.y), PC[1]), JSON.stringify(await pixelAt(A, am.x, am.y)));
await Promise.all([A.screenshot({ path: `${SHOTS}/annot-both-A.png` }), B.screenshot({ path: `${SHOTS}/annot-both-B.png` })]);
await A.click('#an-clear');
for (const p of [A, B]) await p.waitForFunction(() => [...__bb3d.annot.strokes.values()].every(s => s.seat !== 0), { timeout: 4000 });
sb = await annState(B); let sa = await annState(A);
ok('clear mine: A stroke gone on A and B, B stroke stays', sb.strokes.length === 1 && sb.strokes[0].seat === 1 && sa.strokes.length === 1 && sa.strokes[0].seat === 1, JSON.stringify({ sa: sa.strokes, sb: sb.strokes }));

// ---- 5. phone spectator (touch): sees B stroke from snapshot, draws one in neutral colour
const M = await mkPage(bM, 'M', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, `${BASE}?room=${code}&test=1`);
await M.type('#name', '丙·手机'); await M.tap('#join');
await M.waitForFunction(() => window.__bb3d && __bb3d.state && document.querySelector('#annot-layer'), { timeout: 20000 });
await M.waitForFunction(() => __bb3d.annot.strokes.size === 1, { timeout: 4000 });
ok('late joiner (phone) gets existing stroke snapshot', true);
await sleep(800);
await M.tap('#an-pen');
const m1 = await uvScreen(M, 0.35, 0.5), m2 = await uvScreen(M, 0.65, 0.58);
const mcam0 = await M.evaluate(() => __bb3d.board.camera.position.toArray());
await M.touchscreen.touchStart(m1.x, m1.y);
for (let k = 1; k <= 12; k++) { await M.touchscreen.touchMove(m1.x + (m2.x - m1.x) * k / 12, m1.y + (m2.y - m1.y) * k / 12); await sleep(16); }
await M.touchscreen.touchEnd();
const mcam1 = await M.evaluate(() => __bb3d.board.camera.position.toArray());
ok('phone: one-finger drag in pen mode draws, camera does not move', mcam0.every((v, i) => Math.abs(v - mcam1[i]) < 1e-6));
await A.waitForFunction(() => [...__bb3d.annot.strokes.values()].some(s => s.seat === -1 && !s.live && s.pts.length >= 12), { timeout: 4000 });
const amid = await uvScreen(A, 0.5, 0.54);
ok('A sees phone (spectator) stroke in neutral colour', near(await pixelAt(A, amid.x, amid.y), '#d8dee8'), JSON.stringify(await pixelAt(A, amid.x, amid.y)));
await M.screenshot({ path: `${SHOTS}/annot-mobile.png` });
await A.screenshot({ path: `${SHOTS}/annot-mobile-seen-by-A.png` });
// pen off -> one finger pans again
await M.tap('#an-pen');
await M.touchscreen.touchStart(m1.x, m1.y);
for (let k = 1; k <= 8; k++) { await M.touchscreen.touchMove(m1.x + 60 * k / 8, m1.y + 40 * k / 8); await sleep(16); }
await M.touchscreen.touchEnd();
const mcam2 = await M.evaluate(() => __bb3d.board.camera.position.toArray());
ok('phone: pen off -> one-finger drag pans camera again', mcam2.some((v, i) => Math.abs(v - mcam1[i]) > 1e-3));

// ---- 6. clear all (from A) removes everyone's
await A.evaluate(() => { window.confirm = () => true; });
await A.click('#an-clear-all');
for (const p of [A, B, M]) await p.waitForFunction(() => __bb3d.annot.strokes.size === 0 && document.querySelector('#annot-layer').dataset.strokes === '0', { timeout: 4000 });
ok('clear all: 0 strokes on A, B and phone', true);

// ---- 7. reconnect: keep stroke survives a reload of B
await A.click('#an-keep');
ok('keep toggle on', await A.evaluate(() => __bb3d.annot.keep));
await A.mouse.move(sp[0].x, sp[0].y); await A.mouse.down();
for (let k = 1; k <= 10; k++) { await A.mouse.move(sp[0].x + 120 * k / 10, sp[0].y + 50 * k / 10); await sleep(12); }
await A.mouse.up();
await B.waitForFunction(() => __bb3d.annot.strokes.size === 1, { timeout: 4000 });
await B.reload({ waitUntil: 'networkidle0' });
await B.waitForFunction(() => window.__bb3d && __bb3d.state && __bb3d.annot.strokes.size === 1, { timeout: 20000 });
sb = await annState(B);
ok('B reload: gets the unexpired stroke back (keep=true)', sb.strokes[0].keep === true && sb.strokes[0].seat === 0, JSON.stringify(sb.strokes));

// ---- 8. server limits
await B.evaluate(() => { window.__pc = 0; const o = __bb3d.annot.onPing; __bb3d.annot.onPing = m => { window.__pc++; o && o(m); }; });
await A.evaluate(() => { for (let i = 0; i < 200; i++) __bb3d.net.send({ t: 'annot', op: 'ping', u: 0.5, v: 0.5 }); });
await sleep(1500);
const pc = await B.evaluate(() => window.__pc);
ok('ping flood: 200 sent, ≤ 5 delivered', pc >= 1 && pc <= 5, `delivered ${pc}`);
await A.evaluate(() => { const pts = []; for (let i = 0; i < 4000; i++) pts.push(Math.random(), Math.random()); for (let j = 0; j < 20; j++) __bb3d.net.send({ t: 'annot', op: 'stroke', id: 'big', pts: pts.slice(j * 320, j * 320 + 320) }); __bb3d.net.send({ t: 'annot', op: 'stroke', id: 'bad', pts: ['x', null, 1e9, -1e9, 0.5] }); });
await sleep(1200);
const big = await B.evaluate(() => [...__bb3d.annot.strokes.values()].map(s => ({ n: s.pts.length / 2, max: Math.max(...s.pts), min: Math.min(...s.pts) })));
ok('oversized stroke capped at 600 points, coords clamped', big.every(s => s.n <= 600 && s.max <= 1.05 && s.min >= -0.05), JSON.stringify(big));
ok('annotations did not bump game version', (await A.evaluate(() => __bb3d.version)) === v0 && (await B.evaluate(() => __bb3d.version)) === v0);
if (DATA_DIR) {
    await sleep(600);
    const raw = fs.readFileSync(`${DATA_DIR}/rooms.json`, 'utf8');
    ok('rooms.json has no annotation data', !/"pts"|annot|"strokes"/.test(raw), `${raw.length} bytes`);
}
ok('no console / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await Promise.all([bA.close(), bB.close(), bM.close()]);
const fail = results.filter(r => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed`);
process.exit(fail.length ? 1 : 0);
