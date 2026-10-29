// Brewery output by era: plays full AI games through the server engine and checks
// every newly built brewery got 1 beer in the Canal Era and 2 in the Rail Era
// (any level), plus the shared producedCubes() helper the UI uses.
//   node test/brewery-era-test.js [games=10]
'use strict';
const E = require('../server/engine.js');
const vm = require('vm'), fs = require('fs'), path = require('path');
const GAMES = +process.argv[2] || 10;
let fails = 0, checks = 0; const seen = { canal: {}, rail: {} };
const ok = (c, what) => { checks++; if (!c) { fails++; if (fails <= 15) console.log('FAIL', what); } };
// helper loaded the same way the browser does (classic script globals)
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/gameData.js'), 'utf8') + ';this.producedCubes=producedCubes;this.INDUSTRY_DATA=INDUSTRY_DATA;', ctx);
for (const td of ctx.INDUSTRY_DATA.brewery) {
    ok(ctx.producedCubes('brewery', td, 'canal') === 1, `helper canal lv${td.level}`);
    ok(ctx.producedCubes('brewery', td, 'rail') === 2, `helper rail lv${td.level}`);
    ok(ctx.producedCubes('brewery', td, null) === null, `helper no era lv${td.level}`);
}
for (const td of ctx.INDUSTRY_DATA.coalMine) ok(ctx.producedCubes('coalMine', td, 'rail') === td.resourceCubes, `coal lv${td.level}`);
for (let g = 1; g <= GAMES; g++) {
    const n = 2 + (g % 3);
    const s = E.newGame(Array.from({ length: n }, (_, i) => `AI${i + 1}`), Array(n).fill(true));
    let guard = 0;
    while (!s.gameOver && guard++ < 2000) {
        const pid = s.currentPlayerId, era = s.era;
        const before = new Set(Object.entries({ ...s.boardIndustries, ...(s.breweryFarmTiles || {}) }).filter(([, t]) => t).map(([k, t]) => k + '|' + t.playerId + '|' + t.tileData.level));
        let r = E.applyAction(s, pid, E.chooseAI(s, pid), true);
        if (!r.ok) r = E.applyAction(s, pid, { action: 'pass', cardIndex: 0 }, true);
        const d = r.detail;
        if (r.pendingDevelopBonuses > 0) new E.GameLogic(s).applyFreeDevelop(pid, r.pendingDevelopBonuses);
        if (d && d.act === 'build' && d.main && d.main.t === 'brewery') {
            const all = { ...s.boardIndustries, ...(s.breweryFarmTiles || {}) };
            const nw = Object.entries(all).find(([k, t]) => t && t.type === 'brewery' && !before.has(k + '|' + t.playerId + '|' + t.tileData.level));
            if (nw) { const [k, t] = nw;
            // a fresh brewery may be flipped at once only by a sale, never on build; cubes must match the era
            const want = era === 'rail' ? 2 : 1;
            ok(t.resourceCubes === want, `g${g} ${era} brewery lv${t.tileData.level} @${k}: ${t.resourceCubes} beer (want ${want})`);
            seen[era][t.tileData.level] = (seen[era][t.tileData.level] || 0) + 1; }
        }
        // turn advance as the server does
        const tr = s.advanceTurn();
        if (tr === 'endCanalEra') s.endCanalEra(); else if (tr === 'endGame') s.endGame();
    }
}
console.log(JSON.stringify({ games: GAMES, checks, built: seen }));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
