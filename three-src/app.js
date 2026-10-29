// 伯明翰 3D 前端：大厅 + 对局界面 + "先点后确认" 的交互流程。
// 规则全部来自 js/gameLogic.js（与服务端同一份引擎），这里只做呈现与选择。
import { Board3D, PLAYER_CSS, ownerInitial, tilePath } from './board3d.js';
import { Net } from './net.js';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STEM = { cottonMill: 'cotton', coalMine: 'coal', ironWorks: 'iron', manufacturer: 'goods', pottery: 'pottery', brewery: 'brewery' };
const ORDER = ['cottonMill', 'coalMine', 'ironWorks', 'manufacturer', 'pottery', 'brewery'];
const V = '?v=3d1';
const tileImg = (type, level, flipped, pid) => `${tilePath(pid, `${STEM[type]}-${level}${flipped ? '-flipped' : ''}.jpg`)}${V}`;
const indName = t => (INDUSTRY_DISPLAY[t] ? INDUSTRY_DISPLAY[t].name : t);
const connName = c => c ? `${c.cities.map(locationName).join(' — ')}${c.viaBrewery ? '（经农场酿酒厂）' : ''}` : '';
const ownerBadge = (p, pid) => `<i class="ob" style="--pc:${PLAYER_CSS[pid]}" data-ink="${pid}">${esc(ownerInitial(p.name))}<sub>${pid + 1}</sub></i>`;
const DIFF = { easy: '简单', normal: '普通', hard: '困难' };
const ACT = [
    ['build', '建造'], ['network', '建网'], ['sell', '销售'], ['develop', '发展'],
    ['loan', '贷款'], ['scout', '侦察'], ['pass', '跳过'],
];
const ACT_NAME = Object.fromEntries(ACT);

function cardImg(card) {
    if (!card) return null;
    switch (card.type) {
        case 'location': return `assets/cards/${card.location}.jpg${V}`;
        case 'industry': return `assets/cards/${card.industryTypes[0]}.jpg${V}`;
        case 'wildLocation': return `assets/cards/wild-location.jpg${V}`;
        case 'wildIndustry': return `assets/cards/wild-industry.jpg${V}`;
        default: return `assets/cards/back.jpg${V}`;
    }
}

function hydrate(data) { const s = Object.create(GameState.prototype); Object.assign(s, data); return s; }

function toast(text, type = 'info') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = text;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'];
const costLine = td => `£${td.cost}${td.costCoal ? ` <span class="rc coal">煤${td.costCoal}</span>` : ''}${td.costIron ? ` <span class="rc iron">铁${td.costIron}</span>` : ''}${td.beersToSell ? ` <span class="rc beer">售需啤酒${td.beersToSell}</span>` : ''}`;
const gainLine = td => `${td.vp} 分 · 收入 +${td.income} · 连线 ${td.linkVP}`;
function tileInfo(td, type) {
    const parts = [`费用 £${td.cost}`];
    if (td.costCoal) parts.push(`煤 ${td.costCoal}`);
    if (td.costIron) parts.push(`铁 ${td.costIron}`);
    if (td.beersToSell) parts.push(`销售需啤酒 ${td.beersToSell}`);
    const res = td.resourceCubes ? `，产出 ${td.resourceCubes} ${type === 'brewery' ? '桶啤酒' : type === 'coalMine' ? '煤' : '铁'}` : '';
    const era = td.canalEra && td.railEra ? '两个时代' : td.canalEra ? '仅运河时代' : '仅铁路时代';
    return `${parts.join(' · ')}${res}\n翻面得 ${td.vp} 分、收入 +${td.income}，连线分 ${td.linkVP} · ${era}${td.canDevelop ? '' : ' · 不可发展'}`;
}

// ==========================================================================
class App {
    constructor() {
        this.low = /[?&]low=1/.test(location.search) || (navigator.hardwareConcurrency || 4) <= 2;
        this.net = new Net({ message: m => this.onMessage(m), status: ok => this.onStatus(ok) });
        this.msg = null; this.state = null; this.logic = null; this.me = -1;
        this.ix = this.freshIx();
        this.seenEvents = JSON.parse(localStorage.getItem('bb3d_seen') || '{}');
        this.bindStatic();
        this.autoJoin();
    }

    freshIx(card = null) { return { mode: 'idle', card, slot: null, ind: null, links: [], sell: [], beerM: {}, dev: [], scout: [] }; }

    // ---------------------------------------------------------------- shell
    show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }

    bindStatic() {
        $('#name').value = localStorage.getItem('bb_name') || '';
        const params = new URLSearchParams(location.search);
        const urlRoom = (params.get('room') || '').toUpperCase();
        if (urlRoom) $('#code').value = urlRoom;
        const needName = () => {
            const v = $('#name').value.trim();
            if (!v) { this.homeMsg('请先填写昵称'); $('#name').focus(); return false; }
            this.net.name = v; return true;
        };
        document.querySelectorAll('[data-create]').forEach(b => b.onclick = () => {
            if (!needName()) return;
            this.homeMsg('正在创建房间…');
            this.solo = b.dataset.solo ? +b.dataset.create : 0;
            this.net.send({ t: 'create', name: this.net.name, seats: +b.dataset.create });
        });
        const join = () => {
            if (!needName()) return;
            const code = $('#code').value.trim().toUpperCase();
            if (!/^[A-Z0-9]{4}$/.test(code)) return this.homeMsg('请输入 4 位房间号');
            this.homeMsg('正在加入…');
            this.net.code = code;
            this.net.send({ t: 'join', code, name: this.net.name });
        };
        $('#join').onclick = join;
        $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
        $('#lobby-start').onclick = () => this.net.send({ t: 'start' });
        $('#lobby-leave').onclick = () => this.net.send({ t: 'leave' });
        $('#lobby-copy').onclick = () => this.copy($('#lobby-link').value);
        document.querySelectorAll('.seat-count button').forEach(b => b.onclick = () => this.net.send({ t: 'setSeats', n: +b.dataset.n }));
        $('#btn-view').onclick = () => this.board && this.board.resetView();
        $('#btn-zoom-in').onclick = () => this.board && this.board.zoom(0.8);
        $('#btn-zoom-out').onclick = () => this.board && this.board.zoom(1.25);
        $('#btn-log').onclick = () => document.body.classList.toggle('show-log');
        $('#btn-seats').onclick = () => this.seatsModal();
        $('#btn-exit').onclick = () => {
            if (!confirm('退出到首页？座位会保留，用同一浏览器打开房间链接即可回来。')) return;
            this.net.lastRoom = null; location.href = location.pathname;
        };
        $('#btn-reclaim').onclick = () => this.net.send({ t: 'reclaim' });
        $('#btn-panels').onclick = () => document.body.classList.toggle('show-side');
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { if (!$('#modal').hidden && !this.modalLocked) this.closeModal(); else this.cancel(); }
        });
        $('#modal-close').onclick = () => this.closeModal();
        $('#btn-board').onclick = () => this.openBoardModal();
        this.bindPreview();
    }

    autoJoin() {
        const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
        const code = urlRoom || this.net.lastRoom;
        if (code && localStorage.getItem('bb_name')) {
            this.net.code = code;
            this.homeMsg(`正在进入房间 ${code}…`);
            this.net.connect();
        } else if (urlRoom) this.homeMsg(`受邀加入房间 ${urlRoom}：填写昵称后点"加入"`);
    }

    homeMsg(t) { $('#home-msg').textContent = t || ''; }
    copy(text) {
        const ok = () => toast('已复制邀请链接', 'success');
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, () => toast('请手动复制', 'warn'));
        else { const i = $('#lobby-link'); i.select(); try { document.execCommand('copy'); ok(); } catch { toast('请手动复制', 'warn'); } }
    }

    onStatus(ok) {
        $('#net-dot').classList.toggle('off', !ok);
        $('#net-dot').title = ok ? '已连接' : '连接中断，正在重连…';
        if (this.state) this.refresh();
    }

    onMessage(m) {
        if (m.t === 'error') {
            if (m.code === 'noroom') {
                this.net.code = null; this.net.lastRoom = null;
                history.replaceState(null, '', location.pathname);
                this.show('home'); this.homeMsg(m.message);
            } else { toast(m.message, 'error'); this.homeMsg(m.message); }
            this.busy = false; this.refresh && this.state && this.refresh();
            return;
        }
        if (m.t === 'result') { this.busy = false; toast(m.message, m.ok ? 'success' : 'error'); if (!m.ok) this.refresh(); return; }
        if (m.t === 'left') {
            this.net.code = null; this.net.lastRoom = null; this.msg = null;
            history.replaceState(null, '', location.pathname); this.show('home'); return;
        }
        if (m.t !== 'room') return;
        this.msg = m; this.me = m.you.seat; this.isHost = m.you.isHost;
        this.net.code = m.room.code; this.net.lastRoom = m.room.code;
        if (!new URLSearchParams(location.search).get('room')) history.replaceState(null, '', `?room=${m.room.code}`);
        if (m.room.status === 'lobby' || !m.game) { this.renderLobby(m); this.show('lobby'); }
        else this.renderGame(m);
    }

    // ---------------------------------------------------------------- lobby
    renderLobby(m) {
        const room = m.room;
        // "单人对战 AI": fill the other seats with AI and start straight away
        if (this.solo && this.isHost) {
            const empty = room.seats.filter(s => !s.human && !s.ai);
            if (empty.length) { empty.forEach(s => this.net.send({ t: 'setAI', seat: s.index, on: true, difficulty: 'normal' })); return; }
            this.solo = 0; this.net.send({ t: 'start' }); return;
        }
        $('#lobby-code').textContent = room.code;
        $('#lobby-link').value = `${location.origin}${location.pathname}?room=${room.code}`;
        document.querySelectorAll('.seat-count button').forEach(b => { b.classList.toggle('on', +b.dataset.n === room.numSeats); b.disabled = !this.isHost; });
        const box = $('#lobby-seats'); box.innerHTML = '';
        room.seats.forEach((s, i) => {
            const me = i === this.me;
            let label = s.human ? `${esc(s.name)}${me ? '（你）' : ''}` : s.ai ? `${esc(s.name)} <span class="chip">AI·${DIFF[s.difficulty] || '普通'}</span>` : '<span class="muted">空位 · 等待加入</span>';
            if (s.host) label += ' <span class="chip">房主</span>';
            if (s.human && !s.online) label += ' <span class="chip off">离线</span>';
            let ctl = '';
            if (!s.human && !s.ai) {
                if (this.isHost) ctl += `<select data-diff="${i}"><option value="easy">简单</option><option value="normal" selected>普通</option><option value="hard">困难</option></select><button data-a="ai-on" data-s="${i}">设为 AI</button>`;
                if (!me) ctl += `<button data-a="sit" data-s="${i}">坐这里</button>`;
            } else if (s.ai && this.isHost) ctl += `<button data-a="ai-off" data-s="${i}">移除 AI</button>`;
            else if (s.human && this.isHost && !s.host) ctl += `<button data-a="kick" data-s="${i}">移出</button>`;
            if (me && !s.host) ctl += `<button data-a="stand" data-s="${i}">离座观战</button>`;
            const row = document.createElement('div');
            row.className = 'seat';
            row.innerHTML = `<i class="sw" style="background:${PLAYER_COLORS[i]}"></i><div class="seat-name">${label}</div><div class="seat-ctl">${ctl}</div>`;
            box.appendChild(row);
        });
        box.querySelectorAll('button[data-a]').forEach(b => b.onclick = () => {
            const seat = +b.dataset.s, a = b.dataset.a;
            if (a === 'ai-on') this.net.send({ t: 'setAI', seat, on: true, difficulty: (box.querySelector(`[data-diff="${seat}"]`) || {}).value || 'normal' });
            else if (a === 'ai-off') this.net.send({ t: 'setAI', seat, on: false });
            else if (a === 'kick') this.net.send({ t: 'kick', seat });
            else if (a === 'sit') this.net.send({ t: 'sit', seat });
            else if (a === 'stand') this.net.send({ t: 'standUp' });
        });
        $('#lobby-spec').textContent = room.spectators.length ? `观战：${room.spectators.join('、')}` : '';
        const filled = room.seats.every(s => s.human || s.ai);
        $('#lobby-start').hidden = !this.isHost;
        $('#lobby-start').disabled = !filled;
        $('#lobby-hint').textContent = this.isHost ? (filled ? '人齐了，可以开始。' : '把邀请链接或房间号发给朋友；空位可以设为 AI。')
            : (this.me >= 0 ? '已入座，等待房主开始…' : '你在观战，可点空位入座。');
    }

    // ---------------------------------------------------------------- game
    renderGame(m) {
        const first = !this.board;
        this.show('game');
        if (first) {
            this.board = new Board3D($('#stage'), {
                low: this.low, preserve: /[?&]test=1/.test(location.search),
                onPick: (hit, e) => this.onBoardPick(hit, e),
                onHover: (hit, e) => this.onBoardHover(hit, e),
            });
            window.__bb3d = this;
            this.layoutInsets();
            window.addEventListener('resize', () => { this.layoutInsets(); clearTimeout(this.rsT); this.rsT = setTimeout(() => this.board.resetView(), 150); });
        }
        const versionChanged = this.version !== m.version;
        this.version = m.version;
        this.state = hydrate(m.game);
        this.state.players.forEach((p, i) => { p.color = PLAYER_CSS[i] || p.color; });
        this.logic = new GameLogic(this.state);
        if (versionChanged) { this.busy = false; this.ix = this.freshIx(); }
        this.board.update(this.state, this.me);
        this.refresh();
        this.handleBonus(m);
        this.handleEvent(m);
        if (first) requestAnimationFrame(() => { this.layoutInsets(); this.board.resetView(); });
    }

    layoutInsets() {
        if (!this.board) return;
        const top = $('#topbar').getBoundingClientRect().bottom;
        const dock = $('#dock').getBoundingClientRect();
        const wide = window.innerWidth >= 900;
        const left = wide ? $('#side-left').getBoundingClientRect().right : 0;
        const right = wide ? window.innerWidth - $('#side-right').getBoundingClientRect().left : 0;
        document.body.style.setProperty('--dockh', Math.round(window.innerHeight - dock.top) + 'px');
        this.board.insets = { top: top + 4, bottom: window.innerHeight - dock.top + 4, left: Math.max(0, left), right: Math.max(0, right) };
    }

    get my() { return this.me >= 0 && this.state ? this.state.players[this.me] : null; }

    myTurn() {
        const m = this.msg, s = this.state;
        return !!(m && s && m.room.status === 'playing' && this.me >= 0 && s.currentPlayerId === this.me &&
            !s.players[this.me].isAI && !m.pendingBonus && this.net.connected && !this.busy);
    }

    // All the derived "what can I do" data for the current situation.
    buildTargets() { return this.myTurn() ? this.logic.getValidBuildTargets(this.me) : []; }
    cardsFor(t) { return this.logic.getValidCardsForAction(this.me, ACTIONS.BUILD, t); }
    targetsWithCard(card) { return this.buildTargets().filter(t => card == null || this.cardsFor(t).includes(card)); }

    refresh() {
        if (!this.state) return;
        this.renderTop(); this.renderPlayers(); this.renderMarkets(); this.renderMat();
        this.renderHand(); this.renderActions(); this.renderPanel(); this.renderLog();
        if (this.modalKind === 'board' && !$('#modal').hidden) this.openBoardModal(this.boardPid);
        this.updateHighlights();
        if (this.board) this.layoutInsets();
    }

    renderTop() {
        const s = this.state, cur = s.players[s.currentPlayerId];
        const left = s.actionsPerTurn - s.actionsThisTurn;
        $('#era').textContent = s.era === 'canal' ? '运河时代' : '铁路时代';
        $('#era').className = 'era ' + s.era;
        $('#round').textContent = `第 ${s.round} 轮`;
        const st = this.msg.room.status === 'ended' ? '游戏结束' :
            this.msg.pendingBonus && this.msg.pendingBonus.waiting != null ? `等待 ${s.players[this.msg.pendingBonus.waiting].name} 选择奖励` :
            `${s.currentPlayerId === this.me ? '轮到你' : '当前：' + cur.name} · 剩 ${left} 个动作`;
        $('#turn').innerHTML = `<i class="sw" style="background:${cur.color}"></i>${esc(st)}`;
        $('#deck').textContent = `牌堆 ${s.drawDeck.length}`;
        $('#room-code').textContent = this.msg.room.code;
        const mine = this.my;
        $('#btn-reclaim').hidden = !(mine && mine.isAI && this.msg.room.status === 'playing');
    }

    renderPlayers() {
        const s = this.state, box = $('#players');
        const order = s.turnOrder && s.turnOrder.length ? s.turnOrder : s.players.map((_, i) => i);
        box.innerHTML = order.map((pid, n) => {
            const p = s.players[pid], seat = this.msg.room.seats[pid] || {};
            const cur = pid === s.currentPlayerId;
            const links = s.era === 'canal' ? `运河 ${p.linksRemaining.canal}` : `铁路 ${p.linksRemaining.rail}`;
            const spent = (s.moneySpentThisRound || {})[pid] || 0;
            const tags = [p.isAI ? '<span class="chip">AI</span>' : '', pid === this.me ? '<span class="chip me">你</span>' : '', seat.human && !seat.online ? '<span class="chip off">离线</span>' : ''].join('');
            return `<div class="pcard${cur ? ' cur' : ''}" data-pid="${pid}" style="--pc:${p.color}" title="悬停：只看 ${esc(p.name)} 的产业和连线；点击：看 TA 的产业板">
              <div class="pname">${ownerBadge(p, pid)}${esc(p.name)} ${tags}<span class="muted small porder" title="本轮行动顺序">第${n + 1}位</span></div>
              <div class="pstats"><span title="资金">£${p.money}</span><span title="收入等级">收入 ${incomeLevelFromSpace(p.incomeSpace)}</span><span title="胜利点">${p.vp} 分</span></div>
              <div class="pstats sub"><span>手牌 ${p.hand.length}</span><span>${links}</span><span title="本轮花费（决定下轮顺序）">本轮花 £${spent}</span></div>
            </div>`;
        }).join('');
        box.querySelectorAll('.pcard').forEach(el => {
            el.onmouseenter = () => this.board && this.board.setFocus(+el.dataset.pid);
            el.onmouseleave = () => this.board && this.board.setFocus(null);
            el.onclick = e => { if (!e.target.closest('button')) this.openBoardModal(+el.dataset.pid); };
        });
        // colour legend in the top bar (also a focus toggle on touch)
        $('#legend').innerHTML = s.players.map((p, pid) => `<span class="lg${this.focusPid === pid ? ' on' : ''}" data-pid="${pid}" title="${esc(p.name)}：点按只看 TA 的版图资产">${ownerBadge(p, pid)}<span class="lg-n">${esc(p.name)}</span></span>`).join('');
        $('#legend').querySelectorAll('.lg').forEach(el => {
            el.onmouseenter = () => this.board && this.board.setFocus(+el.dataset.pid);
            el.onmouseleave = () => this.board && this.board.setFocus(this.focusPid ?? null);
            el.onclick = () => { const pid = +el.dataset.pid; this.focusPid = this.focusPid === pid ? null : pid; this.board && this.board.setFocus(this.focusPid ?? null); this.renderPlayers(); };
        });
    }

    renderMarkets() {
        const s = this.state;
        const cubes = (n, max, cls) => Array.from({ length: max }, (_, i) => `<i class="cube ${cls}${i < n ? '' : ' empty'}"></i>`).join('');
        $('#markets').innerHTML = `
          <div class="mk"><div class="mk-h">煤市场 <b>£${s.getCoalPrice()}</b><span class="muted">/块 · 剩 ${s.coalMarket}</span></div><div class="cubes">${cubes(s.coalMarket, 14, 'coal')}</div></div>
          <div class="mk"><div class="mk-h">铁市场 <b>£${s.getIronPrice()}</b><span class="muted">/块 · 剩 ${s.ironMarket}</span></div><div class="cubes">${cubes(s.ironMarket, 10, 'iron')}</div></div>
          <div class="mk muted">万能地点 ${s.wildLocationPile} · 万能产业 ${s.wildIndustryPile}</div>`;
    }

    renderMat() {
        const box = $('#mat');
        const p = this.my;
        if (!p) { box.innerHTML = '<div class="muted">观战中</div>'; return; }
        box.style.setProperty('--pc', PLAYER_CSS[this.me] || 'transparent');
        const rem = this.state.getRemainingTiles(this.me);
        const devTypes = this.ix.mode === 'develop' && this.myTurn() ? new Set(this.logic.getDevelopableTypes(this.me).map(t => t.type)) : new Set();
        box.innerHTML = ORDER.map(type => {
            const r = rem[type], lv = this.levelStrip(this.me, type);
            if (!r.count) return `<div class="mtile none" data-type="${type}"><div class="mimg empty"></div><div class="mtxt"><b>${indName(type)}</b><div class="muted">已用完</div></div></div>`;
            const td = r.tiles[0];
            const chosen = this.ix.dev.filter(x => x === type).length;
            const cls = (devTypes.has(type) ? ' can' : '') + (chosen ? ' chosen' : '');
            return `<div class="mtile${cls}" data-type="${type}" data-preview="tile" data-img="${tileImg(type, td.level, false, this.me)}" data-cap="${indName(type)} ${td.level} 级（剩 ${r.count} 块）" data-info="${esc(tileInfo(td, type))}">
              <img class="mimg" src="${tileImg(type, td.level, false, this.me)}" alt="">${chosen ? `<b class="badge">${chosen > 1 ? '×2' : '✓'}</b>` : ''}
              <div class="mtxt"><b>${indName(type)} ${ROMAN[td.level]}</b> <span class="muted">剩 ${r.count}</span>
                <div>${costLine(td)}</div><div>${gainLine(td)}${td.canDevelop ? '' : ' · <span class="warn">不可发展</span>'}</div>
                <div class="lvs">${lv}</div></div></div>`;
        }).join('');
        box.querySelectorAll('.mtile.can').forEach(el => el.onclick = () => this.toggleDevelop(el.dataset.type));
    }

    // per-level remaining counts, e.g. Ⅰ×0 Ⅱ×2 … (used-up levels dimmed)
    levelGroups(pid, type) {
        const all = (this.state.players[pid].industryTiles || {})[type] || [];
        const g = new Map();
        for (const t of all) { const e = g.get(t.level) || { td: t, total: 0, left: 0 }; e.total++; if (!t.used) e.left++; g.set(t.level, e); }
        return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([level, e]) => ({ level, ...e }));
    }
    levelStrip(pid, type) {
        const gs = this.levelGroups(pid, type), next = gs.find(x => x.left);
        return gs.map(x => `<span class="lv${x.left ? '' : ' out'}${x === next ? ' next' : ''}">${ROMAN[x.level]}×${x.left}</span>`).join('');
    }
    openBoardModal(pid = this.me >= 0 ? this.me : 0) {
        const s = this.state;
        const tabs = s.players.map((p, i) => `<button class="btab${i === pid ? ' on' : ''}" data-bp="${i}" style="--pc:${PLAYER_CSS[i]}">${ownerBadge(p, i)}${esc(p.name)}${i === this.me ? '（你）' : ''}</button>`).join('');
        const rows = ORDER.map(type => {
            const gs = this.levelGroups(pid, type), next = gs.find(x => x.left);
            return `<div class="brow"><div class="bname">${indName(type)}<span class="muted">剩 ${gs.reduce((a, x) => a + x.left, 0)}</span></div><div class="blv">${gs.map(x => {
                const td = x.td, era = td.canalEra && td.railEra ? '' : td.canalEra ? '<span class="era">仅运河</span>' : '<span class="era">仅铁路</span>';
                return `<div class="bt${x.left ? '' : ' out'}${x === next ? ' next' : ''}" data-preview="tile" data-img="${tileImg(type, x.level, false, pid)}" data-cap="${indName(type)} ${x.level} 级（剩 ${x.left}/${x.total}）" data-info="${esc(tileInfo(td, type))}">
                  <div class="bimg"><img src="${tileImg(type, x.level, false, pid)}" alt=""><b class="bcnt">×${x.left}<small>/${x.total}</small></b>${x === next ? '<b class="bnext">下一块</b>' : ''}</div>
                  <div class="bc">${costLine(td)}</div><div class="bg">${td.vp} 分 · +${td.income}</div><div class="bg">连线 ${td.linkVP}${td.canDevelop ? '' : ' · <span class="warn">不可发展</span>'}</div>${era}</div>`;
            }).join('')}</div></div>`;
        }).join('');
        this.openModal(`${s.players[pid].name} 的产业板`, `<div class="btabs">${tabs}</div><div class="pboard" style="--pc:${PLAYER_CSS[pid]}">${rows}</div>`);
        $('#modal .modal-box').classList.add('wide');
        $('#modal-body').querySelectorAll('[data-bp]').forEach(b => b.onclick = () => this.openBoardModal(+b.dataset.bp));
        this.modalKind = 'board'; this.boardPid = pid;
    }

    renderHand() {
        const p = this.my, box = $('#hand');
        if (!p) { box.innerHTML = '<div class="muted hand-empty">观战中（看不到别人的手牌）</div>'; return; }
        const ix = this.ix, turn = this.myTurn();
        let valid = null;           // which cards are playable in the current step
        if (turn && ix.mode === 'build' && ix.slot && ix.ind) valid = new Set(this.cardsFor(this.curBuildTarget() || {}));
        else if (turn && ix.mode === 'idle') valid = new Set(p.hand.map((c, i) => i).filter(i => this.targetsWithCard(i).length || true));
        box.innerHTML = p.hand.map((c, i) => {
            const sel = ix.mode === 'scout' ? ix.scout.includes(i) : ix.card === i;
            const dim = valid && !valid.has(i);
            const name = cardDisplayName(c);
            const kind = c.type === 'location' ? '地点牌' : c.type === 'industry' ? '产业牌' : '万能牌';
            return `<button class="card${sel ? ' sel' : ''}${dim ? ' dim' : ''}" data-i="${i}" data-preview="card" data-img="${cardImg(c)}" data-cap="${esc(name)}（${kind}）">
                <img src="${cardImg(c)}" alt="" draggable="false"><span>${esc(name)}</span></button>`;
        }).join('') || '<div class="muted hand-empty">手牌已打完</div>';
        box.querySelectorAll('.card').forEach(el => el.addEventListener('click', () => {
            if (Date.now() < this.suppressClick) return;
            this.hidePreview();
            this.onCard(+el.dataset.i);
        }));
    }

    renderActions() {
        const box = $('#actions');
        const turn = this.myTurn();
        this.actReasons = {};
        box.innerHTML = ACT.map(([a, label]) => {
            let reason = turn ? this.whyNot(a) : '还没轮到你';
            if (!reason && a === 'build' && this.ix.card != null && !this.targetsWithCard(this.ix.card).length) reason = '这张牌没有可建造的位置（可换一张牌，或用它做别的动作）';
            this.actReasons[a] = reason;
            const on = this.ix.mode === a;
            // not the disabled attribute: disabled buttons get no hover/touch, and the reason must be readable
            return `<button class="act${on ? ' on' : ''}${reason ? ' dis' : ''}" data-a="${a}" aria-disabled="${reason ? 'true' : 'false'}" data-tip="${esc(reason || ACT_TIP[a])}">${label}</button>`;
        }).join('');
        box.querySelectorAll('.act').forEach(b => {
            const a = b.dataset.a;
            b.onclick = () => { if (this.actReasons[a]) { toast(`${ACT_NAME[a]}不可用：${this.actReasons[a]}`, 'warn'); return; } this.startAction(a); };
            b.onmouseenter = () => { const r = b.getBoundingClientRect(); this.showTip(this.actReasons[a] ? `${ACT_NAME[a]}不可用\n${this.actReasons[a]}` : ACT_TIP[a], r.left + r.width / 2, r.top - 8, true); };
            b.onmouseleave = () => this.hideTip();
        });
    }

    // Why an action button is unavailable, worked out from the same rules
    // engine the server uses (the engine's own reason, made specific).
    whyNot(a) {
        const L = this.logic, s = this.state, me = this.me, p = this.my;
        const base = L.getDisabledReason(a, me);
        if (!base || !p.hand.length) return base;
        const money = p.money;
        const rich = fn => { p.money = 1e9; try { return fn(); } finally { p.money = money; } };
        switch (a) {
            case 'build': {
                const t = rich(() => L.getValidBuildTargets(me));
                if (t.length) return `资金不足：最便宜的建造需要 £${Math.min(...t.map(x => x.cost.total))}，你只有 £${money}`;
                L.calculateBuildCost = () => ({ money: 0, coal: 0, coalCost: 0, iron: 0, ironCost: 0, total: 0 });
                let t2; try { t2 = L.getValidBuildTargets(me); } finally { delete L.calculateBuildCost; }
                if (t2.length) {
                    const noCoal = t2.filter(x => x.tileData.costCoal > 0 && s.findCoalSource(x.cityId, me).length < x.tileData.costCoal);
                    if (noCoal.length) return `缺煤：能建的位置（如${locationName(noCoal[0].cityId)}的${indName(noCoal[0].industryType)}）拿不到所需的煤——需连到有煤的煤矿，或连到商人才能买市场煤`;
                    return '缺铁：能建的位置都拿不到所需的铁';
                }
                return '没有可建位置：手牌对应的地点没有合适的空位，或产业牌所需地点不在你的网络里';
            }
            case 'network': {
                if (/用完/.test(base)) return `${base}：你的${s.era === 'canal' ? '运河' : '铁路'}连线块已全部放到版图上`;
                const t = rich(() => L.getValidNetworkTargets(me));
                if (t.length) return `资金不足：建网需要 £${Math.min(...t.map(x => x.cost))}，你只有 £${money}`;
                const free = L.playerHasNoTilesOnBoard(me);
                const cand = CONNECTIONS.filter(c => !s.boardLinks[c.id] && (s.era === 'canal' ? c.canal : c.rail) &&
                    (free || s.isInNetwork(me, c.cities[0]) || s.isInNetwork(me, c.cities[1])));
                if (cand.length && s.era !== 'canal') return '没有可用的煤：铁路每段需要 1 煤，你网络边上的线路两端都连不到煤矿或市场';
                return '没有可建的连线：与你网络相邻的线路都已被建，或本时代不能建';
            }
            case 'develop': {
                const iron = s.findIronSource(me);
                if (!iron.length) return base;
                if (!iron[0].free && iron[0].price > money) return `资金不足：发展要 1 铁（铁市场 £${iron[0].price}），你只有 £${money}`;
                return '玩家板上没有可发展的板块（剩下的最低级板块都不可发展）';
            }
            case 'sell': {
                const own = Object.entries(s.boardIndustries).filter(([, t]) => t.playerId === me && !t.flipped && isSellableIndustry(t.type));
                if (!own.length) return '没有可销售的产业：你在版图上没有未翻面的棉纺厂/制造厂/陶瓷厂';
                const linked = own.filter(([k, t]) => L.getSellMerchantsFor(me, k.split('_')[0], t.type).length);
                if (!linked.length) return `没有连到收购商人：你的${own.map(([k, t]) => locationName(k.split('_')[0]) + indName(t.type)).join('、')}都没有连到收购该产品的商人`;
                return '啤酒不足：可卖的产业需要啤酒，但相连的酿酒厂和商人都没有可用的啤酒';
            }
            case 'loan': return `收入太低：当前收入 ${s.getIncomeLevel(me)}，贷款要降 3 级，不能低于 -10`;
            case 'scout': return /3 张/.test(base) ? `${base}（你只有 ${p.hand.length} 张）` : base;
            default: return base;
        }
    }

    renderLog() {
        const s = this.state;
        $('#log').innerHTML = '<div class="log-h">日志</div>' + (this.msg.log || []).slice(0, 60).map(e => {
            const p = e.playerId != null ? s.players[e.playerId] : null;
            return `<div class="le ${e.type || ''}">${p ? `<i class="sw" style="background:${p.color}"></i><b>${esc(p.name)}</b> ` : ''}${esc(e.message)}</div>`;
        }).join('');
    }

    // ---------------------------------------------------------------- interaction
    cancel() { if (this.ix.mode !== 'idle' || this.ix.card != null) { this.ix = this.freshIx(); this.refresh(); } }

    back() {
        const ix = this.ix;
        if (ix.mode === 'build' && ix.ind && this.buildOptions(ix.slot).length > 1) ix.ind = null;
        else if (ix.mode === 'build' && ix.slot) { ix.slot = null; ix.ind = null; }
        else if (ix.mode === 'network' && ix.links.length) ix.links.pop();
        else if (ix.mode === 'sell' && ix.sell.length) ix.sell.pop();
        else if (ix.mode === 'develop' && ix.dev.length) ix.dev.pop();
        else if (ix.mode === 'scout' && ix.scout.length) ix.scout.pop();
        else { this.ix = this.freshIx(ix.mode === 'scout' ? null : ix.card); }
        this.refresh();
    }

    startAction(a) {
        if (!this.myTurn()) return;
        const card = this.ix.card;
        this.ix = this.freshIx(card);
        this.ix.mode = a;
        if (a === 'scout') { this.ix.scout = card != null ? [card] : []; this.ix.card = null; }
        this.refresh();
    }

    onCard(i) {
        const ix = this.ix;
        if (!this.myTurn()) { this.ix.card = ix.card === i ? null : i; this.renderHand(); return; }
        if (ix.mode === 'scout') {
            const k = ix.scout.indexOf(i);
            if (k >= 0) ix.scout.splice(k, 1); else if (ix.scout.length < 3) ix.scout.push(i); else toast('侦察只需弃 3 张牌', 'warn');
        } else if (ix.mode === 'build' && ix.slot) {
            const t = this.curBuildTarget();
            if (t && !this.cardsFor(t).includes(i)) { toast('这张牌不能用于这次建造', 'warn'); return; }
            ix.card = ix.card === i ? null : i;
        } else {
            ix.card = ix.card === i ? null : i;
            if (ix.mode === 'build' && ix.card != null && !this.targetsWithCard(ix.card).length) toast('这张牌没有可建造的位置，可以用来做其他动作', 'warn');
        }
        this.refresh();
    }

    buildOptions(slotKey) {
        if (!slotKey) return [];
        const [cityId, si] = this.splitKey(slotKey);
        return this.buildTargets().filter(t => t.cityId === cityId && t.slotIndex === si);
    }
    splitKey(k) { const i = k.lastIndexOf('_'); return [k.slice(0, i), +k.slice(i + 1)]; }
    curBuildTarget() { const ix = this.ix; return this.buildOptions(ix.slot).find(t => t.industryType === ix.ind) || null; }

    onBoardPick(hit) {
        if (!hit) return;
        const ix = this.ix, turn = this.myTurn();
        if (hit.kind === 'slot' || (hit.kind === 'tile' && hit.slotKey && ix.mode !== 'sell')) {
            if (!turn) { if (hit.kind === 'tile') this.tilePopup(hit); return; }
            if (!['idle', 'build'].includes(ix.mode)) { if (hit.kind === 'tile') this.tilePopup(hit); return; }
            const key = hit.kind === 'slot' ? hit.key : hit.slotKey;
            let opts = this.buildOptions(key);
            if (!opts.length) { if (hit.kind === 'tile') this.tilePopup(hit); else toast('现在不能在这里建造', 'warn'); return; }
            if (ix.card != null) {
                const withCard = opts.filter(t => this.cardsFor(t).includes(ix.card));
                if (!withCard.length) { toast('选中的牌不能在这里建造；先取消选牌，或换一张', 'warn'); return; }
                opts = withCard;
            }
            ix.mode = 'build'; ix.slot = key;
            ix.ind = opts.length === 1 ? opts[0].industryType : null;
            this.autoCard();
            this.refresh();
            return;
        }
        if (hit.kind === 'link' && turn && ix.mode === 'network' && hit.active) {
            if (ix.links.includes(hit.connId)) ix.links = ix.links.filter(x => x !== hit.connId);
            else if (ix.links.length < 2) ix.links.push(hit.connId);
            this.refresh(); return;
        }
        if (hit.kind === 'tile' && turn && ix.mode === 'sell' && hit.active) {
            const k = ix.sell.indexOf(hit.key);
            if (k >= 0) ix.sell.splice(k, 1); else ix.sell.push(hit.key);
            this.refresh(); return;
        }
        if (hit.kind === 'tile') this.tilePopup(hit);
    }

    // With a target picked, a single legal card is chosen for you.
    autoCard() {
        const ix = this.ix;
        if (ix.mode !== 'build' || !ix.ind || ix.card != null) return;
        const t = this.curBuildTarget(); if (!t) return;
        const v = this.cardsFor(t);
        if (v.length === 1) ix.card = v[0];
    }

    toggleDevelop(type) {
        const ix = this.ix;
        const k = ix.dev.lastIndexOf(type);
        const rem = this.state.getRemainingTiles(this.me)[type].count;
        const sameCount = ix.dev.filter(x => x === type).length;
        if (ix.dev.length < 2 && sameCount < rem && !(sameCount === 1 && ix.dev.length === 1 && false)) {
            if (sameCount >= 1 && ix.dev.length === 1) {
                // clicking the same type again: develop two of it, or remove it
                if (rem >= 2 && this.state.players[this.me].industryTiles[type].filter(t => !t.used)[1]?.canDevelop) ix.dev.push(type); else ix.dev.splice(k, 1);
            } else ix.dev.push(type);
        } else if (k >= 0) ix.dev.splice(k, 1);
        else toast('一次最多发展 2 块', 'warn');
        this.refresh();
    }

    // Highlights on the board for the current step.
    updateHighlights() {
        const ix = this.ix, h = { slots: [], links: [], tiles: [], sel: [] };
        if (this.myTurn()) {
            if (ix.mode === 'idle' || (ix.mode === 'build' && !ix.slot)) {
                h.slots = [...new Set(this.targetsWithCard(ix.card).map(t => `${t.cityId}_${t.slotIndex}`))];
            } else if (ix.mode === 'build') {
                h.sel = [ix.slot];
            } else if (ix.mode === 'network') {
                const valid = ix.links.length === 0 ? this.logic.getValidNetworkTargets(this.me).map(t => t.connectionId)
                    : ix.links.length === 1 ? this.logic.getValidSecondRailLinks(this.me, ix.links[0]).map(t => t.connectionId) : [];
                h.links = valid; h.sel = ix.links.slice();
            } else if (ix.mode === 'sell') {
                h.tiles = this.logic.getValidSellTargets(this.me).map(t => t.key);
                h.sel = ix.sell.slice();
            }
        }
        this.board.setHighlights(h);
    }

    // ---------------------------------------------------------------- step panel
    renderPanel() {
        const ix = this.ix, p = this.my, s = this.state;
        const el = $('#panel');
        const turn = this.myTurn();
        let title = '', body = '', ready = false, okLabel = '确认', hint = '';
        const cardLine = (need = true) => ix.card != null && p.hand[ix.card]
            ? `<div class="row"><span>打出/弃掉</span><b>${esc(cardDisplayName(p.hand[ix.card]))}</b></div>`
            : need ? '<div class="row warn">请在下方手牌中选一张要弃掉的牌</div>' : '';
        if (!this.msg || this.msg.room.status === 'ended') { el.hidden = true; return; }
        if (!turn) {
            el.hidden = false; el.className = 'panel wait';
            const cur = s.players[s.currentPlayerId];
            const reason = this.me < 0 ? '你在观战' : this.busy ? '已提交，等待服务器…' : !this.net.connected ? '连接中断，正在重连…'
                : this.msg.pendingBonus && this.msg.pendingBonus.waiting != null ? `等待 ${s.players[this.msg.pendingBonus.waiting].name} 选择奖励…`
                : s.players[this.me] && s.players[this.me].isAI && s.currentPlayerId === this.me ? '你的座位正由 AI 代打（可点顶部"收回控制"）' : `等待 ${cur.name} 行动…`;
            el.innerHTML = `<div class="ptitle">${esc(reason)}</div><div class="muted small">可以拖动/缩放版图，悬停或长按查看大图。</div>`;
            return;
        }
        el.hidden = false; el.className = 'panel';
        switch (ix.mode) {
            case 'idle':
                title = ix.card == null ? '轮到你了' : `已选「${cardDisplayName(p.hand[ix.card])}」`;
                hint = ix.card == null ? '① 选一张手牌，版图会高亮它能建的位置；② 或直接点版图上的金色位置；③ 也可点下方动作按钮。'
                    : (this.targetsWithCard(ix.card).length ? '点版图上高亮的位置建造，或点下方动作按钮用这张牌做其他动作。' : '这张牌现在不能建造，可点下方动作按钮用它做其他动作。');
                {
                    const main = ['build', 'network', 'sell', 'develop'];
                    const r = Object.fromEntries(ACT.map(([a]) => [a, this.whyNot(a)]));
                    if (main.every(a => r[a])) {
                        const left = ['loan', 'scout', 'pass'].filter(a => !r[a]).map(a => ACT_NAME[a]);
                        hint = `<b class="warn">现在只能${left.join('、')}。</b>` + main.map(a => `<div class="why">${ACT_NAME[a]}：${esc(r[a])}</div>`).join('');
                    }
                }
                el.innerHTML = `<div class="ptitle">${esc(title)}</div><div class="hint">${hint}</div>` + (ix.card != null ? '<div class="btns"><button data-b="cancel">取消选牌</button></div>' : '');
                return this.bindPanel();
            case 'build': {
                if (!ix.slot) {
                    el.innerHTML = `<div class="ptitle">建造</div><div class="hint">点版图上高亮的位置${ix.card != null ? '（只显示这张牌能建的）' : ''}。</div><div class="btns"><button data-b="cancel">取消</button></div>`;
                    return this.bindPanel();
                }
                const [cityId] = this.splitKey(ix.slot);
                let opts = this.buildOptions(ix.slot);
                if (ix.card != null) opts = opts.filter(t => this.cardsFor(t).includes(ix.card));
                title = `在 ${locationName(cityId)} 建造`;
                body = '<div class="opts">' + opts.map(t => {
                    const c = t.cost, on = t.industryType === ix.ind;
                    const parts = [`£${c.money}`];
                    if (c.coal) parts.push(`煤 ${c.coal}${c.coalCost ? `（买 £${c.coalCost}）` : '（免费）'}`);
                    if (c.iron) parts.push(`铁 ${c.iron}${c.ironCost ? `（买 £${c.ironCost}）` : '（免费）'}`);
                    return `<button class="opt${on ? ' on' : ''}" data-ind="${t.industryType}"><img src="${tileImg(t.industryType, t.tileData.level, false, this.me)}" alt=""><span><b>${indName(t.industryType)} ${t.tileData.level} 级</b><br>${parts.join(' + ')} = <b>£${c.total}</b></span></button>`;
                }).join('') + '</div>';
                const t = this.curBuildTarget();
                if (t) {
                    body += this.sourceLines(t);
                    body += cardLine();
                    ready = ix.card != null && this.cardsFor(t).includes(ix.card);
                } else body += '<div class="row warn">选择要建的产业</div>';
                okLabel = '确认建造';
                break;
            }
            case 'network': {
                const era = s.era;
                title = era === 'canal' ? '建运河' : '建铁路';
                const n = ix.links.length;
                const name = id => { const c = CONNECTIONS.find(c => c.id === id); return c ? connName(c) : id; };
                if (!n) body = '<div class="hint">点版图上高亮的连线（青色）。</div>';
                else {
                    body = ix.links.map((id, k) => `<div class="row"><span>第 ${k + 1} 条</span><b>${esc(name(id))}</b></div>`).join('');
                    if (n === 1) {
                        const t = this.logic.getValidNetworkTargets(this.me).find(t => t.connectionId === ix.links[0]);
                        body += `<div class="row"><span>费用</span><b>£${t ? t.cost : '?'}${era === 'rail' ? '（含 1 煤）' : ''}</b></div>`;
                        if (era === 'rail' && this.logic.getValidSecondRailLinks(this.me, ix.links[0]).length) body += '<div class="hint">可再点一条高亮连线，一次建两条铁路（共 £15 + 2 煤 + 1 啤酒）。</div>';
                    } else body += '<div class="row"><span>费用</span><b>£15 + 2 煤 + 1 啤酒</b></div>';
                    body += cardLine();
                    ready = ix.card != null;
                }
                okLabel = n === 2 ? '确认建两条' : '确认建网';
                break;
            }
            case 'sell': {
                title = '销售';
                const targets = this.logic.getValidSellTargets(this.me);
                if (!ix.sell.length) body = '<div class="hint">点版图上抬起的己方产业（可多选，一次卖多个）。</div>';
                else {
                    body = ix.sell.map(key => {
                        const t = targets.find(t => t.key === key); if (!t) return '';
                        const [cid] = this.splitKey(key);
                        const mb = t.merchantBeerAvailable && t.beerNeeded > 0
                            ? `<label class="chk"><input type="checkbox" data-mb="${key}" ${ix.beerM[key] !== false ? 'checked' : ''}> 用商人啤酒（拿奖励）</label>` : '';
                        return `<div class="row"><span>${esc(locationName(cid))} ${indName(t.tile.type)} ${t.tile.tileData.level} 级</span><b>需啤酒 ${t.beerNeeded}</b></div>${mb}`;
                    }).join('');
                    const plan = this.sellPlan();
                    const r = this.logic.resolveSellPlan(this.me, plan);
                    if (!r.ok) body += `<div class="row warn">${esc(r.zh || r.message)}</div>`;
                    else {
                        const beers = r.steps.flatMap(st => st.beer.map(id => this.logic.beerSourceLabel(id, true, this.me)));
                        if (beers.length) body += `<div class="src">啤酒来源（自动选择）：${beers.map(esc).join('；')}</div>`;
                    }
                    body += cardLine();
                    ready = r.ok && ix.card != null;
                }
                okLabel = '确认销售';
                break;
            }
            case 'develop': {
                title = '发展';
                if (!ix.dev.length) body = '<div class="hint">在右侧"我的产业板"里点要移除的板块（亮起的可选，最多 2 块；同一种可点两次）。</div>';
                else {
                    const rem = s.getRemainingTiles(this.me);
                    const lv = {};
                    body = ix.dev.map(t => { lv[t] = (lv[t] || 0); const tile = rem[t].tiles[lv[t]++]; return `<div class="row"><span>移除</span><b>${indName(t)} ${tile ? tile.level : '?'} 级</b></div>`; }).join('');
                    const iron = s.findIronSource(this.me).slice(0, ix.dev.length);
                    const cost = iron.reduce((a, x) => a + (x.free ? 0 : x.price), 0);
                    body += `<div class="src">铁：${iron.map(x => x.free ? `${locationName(this.splitKey(x.key)[0])} 的铁厂（免费）` : `市场 £${x.price}`).join('；') || '<span class="warn">不足</span>'}</div>`;
                    body += `<div class="row"><span>费用</span><b>£${cost}</b></div>`;
                    body += cardLine();
                    ready = iron.length >= ix.dev.length && ix.card != null;
                }
                okLabel = '确认发展';
                break;
            }
            case 'loan':
                title = '贷款';
                body = `<div class="row"><span>获得</span><b>£${LOAN_AMOUNT}</b></div><div class="row"><span>代价</span><b>收入下降 3 级</b></div>` + cardLine();
                ready = ix.card != null; okLabel = '确认贷款';
                break;
            case 'scout':
                title = '侦察';
                body = `<div class="hint">在手牌中选 3 张弃掉，换 1 张万能地点 + 1 张万能产业。</div><div class="row"><span>已选</span><b>${ix.scout.length} / 3</b></div>`;
                ready = ix.scout.length === 3; okLabel = '确认侦察';
                break;
            case 'pass':
                title = '跳过';
                body = '<div class="hint">弃一张牌，不做任何事。</div>' + cardLine();
                ready = ix.card != null; okLabel = '确认跳过';
                break;
        }
        el.innerHTML = `<div class="ptitle">${esc(title)}</div>${body}<div class="btns"><button data-b="back">返回</button><button data-b="cancel">取消</button><button data-b="ok" class="primary" ${ready ? '' : 'disabled'}>${okLabel}</button></div>`;
        this.bindPanel();
    }

    sourceLines(t) {
        const s = this.state, out = [];
        if (t.cost.coal) {
            const src = s.findCoalSource(t.cityId, this.me).slice(0, t.cost.coal);
            out.push(`煤：${src.map(x => x.free ? `${locationName(this.splitKey(x.key)[0])} 的煤矿（免费）` : `煤市场 £${x.price}`).join('；')}`);
        }
        if (t.cost.iron) {
            const src = s.findIronSource(this.me).slice(0, t.cost.iron);
            out.push(`铁：${src.map(x => x.free ? `${locationName(this.splitKey(x.key)[0])} 的铁厂（免费）` : `铁市场 £${x.price}`).join('；')}`);
        }
        return out.length ? `<div class="src" title="按规则自动选择：煤取最近的相连煤矿，其次市场；铁优先任意铁厂">${out.join('<br>')}<br><span class="muted">资源来源按规则自动选择最优</span></div>` : '';
    }

    sellPlan() { return this.ix.sell.map(key => ({ key, useMerchantBeer: this.ix.beerM[key] !== false })); }

    bindPanel() {
        const el = $('#panel');
        el.querySelectorAll('[data-b]').forEach(b => b.onclick = () => {
            if (b.dataset.b === 'cancel') this.cancel();
            else if (b.dataset.b === 'back') this.back();
            else if (b.dataset.b === 'ok') this.confirm();
        });
        el.querySelectorAll('[data-ind]').forEach(b => b.onclick = () => { this.ix.ind = b.dataset.ind; this.autoCard(); this.refresh(); });
        el.querySelectorAll('[data-mb]').forEach(c => c.onchange = () => { this.ix.beerM[c.dataset.mb] = c.checked; this.refresh(); });
    }

    confirm() {
        const ix = this.ix;
        let m = null;
        switch (ix.mode) {
            case 'build': { const t = this.curBuildTarget(); if (!t) return; m = { action: 'build', cardIndex: ix.card, pendingData: { cityId: t.cityId, slotIndex: t.slotIndex, industryType: t.industryType } }; break; }
            case 'network': m = { action: 'network', cardIndex: ix.card, pendingData: { connectionId: ix.links[0], connectionId2: ix.links[1] || undefined } }; break;
            case 'sell': m = { action: 'sell', cardIndex: ix.card, pendingData: { sellPlan: this.sellPlan() } }; break;
            case 'develop': m = { action: 'develop', cardIndex: ix.card, pendingData: { industryType1: ix.dev[0], industryType2: ix.dev[1] || null } }; break;
            case 'loan': m = { action: 'loan', cardIndex: ix.card, pendingData: {} }; break;
            case 'scout': m = { action: 'scout', cardIndex: ix.scout[0], pendingData: { scoutCards: ix.scout.slice(1) } }; break;
            case 'pass': m = { action: 'pass', cardIndex: ix.card, pendingData: {} }; break;
        }
        if (!m) return;
        this.busy = true;
        this.net.send({ t: 'action', version: this.version, ...m });
        this.refresh();
    }

    // ---------------------------------------------------------------- modals
    openModal(title, html, locked = false) {
        $('#modal-title').textContent = title;
        $('#modal-body').innerHTML = html;
        $('#modal .modal-box').classList.remove('wide');
        $('#modal').hidden = false;
        this.modalLocked = locked;
        $('#modal-close').hidden = locked;
    }
    closeModal() { $('#modal').hidden = true; this.modalLocked = false; this.modalKind = null; }

    handleBonus(m) {
        const pb = m.pendingBonus;
        if (!pb || pb.waiting != null || !pb.types) { if (this.modalKind === 'bonus') this.closeModal(); return; }
        this.modalKind = 'bonus';
        this.openModal('商人奖励：免费发展', `<p>卖给格洛斯特的商人啤酒，获得 ${pb.count} 次免费发展（不花铁）。选择要移除的板块：</p>
          <div class="opts">${pb.types.map(t => { const r = this.state.getRemainingTiles(this.me)[t]; const lv = r.tiles[0].level;
            return `<button class="opt" data-bt="${t}"><img src="${tileImg(t, lv, false, this.me)}" alt=""><span><b>${indName(t)} ${lv} 级</b></span></button>`; }).join('')}</div>
          <div class="btns"><button data-bt="skip">放弃奖励</button></div>`, true);
        $('#modal-body').querySelectorAll('[data-bt]').forEach(b => b.onclick = () => { this.net.send({ t: 'bonus', type: b.dataset.bt }); this.closeModal(); });
    }

    handleEvent(m) {
        const ev = m.event;
        if (!ev) return;
        const key = m.room.code;
        if ((this.seenEvents[key] || 0) >= ev.id) return;
        this.seenEvents[key] = ev.id;
        localStorage.setItem('bb3d_seen', JSON.stringify(this.seenEvents));
        const s = this.state;
        if (ev.kind === 'scoring') {
            this.openModal(ev.title || '时代计分', `<table class="tbl"><tr><th>玩家</th><th>连线分</th><th>产业分</th><th>总分</th></tr>${ev.scores.map(x => {
                const p = s.players[x.playerId]; return `<tr><td style="color:${p.color}">${esc(p.name)}</td><td>${x.linkVP}</td><td>${x.industryVP}</td><td><b>${x.totalVP}</b></td></tr>`; }).join('')}</table>
              <p class="muted">进入铁路时代：运河与 1 级产业已移除。</p><div class="btns"><button class="primary" data-x>继续</button></div>`);
        } else if (ev.kind === 'gameover') {
            const sorted = [...s.players].sort((a, b) => (b.vp - a.vp) || (s.getIncomeLevel(b.id) - s.getIncomeLevel(a.id)) || (b.money - a.money));
            this.openModal('游戏结束', `<table class="tbl"><tr><th>名次</th><th>玩家</th><th>分数</th><th>收入</th><th>资金</th></tr>${sorted.map((p, i) =>
                `<tr><td>${i + 1}</td><td style="color:${p.color}">${esc(p.name)}</td><td><b>${p.vp}</b></td><td>${s.getIncomeLevel(p.id)}</td><td>£${p.money}</td></tr>`).join('')}</table>
              <div class="btns">${this.isHost ? '<button data-restart>回到大厅再来一局</button>' : ''}<button class="primary" data-x>查看版图</button></div>`);
            const r = $('#modal-body [data-restart]'); if (r) r.onclick = () => { this.net.send({ t: 'restart' }); this.closeModal(); };
        }
        const x = $('#modal-body [data-x]'); if (x) x.onclick = () => this.closeModal();
    }

    seatsModal() {
        const m = this.msg; if (!m || !this.state) return;
        const rows = m.room.seats.map((st, i) => {
            const p = this.state.players[i];
            const status = p.isAI ? (st.human ? 'AI 代打中' : 'AI') : (st.online ? '在线' : '离线');
            let ctl = '';
            if (this.isHost && m.room.status === 'playing') {
                if (p.isAI && st.human) ctl = `<button data-seat="${i}" data-on="0">恢复真人</button>`;
                else if (!p.isAI) ctl = `<button data-seat="${i}" data-on="1">交给 AI</button>`;
            }
            return `<div class="seat"><i class="sw" style="background:${p.color}"></i><div class="seat-name">${esc(p.name)}${i === this.me ? '（你）' : ''} <span class="muted">${status}${st.host ? ' · 房主' : ''}</span></div><div class="seat-ctl">${ctl}</div></div>`;
        }).join('');
        this.openModal('玩家与座位', `${rows}<p class="muted">邀请链接：${esc(location.origin + location.pathname + '?room=' + m.room.code)}</p>${this.isHost ? '<p class="muted">有人掉线时可把座位交给 AI；他回来后点"收回控制"。</p>' : ''}`);
        $('#modal-body').querySelectorAll('[data-seat]').forEach(b => b.onclick = () => { this.net.send({ t: 'setAI', seat: +b.dataset.seat, on: b.dataset.on === '1', difficulty: 'normal' }); this.closeModal(); });
    }

    tilePopup(hit) {
        if (!hit || hit.kind !== 'tile') return;
        const t = hit.tile, p = this.state.players[t.playerId], td = t.tileData;
        const [cid] = this.splitKey(hit.slotKey);
        this.showPreview({ img: tileImg(t.type, td.level, t.flipped, t.playerId), cap: `${locationName(cid)} · ${indName(t.type)} ${td.level} 级（${p.name}）`,
            info: `${t.flipped ? '已翻面' : '未翻面'}${t.resourceCubes ? ` · 剩 ${t.resourceCubes} 个资源` : ''}\n${tileInfo(td, t.type)}` }, null, 2500);
    }

    // ---------------------------------------------------------------- hover / preview
    onBoardHover(hit, e) {
        if (!hit || !e) { this.hidePreview(); this.hideTip(); return; }
        if (hit.kind === 'tile') {
            const t = hit.tile, p = this.state.players[t.playerId], td = t.tileData;
            const [cid] = this.splitKey(hit.slotKey);
            this.hideTip();
            this.showPreview({ img: tileImg(t.type, td.level, t.flipped, t.playerId), cap: `${locationName(cid)} · ${indName(t.type)} ${td.level} 级（${p.name}）`,
                info: `${t.flipped ? '已翻面' : '未翻面'}${t.resourceCubes ? ` · 剩 ${t.resourceCubes} 个资源` : ''}${hit.active ? '\n点击选择' : ''}\n${tileInfo(td, t.type)}` }, { x: e.clientX, y: e.clientY });
            return;
        }
        this.hidePreview();
        let text = '';
        if (hit.kind === 'slot') {
            const [cid, si] = this.splitKey(hit.key);
            const allowed = CITIES[cid] ? [].concat(CITIES[cid].slots[si]) : ['brewery'];
            const opts = hit.active ? this.buildOptions(hit.key) : [];
            text = `${locationName(cid)} · ${allowed.map(indName).join(' / ')}${opts.length ? `\n可建：${opts.map(t => `${indName(t.industryType)} ${t.tileData.level} 级 £${t.cost.total}`).join('，')}` : ''}`;
        } else if (hit.kind === 'link') {
            const c = CONNECTIONS.find(c => c.id === hit.connId);
            if (c) text = `${connName(c)}${hit.active ? '\n点击选择这条连线' : ''}`;
        } else if (hit.kind === 'builtLink') {
            const c = CONNECTIONS.find(c => c.id === hit.connId), p = this.state.players[hit.link.playerId];
            text = `${p.name} 的${hit.link.type === 'canal' ? '运河' : '铁路'}：${connName(c)}`;
        } else if (hit.kind === 'merchant') {
            const md = MERCHANTS[hit.mt.location];
            const buys = { any: '任意产品', blank: '不收购', cottonMill: '棉布', manufacturer: '制造品', pottery: '陶瓷' }[hit.mt.buys];
            const bonus = { vp: `+${md.bonusAmount} 分`, money: `+£${md.bonusAmount}`, income: `收入 +${md.bonusAmount} 格`, develop: `免费发展 ${md.bonusAmount} 次` }[md.bonusType];
            text = `${md.name} 商人：收购${buys}${hit.mt.hasBeer ? `\n有啤酒（喝掉可得奖励：${bonus}）` : ''}`;
        }
        if (text) this.showTip(text, e.clientX, e.clientY); else this.hideTip();
    }

    showTip(text, x, y, above = false) {
        const t = $('#tip'); t.textContent = text; t.hidden = false;
        const w = t.offsetWidth, h = t.offsetHeight;
        if (above) {
            t.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
            t.style.top = Math.max(8, y - h) + 'px';
            return;
        }
        t.style.left = Math.min(window.innerWidth - w - 8, x + 16) + 'px';
        t.style.top = Math.min(window.innerHeight - h - 8, y + 16) + 'px';
    }
    hideTip() { $('#tip').hidden = true; }

    showPreview(d, at, autoHideMs) {
        const pv = $('#preview');
        pv.innerHTML = `${d.img ? `<img src="${d.img}" alt="" class="${d.kind === 'card' ? 'pv-card' : 'pv-tile'}">` : ''}<div class="pv-cap">${esc(d.cap || '')}</div>${d.info ? `<div class="pv-info">${esc(d.info).replace(/\n/g, '<br>')}</div>` : ''}`;
        pv.hidden = false;
        const w = pv.offsetWidth, h = pv.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
        let x, y;
        if (d.anchor && d.anchor.closest('#hand')) {
            // hand cards: beside the hand so the step panel above stays readable
            const r = $('#hand').getBoundingClientRect();
            x = r.left - w - 12; y = vh - h - 8;
            if (x < 8) { x = r.right + 12; if (x + w > vw - 8) { x = vw / 2 - w / 2; y = r.top - h - 8; } }
        } else if (d.anchor) {
            const r = d.anchor.getBoundingClientRect();
            x = r.left + r.width / 2 - w / 2; y = r.top - h - 12;
            if (y < 8) { x = r.right + 12; y = r.top + r.height / 2 - h / 2; }
            if (x + w > vw - 8 && d.anchor) x = r.left - w - 12;
        } else if (at) { x = at.x + 20; y = at.y - h / 2; if (x + w > vw - 8) x = at.x - w - 20; }
        else { x = vw / 2 - w / 2; y = vh / 2 - h / 2; }
        pv.style.left = Math.max(8, Math.min(vw - w - 8, x)) + 'px';
        pv.style.top = Math.max(8, Math.min(vh - h - 8, y)) + 'px';
        clearTimeout(this.pvTimer);
        if (autoHideMs) this.pvTimer = setTimeout(() => this.hidePreview(), autoHideMs);
    }
    hidePreview() { $('#preview').hidden = true; }

    bindPreview() {
        const describe = el => el && { kind: el.dataset.preview, img: el.dataset.img, cap: el.dataset.cap, info: el.dataset.info, anchor: el };
        document.addEventListener('mouseover', e => {
            const el = e.target.closest && e.target.closest('[data-preview]');
            if (el) this.showPreview(describe(el)); else if (!e.target.closest || !e.target.closest('#stage')) this.hidePreview();
        });
        // long press on touch screens
        let timer = null;
        document.addEventListener('touchstart', e => {
            const el = e.target.closest && e.target.closest('[data-preview]');
            if (!el) return;
            timer = setTimeout(() => { this.showPreview(describe(el)); this.suppressClick = Date.now() + 600; }, 420);
        }, { passive: true });
        const end = () => { clearTimeout(timer); if (Date.now() < this.suppressClick) setTimeout(() => this.hidePreview(), 900); };
        document.addEventListener('touchend', end); document.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
        // long press on the board shows tile details
        let bt = null;
        $('#stage').addEventListener('touchstart', e => {
            const t = e.touches[0]; if (!t || e.touches.length > 1 || !this.board) return;
            bt = setTimeout(() => { const hit = this.board.pickAt(t.clientX, t.clientY); if (hit && hit.kind === 'tile') this.tilePopup(hit); }, 450);
        }, { passive: true });
        $('#stage').addEventListener('touchend', () => clearTimeout(bt));
        $('#stage').addEventListener('touchmove', () => clearTimeout(bt), { passive: true });
    }
}

const ACT_TIP = {
    build: '在版图上建造产业（先选牌或先点位置都行）', network: '建运河/铁路连线', sell: '把己方产业卖给相连的商人',
    develop: '从产业板上移除低级板块（每块花 1 铁）', loan: '借 £30，收入降 3 级', scout: '弃 3 张牌换两张万能牌', pass: '弃一张牌，跳过',
};

window.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
