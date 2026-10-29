// ============================================================================
// Brass: Birmingham - Online rooms client (lobby + server-driven game view)
// ============================================================================

const Online = (() => {
    const LS_TOKEN = 'bb_token', LS_NAME = 'bb_name', LS_ROOM = 'bb_room', LS_SEEN = 'bb_seen_events';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function getToken() {
        let t = localStorage.getItem(LS_TOKEN);
        if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
            const a = new Uint8Array(16);
            (window.crypto || window.msCrypto).getRandomValues(a);
            t = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(LS_TOKEN, t);
        }
        return t;
    }

    function showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    }

    function toast(msg, type = 'info') {
        const c = document.getElementById('toast-container');
        if (!c) return alert(msg);
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        c.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'all .3s'; setTimeout(() => el.remove(), 300); }, 3000);
    }

    function hydrate(data) {
        const s = Object.create(GameState.prototype);
        Object.assign(s, data);
        return s;
    }

    const DIFF_LABEL = { easy: '简单', normal: '普通', hard: '困难' };

    class OnlineClient {
        constructor() {
            this.token = getToken();
            this.ws = null;
            this.connected = false;
            this.code = null;
            this.isHost = false;
            this.mySeat = -1;
            this.room = null;
            this.retry = 0;
            this.ui = null;          // UIManager once in a game
            this.gameShownVersion = null;
            this.pendingIntent = null;
        }

        get name() { return (localStorage.getItem(LS_NAME) || '').trim() || '玩家'; }

        connect() {
            if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(`${proto}://${location.host}/ws`);
            this.ws = ws;
            ws.onopen = () => {
                this.connected = true;
                this.retry = 0;
                this.setStatus(true);
                this.raw({ t: 'hello', token: this.token });
                if (this.pendingIntent) { this.raw(this.pendingIntent); this.pendingIntent = null; }
                else if (this.code) this.raw({ t: 'join', code: this.code, name: this.name });
            };
            ws.onmessage = (e) => {
                let msg; try { msg = JSON.parse(e.data); } catch { return; }
                this.onMessage(msg);
            };
            ws.onclose = () => {
                this.connected = false;
                this.setStatus(false);
                if (this.ws !== ws) return;
                const delay = Math.min(10000, 500 * Math.pow(2, this.retry++));
                setTimeout(() => { if (this.ws === ws) { this.ws = null; this.connect(); } }, delay);
            };
            ws.onerror = () => {};
        }

        raw(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
        send(obj) {
            if (!this.connected) { toast('连接已断开，正在重连…', 'error'); return; }
            this.raw(obj);
        }

        // Send now if connected, otherwise once the socket opens
        intent(obj) {
            if (this.connected) this.raw(obj);
            else { this.pendingIntent = obj; this.connect(); }
        }

        setStatus(ok) {
            const dot = document.getElementById('online-dot');
            if (dot) { dot.classList.toggle('off', !ok); dot.title = ok ? '已连接' : '连接中断，正在重连…'; }
            const hint = document.getElementById('lobby-hint');
            if (hint && !ok && this.code) hint.textContent = '连接中断，正在重连…';
            if (this.ui) {
                this.ui.updateActionButtons();
                this.ui.setWaitingOverlay(!this.ui.canAct());
            }
        }

        markEventSeen(id) {
            let seen = {};
            try { seen = JSON.parse(localStorage.getItem(LS_SEEN) || '{}'); } catch {}
            const key = this.code;
            if ((seen[key] || 0) >= id) return false;
            seen[key] = id;
            localStorage.setItem(LS_SEEN, JSON.stringify(seen));
            return true;
        }

        onMessage(msg) {
            if (msg.t === 'error') {
                if (msg.code === 'noroom') {
                    this.code = null;
                    localStorage.removeItem(LS_ROOM);
                    history.replaceState(null, '', location.pathname);
                    showScreen('setup-screen');
                    setOnlineMsg(msg.message);
                } else {
                    toast(msg.message, 'error');
                    setOnlineMsg(msg.message);
                }
                return;
            }
            if (msg.t === 'result') {
                if (!msg.ok) toast(msg.message, 'error');
                else toast(msg.message, 'success');
                return;
            }
            if (msg.t === 'left') {
                this.code = null; this.room = null;
                localStorage.removeItem(LS_ROOM);
                history.replaceState(null, '', location.pathname);
                showScreen('setup-screen');
                return;
            }
            if (msg.t === 'room') {
                this.room = msg.room;
                this.code = msg.room.code;
                this.isHost = msg.you.isHost;
                this.mySeat = msg.you.seat;
                localStorage.setItem(LS_ROOM, this.code);
                if (!new URLSearchParams(location.search).get('room')) {
                    history.replaceState(null, '', `?room=${this.code}`);
                }
                this.lastMsg = msg;
                if (msg.room.status === 'lobby' || !msg.game) {
                    this.renderLobby(msg);
                    showScreen('lobby-screen');
                } else {
                    this.renderGame(msg);
                }
            }
        }

        // ------------------------------------------------------------------
        // Lobby
        // ------------------------------------------------------------------
        renderLobby(msg) {
            const room = msg.room;
            document.getElementById('lobby-code').textContent = room.code;
            const link = `${location.origin}${location.pathname}?room=${room.code}`;
            document.getElementById('lobby-link').value = link;
            document.querySelectorAll('.lobby-count-btn').forEach(b => {
                b.classList.toggle('active', +b.dataset.n === room.numSeats);
                b.disabled = !this.isHost;
            });
            const box = document.getElementById('lobby-seats');
            box.innerHTML = '';
            room.seats.forEach((s, i) => {
                const row = document.createElement('div');
                row.className = 'lobby-seat';
                const me = i === this.mySeat;
                let label;
                if (s.human) label = `${esc(s.name)}${me ? '（你）' : ''}`;
                else if (s.ai) label = `${esc(s.name)} <span class="ai-chip">AI·${DIFF_LABEL[s.difficulty] || '普通'}</span>`;
                else label = '<span class="lobby-empty">空位 · 等待加入</span>';
                const badges = [];
                if (s.host) badges.push('<span class="lobby-badge">房主</span>');
                if (s.human && !s.online) badges.push('<span class="lobby-badge off">离线</span>');
                let ctrls = '';
                if (!s.human && !s.ai) {
                    if (this.isHost) ctrls += `<select class="lobby-diff" data-seat="${i}"><option value="easy">简单</option><option value="normal" selected>普通</option><option value="hard">困难</option></select><button class="online-mini-btn" data-act="ai-on" data-seat="${i}">设为 AI</button>`;
                    if (!me) ctrls += `<button class="online-mini-btn" data-act="sit" data-seat="${i}">坐这里</button>`;
                } else if (s.ai && this.isHost) {
                    ctrls += `<button class="online-mini-btn" data-act="ai-off" data-seat="${i}">移除 AI</button>`;
                } else if (s.human && this.isHost && !s.host) {
                    ctrls += `<button class="online-mini-btn" data-act="kick" data-seat="${i}">移出</button>`;
                }
                if (me && !s.host) ctrls += `<button class="online-mini-btn" data-act="stand" data-seat="${i}">离座观战</button>`;
                row.innerHTML = `<div class="color-swatch" style="background:${PLAYER_COLORS[i]}"></div>
                    <div class="lobby-seat-name">${label} ${badges.join(' ')}</div>
                    <div class="lobby-seat-ctrls">${ctrls}</div>`;
                box.appendChild(row);
            });
            box.querySelectorAll('button[data-act]').forEach(btn => {
                btn.onclick = () => {
                    const seat = +btn.dataset.seat;
                    const act = btn.dataset.act;
                    if (act === 'ai-on') {
                        const sel = box.querySelector(`.lobby-diff[data-seat="${seat}"]`);
                        this.send({ t: 'setAI', seat, on: true, difficulty: sel ? sel.value : 'normal' });
                    } else if (act === 'ai-off') this.send({ t: 'setAI', seat, on: false });
                    else if (act === 'kick') this.send({ t: 'kick', seat });
                    else if (act === 'sit') this.send({ t: 'sit', seat });
                    else if (act === 'stand') this.send({ t: 'standUp' });
                };
            });
            const spec = room.spectators.length ? `观战：${room.spectators.map(esc).join('、')}` : '';
            document.getElementById('lobby-spectators').innerHTML = spec;
            const startBtn = document.getElementById('lobby-start-btn');
            const filled = room.seats.every(s => s.human || s.ai);
            startBtn.style.display = this.isHost ? '' : 'none';
            startBtn.disabled = !filled;
            startBtn.classList.toggle('disabled', !filled);
            const hint = document.getElementById('lobby-hint');
            if (!this.connected) hint.textContent = '连接中断，正在重连…';
            else if (this.isHost) hint.textContent = filled ? '人齐了，可以开始。' : '把邀请链接或房间号发给朋友；空位可以设为 AI。';
            else hint.textContent = this.mySeat >= 0 ? '已入座，等待房主开始游戏…' : '你正在观战，可点击空位入座。';
        }

        // ------------------------------------------------------------------
        // Game
        // ------------------------------------------------------------------
        renderGame(msg) {
            const state = hydrate(msg.game);
            const screen = document.getElementById('game-screen');
            if (!screen.classList.contains('active')) showScreen('game-screen');
            document.getElementById('online-bar').classList.remove('hidden');
            document.getElementById('online-bar-code').textContent = msg.room.code;

            if (!this.ui) {
                const svg = document.getElementById('game-board');
                const renderer = new BoardRenderer(svg);
                renderer.render(state);
                const logic = new GameLogic(state);
                const ui = new UIManager();
                ui.initOnline(state, logic, renderer, this);
                this.ui = ui;
                window.uiManager = ui;
                window.gameState = state;
            }
            this.ui.applyServerUpdate(state, msg);
            window.gameState = state;
            this.updateGameBar();
        }

        onRefresh() { this.updateGameBar(); }

        updateGameBar() {
            const msg = this.lastMsg;
            if (!msg || !msg.game) return;
            const reclaim = document.getElementById('reclaim-btn');
            const mine = this.mySeat >= 0 && this.ui && this.ui.state.players[this.mySeat];
            reclaim.classList.toggle('hidden', !(mine && mine.isAI && msg.room.status === 'playing'));
            // mark offline players in the panels
            const panels = document.querySelectorAll('#player-panels .player-panel');
            msg.room.seats.forEach((s, i) => {
                const el = panels[i] && panels[i].querySelector('.player-panel-name');
                if (!el) return;
                if (s.human && !s.online && !el.querySelector('.offline-chip')) {
                    el.insertAdjacentHTML('beforeend', ' <span class="offline-chip">离线</span>');
                }
                if (i === this.mySeat && !el.querySelector('.me-chip')) {
                    el.insertAdjacentHTML('beforeend', ' <span class="me-chip">你</span>');
                }
            });
        }

        showSeatsModal() {
            const msg = this.lastMsg;
            if (!msg || !this.ui) return;
            const players = this.ui.state.players;
            let html = '<div class="choice-list">';
            msg.room.seats.forEach((s, i) => {
                const p = players[i];
                const status = p.isAI ? (s.human ? 'AI 代打中' : 'AI') : (s.online ? '在线' : '离线');
                let ctrl = '';
                if (this.isHost && msg.room.status === 'playing') {
                    if (p.isAI && s.human) ctrl = `<button class="online-mini-btn" data-seat="${i}" data-on="0">恢复真人</button>`;
                    else if (!p.isAI) ctrl = `<button class="online-mini-btn" data-seat="${i}" data-on="1">交给 AI</button>`;
                }
                html += `<div class="choice-item" style="cursor:default">
                    <div class="color-swatch" style="background:${p.color};width:14px;height:14px;border-radius:50%"></div>
                    <div class="choice-item-text"><div class="choice-item-name">${esc(p.name)}${i === this.mySeat ? '（你）' : ''}</div>
                    <div class="choice-item-detail">${status}${s.host ? ' · 房主' : ''}</div></div>
                    <div>${ctrl}</div></div>`;
            });
            html += '</div>';
            if (msg.room.spectators.length) html += `<p class="lobby-hint">观战：${msg.room.spectators.map(esc).join('、')}</p>`;
            html += `<p class="lobby-hint">邀请链接：${esc(location.origin + location.pathname + '?room=' + msg.room.code)}</p>`;
            if (this.isHost) html += '<p class="lobby-hint">有人掉线时，可以把他的座位交给 AI 继续；他回来后可点“收回控制”。</p>';
            this.ui.showModal('玩家与座位', html, () => {});
            document.querySelectorAll('#modal-body button[data-seat]').forEach(b => {
                b.onclick = () => {
                    this.send({ t: 'setAI', seat: +b.dataset.seat, on: b.dataset.on === '1', difficulty: 'normal' });
                    this.ui.closeModal();
                };
            });
        }
    }

    let client = null;

    function setOnlineMsg(t) {
        const el = document.getElementById('online-msg');
        if (el) el.textContent = t || '';
    }

    function copyText(input) {
        const text = input.value;
        const done = () => toast('已复制邀请链接', 'success');
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done, () => { input.select(); document.execCommand('copy'); done(); });
        } else {
            input.focus(); input.select();
            try { document.execCommand('copy'); done(); } catch { toast('请手动复制链接', 'warning'); }
        }
    }

    function init() {
        client = new OnlineClient();
        window.onlineClient = client;
        const nameInput = document.getElementById('online-name');
        const codeInput = document.getElementById('join-code');
        nameInput.value = localStorage.getItem(LS_NAME) || '';
        const saveName = () => {
            const v = nameInput.value.trim();
            if (!v) { setOnlineMsg('请先填写昵称'); nameInput.focus(); return false; }
            localStorage.setItem(LS_NAME, v.slice(0, 16));
            return true;
        };

        const params = new URLSearchParams(location.search);
        const urlRoom = (params.get('room') || '').toUpperCase();
        if (urlRoom) codeInput.value = urlRoom;

        document.getElementById('create-room-btn').onclick = () => {
            if (!saveName()) return;
            setOnlineMsg('正在创建房间…');
            client.intent({ t: 'create', name: client.name, seats: 4 });
        };
        const doJoin = () => {
            if (!saveName()) return;
            const code = codeInput.value.trim().toUpperCase();
            if (!/^[A-Z0-9]{4}$/.test(code)) { setOnlineMsg('请输入 4 位房间号'); return; }
            setOnlineMsg('正在加入…');
            client.code = code;
            client.intent({ t: 'join', code, name: client.name });
        };
        document.getElementById('join-room-btn').onclick = doJoin;
        codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

        document.querySelectorAll('.lobby-count-btn').forEach(b => {
            b.onclick = () => client.send({ t: 'setSeats', n: +b.dataset.n });
        });
        document.getElementById('lobby-start-btn').onclick = () => client.send({ t: 'start' });
        document.getElementById('lobby-leave-btn').onclick = () => client.send({ t: 'leave' });
        document.getElementById('copy-link-btn').onclick = () => copyText(document.getElementById('lobby-link'));
        document.getElementById('seats-btn').onclick = () => client.showSeatsModal();
        document.getElementById('reclaim-btn').onclick = () => client.send({ t: 'reclaim' });
        document.getElementById('exit-room-btn').onclick = () => {
            if (!confirm('退出到首页？你的座位会保留，用同一浏览器重新打开房间链接即可回来。')) return;
            localStorage.removeItem(LS_ROOM);
            location.href = location.pathname;
        };
        // Re-open the free-develop choice if it is dismissed while still pending
        document.getElementById('modal-close').addEventListener('click', () => {
            const ui = client.ui;
            if (ui && ui.pendingBonusInfo) setTimeout(() => ui.resolveDevelopBonuses(ui.mySeat, 1, () => {}), 50);
        });

        // Auto-join: room in the URL (invite link) or the last room of this browser
        const lastRoom = localStorage.getItem(LS_ROOM);
        if (urlRoom) {
            if (localStorage.getItem(LS_NAME)) {
                client.code = urlRoom;
                setOnlineMsg(`正在进入房间 ${urlRoom}…`);
                client.connect();
            } else {
                setOnlineMsg(`受邀加入房间 ${urlRoom}：填写昵称后点“加入房间”`);
                nameInput.focus();
            }
        } else if (lastRoom) {
            client.code = lastRoom;
            client.connect();
        }
    }

    return { init, OnlineClient };
})();
