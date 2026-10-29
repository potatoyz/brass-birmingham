// Hand-built sell situations. Run against any copy of the rules engine:
//   node test/sell-scenarios.js            (this repo's js/)
//   JS_DIR=/tmp/upstream/js node test/sell-scenarios.js   (upstream copy)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const JS_DIR = process.env.JS_DIR || path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ console, Math, JSON, Date });
const G = vm.runInContext(['gameData.js', 'gameState.js', 'gameLogic.js', 'aiPlayer.js']
    .map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n;\n') +
    '\n;({ GameState, GameLogic, AIPlayer, INDUSTRY_TYPES });', ctx);
const T = G.INDUSTRY_TYPES;
const NEW = typeof G.GameLogic.prototype.resolveSellPlan === 'function';
console.log('engine:', JS_DIR, NEW ? '(patched)' : '(upstream)');

function setup({ links, merchants, tiles }) {
    const s = new G.GameState(2, ['甲', '乙']);
    s.boardIndustries = {};
    s.breweryFarmTiles = {};
    s.boardLinks = {};
    for (const id of links) s.boardLinks[id] = { playerId: 0, type: 'canal' };
    s.merchantTiles = merchants.map(([location, hasBeer]) => ({ location, buys: 'any', hasBeer }));
    for (const [key, pid, type, td] of tiles) {
        s.boardIndustries[key] = { playerId: pid, type, flipped: false, resourceCubes: td.cubes || 0,
            tileData: Object.assign({ level: 1, vp: 3, income: 2, beersToSell: 0 }, td) };
    }
    s.players.forEach(p => { p.hand = [{ type: 'location', name: 'x' }, { type: 'location', name: 'y' }]; });
    return s;
}
const snap = s => JSON.stringify({ b: s.boardIndustries, m: s.merchantTiles, p: s.players.map(p => [p.money, p.vp, p.incomeSpace, p.income, p.hand.length]) });
const sold = s => Object.entries(s.boardIndustries).filter(([, t]) => t.flipped && t.type !== T.BREWERY).map(([k]) => k);
let fails = 0;
const check = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) fails++; };
const brewery = (cubes) => ({ cubes, level: 1 });

// S1: only merchant beer available; player declines the "use merchant beer" box
{
    const s = setup({ links: ['birmingham-oxford'], merchants: [['oxford', true]],
        tiles: [['birmingham_0', 0, T.COTTON_MILL, { beersToSell: 1 }]] });
    const L = new G.GameLogic(s);
    const before = snap(s);
    const r = L.executeSell(0, [{ key: 'birmingham_0', useMerchantBeer: false }], 0);
    console.log('S1 useMerchantBeer=false ->', r.success, r.message);
    check('S1 rejected, nothing changed', !r.success && snap(s) === before);
    if (NEW) {
        const r2 = L.executeSell(0, [{ key: 'birmingham_0', beer: ['m:0'] }], 0);
        check('S1 explicit merchant barrel sells + bonus', r2.success && !s.merchantTiles[0].hasBeer && sold(s).length === 1, r2.message);
    }
}

// S2: choose between own brewery (unconnected, allowed) and connected opponent brewery
{
    const mk = () => setup({ links: ['birmingham-oxford', 'birmingham-coventry'], merchants: [['oxford', false]],
        tiles: [['birmingham_0', 0, T.COTTON_MILL, { beersToSell: 1 }],
                ['dudley_0', 0, T.BREWERY, brewery(1)],
                ['coventry_1', 1, T.BREWERY, brewery(1)],
                ['worcester_0', 1, T.BREWERY, brewery(1)]] });
    let s = mk(); let L = new G.GameLogic(s);
    const r = L.executeSell(0, [{ key: 'birmingham_0', useMerchantBeer: false }], 0);
    check('S2 default picks own brewery first', r.success && s.boardIndustries.dudley_0.resourceCubes === 0 && s.boardIndustries.coventry_1.resourceCubes === 1, r.message);
    if (NEW) {
        s = mk(); L = new G.GameLogic(s);
        const ids = L.getSellBeerSources(0, 'birmingham_0').map(x => `${x.id}x${x.count}`);
        check('S2 options = own dudley + connected opponent coventry (not unconnected worcester)', ids.join() === 'b:dudley_0x1,b:coventry_1x1', ids.join());
        const inc1 = s.players[1].incomeSpace;
        const r2 = L.executeSell(0, [{ key: 'birmingham_0', beer: ['b:coventry_1'] }], 0);
        check('S2 chose opponent barrel: theirs used, opponent tile flips (+income), mine kept',
            r2.success && s.boardIndustries.coventry_1.flipped && s.boardIndustries.dudley_0.resourceCubes === 1 && s.players[1].incomeSpace !== inc1, r2.message);
        s = mk(); L = new G.GameLogic(s); const b = snap(s);
        const r3 = L.executeSell(0, [{ key: 'birmingham_0', beer: ['b:worcester_0'] }], 0);
        check('S2 unconnected opponent brewery rejected', !r3.success && snap(s) === b, r3.zh);
        const r4 = L.executeSell(0, [{ key: 'birmingham_0', beer: ['b:dudley_0', 'b:dudley_0'] }], 0);
        check('S2 wrong barrel count rejected', !r4.success && snap(s) === b, r4.zh);
    }
}

// S3: two tiles, 2 barrels for 3 needed (beer runs out mid-batch)
{
    const mk = () => setup({ links: ['birmingham-oxford'], merchants: [['oxford', true], ['oxford', false]],
        tiles: [['birmingham_0', 0, T.COTTON_MILL, { beersToSell: 1 }],
                ['birmingham_1', 0, T.MANUFACTURER, { beersToSell: 2, level: 5 }],
                ['dudley_0', 0, T.BREWERY, brewery(1)]] });
    let s = mk(); let L = new G.GameLogic(s); const b = snap(s); const inc = s.players[0].incomeSpace;
    const r = L.executeSell(0, [{ key: 'birmingham_0', useMerchantBeer: false }, { key: 'birmingham_1', useMerchantBeer: true }], 0);
    console.log('S3 batch ->', r.success, r.message, '| sold:', sold(s).join(), '| merchant beer left:', s.merchantTiles[0].hasBeer, '| income space', inc, '->', s.players[0].incomeSpace);
    check('S3 batch rejected atomically (no partial sale, no free bonus)', !r.success && snap(s) === b, r.zh || r.message);
    if (NEW) {
        const r2 = L.executeSell(0, [{ key: 'birmingham_0', beer: ['b:dudley_0'] }, { key: 'birmingham_1', beer: ['m:0', 'b:dudley_0'] }], 0);
        check('S3 explicit double-use of last barrel rejected', !r2.success && snap(s) === b, r2.zh);
        const r3 = L.executeSell(0, [{ key: 'birmingham_1', beer: ['m:0', 'b:dudley_0'] }], 0);
        check('S3 the 2-beer tile alone sells (merchant + brewery)', r3.success && sold(s).join() === 'birmingham_1', r3.message);
    }
}

// S4: batch that only works with the right assignment (greedy own-first fails)
{
    const s = setup({ links: ['birmingham-oxford', 'birmingham-coventry', 'coalbrookdale-shrewsbury'],
        merchants: [['oxford', false], ['shrewsbury', false]],
        tiles: [['birmingham_0', 0, T.COTTON_MILL, { beersToSell: 1 }],
                ['coalbrookdale_0', 0, T.COTTON_MILL, { beersToSell: 1 }],
                ['dudley_0', 0, T.BREWERY, brewery(1)],
                ['coventry_1', 1, T.BREWERY, brewery(1)]] });
    const L = new G.GameLogic(s); const b = snap(s);
    const r = L.executeSell(0, [{ key: 'birmingham_0', useMerchantBeer: false }, { key: 'coalbrookdale_0', useMerchantBeer: false }], 0);
    console.log('S4 batch ->', r.success, r.message, '| sold:', sold(s).join());
    check('S4 both tiles sold (birmingham drinks coventry, coalbrookdale drinks own)', r.success && sold(s).length === 2, r.message);
}

// S6: forged plans through the server's applyAction (what a client can send)
if (NEW && !process.env.JS_DIR) {
    const E = require('../server/engine.js');
    const s = E.newGame(['甲', '乙'], [{ isAI: false }, { isAI: false }]);
    const pid = s.currentPlayerId, opp = 1 - pid;
    s.boardIndustries = {}; s.boardLinks = { 'birmingham-oxford': { playerId: pid, type: 'canal' } };
    s.merchantTiles = [{ location: 'oxford', buys: 'any', hasBeer: true }];
    const t = (pl, type, td, cubes = 0) => ({ playerId: pl, type, flipped: false, resourceCubes: cubes, tileData: Object.assign({ level: 1, vp: 3, income: 2, beersToSell: 0 }, td) });
    s.boardIndustries.birmingham_0 = t(pid, 'cottonMill', { beersToSell: 1 });
    s.boardIndustries.worcester_0 = t(opp, 'brewery', {}, 1);
    const before = E.serialize(s);
    for (const beer of [['b:worcester_0'], ['m:5'], ['b:__proto__'], ['m:0', 'm:0'], [], 'x']) {
        const r = E.applyAction(s, pid, { action: 'sell', pendingData: { sellPlan: [{ key: 'birmingham_0', beer }] }, cardIndex: 0 }, false);
        check(`S6 forged beer ${JSON.stringify(beer)} rejected, state untouched`, !r.ok && E.serialize(s) === before, r.message);
    }
    const ok = E.applyAction(s, pid, { action: 'sell', pendingData: { sellPlan: [{ key: 'birmingham_0', beer: ['m:0'] }] }, cardIndex: 0 }, false);
    check('S6 legal chosen barrel accepted', ok.ok, ok.message);
}

// S5: all-AI games through the server engine: AI sells never rejected
if (NEW && !process.env.JS_DIR) {
    const E = require('../server/engine.js');
    let sells = 0, multi = 0, rejected = 0, ended = 0;
    for (let g = 0; g < 15; g++) {
        const n = 2 + (g % 3);
        const s = E.newGame(Array.from({ length: n }, (_, i) => 'AI' + i), Array.from({ length: n }, () => ({ isAI: true, difficulty: ['easy', 'normal', 'hard'][g % 3] })));
        for (let guard = 0; guard < 3000 && !s.gameOver; guard++) {
            const pid = s.currentPlayerId;
            const d = E.chooseAI(s, pid);
            const r = E.applyAction(s, pid, d, true);
            if (d.action === 'sell') { sells++; if (d.pendingData.sellPlan.length > 1) multi++; if (!r.ok) rejected++; }
            if (!r.ok) E.applyAction(s, pid, { action: 'pass', cardIndex: 0 }, true);
            const tr = s.advanceTurn();
            if (tr === 'endCanalEra') s.endCanalEra();
            else if (tr === 'endGame') { s.endGame(); ended++; break; }
        }
    }
    check(`S5 15 AI games: ${ended} finished, ${sells} AI sells (${multi} multi-tile), ${rejected} rejected`, ended === 15 && rejected === 0 && sells > 0);
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exitCode = fails ? 1 : 0;
