// 动作动画：把相邻两个服务端状态做差，得出“发生了什么”，再在 3D 版图和
// HTML 层上按顺序播放。对自己、对手和 AI 一视同仁（都只看状态变化）。
import { Sfx } from './sfx.js';

const SELLABLE = new Set(['cottonMill', 'manufacturer', 'pottery']);
const IND_ZH = t => (window.INDUSTRY_DISPLAY && INDUSTRY_DISPLAY[t] ? INDUSTRY_DISPLAY[t].name : t);
const LS = 'bb3d_fx';

// ------------------------------------------------------------------ diff
export function diffStates(a, b) {
    if (!a || !b || a.era !== b.era || b.gameOver) return null;     // era change / end: the scoring screen takes over
    const actor = a.currentPlayerId;
    const plan = { actor, built: [], links: [], flips: [], spend: [], market: [], beers: [], bonus: [], develop: [], money: [], income: [], vp: [],
        scout: false, discard: 0, turnTo: b.currentPlayerId !== a.currentPlayerId ? b.currentPlayerId : null, roundEnd: b.round !== a.round };
    const A = a.boardIndustries || {}, B = b.boardIndustries || {};
    const sameTile = (x, y) => x && y && x.playerId === y.playerId && x.type === y.type && (x.tileData || {}).level === (y.tileData || {}).level;
    for (const [k, t] of Object.entries(B)) if (!sameTile(A[k], t)) plan.built.push({ key: k, tile: t });
    for (const [f, t] of Object.entries(b.breweryFarmTiles || {})) if (t && !(a.breweryFarmTiles || {})[f]) plan.built.push({ key: `farm_${f}`, tile: t });
    for (const [id, l] of Object.entries(b.boardLinks || {})) if (!(a.boardLinks || {})[id]) plan.links.push({ id, link: l });
    for (const [k, t] of Object.entries(B)) if (sameTile(A[k], t) && !A[k].flipped && t.flipped) plan.flips.push({ key: k, tile: t, sold: SELLABLE.has(t.type) });
    // resources taken off tiles (coal / iron / beer)
    const res = (o, k) => (o[k] && o[k].resourceCubes) || 0;
    for (const [k, t] of Object.entries(A)) {
        if (!sameTile(t, B[k])) continue;
        const d = res(A, k) - res(B, k);
        if (d > 0) (t.type === 'brewery' ? plan.beers : plan.spend).push({ from: 'tile', key: k, kind: t.type === 'brewery' ? 'beer' : t.type === 'coalMine' ? 'coal' : 'iron', n: d });
    }
    for (const [f, t] of Object.entries(a.breweryFarmTiles || {})) {
        const u = (b.breweryFarmTiles || {})[f];
        if (t && u && (t.resourceCubes || 0) > (u.resourceCubes || 0)) plan.beers.push({ from: 'tile', key: `farm_${f}`, kind: 'beer', n: t.resourceCubes - u.resourceCubes });
    }
    for (const [kind, k] of [['coal', 'coalMarket'], ['iron', 'ironMarket']]) {
        const d = (b[k] || 0) - (a[k] || 0);
        if (d) plan.market.push({ kind, before: a[k] || 0, after: b[k] || 0 });
    }
    (a.merchantTiles || []).forEach((m, i) => { const n = (b.merchantTiles || [])[i]; if (m.hasBeer && n && !n.hasBeer) plan.beers.push({ from: 'merchant', index: i, kind: 'beer', n: 1, loc: m.location }); });
    for (const mb of plan.beers.filter(x => x.from === 'merchant')) plan.bonus.push(mb);
    // per-player numbers
    b.players.forEach((p, i) => {
        const q = a.players[i]; if (!q) return;
        if (p.money !== q.money) plan.money.push({ pid: i, from: q.money, to: p.money });
        if (p.incomeSpace !== q.incomeSpace) plan.income.push({ pid: i, d: incomeLevelFromSpace(p.incomeSpace) - incomeLevelFromSpace(q.incomeSpace) });
        if (p.vp !== q.vp) plan.vp.push({ pid: i, d: p.vp - q.vp });
    });
    // develop: tiles used from the actor's mat that did not land on the board
    const P0 = a.players[actor], P1 = b.players[actor];
    if (P0 && P1) {
        const usedOf = (p, t) => ((p.industryTiles || {})[t] || []).filter(x => x.used).length;
        for (const t of Object.keys(P1.industryTiles || {})) {
            const n = usedOf(P1, t) - usedOf(P0, t) - plan.built.filter(x => x.tile.playerId === actor && x.tile.type === t).length;
            for (let i = 0; i < n; i++) {
                const left = (P0.industryTiles[t] || []).filter(x => !x.used);
                plan.develop.push({ type: t, level: left[i] ? left[i].level : '' });
            }
        }
        plan.scout = (b.wildLocationPile < a.wildLocationPile) && (b.wildIndustryPile < a.wildIndustryPile);
        plan.loan = !plan.built.length && !plan.links.length && plan.income.some(x => x.pid === actor && x.d < 0) && P1.money > P0.money;
        plan.discard = plan.scout ? 3 : 1;
    }
    plan.empty = !plan.built.length && !plan.links.length && !plan.flips.length && !plan.develop.length && !plan.scout && !plan.loan && plan.turnTo == null && !plan.money.length;
    return plan;
}

// ------------------------------------------------------------------ player
export class Fx {
    constructor(app) {
        this.app = app;
        this.sfx = new Sfx();
        const saved = localStorage.getItem(LS);
        this.reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.mode = saved || (this.reduced ? 'fast' : 'normal');     // normal | fast | off
        this.layer = document.createElement('div'); this.layer.id = 'fx-layer'; document.body.appendChild(this.layer);
        this.activeFloats = [];
    }
    get speed() {
        if (this._speed !== undefined) return this._speed;
        return this.mode === 'off' ? 0 : this.mode === 'fast' ? 2 : 1;
    }
    set speed(v) {
        this._speed = v;
        if (v === 0) this.mode = 'off';
    }
    setMode(m) {
        this._speed = undefined;
        this.mode = m;
        localStorage.setItem(LS, m);
    }
    get simple() { return this.reduced || this.app.low; }
    snd(name, delay = 0, sp = this.speed) {
        if (sp) setTimeout(() => this.sfx.play(name, { rate: sp > 1 ? 1.25 : 1 }), delay / sp);
        else this.sfx.play(name);
    }

    // Play one diff; resolves when done (~1.5s at normal speed, faster when queue backs up, min ~0.6s).
    play(plan, boost = 1) {
        const board = this.app.board;
        const rawSp = this.speed * boost;
        const sp = this.speed === 0 ? 0 : Math.min(rawSp, 2.5);
        if (board) board.fxSpeed = sp;

        if (!plan || plan.empty || !this.speed || !sp) {
            if (plan && !plan.empty) {
                this.numbers(plan);
            }
            return Promise.resolve();
        }

        const W = [];
        const at = ms => ms;                       // delays are in "normal speed" ms; board scales them
        const T = ms => (sp ? ms / sp : 0);        // DOM timers
        // where resources go: first new tile / link / sold tile
        const dest = plan.built.length ? board.tileWorld(plan.built[0].key)
            : plan.links.length ? board.linkWorld(plan.links[0].id)
            : plan.flips.length ? board.tileWorld(plan.flips[0].key) : null;
        let k = 0;
        // coal / iron off tiles
        for (const s of plan.spend) for (let i = 0; i < s.n; i++) W.push(board.fly(s.kind, board.tileWorld(s.key), dest, at(80 * k++)));
        // market cubes: bought (fly to destination) or sold (fly from the new mine / works into the market)
        for (const m of plan.market) {
            const len = board.marketSpaces(m.kind).length;
            if (m.after < m.before) {
                for (let i = len - m.before; i < len - m.after; i++) W.push(board.fly(m.kind, board.marketWorld(m.kind, i), dest, at(80 * k++)));
            } else {
                const src = plan.built.length ? board.tileWorld(plan.built[0].key) : dest;
                for (let i = len - m.after; i < len - m.before; i++) {
                    const cube = board.marketCube(m.kind, i); if (cube) cube.visible = false;
                    W.push(board.fly(m.kind, src, board.marketWorld(m.kind, i), at(500 + 80 * k++), () => { if (cube) cube.visible = true; }));
                }
            }
        }
        if (plan.spend.length || plan.market.length) this.snd('cube', 400, sp);
        // beer
        const beerTo = plan.flips.length ? board.tileWorld(plan.flips[0].key) : dest;
        plan.beers.forEach((b, i) => {
            const from = b.from === 'merchant' ? board.merchPos[b.index] : board.tileWorld(b.key);
            for (let j = 0; j < b.n; j++) W.push(board.fly('beer', from, beerTo, at(100 * (i + j))));
        });
        if (plan.beers.length) this.snd('beer', 450, sp);
        // new tiles and links
        plan.built.forEach((b, i) => { W.push(board.dropTile(b.key, at(150 + 100 * i))); this.snd('build', 150 + 100 * i + 480, sp); });
        plan.links.forEach((l, i) => { W.push(board.growLink(l.id, at(100 + 150 * i))); this.snd('link', 100 + 150 * i, sp); });
        plan.flips.forEach((f, i) => { W.push(board.flipTile(f.key, at((plan.beers.length ? 450 : 50) + 100 * i))); this.snd('flip', (plan.beers.length ? 450 : 50) + 100 * i, sp); });
        // merchant bonus popup
        plan.bonus.forEach((b, i) => {
            const md = MERCHANTS[b.loc] || {};
            const txt = { vp: `+${md.bonusAmount} 分`, money: `+£${md.bonusAmount}`, income: `收入 +${md.bonusAmount}`, develop: `免费发展 ×${md.bonusAmount}` }[md.bonusType] || '商人奖励';
            const pos = board.merchPos[b.index];
            setTimeout(() => { if (pos) { const p = board.project(pos); this.float(p.x, p.y - 10, `🍺 ${txt}`, 'bonus big'); } this.sfx.play('bonus'); }, T(550 + 150 * i));
            if (pos) W.push(board.pulse(pos.clone(), 0xffd34d, at(550)));
        });
        // money / income / vp floats on the HUD and player chips
        setTimeout(() => this.numbers(plan), T(plan.built.length || plan.links.length ? 500 : 150));
        // develop: tile leaves the player mat
        if (plan.develop.length) {
            this.snd('discard', 100, sp);
            plan.develop.forEach((d, i) => setTimeout(() => this.develop(plan.actor, d), T(150 * i)));
        }
        if (plan.loan) this.snd('loan', 150, sp);
        // the card(s) played this action
        this.discard(plan.actor, plan.scout ? 3 : 1, plan.scout, T);
        if (plan.scout) this.snd('discard', 0, sp);
        // whose turn
        if (plan.turnTo != null) setTimeout(() => this.app.turnNotice(plan.turnTo), T(850));

        const all = Promise.all(W);
        const minTime = new Promise(r => setTimeout(r, T(1450)));
        const cap = new Promise(r => setTimeout(r, T(2000)));
        return Promise.race([
            Promise.all([all, minTime]).then(() => new Promise(r => setTimeout(r, T(50)))),
            cap
        ]);
    }

    // anchor rect for a player: my HUD (money) or their chip
    anchor(pid) {
        const el = pid === this.app.me ? document.querySelector('#hud-money') : document.querySelector(`#opps .opp[data-pid="${pid}"]`);
        return el ? el.getBoundingClientRect() : null;
    }
    numbers(plan) {
        const me = this.app.me;
        const incDelay = this.speed === 0 ? 0 : 260;
        const vpDelay = this.speed === 0 ? 0 : 480;
        for (const m of plan.money) {
            const r = this.anchor(m.pid); const d = m.to - m.from;
            if (r) this.float(r.left + r.width / 2, r.bottom + 4, `${d > 0 ? '+' : '−'}£${Math.abs(d)}`, d > 0 ? 'up' : 'down', true);
            if (m.pid === me) { this.roll(document.querySelector('#hud-money b'), m.from, m.to); if (this.speed) this.snd(d > 0 ? 'coin' : 'coinDown'); }
            else { const el = document.querySelector(`#opps .opp[data-pid="${m.pid}"] .om`); if (el) this.roll(el, m.from, m.to, '£'); }
        }
        for (const x of plan.income) {
            const r = this.anchor(x.pid); if (!r) continue;
            const text = `收入 ${x.d > 0 ? '+' : ''}${x.d}`;
            const cls = x.d > 0 ? 'up' : 'down';
            if (incDelay) setTimeout(() => this.float(r.left + r.width / 2, r.bottom + 4, text, cls, true), incDelay);
            else this.float(r.left + r.width / 2, r.bottom + 4, text, cls, true);
        }
        for (const x of plan.vp) {
            const r = this.anchor(x.pid); if (!r) continue;
            const text = `${x.d > 0 ? '+' : ''}${x.d} ★`;
            if (vpDelay) setTimeout(() => this.float(r.left + r.width / 2, r.bottom + 4, text, 'vp', true), vpDelay);
            else this.float(r.left + r.width / 2, r.bottom + 4, text, 'vp', true);
        }
        if (plan.vp.length && this.speed) this.snd('score');
    }
    // number roll on an element: £12 → £20
    roll(el, from, to, prefix = '') {
        if (!el) return;
        const t0 = performance.now(), dur = this.speed ? 800 / this.speed : 0;
        el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump', to > from ? 'gain' : 'loss');
        const step = () => {
            const k = dur ? Math.min(1, (performance.now() - t0) / dur) : 1;
            el.textContent = prefix + Math.round(from + (to - from) * (1 - (1 - k) ** 3));
            if (k < 1) requestAnimationFrame(step); else setTimeout(() => el.classList.remove('bump', 'gain', 'loss'), 300);
        };
        step();
    }
    float(x, y, text, cls = '', under = false) {
        const isOff = this.mode === 'off' || this.speed === 0;
        const durMs = isOff ? 1500 : 2500;
        const now = performance.now();
        this.activeFloats = (this.activeFloats || []).filter(f => f.expire > now && f.el && f.el.isConnected);

        let targetY = y;
        const H = 28;
        const step = (y > (window.innerHeight || 800) / 2) ? -H : H;
        const nearFloats = this.activeFloats.filter(f => Math.abs(f.x - x) < 70);
        while (nearFloats.some(f => Math.abs(f.y - targetY) < H - 4)) {
            targetY += step;
        }

        const el = document.createElement('div');
        el.className = `fx-float ${cls}${under ? ' under' : ''}${isOff ? ' off-mode' : ''}`;
        el.textContent = text;
        el.style.left = x + 'px';
        el.style.top = targetY + 'px';
        el.style.animationDuration = `${durMs}ms`;
        this.layer.appendChild(el);

        const entry = { x, y: targetY, expire: now + durMs, el };
        this.activeFloats.push(entry);

        setTimeout(() => {
            el.remove();
            const idx = this.activeFloats.indexOf(entry);
            if (idx >= 0) this.activeFloats.splice(idx, 1);
        }, durMs + 50);
    }
    // a card (or three) flies from the player's hand / chip to the discard
    discard(pid, n, scout, T) {
        if (!this.speed) return;
        const from = pid === this.app.me ? document.querySelector('#hand') : document.querySelector(`#opps .opp[data-pid="${pid}"]`);
        if (!from) return;
        const r = from.getBoundingClientRect();
        for (let i = 0; i < n; i++) {
            const c = document.createElement('div'); c.className = 'fx-card';
            c.style.left = (r.left + r.width / 2 - 26 + i * 10) + 'px'; c.style.top = (r.top + r.height / 2 - 38) + 'px';
            c.style.setProperty('--dx', `${(innerWidth / 2 - r.left - r.width / 2) * 0.4 + (i - 1) * 30}px`);
            c.style.setProperty('--dy', `${pid === this.app.me ? -160 : 140}px`);
            c.style.animationDuration = `${T(900)}ms`; c.style.animationDelay = `${T(i * 100)}ms`;
            this.layer.appendChild(c); setTimeout(() => c.remove(), T(1000 + i * 100));
        }
        if (scout && pid === this.app.me) setTimeout(() => document.querySelectorAll('#hand .card').forEach(el => {
            if (/wild/.test(el.querySelector('img') && el.querySelector('img').src)) { el.classList.add('fx-new'); setTimeout(() => el.classList.remove('fx-new'), 900); }
        }), T(400));
    }
    develop(pid, d) {
        const name = `${IND_ZH(d.type)} ${d.level ? ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'][d.level] : ''}`;
        if (pid === this.app.me) {
            const el = document.querySelector(`#mat .mtile[data-type="${d.type}"]`);
            if (el) {
                const r = el.getBoundingClientRect();
                const ghost = el.querySelector('img') ? el.querySelector('img').cloneNode() : null;
                if (ghost && this.speed) {
                    ghost.className = 'fx-ghost'; Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: Math.min(r.width, 56) + 'px' });
                    this.layer.appendChild(ghost); setTimeout(() => ghost.remove(), 1100);
                }
                el.classList.add('fx-flash'); setTimeout(() => el.classList.remove('fx-flash'), 1100);
                this.float(r.left + r.width / 2, r.top, `发展 −${name}`, 'dev');
                return;
            }
        }
        const r = this.anchor(pid);
        if (r) this.float(r.left + r.width / 2, r.bottom + 26, `发展 −${name}`, 'dev', true);
    }
}
