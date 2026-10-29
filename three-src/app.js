// 伯明翰 3D 前端：大厅 + 对局界面 + "先点后确认" 的交互流程。
// 规则全部来自 js/gameLogic.js（与服务端同一份引擎），这里只做呈现与选择。
import { Board3D, PLAYER_CSS, ownerInitial, tilePath } from './board3d.js';
import { Net } from './net.js';
import { Fx, diffStates } from './fx.js';
import { ICON } from './icons.js';
import { Annotator } from './annot.js';

const $ = s => document.querySelector(s);
const hhmm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
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
const ic = n => ICON[n] || '';
const ROMAN_ = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'];

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
        this.queue = []; this.playing = false; this.hold = {};
        this.fx = new Fx(this);
        this.annot = new Annotator(this.net);
        this.annot.onChange = () => this.annotUi();
        this.annot.onPing = m => { if (!m.mine) this.fx.sfx.play('link', { rate: 1.7, volume: 0.45 }); };
        document.querySelectorAll('[data-ic]').forEach(el => { el.outerHTML = ic(el.dataset.ic); });
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
        $('#an-ping').onclick = () => this.annot.setMode('ping');
        $('#an-pen').onclick = () => this.annot.setMode('pen');
        $('#an-keep').onclick = () => { this.annot.setKeep(!this.annot.keep); toast(this.annot.keep ? '新笔迹将保留，直到手动清除' : '新笔迹 60 秒后自动淡出'); };
        $('#an-clear').onclick = () => this.annot.clear(false);
        $('#an-clear-all').onclick = () => { if (confirm('清除所有人的笔迹？')) this.annot.clear(true); };
        $('#btn-view').onclick = () => this.board && this.board.resetView();
        $('#btn-zoom-in').onclick = () => this.board && this.board.zoom(0.8);
        $('#btn-zoom-out').onclick = () => this.board && this.board.zoom(1.25);
        $('#btn-log').onclick = () => document.body.classList.toggle('show-log');
        $('#ticker').onclick = () => document.body.classList.toggle('show-log');
        $('#btn-market').onclick = () => this.marketModal();
        $('#mk-mini').onclick = () => this.marketModal();
        $('#btn-settings').onclick = () => this.settingsModal();
        $('#btn-board2').onclick = () => this.openBoardModal();
        $('#btn-seats').onclick = () => this.seatsModal();
        $('#btn-exit').onclick = () => {
            if (!confirm('退出到首页？座位会保留，用同一浏览器打开房间链接即可回来。')) return;
            this.net.lastRoom = null; location.href = location.pathname;
        };
        $('#btn-reclaim').onclick = () => this.net.send({ t: 'reclaim' });
        $('#btn-panels').onclick = () => document.body.classList.toggle('show-side');
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.annot.mode && $('#modal').hidden) { this.annot.setMode(this.annot.mode); return; }
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
        if (m.t === 'result') {
            toast(m.message, m.ok ? 'success' : 'error');
            // on success stay busy until the new state is applied (it may be queued behind an animation)
            if (!m.ok) { this.busy = false; this.refresh(); }
            else { clearTimeout(this.busyT); this.busyT = setTimeout(() => { if (this.busy) { this.busy = false; this.refresh(); } }, 6000); }
            return;
        }
        if (m.t === 'left') {
            this.net.code = null; this.net.lastRoom = null; this.msg = null;
            history.replaceState(null, '', location.pathname); this.show('home'); return;
        }
        if (m.t === 'annot' || m.t === 'annots') { this.annot.onMessage(m); return; }
        if (m.t !== 'room') return;
        this.net.code = m.room.code; this.net.lastRoom = m.room.code;
        if (!new URLSearchParams(location.search).get('room')) history.replaceState(null, '', `?room=${m.room.code}`);
        if (m.room.status === 'lobby' || !m.game) { this.queue = []; this.shown = null; this.msg = m; this.me = m.you.seat; this.isHost = m.you.isHost; this.renderLobby(m); this.show('lobby'); return; }
        // game updates are queued so each action's animation plays in server order
        this.queue.push(m);
        this.pump();
    }

    applyRoom(m) {
        this.msg = m; this.me = m.you.seat; this.isHost = m.you.isHost;
        this.net.code = m.room.code; this.net.lastRoom = m.room.code;
        if (m.room.status === 'lobby' || !m.game) { this.renderLobby(m); this.show('lobby'); } else this.renderGame(m);
    }
    async pump() {
        if (this.playing) return;
        while (this.queue.length) {
            const m = this.queue.shift();
            const prev = this.shown;
            const plan = prev && prev.code === m.room.code && prev.version !== m.version && m.game ? diffStates(prev.game, m.game) : null;
            this.hold = {};
            if (plan && this.fx.speed) for (const x of plan.money) this.hold[x.pid] = x.from;
            this.shown = { code: m.room.code, version: m.version, game: m.game };
            this.applyRoom(m);
            if (!plan || plan.empty) { this.hold = {}; continue; }
            this.playing = true;
            try { await this.fx.play(plan, this.queue.length > 2 ? 3 : this.queue.length ? 1.6 : 1); } catch (e) { console.warn('fx', e); }
            this.playing = false;
            if (Object.keys(this.hold).length) { this.hold = {}; this.renderHud(); this.renderPlayers(); }
        }
    }
    // a short banner when the turn passes
    turnNotice(pid) {
        if (!this.state || this.state.currentPlayerId !== pid) return;
        const p = this.state.players[pid]; if (!p) return;
        const mine = pid === this.me;
        const el = document.createElement('div');
        el.className = 'fx-turn' + (mine ? ' mine' : '');
        el.style.setProperty('--pc', PLAYER_CSS[pid]);
        el.innerHTML = mine ? '轮到你了' : `${ownerBadge(p, pid)}${esc(p.name)} 行动中`;
        this.fx.layer.querySelectorAll('.fx-turn').forEach(x => x.remove());
        this.fx.layer.appendChild(el);
        setTimeout(() => el.remove(), mine ? 1500 : 1100);
        if (mine) this.fx.sfx.play('turn');
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
            this.annot.attach(this.board);
            this.board.onResetView = () => this.placeInfo();
            this.layoutInsets();
            window.addEventListener('resize', () => { this.layoutInsets(); clearTimeout(this.rsT); this.rsT = setTimeout(() => this.board.resetView(), 150); });
        }
        const versionChanged = this.version !== m.version;
        this.version = m.version;
        this.state = hydrate(m.game);
        this.state.players.forEach((p, i) => { p.color = PLAYER_CSS[i] || p.color; });
        this.logic = new GameLogic(this.state);
        if (versionChanged) { this.busy = false; this.ix = this.freshIx(); }
        this.annot.me = this.me;
        this.board.update(this.state, this.me);
        this.refresh();
        this.handleBonus(m);
        this.handleEvent(m);
        if (first) requestAnimationFrame(() => { this.layoutInsets(); this.board.resetView(); });
    }

    annotUi() {
        const a = this.annot, pen = a.mode === 'pen';
        $('#an-ping').classList.toggle('on', a.mode === 'ping');
        $('#an-pen').classList.toggle('on', pen);
        $('#an-keep').hidden = !pen; $('#an-keep').classList.toggle('on', a.keep);
        let mine = 0; for (const s of a.strokes.values()) if (s.mine) mine++;
        $('#an-clear').hidden = !(pen || mine);
        $('#an-clear-all').hidden = !(pen || a.strokes.size > mine);
        let hint = $('#annot-hint');
        const text = a.mode === 'ping' ? '点版图发信号（Esc 退出）' : pen ? (matchMedia('(pointer:coarse)').matches ? '单指画线，双指缩放' : '拖动画线，滚轮缩放（Esc 退出）') : '';
        if (text && !hint) { hint = document.createElement('div'); hint.id = 'annot-hint'; hint.className = 'annot-hint'; $('#game').appendChild(hint); }
        if (hint) { hint.hidden = !text; hint.textContent = text; }
    }

    layoutInsets() {
        if (!this.board) return;
        const hb = $('#hud').getBoundingClientRect();
        document.body.style.setProperty('--annot-top', Math.round(hb.bottom + 10) + 'px');
        const wide = window.innerWidth >= 900;
        const top = wide ? $('#opps').getBoundingClientRect().bottom : Math.max($('#hud').getBoundingClientRect().bottom, $('#toolbar').getBoundingClientRect().bottom);
        const dock = $('#dock').getBoundingClientRect();
        document.body.style.setProperty('--dockh', Math.round(window.innerHeight - dock.top) + 'px');
        const bottomEdge = wide ? dock.top : Math.min(dock.top, $('#opps').getBoundingClientRect().top || dock.top);
        const right = wide && !document.body.classList.contains('wide-info') && !document.body.classList.contains('near-side') ? window.innerWidth - $('#side-right').getBoundingClientRect().left : 0;
        this.board.insets = { top: top + 4, bottom: window.innerHeight - bottomEdge + 4, left: 0, right: Math.max(0, right) };
    }

    get my() { return this.me >= 0 && this.state ? this.state.players[this.me] : null; }

    myTurn() {
        const m = this.msg, s = this.state;
        return !!(m && s && m.room.status === 'playing' && this.me >= 0 && s.currentPlayerId === this.me &&
            !s.players[this.me].isAI && !m.pendingBonus && this.net.connected && !this.busy && !this.queue.length);
    }

    // All the derived "what can I do" data for the current situation.
    buildTargets() { return this.myTurn() ? this.logic.getValidBuildTargets(this.me) : []; }
    cardsFor(t) { return this.logic.getValidCardsForAction(this.me, ACTIONS.BUILD, t); }
    targetsWithCard(card) { return this.buildTargets().filter(t => card == null || this.cardsFor(t).includes(card)); }

    refresh() {
        if (!this.state) return;
        this.renderTop(); this.renderHud(); this.renderPlayers(); this.renderMarkets(); this.renderMat();
        this.renderHand(); this.renderActions(); this.renderPanel(); this.renderLog(); this.renderInfo();
        if (this.modalKind === 'board' && !$('#modal').hidden) this.openBoardModal(this.boardPid);
        this.updateHighlights();
        if (this.board) this.layoutInsets();
    }

    renderTop() {
        const s = this.state;
        $('#era').textContent = s.era === 'canal' ? '运河' : '铁路';
        $('#era').className = 'era ' + s.era;
        $('#era').innerHTML = `${ic(s.era === 'canal' ? 'canal' : 'rail')}${s.era === 'canal' ? '运河时代' : '铁路时代'}`;
        $('#round').textContent = `第 ${s.round} 轮`;
        $('#room-code').textContent = this.msg.room.code;
        const mine = this.my;
        $('#btn-reclaim').hidden = !(mine && mine.isAI && this.msg.room.status === 'playing');
    }

    // My own status: big money, income, VP, actions left.
    renderHud() {
        const s = this.state, p = this.my, hud = $('#hud');
        hud.classList.toggle('spec', !p);
        const cur = s.currentPlayerId === this.me && this.msg.room.status === 'playing';
        hud.classList.toggle('cur', !!cur);
        if (!p) { $('#hud-badge').innerHTML = '<span class="muted">观战中</span>'; $('#hud-money b').textContent = '—'; $('#hud-income b').textContent = '—'; $('#hud-vp b').textContent = '—'; $('#hud-spent b').textContent = '—'; $('#hud-acts').innerHTML = ''; return; }
        hud.style.setProperty('--pc', PLAYER_CSS[this.me]);
        $('#hud-badge').innerHTML = `${ownerBadge(p, this.me)}<span class="hud-name">${esc(p.name)}</span>`;
        const mb = $('#hud-money b');
        if (!mb.classList.contains('bump')) mb.textContent = this.hold[this.me] ?? p.money;
        const inc = incomeLevelFromSpace(p.incomeSpace);
        $('#hud-income b').textContent = (inc > 0 ? '+' : '') + inc;
        $('#hud-income').classList.toggle('neg', inc < 0);
        $('#hud-vp b').textContent = p.vp;
        $('#hud-spent b').textContent = '£' + ((s.moneySpentThisRound || {})[this.me] || 0);
        const left = cur ? s.actionsPerTurn - s.actionsThisTurn : 0;
        const total = s.actionsPerTurn || 2;
        $('#hud-acts').innerHTML = cur ? `${ic('actions')}${Array.from({ length: total }, (_, i) => `<i class="pip${i < left ? ' on' : ''}"></i>`).join('')}` : '';
        $('#hud-acts').title = cur ? `本回合还剩 ${left} 个动作` : '';
        $('#hud-acts').hidden = !cur;
    }

    // Opponents as a compact strip in turn order; hover = focus, click = details.
    renderPlayers() {
        const s = this.state, box = $('#opps');
        const order = s.turnOrder && s.turnOrder.length ? s.turnOrder : s.players.map((_, i) => i);
        box.innerHTML = order.filter(pid => pid !== this.me).map(pid => {
            const p = s.players[pid], seat = this.msg.room.seats[pid] || {};
            const cur = pid === s.currentPlayerId && this.msg.room.status === 'playing';
            const off = seat.human && !seat.online;
            const st = this.turnStatus(pid), sp = (s.moneySpentThisRound || {})[pid] || 0;
            return `<button class="opp${cur ? ' cur' : ''}${off ? ' off' : ''}${st === 'done' ? ' done' : ''}${this.focusPid === pid ? ' focus' : ''}" data-pid="${pid}" style="--pc:${p.color}" title="${esc(p.name)}${p.isAI ? '（AI）' : ''}${off ? '（离线）' : ''}：本轮第 ${order.indexOf(pid) + 1} 个行动${st === 'done' ? '（已行动）' : ''}，本轮花费 £${sp}。悬停只看 TA 的资产，点击看详情">
              <b class="oi c-only">${order.indexOf(pid) + 1}</b>${ownerBadge(p, pid)}<span class="on">${esc(p.name)}</span><span class="om">£${this.hold[pid] ?? p.money}</span><span class="ov">${ic('vp')}${p.vp}</span><span class="osp c-only" data-sp="${pid}" title="本轮花费">${ic('spent')}${sp}</span>${st === 'done' ? `<span class="odone c-only">${ic('check')}</span>` : ''}${cur ? '<i class="turnmark" title="正在行动"></i>' : ''}</button>`;
        }).join('');
        box.querySelectorAll('.opp').forEach(el => {
            el.onmouseenter = () => this.board && this.board.setFocus(+el.dataset.pid);
            el.onmouseleave = () => this.board && this.board.setFocus(this.focusPid ?? null);
            el.onclick = () => this.playerModal(+el.dataset.pid);
        });
    }

    // Details of one player (secondary view).
    playerModal(pid) {
        const s = this.state, p = s.players[pid], seat = this.msg.room.seats[pid] || {};
        const order = s.turnOrder && s.turnOrder.length ? s.turnOrder : s.players.map((_, i) => i);
        const links = s.era === 'canal' ? `运河 ${p.linksRemaining.canal}` : `铁路 ${p.linksRemaining.rail}`;
        const spent = (s.moneySpentThisRound || {})[pid] || 0;
        const tags = [p.isAI ? 'AI' : '', pid === this.me ? '你' : '', seat.human && !seat.online ? '离线' : '', pid === s.currentPlayerId ? '正在行动' : ''].filter(Boolean).map(t => `<span class="chip">${t}</span>`).join('');
        this.openModal(`${p.name}`, `<div class="pdet" style="--pc:${p.color}">
            <div class="pdet-h">${ownerBadge(p, pid)}<b>${esc(p.name)}</b>${tags}</div>
            <div class="pdet-g">
              <div>${ic('coin')}<b>£${p.money}</b><small>资金</small></div>
              <div>${ic('income')}<b>${incomeLevelFromSpace(p.incomeSpace)}</b><small>收入</small></div>
              <div>${ic('vp')}<b>${p.vp}</b><small>胜利点</small></div>
              <div>${ic('cards')}<b>${p.hand.length}</b><small>手牌</small></div>
              <div>${ic(s.era === 'canal' ? 'canal' : 'rail')}<b>${links.split(' ')[1]}</b><small>剩余${links.split(' ')[0]}</small></div>
              <div><b>第 ${order.indexOf(pid) + 1} 位</b><small>本轮顺序 · 已花 £${spent}</small></div>
            </div></div>
            <div class="btns"><button data-focus>${this.focusPid === pid ? '取消只看 TA' : '版图上只看 TA'}</button><button class="primary" data-pb>TA 的产业板</button></div>`);
        $('#modal-body [data-pb]').onclick = () => this.openBoardModal(pid);
        $('#modal-body [data-focus]').onclick = () => { this.focusPid = this.focusPid === pid ? null : pid; this.board && this.board.setFocus(this.focusPid ?? null); this.closeModal(); this.renderPlayers(); };
    }

    // Tiny market line under the mat; details in a modal.
    renderMarkets() {
        const s = this.state;
        $('#mk-mini').innerHTML = `<span>${ic('coal')}£${s.getCoalPrice()}</span><span>${ic('iron')}£${s.getIronPrice()}</span><span title="牌堆">${ic('cards')}${s.drawDeck.length}</span>`;
        if (this.modalKind === 'market' && !$('#modal').hidden) this.marketModal();
    }
    marketModal() {
        const s = this.state; if (!s) return;
        const cubes = (n, max, cls) => Array.from({ length: max }, (_, i) => `<i class="cube ${cls}${i < max - n ? ' empty' : ''}"></i>`).join('');
        this.openModal('市场与牌堆', `
          <div class="mk"><div class="mk-h">${ic('coal')} 煤 <b>£${s.getCoalPrice()}</b><span class="muted">/块 · 剩 ${s.coalMarket}/14</span></div><div class="cubes">${cubes(s.coalMarket, 14, 'coal')}</div></div>
          <div class="mk"><div class="mk-h">${ic('iron')} 铁 <b>£${s.getIronPrice()}</b><span class="muted">/块 · 剩 ${s.ironMarket}/10</span></div><div class="cubes">${cubes(s.ironMarket, 10, 'iron')}</div></div>
          <div class="mk">${ic('cards')} 牌堆 <b>${s.drawDeck.length}</b> 张 · 万能地点 <b>${s.wildLocationPile}</b> · 万能产业 <b>${s.wildIndustryPile}</b></div>
          <p class="muted small">市场价格随存量变化：越少越贵；市场空了仍可按 £8（煤）/£6（铁）购买。煤需要连到市场（商人）才能买，铁随处可买。</p>`);
        this.modalKind = 'market';
    }
    settingsModal() {
        const f = this.fx;
        const row = (k, v, label) => `<button class="seg${f.mode === v ? ' on' : ''}" data-fx="${v}">${label}</button>`;
        this.openModal('动画与声音', `
          <div class="set-row"><span>${ic('speed')} 动作动画</span><span class="segs">${row('', 'normal', '正常')}${row('', 'fast', '快速')}${row('', 'off', '关闭')}</span></div>
          <div class="set-row"><span>${ic(f.sfx.muted ? 'mute' : 'sound')} 音效</span><span class="segs"><button class="seg${f.sfx.muted ? '' : ' on'}" data-snd="1">开</button><button class="seg${f.sfx.muted ? ' on' : ''}" data-snd="0">关</button></span></div>
          <p class="muted small">${f.reduced ? '系统开启了"减少动态效果"，默认用快速动画。' : '对手和 AI 的动作也会按顺序播放；连续多步时自动加速。'}</p>`);
        $('#modal-body').querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { f.setMode(b.dataset.fx); this.settingsModal(); });
        $('#modal-body').querySelectorAll('[data-snd]').forEach(b => b.onclick = () => { f.sfx.muted = b.dataset.snd === '0'; if (!f.sfx.muted) f.sfx.play('coin'); this.settingsModal(); });
    }

    // Right side: one small icon per industry showing only the next tile.
    renderMat() {
        const box = $('#mat');
        const p = this.my;
        if (!p) { box.innerHTML = '<div class="muted">观战中</div>'; return; }
        box.style.setProperty('--pc', PLAYER_CSS[this.me] || 'transparent');
        const rem = this.state.getRemainingTiles(this.me);
        const devMode = this.ix.mode === 'develop' && this.myTurn();
        document.body.classList.toggle('dev-mode', devMode);
        const devTypes = devMode ? new Set(this.logic.getDevelopableTypes(this.me).map(t => t.type)) : new Set();
        box.innerHTML = ORDER.map(type => {
            const r = rem[type];
            if (!r.count) return `<div class="mtile none" data-type="${type}" title="${indName(type)}：已用完"><div class="mimg empty">${indName(type).slice(0, 2)}</div><div class="mcost muted">用完</div></div>`;
            const td = r.tiles[0];
            const chosen = this.ix.dev.filter(x => x === type).length;
            const cls = (devTypes.has(type) ? ' can' : '') + (chosen ? ' chosen' : '') + (td.canDevelop ? '' : ' nodev');
            const cost = `<span>£${td.cost}</span>${td.costCoal ? `<span class="rq">${ic('coal')}${td.costCoal}</span>` : ''}${td.costIron ? `<span class="rq">${ic('iron')}${td.costIron}</span>` : ''}${td.beersToSell ? `<span class="rq">${ic('beer')}${td.beersToSell}</span>` : ''}`;
            return `<div class="mtile${cls}" data-type="${type}" data-preview="tile" data-img="${tileImg(type, td.level, false, this.me)}" data-cap="${indName(type)} ${td.level} 级（剩 ${r.count} 块）" data-info="${esc(tileInfo(td, type) + '\n剩余：' + this.levelGroups(this.me, type).map(x => `${ROMAN[x.level]}×${x.left}`).join(' '))}">
              <div class="mimgw"><img class="mimg" src="${tileImg(type, td.level, false, this.me)}" alt="${indName(type)}"><b class="mlv">${ROMAN[td.level]}</b><b class="mcnt">×${r.count}</b>${chosen ? `<b class="badge">${chosen > 1 ? '×2' : '✓'}</b>` : ''}</div>
              <div class="mcost">${cost}</div></div>`;
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

    // Turn status of a player in the current round: done / cur / wait.
    turnStatus(pid) {
        const s = this.state, order = s.turnOrder && s.turnOrder.length ? s.turnOrder : s.players.map((_, i) => i);
        if (this.msg.room.status !== 'playing') return 'done';
        const i = order.indexOf(pid);
        return i < s.currentPlayerIndex ? 'done' : i === s.currentPlayerIndex ? 'cur' : 'wait';
    }

    // Side panels (wide screens only): this round + log on the left, next round on the right.
    placeInfo() {
        if (!this.board) return;
        const W = window.innerWidth, H = window.innerHeight, r = this.board.boardRect();
        const box = el => { const b = $(el).getBoundingClientRect(); return b.width ? b : null; };
        const hud = box('#hud'), opps = box('#opps'), tb = box('#toolbar');
        const gap = 14, minW = 230, maxW = 290, MATW = 410;
        // Wide layout: the "next tile" panel leaves the screen edge and joins the
        // right column, so the board is centred. Decide from the centred geometry
        // (board size is height-bound here) so toggling cannot oscillate.
        const sideFree = (W - (r.right - r.left)) / 2;
        const wide = W >= 900 && sideFree - gap - 64 >= minW && sideFree - 2 * gap >= MATW && r.bottom - r.top > 360;
        const was = document.body.classList.contains('wide-info');
        document.body.classList.toggle('wide-info', wide);
        $('#info-l').hidden = $('#info-r').hidden = !wide;
        this.infoWide = wide;
        if (was !== wide) { this.layoutInsets(); requestAnimationFrame(() => this.board.resetView()); }
        // Middle widths (e.g. 1280): no side columns, but the "next tile" panel
        // still hugs the board's right edge, a bit larger (3 columns).
        const NEARW = 290, near = !wide && W >= 900 && sideFree - 2 * gap >= NEARW && r.bottom - r.top > 300;
        const wasNear = document.body.classList.contains('near-side');
        document.body.classList.toggle('near-side', near);
        if (wasNear !== near && was === wide) { this.layoutInsets(); requestAnimationFrame(() => this.board.resetView()); }
        const sr = $('#side-right');
        if (near) {
            const top = Math.max(r.top, ($('#opps').getBoundingClientRect().bottom || 0) + 10), maxH = $('#dock').getBoundingClientRect().top - top - 10;
            Object.assign(sr.style, { left: Math.round(r.right + gap) + 'px', top: Math.round(top) + 'px', width: NEARW + 'px', maxHeight: Math.round(maxH) + 'px' });
            sr.classList.remove('mat4');
            if (sr.scrollHeight > maxH + 1) sr.classList.add('mat4');   // short screens: 4 columns, 2 rows
        } else if (!wide) Object.assign(sr.style, { left: '', top: '', width: '', maxHeight: '' });
        if (!wide) { this.renderLog(); this.renderPlayers(); return; }
        const lAvail = r.left - gap - 64, rAvail = W - gap - r.right - gap;
        const over = (b, x0, x1) => b && x0 < b.right && x1 > b.left;
        const lw = Math.min(maxW, lAvail), lx = Math.round(r.left - gap - lw);
        let lt = Math.max(10, r.top);
        for (const b of [hud, opps]) if (over(b, lx, lx + lw)) lt = Math.max(lt, b.bottom + 10);
        const lb = Math.max(lt + 320, r.bottom);
        Object.assign($('#info-l').style, { left: lx + 'px', width: lw + 'px', top: Math.round(lt) + 'px', height: Math.round(Math.min(H - 10, lb) - lt) + 'px' });
        const rw = Math.min(maxW, rAvail), rx = Math.round(r.right + gap);
        let rt = Math.max(10, r.top);
        for (const b of [tb, opps]) if (over(b, rx, rx + rw)) rt = Math.max(rt, b.bottom + 10);
        Object.assign($('#info-r').style, { left: rx + 'px', width: rw + 'px', top: Math.round(rt) + 'px', maxHeight: Math.round(H - rt - 10) + 'px' });
        $('#log-dock').dataset.key = '';
        this.renderInfo(); this.renderLog(); this.renderPlayers();
        // "next tile" panel: same column, right under the next-round box
        const st = Math.round($('#info-r').getBoundingClientRect().bottom + 10);
        Object.assign($('#side-right').style, { left: rx + 'px', top: st + 'px', width: Math.min(MATW, rAvail) + 'px', maxHeight: Math.round(H - st - 10) + 'px' });
    }

    renderInfo() {
        const s = this.state; if (!s || !this.msg) return;
        const order = s.turnOrder && s.turnOrder.length ? s.turnOrder : s.players.map((_, i) => i);
        const spent = pid => (s.moneySpentThisRound || {})[pid] || 0;
        // the rule (GameState.endRound): stable sort of the current order by money spent, least first
        const next = [...order].sort((a, b) => spent(a) - spent(b));
        this.roundInfo = { order: [...order], next, spent: order.map(spent), status: order.map(pid => this.turnStatus(pid)) };
        const prev = this.prevSpent || {}; this.prevSpent = Object.fromEntries(order.map(pid => [pid, spent(pid)]));
        if (!document.body.classList.contains('wide-info')) { this.bumpSpent(prev); return; }
        const total = s.actionsPerTurn || 2;
        const row = (pid, i, extra) => {
            const p = s.players[pid], st = this.turnStatus(pid);
            return `<div class="ir st-${st}${pid === this.me ? ' me' : ''}" data-pid="${pid}" style="--pc:${PLAYER_CSS[pid]}"><b class="ix">${i + 1}</b>${ownerBadge(p, pid)}<span class="nm">${esc(p.name)}</span>${extra(pid, st)}</div>`;
        };
        $('#round-box').innerHTML = `<div class="ih">${ic('order')}本轮<span class="muted">第 ${s.round} 轮</span></div>` + order.map((pid, i) => row(pid, i, (pid, st) => {
            const left = st === 'cur' ? total - s.actionsThisTurn : st === 'wait' ? total : 0;
            const stt = st === 'done' ? `<span class="stt" title="已行动">${ic('check')}</span>`
                : st === 'cur' ? `<span class="stt" title="正在行动，还剩 ${left} 个动作">${Array.from({ length: total }, (_, k) => `<i class="pip${k < left ? ' on' : ''}"></i>`).join('')}</span>`
                : `<span class="stt" title="等待中，${left} 个动作">${ic('hourglass')}${left}</span>`;
            return `${stt}<span class="sp" data-sp="${pid}" title="本轮已花费">£${spent(pid)}</span>`;
        })).join('') + `<div class="ifoot">${ic('spent')} 本轮花费，花得少的下轮先动</div>`;
        $('#next-box').innerHTML = `<div class="ih">${ic('order')}下轮顺位<span class="muted">预测</span></div>` + next.map((pid, i) => {
            const p = s.players[pid], d = order.indexOf(pid) - i, inc = incomeLevelFromSpace(p.incomeSpace);
            return `<div class="nr${pid === this.me ? ' me' : ''}" data-pid="${pid}" style="--pc:${PLAYER_CSS[pid]}">
              <div class="nr1"><b class="ix">${i + 1}</b>${ownerBadge(p, pid)}<span class="nm">${esc(p.name)}</span>${d ? `<span class="mv ${d > 0 ? 'up' : 'dn'}" title="${d > 0 ? '比本轮提前' : '比本轮推后'} ${Math.abs(d)} 位">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : ''}<span class="sp" data-sp="${pid}" title="本轮已花费">£${spent(pid)}</span></div>
              <div class="nr2"><span title="资金">${ic('coin')}${this.hold[pid] ?? p.money}</span><span title="收入"${inc < 0 ? ' class="neg"' : ''}>${ic('income')}${inc > 0 ? '+' : ''}${inc}</span><span title="胜利点">${ic('vp')}${p.vp}</span><span title="手牌">${ic('cards')}${p.hand.length}</span></div></div>`;
        }).join('');
        document.querySelectorAll('#info-l [data-pid], #info-r [data-pid]').forEach(el => {
            el.onmouseenter = () => this.board && this.board.setFocus(+el.dataset.pid);
            el.onmouseleave = () => this.board && this.board.setFocus(this.focusPid ?? null);
            el.onclick = () => this.playerModal(+el.dataset.pid);
        });
        this.bumpSpent(prev);
    }
    bumpSpent(prev) {
        for (const [pid, v] of Object.entries(this.prevSpent || {})) {
            if (prev[pid] == null || prev[pid] === v) continue;
            document.querySelectorAll(`[data-sp="${pid}"]`).forEach(el => { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); });
        }
    }

    renderLog() {
        const s = this.state;
        const line = e => { const p = e.playerId != null ? s.players[e.playerId] : null; return `<div class="le ${e.type || ''}">${e.ts ? `<time>${hhmm(e.ts)}</time>` : ''}${p ? `${ownerBadge(p, e.playerId)}` : ''}<span>${esc(e.message)}</span></div>`; };
        const log = this.msg.log || [];   // newest first (server unshifts)
        $('#log').innerHTML = `<div class="log-h">日志 <button class="mini" data-close>${ic('close')}</button></div>` + log.slice(0, 100).map(line).join('');
        const dock = $('#log-dock');
        if (document.body.classList.contains('wide-info')) {
            const key = `${log.length}|${log[0] && (log[0].ts || log[0].message)}`;
            if (dock.dataset.key !== key) {
                dock.dataset.key = key;
                dock.innerHTML = `<div class="ih">${ic('log')}日志</div><div class="lscroll">${log.slice(0, 100).map(line).join('') || '<div class="le muted">对局开始</div>'}</div>`;
            }
        } else if (dock.dataset.key) { dock.dataset.key = ''; dock.innerHTML = ''; }
        $('#log [data-close]').onclick = () => document.body.classList.remove('show-log');
        $('#ticker').innerHTML = log.slice(0, 2).map(line).join('') + (log.length ? '' : '<div class="le muted">对局开始</div>');
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
            el.innerHTML = `<div class="ptitle one">${cur && !this.busy && this.me >= 0 && this.net.connected && !(this.msg.pendingBonus && this.msg.pendingBonus.waiting != null) ? ownerBadge(cur, s.currentPlayerId) : ''}${esc(reason)}</div>`;
            return;
        }
        el.hidden = false; el.className = 'panel';
        switch (ix.mode) {
            case 'idle':
                title = ix.card == null ? '轮到你了' : `已选「${cardDisplayName(p.hand[ix.card])}」`;
                hint = ix.card == null ? '点版图金色位置建造，或选一张牌 / 一个动作。'
                    : (this.targetsWithCard(ix.card).length ? '点高亮位置建造，或选下方动作。' : '这张牌不能建造，选下方其他动作。');
                {
                    const main = ['build', 'network', 'sell', 'develop'];
                    const r = Object.fromEntries(ACT.map(([a]) => [a, this.whyNot(a)]));
                    if (main.every(a => r[a])) {
                        const left = ['loan', 'scout', 'pass'].filter(a => !r[a]).map(a => ACT_NAME[a]);
                        hint = `<details class="whys"><summary><b class="warn">现在只能${left.join('、')}</b> <span class="muted">为什么？</span></summary>${main.map(a => `<div class="why">${ACT_NAME[a]}：${esc(r[a])}</div>`).join('')}</details>`;
                    }
                }
                el.className = 'panel idle';
                el.innerHTML = `<div class="pline"><span class="ptitle">${esc(title)}</span><span class="hint">${hint}</span>${ix.card != null ? '<button data-b="cancel" class="mini">取消选牌</button>' : ''}</div>`;
                return this.bindPanel();
            case 'build': {
                if (!ix.slot) {
                    el.innerHTML = `<div class="pline"><span class="ptitle">建造</span><span class="hint">点版图上高亮的位置。</span><button data-b="cancel" class="mini">取消</button></div>`;
                    return this.bindPanel();
                }
                const [cityId] = this.splitKey(ix.slot);
                let opts = this.buildOptions(ix.slot);
                if (ix.card != null) opts = opts.filter(t => this.cardsFor(t).includes(ix.card));
                title = `在 ${locationName(cityId)} 建造`;
                body = '<div class="opts">' + opts.map(t => {
                    const c = t.cost, on = t.industryType === ix.ind;
                    const parts = [`£${c.money}`];
                    if (c.coal) parts.push(`${ic('coal')}${c.coal}${c.coalCost ? `(£${c.coalCost})` : ''}`);
                    if (c.iron) parts.push(`${ic('iron')}${c.iron}${c.ironCost ? `(£${c.ironCost})` : ''}`);
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
                if (!n) body = '<div class="hint">点版图上青色的连线。</div>';
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
                if (!ix.sell.length) body = '<div class="hint">点版图上抬起的产业（可多选）。</div>';
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
                if (!ix.dev.length) body = '<div class="hint">在右侧点亮起的板块（最多 2 块）。</div>';
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
                body = `<div class="hint">弃 3 张牌，换两张万能牌。</div><div class="row"><span>已选</span><b>${ix.scout.length} / 3</b></div>`;
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
        return out.length ? `<div class="src" title="按规则自动选择：煤取最近的相连煤矿，其次市场；铁优先任意铁厂">${out.join('<br>')}</div>` : '';
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
        this.modalKind = null;
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
        this.openModal('商人奖励：免费发展', `<p>卖给格洛斯特的商人啤酒，获得 ${pb.count} 次免费发展（不花铁）。选择要移除的板块：</p>
          <div class="opts">${pb.types.map(t => { const r = this.state.getRemainingTiles(this.me)[t]; const lv = r.tiles[0].level;
            return `<button class="opt" data-bt="${t}"><img src="${tileImg(t, lv, false, this.me)}" alt=""><span><b>${indName(t)} ${lv} 级</b></span></button>`; }).join('')}</div>
          <div class="btns"><button data-bt="skip">放弃奖励</button></div>`, true);
        this.modalKind = 'bonus';
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
            this.openModal(ev.title || '时代计分', `<table class="tbl score"><tr><th>玩家</th><th>连线分</th><th>产业分</th><th>总分</th></tr>${ev.scores.map(x => {
                const p = s.players[x.playerId]; return `<tr class="sr" data-l="${x.linkVP}" data-i="${x.industryVP}" data-t="${x.totalVP}"><td style="color:${p.color}">${ownerBadge(p, x.playerId)}${esc(p.name)}</td><td class="c-l">${x.linkVP}</td><td class="c-i">${x.industryVP}</td><td><b class="c-t">${x.totalVP}</b></td></tr>`; }).join('')}</table>
              <p class="muted">进入铁路时代：运河与 1 级产业已移除。</p><div class="btns"><button class="primary" data-x>继续</button></div>`);
        } else if (ev.kind === 'gameover') {
            const sorted = [...s.players].sort((a, b) => (b.vp - a.vp) || (s.getIncomeLevel(b.id) - s.getIncomeLevel(a.id)) || (b.money - a.money));
            this.openModal('游戏结束', `<table class="tbl"><tr><th>名次</th><th>玩家</th><th>分数</th><th>收入</th><th>资金</th></tr>${sorted.map((p, i) =>
                `<tr><td>${i + 1}</td><td style="color:${p.color}">${esc(p.name)}</td><td><b>${p.vp}</b></td><td>${s.getIncomeLevel(p.id)}</td><td>£${p.money}</td></tr>`).join('')}</table>
              <div class="btns">${this.isHost ? '<button data-restart>回到大厅再来一局</button>' : ''}<button class="primary" data-x>查看版图</button></div>`);
            const r = $('#modal-body [data-restart]'); if (r) r.onclick = () => { this.net.send({ t: 'restart' }); this.closeModal(); };
        }
        const x = $('#modal-body [data-x]'); if (x) x.onclick = () => this.closeModal();
        this.animateScores();
    }
    // era scoring: rows come in one by one, numbers count up, "+N★" floats out
    animateScores() {
        const rows = [...document.querySelectorAll('#modal-body tr.sr')];
        const sp = this.fx.speed;
        if (!rows.length || !sp) return;
        rows.forEach(r => r.classList.add('pre'));
        rows.forEach((r, i) => setTimeout(() => {
            r.classList.remove('pre'); r.classList.add('in');
            const L = +r.dataset.l, I = +r.dataset.i, T = +r.dataset.t;
            this.fx.roll(r.querySelector('.c-l'), 0, L); setTimeout(() => this.fx.roll(r.querySelector('.c-i'), 0, I), 200 / sp);
            this.fx.roll(r.querySelector('.c-t'), T - L - I, T);
            const b = r.getBoundingClientRect();
            setTimeout(() => this.fx.float(b.right - 30, b.top, `+${L + I}★`, 'vp big'), 250 / sp);
            this.fx.sfx.play('score');
        }, (250 + i * 420) / sp));
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
        this.pvCur = d;
        this.placePreview(d, at);
        // The <img> box is reserved via CSS aspect-ratio, but re-place once it has
        // loaded anyway (fonts / captions can still change the height).
        const img = pv.querySelector('img');
        if (img && !img.complete) img.addEventListener('load', () => { if (!pv.hidden && this.pvCur === d) this.placePreview(d, at); }, { once: true });
        clearTimeout(this.pvTimer);
        if (autoHideMs) this.pvTimer = setTimeout(() => this.hidePreview(), autoHideMs);
    }
    // Position the preview fully inside the viewport. For hand cards it goes
    // beside the hand (bottom-aligned) when there is room, else centred above the
    // hand; the image shrinks to fit the free height so it never covers the hand.
    placePreview(d, at) {
        const pv = $('#preview'), img = pv.querySelector('img'), vw = window.innerWidth, vh = window.innerHeight;
        if (img) img.style.width = '';
        let w = pv.offsetWidth, h = pv.offsetHeight;
        const fit = maxH => {
            if (!img || h <= maxH) return;
            const extra = h - img.offsetHeight, ar = img.offsetWidth / Math.max(1, img.offsetHeight);
            img.style.width = Math.max(60, Math.floor((maxH - extra) * ar)) + 'px';
            w = pv.offsetWidth; h = pv.offsetHeight;
        };
        let x, y;
        const hand = d.anchor && d.anchor.closest('#hand') && $('#hand');
        if (hand) {
            const r = hand.getBoundingClientRect(), sideL = r.left - 20, sideR = vw - r.right - 20;
            fit(vh - 16);
            if (sideL >= w || sideR >= w) { x = sideL >= w ? r.left - w - 12 : r.right + 12; y = vh - h - 8; }
            else { fit(r.top - 16); x = r.left + r.width / 2 - w / 2; y = r.top - h - 8; }
        } else if (d.anchor) {
            fit(vh - 16);
            const r = d.anchor.getBoundingClientRect();
            x = r.left + r.width / 2 - w / 2; y = r.top - h - 12;
            if (y < 8) { x = r.right + 12; y = r.top + r.height / 2 - h / 2; }
            if (x + w > vw - 8) x = r.left - w - 12;
        } else if (at) { fit(vh - 16); x = at.x + 20; y = at.y - h / 2; if (x + w > vw - 8) x = at.x - w - 20; }
        else { fit(vh - 16); x = vw / 2 - w / 2; y = vh / 2 - h / 2; }
        pv.style.left = Math.max(8, Math.min(vw - w - 8, x)) + 'px';
        pv.style.top = Math.max(8, Math.min(vh - h - 8, y)) + 'px';
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
