// Live board annotations: temporary pings and pen strokes, shared with
// everyone in the room over the existing WebSocket. Drawn on a 2D overlay
// canvas that is re-projected from board-plane (u, v) coordinates on every
// render, so it follows pan / zoom / tilt. Never touches game state.
import { PLAYER_CSS } from './board3d.js';

const NEUTRAL = '#d8dee8';
const PING_MS = 4000;
const FADE_MS = 5000;           // strokes fade out over their last 5 s
const SEND_MS = 50;             // stroke chunk flush interval
const MIN_PX = 3;               // min screen distance between sampled points
const LS_KEEP = 'bb3d_annot_keep';

const colorOf = seat => (seat >= 0 && PLAYER_CSS[seat]) || NEUTRAL;

export class Annotator {
    constructor(net) {
        this.net = net;
        this.board = null;
        this.mode = null;               // null | 'ping' | 'pen'
        this.strokes = new Map();       // id -> { id, seat, name, pts: [u,v,...], keep, ttl, t0, mine, local }
        this.pings = [];                // { id, seat, name, u, v, t0, mine }
        this.keep = localStorage.getItem(LS_KEEP) === '1';
        this.cur = null;                // stroke being drawn by me
        this.seq = 0;
        this.me = -1;
        this.onChange = () => {};
    }

    // ---------------------------------------------------------------- setup
    attach(board) {
        this.board = board;
        const cv = this.canvas = document.createElement('canvas');
        cv.id = 'annot-layer';
        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
        board.container.appendChild(cv);
        this.ctx = cv.getContext('2d');
        board.afterRender = () => this.draw();
        board.wantFrames = () => this.wantFrames();
        board.tapFilter = e => this.onTap(e);
        const el = board.renderer.domElement;
        el.addEventListener('pointerdown', e => this.penDown(e));
        el.addEventListener('pointermove', e => this.penMove(e));
        el.addEventListener('pointerup', e => this.penUp(e));
        el.addEventListener('pointercancel', e => this.penUp(e, true));
        this.pointers = new Set();
        el.addEventListener('pointerdown', e => this.pointers.add(e.pointerId), true);
        const rm = e => this.pointers.delete(e.pointerId);
        el.addEventListener('pointerup', rm); el.addEventListener('pointercancel', rm);
        board.dirty = true;
    }

    setMode(mode) {
        this.mode = this.mode === mode ? null : mode;
        const b = this.board;
        if (b) {
            b.annotMode = this.mode;
            // pen: one finger / left drag draws, wheel / pinch still zooms
            b.controls.enablePan = this.mode !== 'pen';
            b.controls.enableRotate = this.mode !== 'pen';
            b.renderer.domElement.style.cursor = this.mode ? 'crosshair' : '';
        }
        if (this.mode !== 'pen') this.finishStroke();
        this.onChange();
    }
    setKeep(v) { this.keep = !!v; localStorage.setItem(LS_KEEP, v ? '1' : '0'); this.onChange(); }

    // ---------------------------------------------------------------- input
    onTap(e) {
        if (e.altKey || this.mode === 'ping') { this.sendPing(e.clientX, e.clientY); return true; }
        return this.mode === 'pen';     // pen taps never select board things
    }
    sendPing(x, y) {
        const p = this.board.uvAt(x, y); if (!p) return;
        this.net.send({ t: 'annot', op: 'ping', u: p.u, v: p.v });
    }
    penDown(e) {
        if (this.mode !== 'pen' || e.button > 0) return;
        if (this.pointers.size > 1) { this.finishStroke(); return; }   // second finger: pinch, not ink
        const p = this.board.uvAt(e.clientX, e.clientY); if (!p) return;
        try { e.target.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
        const st = { id: 'L' + id, cid: id, seat: this.me, name: '', pts: [p.u, p.v], keep: this.keep, ttl: this.keep ? 30 * 60e3 : 60e3, t0: performance.now(), mine: true, local: true, live: true };
        this.strokes.set(st.id, st);
        this.cur = { st, pid: e.pointerId, buf: [p.u, p.v], lx: e.clientX, ly: e.clientY, n: 1, sent: false };
        this.flushT = setInterval(() => this.flush(false), SEND_MS);
        this.board.dirty = true;
        e.preventDefault();
    }
    penMove(e) {
        const c = this.cur; if (!c || e.pointerId !== c.pid) return;
        if (this.pointers.size > 1) { this.finishStroke(); return; }
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of (evs.length ? evs : [e])) {
            if (Math.hypot(ev.clientX - c.lx, ev.clientY - c.ly) < MIN_PX || c.n >= 600) continue;
            const p = this.board.uvAt(ev.clientX, ev.clientY); if (!p) continue;
            c.lx = ev.clientX; c.ly = ev.clientY; c.n++;
            c.st.pts.push(p.u, p.v); c.buf.push(p.u, p.v);
        }
        this.board.dirty = true;
    }
    penUp(e) { if (this.cur && e.pointerId === this.cur.pid) this.finishStroke(); }
    flush(end) {
        const c = this.cur; if (!c) return;
        if (!c.buf.length && !end) return;
        while (c.buf.length > 320) this.net.send({ t: 'annot', op: 'stroke', id: c.st.cid, pts: c.buf.splice(0, 320), keep: c.st.keep });
        if (!c.buf.length && end && !c.sent) return;
        this.net.send({ t: 'annot', op: 'stroke', id: c.st.cid, pts: c.buf.splice(0), keep: c.st.keep, end: !!end });
        c.sent = true;
    }
    finishStroke() {
        if (!this.cur) return;
        clearInterval(this.flushT);
        this.flush(true);
        this.cur.st.live = false; this.cur.st.t0 = performance.now();
        this.cur = null;
        this.onChange();
    }
    clear(all) { this.net.send({ t: 'annot', op: 'clear', all: !!all }); }

    // ---------------------------------------------------------------- network
    onMessage(m) {
        const now = performance.now();
        if (m.t === 'annots') {
            this.strokes.clear();
            for (const s of m.strokes || []) this.strokes.set(s.id, { ...s, t0: now - (s.age || 0) });
        } else if (m.op === 'ping') {
            this.pings.push({ id: m.id, seat: m.seat, name: m.name, u: m.u, v: m.v, t0: now, mine: m.mine });
            if (this.pings.length > 30) this.pings.shift();
            this.onPing && this.onPing(m);
        } else if (m.op === 'stroke') {
            if (m.mine) {                      // my own echo: already drawn locally; just learn name/colour
                for (const s of this.strokes.values()) if (s.local && s.id === 'L' + m.id.split('-').slice(1).join('-')) { s.name = m.name; s.seat = m.seat; s.srv = m.id; }
            } else {
                let s = this.strokes.get(m.id);
                if (!s) { s = { id: m.id, seat: m.seat, name: m.name, pts: [], keep: m.keep, ttl: m.ttl, t0: now, mine: false, live: true }; this.strokes.set(m.id, s); }
                s.pts.push(...m.pts); s.t0 = now; if (m.end) s.live = false;
            }
        } else if (m.op === 'clear') {
            if (m.all) this.strokes.clear();
            else if (m.mine) { for (const [id, s] of this.strokes) if (s.mine && s !== (this.cur && this.cur.st)) this.strokes.delete(id); }
            else for (const id of m.ids || []) { this.strokes.delete(id); for (const [k, s] of this.strokes) if (s.srv === id) this.strokes.delete(k); }
        } else return;
        this.onChange();
        if (this.board) this.board.dirty = true;
    }

    // ---------------------------------------------------------------- render
    wantFrames() {
        const now = performance.now();
        let want = !!this.cur || this.pings.length > 0;
        if (this.pings.length) this.pings = this.pings.filter(p => now - p.t0 < PING_MS);
        for (const [id, s] of this.strokes) {
            if (s.live) continue;
            const left = s.ttl - (now - s.t0);
            if (left <= 0) { this.strokes.delete(id); want = true; this.onChange(); }
            else if (left < FADE_MS) want = true;
        }
        if (!want && this.hadInk) { this.hadInk = false; want = true; }   // one last clean frame
        return want;
    }
    draw() {
        const b = this.board, cv = this.canvas; if (!cv) return;
        const w = b.renderer.domElement.clientWidth, h = b.renderer.domElement.clientHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const x = this.ctx; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
        const now = performance.now();
        x.lineCap = 'round'; x.lineJoin = 'round';
        for (const s of this.strokes.values()) {
            const left = s.live ? Infinity : s.ttl - (now - s.t0);
            const a = Math.max(0, Math.min(1, left / FADE_MS)); if (a <= 0 || s.pts.length < 2) continue;
            const pts = [];
            for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push(b.uvToScreen(s.pts[i], s.pts[i + 1]));
            x.globalAlpha = a;
            for (const [col, lw] of [['rgba(0,0,0,.55)', 7], [colorOf(s.seat), 4]]) {
                x.strokeStyle = col; x.lineWidth = lw; x.beginPath();
                x.moveTo(pts[0].x, pts[0].y);
                if (pts.length === 1) x.lineTo(pts[0].x + 0.1, pts[0].y);
                for (let i = 1; i < pts.length; i++) x.lineTo(pts[i].x, pts[i].y);
                x.stroke();
            }
        }
        for (const p of this.pings) {
            const k = (now - p.t0) / PING_MS; if (k >= 1) continue;
            const c = colorOf(p.seat);
            let { x: px, y: py } = b.uvToScreen(p.u, p.v);
            const off = px < 0 || py < 0 || px > w || py > h;
            px = Math.max(16, Math.min(w - 16, px)); py = Math.max(16, Math.min(h - 16, py));
            const a = k > 0.75 ? (1 - k) / 0.25 : 1;
            x.globalAlpha = a;
            for (let r = 0; r < 2; r++) {
                const q = ((now - p.t0) / 900 + r * 0.5) % 1;
                x.strokeStyle = c; x.lineWidth = 3 * (1 - q) + 1;
                x.globalAlpha = a * (1 - q);
                x.beginPath(); x.arc(px, py, 8 + 34 * q, 0, Math.PI * 2); x.stroke();
            }
            x.globalAlpha = a;
            x.fillStyle = c; x.strokeStyle = 'rgba(0,0,0,.7)'; x.lineWidth = 2;
            x.beginPath(); x.arc(px, py, off ? 9 : 7, 0, Math.PI * 2); x.fill(); x.stroke();
            if (p.name) {
                x.font = '600 14px system-ui, sans-serif';
                const tw = x.measureText(p.name).width, bx = Math.min(w - tw - 22, px + 14), by = Math.max(4, py - 34);
                x.fillStyle = 'rgba(16,12,8,.85)'; roundRect(x, bx, by, tw + 16, 24, 12); x.fill();
                x.strokeStyle = c; x.lineWidth = 2; x.stroke();
                x.fillStyle = '#fff'; x.textBaseline = 'middle'; x.fillText(p.name, bx + 8, by + 12);
            }
        }
        x.globalAlpha = 1;
        this.hadInk = this.strokes.size > 0 || this.pings.length > 0;
        cv.dataset.strokes = String([...this.strokes.values()].filter(s => s.pts.length >= 2).length);
        cv.dataset.pings = String(this.pings.length);
    }
}

function roundRect(x, X, Y, W, H, r) {
    x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r);
    x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
}
