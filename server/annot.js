// Live board annotations (pings + pen strokes). Pure in-memory: never written
// to rooms.json and never touches the game state / rules engine.
'use strict';

const LIMITS = {
    STROKE_TTL_MS: 60 * 1000,          // default: a stroke fades out after 60 s
    KEEP_TTL_MS: 30 * 60 * 1000,       // "keep" strokes still expire after 30 min
    MAX_PTS_PER_STROKE: 600,
    MAX_PTS_PER_MSG: 160,
    MAX_STROKES_PER_USER: 30,          // oldest dropped beyond this
    MAX_STROKES_PER_ROOM: 120,
    MAX_PTS_PER_ROOM: 24000,
    PING_MIN_GAP_MS: 350,              // ≈ 3 pings/s per connection
    MSG_RATE: 40, MSG_BURST: 80,       // token bucket for all annot messages
};

const store = new Map();               // room code -> { seq, strokes: Map<id, stroke> }
const now = () => Date.now();
const num = v => (typeof v === 'number' && Number.isFinite(v));
const q = v => Math.round(Math.max(-0.05, Math.min(1.05, v)) * 10000) / 10000;

function roomStore(code) {
    let s = store.get(code);
    if (!s) { s = { seq: 0, strokes: new Map() }; store.set(code, s); }
    return s;
}
function drop(code) { store.delete(code); }

function allow(ws) {
    const t = now();
    const b = ws.annotBucket || (ws.annotBucket = { tok: LIMITS.MSG_BURST, at: t });
    b.tok = Math.min(LIMITS.MSG_BURST, b.tok + (t - b.at) / 1000 * LIMITS.MSG_RATE); b.at = t;
    if (b.tok < 1) return false;
    b.tok -= 1; return true;
}

function prune(s, t = now()) {
    const gone = [];
    for (const [id, st] of s.strokes) if (t - st.last > st.ttl) { s.strokes.delete(id); gone.push(id); }
    return gone;
}
function totalPts(s) { let n = 0; for (const st of s.strokes.values()) n += st.pts.length / 2; return n; }

function pub(st, tok) {
    return { id: st.id, seat: st.seat, name: st.name, pts: st.pts, keep: st.keep, ttl: st.ttl, age: now() - st.last, mine: st.owner === tok };
}
function snapshot(code, tok) {
    const s = store.get(code); if (!s) return [];
    prune(s);
    return [...s.strokes.values()].map(st => pub(st, tok));
}

// ctx: { room, ws, seat, name, sendTo(fn(conn) -> msg) }
function handle(ctx, msg) {
    const { room, ws } = ctx;
    if (!room.game) return;                       // board only exists in a game
    if (!allow(ws)) return;
    const s = roomStore(room.code);
    const base = { t: 'annot', seat: ctx.seat, name: ctx.name };
    const op = msg.op;
    if (op === 'ping') {
        if (!num(msg.u) || !num(msg.v)) return;
        const t = now();
        if (ws.annotPingAt && t - ws.annotPingAt < LIMITS.PING_MIN_GAP_MS) return;
        ws.annotPingAt = t;
        const out = { ...base, op: 'ping', id: `p${++s.seq}`, u: q(msg.u), v: q(msg.v) };
        return ctx.sendTo(c => ({ ...out, mine: c.token === ws.token }));
    }
    if (op === 'stroke') {
        const cid = String(msg.id || '').slice(0, 24);
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(cid) || !Array.isArray(msg.pts)) return;
        const raw = msg.pts.slice(0, LIMITS.MAX_PTS_PER_MSG * 2);
        const pts = [];
        for (let i = 0; i + 1 < raw.length; i += 2) { if (num(raw[i]) && num(raw[i + 1])) pts.push(q(raw[i]), q(raw[i + 1])); }
        const owner = ws.token;
        const id = `${ws.annotKey || (ws.annotKey = Math.random().toString(36).slice(2, 8))}-${cid}`;
        prune(s);
        let st = s.strokes.get(id);
        if (!st) {
            if (!pts.length) return;
            const mine = [...s.strokes.values()].filter(x => x.owner === owner);
            while (mine.length >= LIMITS.MAX_STROKES_PER_USER) { const o = mine.shift(); s.strokes.delete(o.id); ctx.sendTo(() => ({ t: 'annot', op: 'clear', ids: [o.id] })); }
            if (s.strokes.size >= LIMITS.MAX_STROKES_PER_ROOM) return;
            const keep = !!msg.keep;
            st = { id, owner, seat: ctx.seat, name: ctx.name, pts: [], keep, ttl: keep ? LIMITS.KEEP_TTL_MS : LIMITS.STROKE_TTL_MS, last: now(), done: false };
            s.strokes.set(id, st);
        }
        if (st.owner !== owner || st.done) return;
        const room_left = Math.max(0, LIMITS.MAX_PTS_PER_ROOM - totalPts(s));
        const cap = Math.min(LIMITS.MAX_PTS_PER_STROKE - st.pts.length / 2, room_left);
        const add = pts.slice(0, Math.max(0, cap) * 2);
        st.pts.push(...add); st.last = now();
        if (msg.end) st.done = true;
        if (!add.length && !msg.end) return;
        const out = { ...base, op: 'stroke', id, pts: add, keep: st.keep, ttl: st.ttl, end: !!msg.end };
        return ctx.sendTo(c => ({ ...out, mine: c.token === owner }));
    }
    if (op === 'clear') {
        const ids = [];
        for (const st of [...s.strokes.values()]) if (msg.all || st.owner === ws.token) { s.strokes.delete(st.id); ids.push(st.id); }
        return ctx.sendTo(c => ({ ...base, op: 'clear', all: !!msg.all, ids, mine: c.token === ws.token }));
    }
}

module.exports = { handle, snapshot, drop, prune, store, LIMITS };
