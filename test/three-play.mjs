// Two real browsers play a full 2-player game through the 3D UI (clicks only).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://127.0.0.1:28790/';
const SHOTS = '/workspace/shots';
const MAX_ACTIONS = +(process.env.MAX_ACTIONS || 400);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launch = () => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args });

const errors = [];
const stats = { actions: {}, flows: {}, failures: [], shots: [] };
const shotOnce = new Set();
async function shot(page, name, force) {
    if (shotOnce.has(name) && !force) return;
    shotOnce.add(name);
    const p = `${SHOTS}/three-${name}.png`;
    await page.screenshot({ path: p }); stats.shots.push(p);
}

async function mkPage(browser, tag, w, h, url) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] console.error: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: 'networkidle0' });
    page.tag = tag;
    return page;
}

const bA = await launch(), bB = await launch();
const A = await mkPage(bA, 'A', 1280, 800, BASE + '?test=1');
await A.type('#name', '甲·Alice');
await A.click('[data-create="2"]:not([data-solo])');
await A.waitForFunction(() => document.querySelector('#lobby').classList.contains('active') && document.querySelector('#lobby-code').textContent.length === 4);
const code = await A.$eval('#lobby-code', e => e.textContent);
console.log('room', code);
const B = await mkPage(bB, 'B', 1920, 1080, `${BASE}?room=${code}&test=1&low=1`);
await B.type('#name', '乙·Bob');
await B.click('#join');
await A.waitForFunction(() => !document.querySelector('#lobby-start').disabled);
await shot(A, 'lobby');
await A.click('#lobby-start');
for (const p of [A, B]) await p.waitForFunction(() => window.__bb3d && window.__bb3d.state, { timeout: 20000 });
await sleep(1500);
await shot(A, 'start-1280');
await shot(B, 'start-1920');

// ------------------------------------------------------------------ helpers
async function clickSel(page, sel) {
    await page.waitForSelector(sel, { visible: true, timeout: 4000 });
    await page.click(sel);
    await sleep(60);
}
async function clickBoard(page, kind, id) {
    for (let tries = 0; tries < 3; tries++) {
        const pt = await page.evaluate((kind, id) => {
            const b = window.__bb3d.board;
            const ok = p => p && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight && document.elementFromPoint(p.x, p.y) === b.renderer.domElement;
            let p = b.screenOf(kind, id);
            if (!ok(p)) { b.centerOn(kind, id); p = b.screenOf(kind, id); }
            return ok(p) ? p : null;
        }, kind, id);
        if (pt) { await page.mouse.click(pt.x, pt.y); await sleep(80); return true; }
        await sleep(100);
    }
    throw new Error(`cannot reach ${kind} ${id} on screen`);
}
const ix = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__bb3d.ix)));
async function clickCard(page, i) { await clickSel(page, `#hand .card[data-i="${i}"]`); }
async function ensureCard(page, i) { const s = await ix(page); if (s.card !== i) await clickCard(page, i); }

// ------------------------------------------------------------------ deciding (inside the page)
async function decide(page, done) {
    return page.evaluate((done) => {
        const a = window.__bb3d, me = a.me;
        const st = Object.assign(Object.create(GameState.prototype), JSON.parse(JSON.stringify(a.msg.game)));
        const L = new GameLogic(st);
        const ok = x => !L.getDisabledReason(x, me);
        const s = st;
        if (!done.scout && s.round >= 2 && ok('scout')) return { action: 'scout', cards: [0, 1, 2] };
        if (!done.develop && s.round >= 2 && ok('develop')) {
            const t = L.getDevelopableTypes(me).map(x => x.type);
            const iron = s.findIronSource(me).length;
            return { action: 'develop', cardIndex: 0, pd: { industryType1: t[0], industryType2: iron >= 2 && t[1] ? t[1] : null } };
        }
        if (!done.loan && s.round >= 3 && ok('loan')) return { action: 'loan', cardIndex: 0 };
        if (!done.pass && s.round >= 4 && ok('pass')) return { action: 'pass', cardIndex: s.players[me].hand.length - 1 };
        if (s.era === 'rail' && !done.double && ok('network')) {
            for (const t of L.getValidNetworkTargets(me)) {
                const sec = L.getValidSecondRailLinks(me, t.connectionId);
                if (sec.length) return { action: 'network', cardIndex: 0, pd: { connectionId: t.connectionId, connectionId2: sec[0].connectionId }, double: true };
            }
        }
        const c = AIPlayer.chooseAction(st, L, me, 'normal');
        if (!c) return { action: 'pass', cardIndex: 0 };
        return { action: c.action, cardIndex: c.cardIndex, pd: c.pendingData, cards: c.action === 'scout' ? [c.cardIndex, ...c.pendingData.scoutCards] : null };
    }, done);
}

// ------------------------------------------------------------------ doing (clicks only)
let flip = 0;
async function perform(page, plan) {
    const { action, cardIndex, pd } = plan;
    if (action === 'build') {
        const key = `${pd.cityId}_${pd.slotIndex}`;
        const cardFirst = (flip++ % 2) === 0;
        stats.flows[cardFirst ? 'build:card→slot' : 'build:slot→card'] = (stats.flows[cardFirst ? 'build:card→slot' : 'build:slot→card'] || 0) + 1;
        if (cardFirst) { await clickCard(page, cardIndex); await sleep(150); await shot(page, 'build-highlight'); }
        await clickBoard(page, 'slot', key);
        if (await page.$(`#panel [data-ind="${pd.industryType}"]:not(.on)`)) await clickSel(page, `#panel [data-ind="${pd.industryType}"]`);
        await ensureCard(page, cardIndex);
        await shot(page, 'build-panel');
    } else if (action === 'network') {
        await clickSel(page, '#actions [data-a="network"]');
        await clickBoard(page, 'link', pd.connectionId);
        if (pd.connectionId2) { await sleep(120); await shot(page, 'network-second'); await clickBoard(page, 'link', pd.connectionId2); }
        await clickCard(page, cardIndex);
        await shot(page, pd.connectionId2 ? 'network-double' : 'network');
    } else if (action === 'sell') {
        await clickSel(page, '#actions [data-a="sell"]');
        await sleep(100); await shot(page, 'sell-highlight');
        for (const e of pd.sellPlan) {
            await clickBoard(page, 'tile', e.key);
            const cb = await page.$(`#panel [data-mb="${e.key}"]`);
            if (cb && !e.useMerchantBeer && await cb.evaluate(c => c.checked)) await cb.click();
        }
        await clickCard(page, cardIndex);
        await shot(page, 'sell-panel');
    } else if (action === 'develop') {
        await clickSel(page, '#actions [data-a="develop"]');
        await clickSel(page, `#mat .mtile[data-type="${pd.industryType1}"]`);
        if (pd.industryType2) await clickSel(page, `#mat .mtile[data-type="${pd.industryType2}"]`);
        await clickCard(page, cardIndex);
        await shot(page, 'develop');
    } else if (action === 'scout') {
        await clickSel(page, '#actions [data-a="scout"]');
        for (const i of plan.cards) await clickCard(page, i);
        await shot(page, 'scout');
    } else {
        await clickSel(page, `#actions [data-a="${action}"]`);
        await clickCard(page, cardIndex);
        await shot(page, action);
    }
    const okBtn = await page.$('#panel [data-b="ok"]');
    if (!okBtn || await okBtn.evaluate(b => b.disabled)) throw new Error('confirm disabled: ' + (await page.$eval('#panel', e => e.innerText)).replace(/\n/g, ' | '));
    const v0 = await page.evaluate(() => window.__bb3d.version);
    await okBtn.click();
    await page.waitForFunction(v0 => window.__bb3d.version !== v0 || !window.__bb3d.busy, { timeout: 8000 }, v0);
    const v1 = await page.evaluate(() => window.__bb3d.version);
    if (v1 === v0) throw new Error('server rejected: ' + await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' / ')));
}

// ------------------------------------------------------------------ main loop
const done = {};
let n = 0, lastEra = 'canal', idle = 0;
const t0 = Date.now();
while (n < MAX_ACTIONS) {
    let acted = false;
    for (const page of [A, B]) {
        const s = await page.evaluate(() => {
            const a = window.__bb3d;
            return { status: a.msg.room.status, myTurn: a.myTurn(), modal: !document.querySelector('#modal').hidden,
                bonus: !!document.querySelector('#modal-body [data-bt]'), era: a.state.era, round: a.state.round };
        });
        if (s.status === 'ended') {
            await sleep(500); await shot(page, `gameover-${page.tag}`);
            continue;
        }
        if (s.modal) {
            if (s.bonus) { await shot(page, 'bonus'); await page.click('#modal-body [data-bt]'); stats.actions.bonus = (stats.actions.bonus || 0) + 1; }
            else { await shot(page, `modal-${s.era}`); const x = await page.$('#modal-body [data-x]'); if (x) await x.click(); else await page.click('#modal-close'); }
            acted = true; await sleep(150); continue;
        }
        if (s.era !== lastEra) { lastEra = s.era; await sleep(400); await shot(page, 'rail-start'); }
        if (!s.myTurn) continue;
        const plan = await decide(page, done);
        try {
            await perform(page, plan);
            stats.actions[plan.action] = (stats.actions[plan.action] || 0) + 1;
            done[plan.action] = true; if (plan.double) { done.double = true; stats.actions.doubleRail = 1; }
        } catch (e) {
            stats.failures.push({ page: page.tag, plan, err: e.message });
            console.log('FAIL', page.tag, JSON.stringify(plan), e.message);
            await shot(page, `fail-${stats.failures.length}`, true);
            await page.evaluate(() => window.__bb3d.cancel());
            // keep the game going: send the same move directly
            await page.evaluate(p => { const a = window.__bb3d; a.net.send({ t: 'action', version: a.version, action: p.action, cardIndex: p.cards ? p.cards[0] : p.cardIndex, pendingData: p.cards ? { scoutCards: p.cards.slice(1) } : (p.pd || {}) }); }, plan);
            await sleep(800);
        }
        n++; acted = true;
        if (n % 20 === 0) console.log(`#${n} era=${s.era} round=${s.round} ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(stats.actions));
    }
    const ended = await A.evaluate(() => window.__bb3d.msg.room.status === 'ended');
    if (ended) { await sleep(800); for (const p of [A, B]) { const m = await p.evaluate(() => !document.querySelector('#modal').hidden); await shot(p, `gameover-${p.tag}`, true); } break; }
    if (!acted) { if (++idle > 200) { console.log('stalled'); break; } await sleep(100); } else idle = 0;
}
const final = await A.evaluate(() => { const s = window.__bb3d.state; return { status: window.__bb3d.msg.room.status, era: s.era, round: s.round, players: s.players.map(p => ({ name: p.name, vp: p.vp, money: p.money })) }; });
const out = { code, n, secs: Math.round((Date.now() - t0) / 1000), final, ...stats, errors };
fs.writeFileSync(`${SHOTS}/three-play-report.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await bA.close(); await bB.close();
