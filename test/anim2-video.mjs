// Records the normal-speed animations (build + round income floats) of a solo game
// vs 3 AI, and measures float lifetimes / action durations in the page.
//   cp test/anim2-video.mjs /workspace/shottool/ && BASE=http://127.0.0.1:28790/ node /workspace/shottool/anim2-video.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const SHOTS = process.env.SHOTS || '/workspace/shots';
const OUT = '/tmp/anim2vid'; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.evaluateOnNewDocument(() => { localStorage.setItem('bb3d_fx', 'normal'); });
await page.goto(BASE + '?test=1', { waitUntil: 'networkidle0' });
await page.type('#name', '我');
await page.click('[data-solo][data-create="4"]');
await page.waitForFunction(() => window.__bb3d && __bb3d.state, { timeout: 20000 });
await page.evaluate(() => {
    const fx = __bb3d.fx; fx.setMode('normal');
    window.__floats = []; window.__plays = [];
    new MutationObserver(ms => { for (const m of ms) { for (const n of m.addedNodes) if (n.classList && n.classList.contains('fx-float')) n.__t0 = performance.now(); for (const n of m.removedNodes) if (n.__t0) __floats.push({ text: n.textContent, ms: performance.now() - n.__t0, top: parseFloat(n.style.top), left: parseFloat(n.style.left) }); } }).observe(fx.layer, { childList: true });
    const orig = fx.play.bind(fx); fx.play = (plan, boost) => { const t0 = performance.now(); return orig(plan, boost).then(r => { if (plan && !plan.empty) __plays.push({ boost, ms: performance.now() - t0, built: plan.built.length }); return r; }); };
});
// screencast frames with timestamps
const cdp = await page.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', async f => { const i = frames.length; fs.writeFileSync(`${OUT}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64')); frames.push(f.metadata.timestamp); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
const t0 = Date.now();
for (let guard = 0; guard < 30 && Date.now() - t0 < 75000; guard++) {
    await page.waitForFunction(() => __bb3d.myTurn(), { timeout: 60000 });
    const st = await page.evaluate(() => ({ round: __bb3d.state.round }));
    if (st.round >= 3) break;
    await sleep(900);
    const v = await page.evaluate(() => {
        const a = __bb3d, s = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
        const d = AIPlayer.chooseAction(s, new GameLogic(s), a.me, 'normal');
        a.net.send({ t: 'action', version: a.version, ...d }); return a.version;
    });
    await page.waitForFunction(v => __bb3d.version !== v, { timeout: 8000 }, v);
}
await sleep(3500);
await cdp.send('Page.stopScreencast');
const m = await page.evaluate(() => ({ floats: __floats, plays: __plays }));
await browser.close();
// assemble with real frame timing
let list = '';
for (let i = 0; i < frames.length; i++) { const d = i + 1 < frames.length ? frames[i + 1] - frames[i] : 0.1; list += `file '${OUT}/f${String(i).padStart(5, '0')}.jpg'\nduration ${Math.max(0.01, d).toFixed(3)}\n`; }
fs.writeFileSync(`${OUT}/list.txt`, list);
execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i ${OUT}/list.txt -vf "fps=25,scale=1280:-2,format=yuv420p" -c:v libx264 -crf 24 ${SHOTS}/anim2-play.mp4`);
const fl = m.floats.map(f => f.ms), normal = m.plays.filter(p => p.boost === 1), boosted = m.plays.filter(p => p.boost > 1);
const stat = a => a.length ? { n: a.length, min: Math.round(Math.min(...a)), max: Math.round(Math.max(...a)), avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length) } : null;
const res = { frames: frames.length, seconds: Math.round(frames.at(-1) - frames[0]), floats: stat(fl), incomeFloats: m.floats.filter(f => /收入|\+£/.test(f.text)).slice(0, 5), playsNormal: stat(normal.map(p => p.ms)), playsBoosted: stat(boosted.map(p => p.ms)), errors };
console.log(JSON.stringify(res, null, 1));
// overlapping floats alive at the same time near each other
const ok = fl.length > 0 && Math.min(...fl) >= 1500 && (!normal.length || (stat(normal.map(p => p.ms)).min >= 1150 && stat(normal.map(p => p.ms)).max <= 2100)) && (!boosted.length || stat(boosted.map(p => p.ms)).min >= 550) && !errors.length;
console.log(ok ? 'ALL PASSED' : 'FAILED'); process.exit(ok ? 0 : 1);
