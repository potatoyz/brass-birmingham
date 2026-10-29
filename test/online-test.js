// End-to-end test: 3 human ws clients + 1 AI seat play a full game against a
// spawned server, playing random legal moves, checking hidden info + sync,
// illegal-move rejection, reconnect, and restart persistence.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const E = require('../server/engine');

const PORT = 28799 + Math.floor(Math.random() * 100);
const BASE = process.env.BASE_URL || null; // test a live server instead
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bbtest-'));
const URL = BASE ? BASE.replace(/^http/, 'ws') + '/ws' : `ws://127.0.0.1:${PORT}/ws`;
const MODE = process.env.MODE || 'full'; // 'full' | 'smoke'

let srv = null;
function startServer() {
    return new Promise((resolve) => {
        srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, AI_DELAY_MS: '15' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        srv.stdout.on('data', d => { if (/listening/.test(d)) resolve(); });
        srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
    });
}
function stopServer() { return new Promise(r => { srv.once('exit', r); srv.kill('SIGTERM'); }); }

const stats = { sells: 0, sellExplicit: 0, sellAuto: 0, sellMultiTile: 0, sellMerchantBeer: 0, sellOpponentBeer: 0, sellRejectedAsPredicted: 0, sellRejectMessages: {}, actions: 0, rejectedIllegal: 0, hiddenChecks: 0, syncChecks: 0, bonus: 0, maxRound: 0, eras: new Set(), errors: [] };
function fail(msg) { stats.errors.push(msg); console.error('FAIL:', msg); }
const rnd = a => a[Math.floor(Math.random() * a.length)];

class Client {
    constructor(name, token) {
        this.name = name; this.token = token || crypto.randomBytes(16).toString('hex');
        this.last = null; this.msgs = []; this.waiters = []; this.actedVersion = -1; this.auto = false;
    }
    open() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(URL);
            this.ws.on('open', () => { this.send({ t: 'hello', token: this.token }); resolve(); });
            this.ws.on('error', reject);
            this.ws.on('message', d => this.onMsg(JSON.parse(d)));
        });
    }
    close() { this.auto = false; return new Promise(r => { this.ws.once('close', r); this.ws.close(); }); }
    send(o) { this.ws.send(JSON.stringify(o)); }
    onMsg(m) {
        this.msgs.push(m);
        if (m.t === 'room') { this.last = m; checkView(this, m); }
        if (m.t === 'room' && this.pendingSell && m.version > this.pendingSell.version) {
            const ps = this.pendingSell; this.pendingSell = null;
            if (!ps.expectOk) fail(`${this.name}: sell the client predicted impossible was accepted`);
            else verifySell(this, ps, m);
        }
        if (m.t === 'result' && this.pendingSell && !m.ok) {
            const ps = this.pendingSell; this.pendingSell = null;
            if (ps.expectOk) fail(`${this.name}: valid sell rejected: ${m.message}`);
            else {
                stats.sellRejectedAsPredicted++;
                stats.sellRejectMessages[m.message] = (stats.sellRejectMessages[m.message] || 0) + 1;
                if (this.last.version !== ps.version || publicPart(this.last) !== publicPart(ps.prev)) fail(`${this.name}: rejected sell changed the game`);
            }
            this.actedVersion = -1;
            if (this.auto) setImmediate(() => this.maybeAct());
        } else if (m.t === 'result' && !m.ok && this.expectReject) { this.expectReject = false; stats.rejectedIllegal++; }
        else if (m.t === 'result' && !m.ok) {
            // the rules engine refused a move our random picker thought was ok
            stats.retries = (stats.retries || 0) + 1;
            stats.rejectReasons = stats.rejectReasons || {};
            stats.rejectReasons[m.message] = (stats.rejectReasons[m.message] || 0) + 1;
            this.actedVersion = -1;
            if (this.auto) setImmediate(() => this.maybeAct());
        }
        for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
        if (this.auto && m.t === 'room') setImmediate(() => this.maybeAct());
    }
    wait(pred, ms = 5000) {
        return new Promise((resolve, reject) => {
            const w = { pred, resolve };
            this.waiters.push(w);
            setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`${this.name}: timeout`)); } }, ms);
        });
    }
    maybeAct() {
        const m = this.last;
        if (!m || !m.game || m.room.status !== 'playing') return;
        if (this.actedVersion === m.version) return;
        const seat = m.you.seat;
        if (m.pendingBonus && m.pendingBonus.types) {
            this.actedVersion = m.version;
            stats.bonus++;
            this.send({ t: 'bonus', type: Math.random() < 0.3 ? 'skip' : rnd(m.pendingBonus.types) });
            return;
        }
        if (m.pendingBonus) return;
        const st = E.hydrate(m.game);
        if (st.currentPlayerId !== seat || st.players[seat].isAI) return;
        this.actedVersion = m.version;
        const a = randomAction(st, seat);
        stats.actions++;
        if (a.action === E.ACTIONS.SELL) {
            const L = new E.GameLogic(E.hydrate(m.game));
            const r = L.resolveSellPlan(seat, a.pendingData.sellPlan);
            this.pendingSell = { version: m.version, prev: m, plan: a.pendingData.sellPlan, expectOk: r.ok, steps: r.ok ? r.steps : null };
        }
        this.send({ t: 'action', ...a, version: m.version });
    }
}

function randomAction(st, pid) {
    const L = new E.GameLogic(st);
    const P = st.players[pid];
    const A = E.ACTIONS;
    const ok = Object.values(A).filter(a => L.canPerformAction(a, pid));
    // bias toward productive actions
    const weighted = ok.flatMap(a => a === A.PASS ? [a] : a === A.LOAN ? [a] : a === A.SELL ? [a, a, a, a, a, a, a, a] : [a, a, a]);
    let action = rnd(weighted);
    // Play mostly like a sensible player (AI policy) so industries get built
    // and sold; whenever a sale is possible, sell with randomly chosen beer.
    // (hold sales back a little so several tiles get sold in one batch)
    const nSell = ok.includes(A.SELL) ? L.getValidSellTargets(pid).length : 0;
    if (nSell && Math.random() < (nSell >= 2 ? 0.9 : st.round > 6 ? 0.5 : 0.1)) action = A.SELL;
    else if (Math.random() < 0.75) {
        const d = E.G.AIPlayer.chooseAction(st, L, pid, 'normal');
        if (d && d.action !== A.SELL) return { action: d.action, pendingData: d.pendingData || {}, cardIndex: d.cardIndex };
    }
    const anyCard = () => Math.floor(Math.random() * P.hand.length);
    switch (action) {
        case A.BUILD: {
            const t = rnd(L.getValidBuildTargets(pid));
            const cards = L.getValidCardsForAction(pid, A.BUILD, t);
            return { action, pendingData: { cityId: t.cityId, slotIndex: t.slotIndex, industryType: t.industryType }, cardIndex: rnd(cards) };
        }
        case A.NETWORK: {
            const t = rnd(L.getValidNetworkTargets(pid));
            let c2 = null;
            if (st.era === 'rail' && Math.random() < 0.5) {
                const s2 = L.getValidSecondRailLinks(pid, t.connectionId);
                if (s2.length) c2 = rnd(s2).connectionId;
            }
            return { action, pendingData: { connectionId: t.connectionId, connectionId2: c2 }, cardIndex: anyCard() };
        }
        case A.DEVELOP: {
            const types = L.getDevelopableTypes(pid);
            const t1 = rnd(types).type;
            return { action, pendingData: { industryType1: t1, industryType2: null }, cardIndex: anyCard() };
        }
        case A.SELL: {
            const ts = L.getValidSellTargets(pid);
            const mode = Math.random();
            let tiles = mode < 0.3 ? ts : ts.filter(() => Math.random() < 0.6);   // 30%: everything at once (beer runs short)
            if (!tiles.length) tiles = [rnd(ts)];
            const explicit = Math.random() < 0.6;
            const plan = tiles.map(t => {
                if (!explicit) return { key: t.key, useMerchantBeer: Math.random() < 0.7 };
                // the player picks each barrel (any legal source, maybe over-using one)
                const srcs = L.getSellBeerSources(pid, t.key);
                return { key: t.key, beer: Array.from({ length: t.beerNeeded }, () => rnd(srcs).id) };
            });
            stats.sells++; if (explicit) stats.sellExplicit++; else stats.sellAuto++;
            if (plan.length > 1) stats.sellMultiTile++;
            return { action, pendingData: { sellPlan: plan }, cardIndex: anyCard() };
        }
        case A.SCOUT: {
            const idx = [...P.hand.keys()].sort(() => Math.random() - 0.5).slice(0, 3);
            return { action, pendingData: { scoutCards: idx }, cardIndex: null };
        }
        default:
            return { action, pendingData: {}, cardIndex: anyCard() };
    }
}

// After an accepted sell: every chosen barrel left its source, every tile flipped
function verifySell(c, ps, m) {
    const before = ps.prev.game, after = m.game;
    // canal-era tiles leave the board when the era ends right after this sale
    if (after.era !== before.era || after.gameOver) { stats.sellAtEraEnd = (stats.sellAtEraEnd || 0) + 1; return; }
    stats.sellVerified = (stats.sellVerified || 0) + 1;
    const cubes = (g, key) => key.startsWith('farm_') ? (g.breweryFarmTiles[key.slice(5)] || {}).resourceCubes || 0 : (g.boardIndustries[key] || {}).resourceCubes || 0;
    const use = {};
    for (const st of ps.steps) {
        if (!after.boardIndustries[st.key] || !after.boardIndustries[st.key].flipped) fail(`${c.name}: sold tile ${st.key} not flipped`);
        for (const id of st.beer) use[id] = (use[id] || 0) + 1;
    }
    for (const [id, n] of Object.entries(use)) {
        if (id.startsWith('m:')) {
            stats.sellMerchantBeer++;
            if (after.merchantTiles[+id.slice(2)].hasBeer) fail(`${c.name}: merchant barrel ${id} not used`);
        } else {
            const k = id.slice(2);
            const owner = k.startsWith('farm_') ? before.breweryFarmTiles[k.slice(5)].playerId : before.boardIndustries[k].playerId;
            if (owner !== ps.prev.you.seat) stats.sellOpponentBeer++;
            if (cubes(before, k) - cubes(after, k) !== n) fail(`${c.name}: brewery ${k} lost ${cubes(before, k) - cubes(after, k)} barrels, expected ${n}`);
        }
    }
    // explicit choices must be honoured exactly
    ps.plan.forEach((e, i) => { if (e.beer && e.beer.join() !== ps.steps[i].beer.join()) fail(`${c.name}: beer choice not honoured`); });
}

const clients = [];
function checkView(c, m) {
    if (!m.game) return;
    stats.hiddenChecks++;
    const seat = m.you.seat;
    m.game.players.forEach((p, i) => {
        if (i === seat) {
            if (p.hand.some(card => card.type === 'hidden')) fail(`${c.name}: own hand masked`);
        } else if (!p.hand.every(card => card && card.type === 'hidden' && Object.keys(card).length === 1)) {
            fail(`${c.name} (seat ${seat}) can see hand of player ${i}`);
        }
    });
    if (!m.game.drawDeck.every(x => x === 0)) fail(`${c.name}: draw deck leaked`);
    stats.maxRound = Math.max(stats.maxRound, m.game.round);
    stats.eras.add(m.game.era);
}
function publicPart(m) {
    const g = JSON.parse(JSON.stringify(m.game));
    g.players.forEach(p => { p.hand = p.hand.length; });
    return JSON.stringify(g);
}
function checkSync() {
    const vs = clients.filter(c => c.last && c.last.game);
    if (vs.length < 2) return;
    const v = vs[0].last.version;
    if (!vs.every(c => c.last.version === v)) return; // in flight
    stats.syncChecks++;
    const ref = publicPart(vs[0].last);
    for (const c of vs.slice(1)) if (publicPart(c.last) !== ref) fail(`desync between ${vs[0].name} and ${c.name} at v${v}`);
    // hand-count consistency: what others see == what the owner has
    for (const c of vs) {
        const seat = c.last.you.seat;
        if (seat < 0) continue;
        const own = c.last.game.players[seat].hand.length;
        for (const o of vs) if (o.last.game.players[seat].hand.length !== own) fail(`hand count mismatch seat ${seat}`);
    }
}

async function main() {
    if (!BASE) await startServer();
    const host = new Client('Host'), p2 = new Client('P2'), p3 = new Client('P3');
    clients.push(host, p2, p3);
    await Promise.all(clients.map(c => c.open()));

    host.send({ t: 'create', name: '房主', seats: 4 });
    const r0 = await host.wait(m => m.t === 'room');
    const code = r0.room.code;
    console.log('room created', code);
    p2.send({ t: 'join', code, name: '玩家二' });
    p3.send({ t: 'join', code, name: '玩家三' });
    await p3.wait(m => m.t === 'room' && m.you.seat === 2);
    // non-host may not start / set AI
    p2.send({ t: 'start' });
    await p2.wait(m => m.t === 'error' && /房主/.test(m.message));
    host.send({ t: 'start' }); // seat 4 empty -> refused
    await host.wait(m => m.t === 'error' && /空座位/.test(m.message));
    host.send({ t: 'setAI', seat: 3, on: true, difficulty: 'normal' });
    await host.wait(m => m.t === 'room' && m.room.seats[3].ai);
    const lobby = host.last.room;
    console.log('lobby seats:', lobby.seats.map(s => `${s.name}${s.ai ? '(AI)' : ''}`).join(', '));

    if (MODE === 'smoke') {
        // live-server smoke: also bad code join
        const p4 = new Client('P4'); await p4.open();
        p4.send({ t: 'join', code: 'ZZZZ', name: 'x' });
        const e = await p4.wait(m => m.t === 'error');
        console.log('bad code ->', e.message);
        host.send({ t: 'start' });
        const g = await host.wait(m => m.t === 'room' && m.game);
        console.log('game started on live server, round', g.game.round, 'era', g.game.era, 'my hand', g.game.players[0].hand.length,
            'others hidden:', g.game.players.slice(1).every(p => p.hand.every(c => c.type === 'hidden')));
        for (const c of clients) c.send({ t: 'leave' });
        await p4.close();
        await Promise.all(clients.map(c => c.close()));
        console.log(JSON.stringify({ code, errors: stats.errors }));
        process.exit(stats.errors.length ? 1 : 0);
    }

    host.send({ t: 'start' });
    await host.wait(m => m.t === 'room' && m.game);
    const syncTimer = setInterval(checkSync, 5);

    // illegal: someone acts out of turn / with bad data
    const st0 = E.hydrate(host.last.game);
    const cur = st0.currentPlayerId;
    const notCur = clients.find(c => c.last.you.seat !== cur);
    notCur.expectReject = true;
    notCur.send({ t: 'action', action: 'pass', cardIndex: 0 });
    await notCur.wait(m => m.t === 'error' && /还没轮到你/.test(m.message)).catch(() => fail('out-of-turn not rejected'));
    notCur.expectReject = false;
    stats.rejectedIllegal++;
    const curC = clients.find(c => c.last.you.seat === cur);
    if (curC) {
        curC.expectReject = true;
        curC.send({ t: 'action', action: 'build', pendingData: { cityId: 'nowhere', slotIndex: 0, industryType: 'coalMine' }, cardIndex: 0 });
        await curC.wait(m => m.t === 'result' && !m.ok).catch(() => fail('bad build not rejected'));
        curC.expectReject = true;
        curC.send({ t: 'action', action: 'pass', cardIndex: 99 });
        await curC.wait(m => m.t === 'result' && !m.ok).catch(() => fail('bad card not rejected'));
    }

    for (const c of clients) { c.auto = true; c.maybeAct(); }

    // Mid-game: disconnect P2, reconnect with the same token, keep playing
    await host.wait(m => m.t === 'room' && m.game && m.game.round >= 3, 60000);
    p2.auto = false;
    await p2.close();
    const handBefore = p2.last.game.players[p2.last.you.seat].hand;
    const seen = (!host.last.room.seats[1].online && host.last) ||
        await host.wait(m => m.t === 'room' && !m.room.seats[1].online, 5000).catch(() => null);
    console.log('P2 offline shown to host:', !!seen);
    if (!seen) fail('offline not shown');
    const p2b = new Client('P2-reconnect', p2.token);
    clients[1] = p2b;
    await p2b.open();
    p2b.send({ t: 'join', code, name: '玩家二' });
    const back = await p2b.wait(m => m.t === 'room' && m.game);
    console.log('P2 reconnect -> seat', back.you.seat, 'hand size', back.game.players[back.you.seat].hand.length);
    if (back.you.seat !== 1) fail('reconnect did not restore seat');
    if (back.game.players[1].hand.length && JSON.stringify(back.game.players[1].hand) !== JSON.stringify(handBefore) && back.version === p2.last.version) fail('hand changed across reconnect');
    p2b.auto = true; p2b.maybeAct();

    // Rail era reached?
    await host.wait(m => m.t === 'room' && m.game && m.game.era === 'rail', 120000);
    console.log('era change reached; event:', host.last.event && host.last.event.kind);

    // Persistence: restart the server mid rail-era, everyone reconnects
    if (!BASE) {
        for (const c of clients) c.auto = false;
        await new Promise(r => setTimeout(r, 300));
        const vBefore = host.last.version;
        const pubBefore = publicPart(host.last);
        await Promise.all(clients.map(c => c.close()));
        await stopServer();
        await startServer();
        const fresh = clients.map(c => new Client(c.name + '*', c.token));
        clients.splice(0, clients.length, ...fresh);
        await Promise.all(clients.map(c => c.open()));
        for (const c of clients) c.send({ t: 'join', code, name: c.name });
        await Promise.all(clients.map(c => c.wait(m => m.t === 'room' && m.game)));
        const same = publicPart(clients[0].last) === pubBefore || clients[0].last.version >= vBefore;
        console.log('after restart: version', vBefore, '->', clients[0].last.version, 'state restored:', same);
        if (!same) fail('state not restored after restart');
        for (const c of clients) { c.auto = true; c.maybeAct(); }
    }

    const end = await clients[0].wait(m => m.t === 'room' && m.room.status === 'ended', 180000);
    clearInterval(syncTimer);
    checkSync();
    const final = end.game.players.map(p => `${p.name}:${p.vp}VP`).join(' ');
    const aiLog = end.log.filter(e => e.playerId === 3).map(e => e.message);
    console.log('AI log sample:', aiLog.slice(0, 12).join(' | '));
    console.log('GAME OVER:', final, '| event', end.event && end.event.kind);
    // host returns to lobby
    clients[0].send({ t: 'restart' });
    await clients[0].wait(m => m.t === 'room' && m.room.status === 'lobby');
    console.log('restart -> lobby ok');
    await Promise.all(clients.map(c => c.close()));
    if (!BASE) await stopServer();
    stats.eras = [...stats.eras];
    console.log(JSON.stringify(stats, null, 1));
    process.exit(stats.errors.length ? 1 : 0);
}

main().catch(async e => { console.error(e); try { if (srv) srv.kill(); } catch {} ; process.exit(2); });
