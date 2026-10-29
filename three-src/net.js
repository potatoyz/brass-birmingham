// WebSocket client for the existing room server (same protocol as js/online.js).
const LS_TOKEN = 'bb_token', LS_NAME = 'bb_name', LS_ROOM = 'bb3d_room';

function token() {
    let t = localStorage.getItem(LS_TOKEN);
    if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
        const a = new Uint8Array(16); crypto.getRandomValues(a);
        t = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(LS_TOKEN, t);
    }
    return t;
}

export class Net {
    constructor(handlers) {
        this.h = handlers;
        this.token = token();
        this.ws = null; this.connected = false; this.retry = 0;
        this.code = null; this.queue = [];
    }
    get name() { return (localStorage.getItem(LS_NAME) || '').trim() || '玩家'; }
    set name(v) { localStorage.setItem(LS_NAME, String(v).slice(0, 16)); }
    get lastRoom() { return localStorage.getItem(LS_ROOM); }
    set lastRoom(v) { if (v) localStorage.setItem(LS_ROOM, v); else localStorage.removeItem(LS_ROOM); }

    connect() {
        if (this.ws && this.ws.readyState <= 1) return;
        const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        ws.onopen = () => {
            this.connected = true; this.retry = 0;
            this.raw({ t: 'hello', token: this.token });
            if (this.queue.length) { this.queue.splice(0).forEach(m => this.raw(m)); }
            else if (this.code) this.raw({ t: 'join', code: this.code, name: this.name });
            this.h.status && this.h.status(true);
        };
        ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } this.h.message(m); };
        ws.onclose = () => {
            this.connected = false;
            this.h.status && this.h.status(false);
            if (this.ws !== ws) return;
            const d = Math.min(10000, 500 * 2 ** this.retry++);
            setTimeout(() => { if (this.ws === ws) { this.ws = null; this.connect(); } }, d);
        };
    }
    raw(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
    send(m) {
        if (this.connected) this.raw(m);
        else { this.queue.push(m); this.connect(); }
    }
}
