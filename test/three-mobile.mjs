import puppeteer from 'puppeteer-core';
const BASE = 'http://127.0.0.1:28790/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '?test=1', { waitUntil: 'networkidle0' });
await page.screenshot({ path: '/workspace/shots/three-mobile-home.png' });
await page.type('#name', '手机');
await page.tap('[data-solo][data-create="2"]');
await page.waitForFunction(() => window.__bb3d && window.__bb3d.myTurn && window.__bb3d.myTurn(), { timeout: 30000 });
await sleep(1500);
await page.screenshot({ path: '/workspace/shots/three-mobile-game.png' });
// pick the AI's suggested build through taps
const plan = await page.evaluate(() => {
  const a = __bb3d, st = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
  const L = new GameLogic(st); const t = L.getValidBuildTargets(a.me)[0];
  return { key: `${t.cityId}_${t.slotIndex}`, ind: t.industryType, card: L.getValidCardsForAction(a.me, 'build', t)[0] };
});
await page.tap(`#hand .card[data-i="${plan.card}"]`); await sleep(300);
const pt = await page.evaluate(k => { const b = __bb3d.board; let p = b.screenOf('slot', k);
  if (!p || document.elementFromPoint(p.x, p.y) !== b.renderer.domElement) { b.centerOn('slot', k); p = b.screenOf('slot', k); } return p; }, plan.key);
await page.touchscreen.tap(pt.x, pt.y); await sleep(300);
if (await page.$(`#panel [data-ind="${plan.ind}"]:not(.on)`)) await page.tap(`#panel [data-ind="${plan.ind}"]`);
await sleep(300);
await page.screenshot({ path: '/workspace/shots/three-mobile-build.png' });
const v0 = await page.evaluate(() => __bb3d.version);
await page.tap('#panel [data-b="ok"]');
await page.waitForFunction(v0 => __bb3d.version !== v0, { timeout: 8000 }, v0);
await sleep(800);
await page.tap('#btn-panels'); await sleep(300);
await page.screenshot({ path: '/workspace/shots/three-mobile-info.png' });
console.log('mobile build ok', JSON.stringify(plan), errs.length ? errs : 'no console errors');
await browser.close();
