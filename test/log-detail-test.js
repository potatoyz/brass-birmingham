// Detailed action log: plays full AI games through the server engine and checks
// every log detail (server/engine.js summarize) against what really changed:
//   money of every player, money spent this round, coal/iron/beer cubes per
//   board location + markets, income levels, flips, VP; also round income.
//   node test/log-detail-test.js [games=6]
'use strict';
const E = require('../server/engine.js');
const GAMES = +process.argv[2] || 6;
let fails = 0, checks = 0, actions = 0;
const counts = { res: 0, flips: 0, gain: 0, mkt: 0, inc: 0, rounds: 0, scores: 0, merchant: 0 };
const bad = (g, what, info) => { fails++; if (fails <= 15) console.log(`FAIL g${g} ${what} — ${info}`); };
const ok = (g, cond, what, info) => { checks++; if (!cond) bad(g, what, typeof info === 'function' ? info() : info); };

function snap(s) {
    const tiles = {};
    for (const [k, t] of Object.entries(s.boardIndustries)) tiles[k] = { owner: t.playerId, type: t.type, cubes: t.resourceCubes, flipped: t.flipped, lv: t.tileData.level };
    for (const [k, t] of Object.entries(s.breweryFarmTiles || {})) if (t) tiles[k] = { owner: t.playerId, type: t.type, cubes: t.resourceCubes, flipped: t.flipped, lv: t.tileData.level };
    return {
        tiles, coal: s.coalMarket, iron: s.ironMarket,
        money: s.players.map(p => p.money), vp: s.players.map(p => p.vp),
        inc: s.players.map(p => s.getIncomeLevel(p.id)), spent: s.players.map(p => (s.moneySpentThisRound || {})[p.id] || 0),
        mbeer: s.merchantTiles.filter(m => m.hasBeer).length,
    };
}
const resOf = type => type === 'coalMine' ? 'coal' : type === 'ironWorks' ? 'iron' : type === 'brewery' ? 'beer' : null;

for (let g = 1; g <= GAMES; g++) {
    const n = 2 + (g % 3);
    const s = E.newGame(Array.from({ length: n }, (_, i) => `AI${i + 1}`), Array(n).fill(true));
    let guard = 0;
    while (!s.gameOver && guard++ < 2000) {
        const pid = s.currentPlayerId;
        const a = snap(s);
        const choice = E.chooseAI(s, pid);
        let r = E.applyAction(s, pid, choice, true);
        if (!r.ok) r = E.applyAction(s, pid, { action: 'pass', cardIndex: 0 }, true);
        if (!r.ok) { bad(g, 'pass', r.message); break; }
        actions++;
        const b = snap(s), d = r.detail;
        // money: every player's change equals the ledger's net
        for (let p = 0; p < n; p++) ok(g, b.money[p] - a.money[p] === (d.net[p] || 0), 'money', () => `${d.act} p${p} real ${b.money[p] - a.money[p]} vs log ${d.net[p] || 0} ${JSON.stringify(d)}`);
        const costSum = (d.cost || []).reduce((x, c) => x + c.amt, 0);
        ok(g, (d.spent || 0) === b.spent[pid] - a.spent[pid], 'spent', () => `${d.act} spent ${d.spent} vs tracker ${b.spent[pid] - a.spent[pid]}`);
        ok(g, costSum === (d.spent || 0), 'cost breakdown', () => `${d.act} parts ${costSum} vs spent ${d.spent} ${JSON.stringify(d.cost)}`);
        // cubes per (location, owner, resource) on tiles that existed before
        const real = {}, logged = {};
        for (const [k, t] of Object.entries(a.tiles)) {
            const t2 = b.tiles[k]; const res = resOf(t.type);
            if (!res || !t2 || t2.owner !== t.owner || t2.lv !== t.lv) continue;
            const used = t.cubes - t2.cubes; if (used <= 0) continue;
            const id = `${res}|${E.keyLoc(k)}|${t.owner}`; real[id] = (real[id] || 0) + used;
        }
        for (const x of d.res || []) if (x.src === 'tile') { const id = `${x.r}|${x.loc}|${x.owner}`; logged[id] = (logged[id] || 0) + x.n; counts.res += x.n; }
        ok(g, JSON.stringify(Object.entries(real).sort()) === JSON.stringify(Object.entries(logged).sort()), "tile cubes", () => `${d.act} real ${JSON.stringify(real)} log ${JSON.stringify(logged)} ${JSON.stringify(d)}`);
        // markets
        for (const res of ['coal', 'iron']) {
            const took = (d.res || []).filter(x => x.r === res && x.src === 'market').reduce((t, x) => t + x.n, 0);
            const put = d.tomkt && d.tomkt.r === res ? d.tomkt.n : 0;
            counts.mkt += took;
            ok(g, b[res] - a[res] === put - took, `${res} market`, () => `real ${b[res] - a[res]} vs log +${put} -${took}`);
        }
        // merchant beer
        const mb = (d.res || []).filter(x => x.src === 'merchant').length; counts.merchant += mb;
        ok(g, a.mbeer - b.mbeer === mb, 'merchant beer', `${a.mbeer - b.mbeer} vs ${mb}`);
        // flips: every newly flipped pre-existing tile is in the log (with owner)
        const newFlips = Object.entries(b.tiles).filter(([k, t]) => t.flipped && (!a.tiles[k] || !a.tiles[k].flipped || a.tiles[k].lv !== t.lv || a.tiles[k].owner !== t.owner)).map(([k, t]) => `${E.keyLoc(k)}|${t.owner}|${t.type}`).sort();
        const logFlips = (d.flips || []).map(f => `${f.loc}|${f.owner}|${f.t}`).sort(); counts.flips += logFlips.length;
        ok(g, JSON.stringify(newFlips) === JSON.stringify(logFlips), 'flips', () => `real ${newFlips} log ${logFlips}`);
        // income levels
        for (let p = 0; p < n; p++) {
            const x = (d.inc || []).find(i => i.pid === p);
            ok(g, x ? (x.from === a.inc[p] && x.to === b.inc[p]) : a.inc[p] === b.inc[p], 'income level', () => `p${p} ${a.inc[p]}→${b.inc[p]} log ${JSON.stringify(x)}`);
            if (x) counts.inc++;
        }
        // VP (merchant bonus) for the actor
        const vpLog = (d.vp || []).reduce((t, v) => t + v.amt, 0);
        ok(g, b.vp[pid] - a.vp[pid] === vpLog, 'vp', `${b.vp[pid] - a.vp[pid]} vs ${vpLog}`);
        counts.gain += (d.gain || []).length;
        if (r.pendingDevelopBonuses > 0) new E.GameLogic(s).applyFreeDevelop(pid, r.pendingDevelopBonuses);
        // turn advance with round income, as the server does
        const a2 = snap(s);
        const { r: tr, ledger } = E.withLedger(s, () => s.advanceTurn());
        const rd = E.summarize(ledger, 'round', null);
        if (rd.income) {
            counts.rounds++;
            const b2 = snap(s);
            for (let p = 0; p < n; p++) ok(g, b2.money[p] - a2.money[p] === (rd.net[p] || 0), 'round income', () => `p${p} ${b2.money[p] - a2.money[p]} vs ${rd.net[p]}`);
        }
        if (tr === 'endCanalEra') { const sc = s.endCanalEra(); counts.scores++; ok(g, sc.every(x => x.totalVP === s.players[x.playerId].vp), 'canal score', ''); }
        else if (tr === 'endGame') { s.endGame(); counts.scores++; }
    }
    ok(g, s.gameOver, 'game finished', `guard ${guard}`);
    // ledger never leaks into the saved state
    ok(g, !('_ledger' in JSON.parse(E.serialize(s))), 'ledger not serialized', '');
}
console.log(JSON.stringify({ games: GAMES, actions, checks, ...counts }));
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
