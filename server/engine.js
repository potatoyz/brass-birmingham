// Loads the browser game scripts (gameData / gameState / gameLogic / aiPlayer)
// into a sandboxed context so the server can run the exact same rules engine.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');
const FILES = ['gameData.js', 'gameState.js', 'gameLogic.js', 'aiPlayer.js'];

const ctx = vm.createContext({ console, Math, JSON, Date });
const src = FILES.map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n;\n') +
    '\n;({ GameState, GameLogic, AIPlayer, ACTIONS, ERA, CARD_TYPES, INDUSTRY_TYPES, INDUSTRY_DISPLAY, CITIES, BREWERY_FARMS, LOAN_AMOUNT, locationName, INDUSTRY_TYPES });';
const G = vm.runInContext(src, ctx, { filename: 'game-engine.js' });
const { GameState, GameLogic, AIPlayer, ACTIONS, ERA, CARD_TYPES, INDUSTRY_DISPLAY, CITIES, BREWERY_FARMS, LOAN_AMOUNT, locationName } = G;

// NB: GameState defines toJSON() (a summary for debugging), so always
// serialize a shallow plain copy to capture the full state.
function serialize(x) { return JSON.stringify(Object.assign({}, x)); }
function cloneData(x) { return JSON.parse(serialize(x)); }

function newGame(names, aiCfg) {
    return new GameState(names.length, names, aiCfg);
}

// Plain data -> GameState instance (methods via prototype)
function hydrate(data) {
    const s = Object.create(GameState.prototype);
    Object.assign(s, cloneData(data));
    return s;
}

function isInt(n) { return Number.isInteger(n); }

// Validate + execute one action for playerId. Returns
// { ok, message, pendingDevelopBonuses } and mutates state only on success.
function applyAction(state, playerId, msg, isAI) {
    const logic = new GameLogic(state);
    const player = state.players[playerId];
    const action = msg.action;
    const pd = (msg.pendingData && typeof msg.pendingData === 'object') ? msg.pendingData : {};
    const cardIndex = msg.cardIndex;
    const handOk = i => isInt(i) && i >= 0 && i < player.hand.length;
    const fail = m => ({ ok: false, message: m });

    if (!Object.values(ACTIONS).includes(action)) return fail('未知动作');
    if (player.hand.length === 0) return fail('手牌为空');
    if (action !== ACTIONS.SCOUT && !handOk(cardIndex)) return fail('请选择一张有效的手牌');
    if (!logic.canPerformAction(action, playerId)) return fail('当前无法执行该动作');

    const backup = serialize(state);
    startLedger(state);
    let result;
    let logText = null;
    switch (action) {
        case ACTIONS.BUILD: {
            const t = logic.getValidBuildTargets(playerId).find(t =>
                t.cityId === pd.cityId && t.slotIndex === pd.slotIndex && t.industryType === pd.industryType);
            if (!t) return fail('无效的建造位置');
            const valid = logic.getValidCardsForAction(playerId, ACTIONS.BUILD, t);
            if (!valid.includes(cardIndex)) return fail('这张牌不能用于该建造');
            result = logic.executeBuild(playerId, t.cityId, t.slotIndex, t.industryType, cardIndex);
            if (result.success) {
                const cityName = (CITIES[t.cityId] && CITIES[t.cityId].name) || (BREWERY_FARMS[t.cityId] && BREWERY_FARMS[t.cityId].name) || t.cityId;
                logText = `在${cityName}建造了 ${INDUSTRY_DISPLAY[t.industryType].name}`;
            }
            break;
        }
        case ACTIONS.NETWORK: {
            const targets = logic.getValidNetworkTargets(playerId);
            if (!targets.some(t => t.connectionId === pd.connectionId)) return fail('无效的连线');
            if (pd.connectionId2) {
                const seconds = logic.getValidSecondRailLinks(playerId, pd.connectionId);
                if (!seconds.some(s => s.connectionId === pd.connectionId2)) return fail('无效的第二条铁路');
                result = logic.executeNetworkDouble(playerId, pd.connectionId, pd.connectionId2, cardIndex);
            } else {
                result = logic.executeNetwork(playerId, pd.connectionId, cardIndex);
            }
            if (result.success) logText = result.message;
            break;
        }
        case ACTIONS.DEVELOP: {
            const types = logic.getDevelopableTypes(playerId);
            const t1 = pd.industryType1, t2 = pd.industryType2 || null;
            if (!types.some(t => t.type === t1)) return fail('无效的开发选择');
            if (t2) {
                if (!types.some(t => t.type === t2)) return fail('无效的第二个开发选择');
                if (t1 === t2 && state.getRemainingTiles(playerId)[t1].count < 2) return fail('板块不足');
                if (state.findIronSource(playerId).length < 2) return fail('铁不足');
            }
            result = logic.executeDevelop(playerId, t1, t2, cardIndex);
            if (result.success) logText = result.message;
            break;
        }
        case ACTIONS.SELL: {
            const plan = Array.isArray(pd.sellPlan) ? pd.sellPlan : [];
            const valid = new Set(logic.getValidSellTargets(playerId).map(t => t.key));
            const seen = new Set();
            if (plan.length === 0) return fail('请选择要出售的产业');
            for (const e of plan) {
                if (!e || !valid.has(e.key) || seen.has(e.key)) return fail('无效的出售选择');
                seen.add(e.key);
            }
            const clean = plan.map(e => {
                const c = { key: e.key, useMerchantBeer: !!e.useMerchantBeer };
                if (Array.isArray(e.beer)) c.beer = e.beer.slice(0, 4).map(x => String(x).slice(0, 40));
                return c;
            });
            result = logic.executeSell(playerId, clean, cardIndex, { autoResolveDevelop: !!isAI });
            if (result.success) logText = result.message;
            break;
        }
        case ACTIONS.LOAN:
            result = logic.executeLoan(playerId, cardIndex);
            if (result.success) logText = `贷款 £${LOAN_AMOUNT}`;
            break;
        case ACTIONS.SCOUT: {
            const idx = Array.isArray(pd.scoutCards) ? pd.scoutCards.slice() : [];
            if (isInt(cardIndex) && idx.length === 2) idx.push(cardIndex);
            if (idx.length !== 3 || !idx.every(handOk) || new Set(idx).size !== 3) return fail('侦察需要选择 3 张不同的牌');
            result = logic.executeScout(playerId, idx);
            if (result.success) logText = '侦察（获得万能牌）';
            break;
        }
        case ACTIONS.PASS:
            result = logic.executePass(playerId, cardIndex);
            if (result.success) logText = '跳过';
            break;
    }
    const ledger = stopLedger(state);
    if (!result || !result.success) {
        // restore anything a failed execute may have touched
        const restored = JSON.parse(backup);
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, restored);
        return fail((result && (result.zh || result.message)) || '动作失败');
    }
    return { ok: true, message: result.message, logText, pendingDevelopBonuses: result.pendingDevelopBonuses || 0, detail: summarize(ledger, action, playerId), ledger };
}

// ---- action ledger -> structured log detail ------------------------------
// GameState/GameLogic record what they actually did (state._rec) while a
// non-enumerable `_ledger` array is attached; never serialized.
function startLedger(state) { Object.defineProperty(state, '_ledger', { value: [], writable: true, configurable: true, enumerable: false }); }
function stopLedger(state) { const l = state._ledger || []; delete state._ledger; return l; }
function withLedger(state, fn) { startLedger(state); try { const r = fn(); return { r, ledger: stopLedger(state) }; } catch (e) { stopLedger(state); throw e; } }

function keyLoc(key) {
    if (!key) return '';
    let id = String(key);
    if (id.startsWith('farm_')) id = id.slice(5);
    if (BREWERY_FARMS[id]) return BREWERY_FARMS[id].name;
    const m = id.match(/^(.*)_(\d+)$/);
    return locationName(m ? m[1] : id);
}
const indName = t => (INDUSTRY_DISPLAY[t] && INDUSTRY_DISPLAY[t].name) || t;

// Turns raw ledger events into a compact, display-ready detail object:
//   act, pid, main{...}, cost[{l,amt}], gain[{l,amt}], res[{r,src,loc,owner,n,price}],
//   flips[{owner,t,lv,loc,spaces}], inc[{pid,from,to}], vp[{pid,amt,l}], dev[], disc[], net{pid:£}
function summarize(ledger, act, pid) {
    const d = { act, pid, cost: [], gain: [], res: [], flips: [], inc: [], vp: [], dev: [], disc: [], links: [], sold: [], net: {} };
    const net = (p, a) => { d.net[p] = (d.net[p] || 0) + a; };
    const addRes = (r, src, extra) => {
        const last = d.res.find(x => x.r === r && x.src === src && x.key === extra.key && x.price === extra.price && x.forKey === extra.forKey);
        if (last) last.n++; else d.res.push({ r, src, n: 1, ...extra });
    };
    let beerFor = null;
    const incBy = new Map();
    for (const e of ledger) {
        switch (e.k) {
            case 'build': d.main = { t: e.type, lv: e.level, loc: keyLoc(e.loc) }; if (e.base) d.cost.push({ l: e.type ? '建造费' : '费用', amt: e.base }); break;
            case 'link': d.links.push({ t: e.type, a: locationName(e.a), b: locationName(e.b) }); if (e.base) d.cost.push({ l: e.type === 'canal' ? '运河费' : '铁路费', amt: e.base }); break;
            case 'spend': net(e.pid, -e.amt); d.spent = (d.spent || 0) + e.amt; break;
            case 'mkt': addRes(e.r || e.res, e.supply ? 'supply' : 'market', { price: e.price }); d.cost.push({ l: `${e.res === 'coal' ? '煤' : '铁'}（市场）`, amt: e.price, r: e.res }); break;
            case 'use': addRes(e.res, 'tile', { key: e.key, loc: keyLoc(e.key), owner: e.owner, forKey: e.res === 'beer' ? beerFor : undefined }); if (e.res === 'beer') beerFor = null; break;
            case 'beerFor': beerFor = e.forKey; break;
            case 'mbeer': d.res.push({ r: 'beer', src: 'merchant', n: 1, loc: locationName(e.merchant), name: e.name, bonus: e.bonus, amt: e.amt, forKey: e.forKey });
                if (e.bonus === 'vp') d.vp.push({ pid: e.pid, amt: e.amt, l: `商人奖励（${e.name}）` });
                if (e.bonus === 'develop') d.gain.push({ l: `商人奖励（${e.name}）：免费发展 ${e.amt}`, amt: 0 });
                break;
            case 'gain': net(e.pid, e.amt); d.gain.push({ l: e.why === 'loan' ? '贷款' : e.why === 'tomkt' ? '卖给市场' : `商人奖励（${e.name}）`, amt: e.amt, why: e.why }); break;
            case 'tomkt': d.tomkt = { r: e.res, n: e.n, gain: e.gain }; break;
            case 'flip': d.flips.push({ owner: e.owner, t: e.type, lv: e.level, loc: keyLoc(e.key), spaces: e.spaces }); break;
            case 'inc': { const x = incBy.get(e.pid); if (x) x.to = e.to; else incBy.set(e.pid, { pid: e.pid, from: e.from, to: e.to }); break; }
            case 'loanInc': incBy.set(e.pid, { pid: e.pid, from: e.from, to: e.to }); break;
            case 'sold': d.sold.push({ t: e.type, lv: e.level, loc: keyLoc(e.key), key: e.key }); break;
            case 'dev': d.dev.push({ t: e.type, lv: e.level }); break;
            case 'discard': d.disc.push(e.card); break;
            case 'income': net(e.pid, e.amt); d.income = d.income || []; d.income.push({ pid: e.pid, amt: e.amt }); break;
            case 'shortSale': net(e.pid, e.amt); d.short = d.short || []; d.short.push({ pid: e.pid, t: e.type, lv: e.level, amt: e.amt }); break;
            case 'shortVp': net(e.pid, e.money); d.short = d.short || []; d.short.push({ pid: e.pid, vp: e.vp, money: e.money }); break;
        }
    }
    d.inc = [...incBy.values()].filter(x => x.from !== x.to);
    for (const k of Object.keys(d)) if (Array.isArray(d[k]) && !d[k].length) delete d[k];
    for (const r of d.res || []) delete r.key;
    return d;
}

function applyFreeDevelop(state, playerId, type) {
    const logic = new GameLogic(state);
    const types = logic.getDevelopableTypes(playerId);
    if (!types.some(t => t.type === type)) return null;
    const removed = logic.applyFreeDevelop(playerId, 1, type);
    return removed[0] || null;
}

function developableTypes(state, playerId) {
    return new GameLogic(state).getDevelopableTypes(playerId).map(t => t.type);
}

function chooseAI(state, playerId) {
    const logic = new GameLogic(state);
    const p = state.players[playerId];
    return AIPlayer.chooseAction(state, logic, playerId, p.aiDifficulty || 'normal');
}

module.exports = { keyLoc, startLedger, stopLedger, withLedger, summarize, G, GameState, GameLogic, ACTIONS, ERA, CARD_TYPES, newGame, hydrate, applyAction, applyFreeDevelop, developableTypes, chooseAI, cloneData, serialize };
