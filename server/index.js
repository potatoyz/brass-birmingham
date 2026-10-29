// Brass: Birmingham online server: static files + WebSocket rooms.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '28789', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AI_DELAY_MS = parseInt(process.env.AI_DELAY_MS || '1100', 10);
// Room auto-close: a room with no live human connection (seated player or
// spectator) for ROOM_IDLE_TTL_S seconds is closed and deleted (memory +
// rooms.json). AI seats never keep a room alive. Checked every ROOM_SWEEP_MS.
const ROOM_IDLE_TTL_MS = Math.max(1, parseFloat(process.env.ROOM_IDLE_TTL_S || '3600')) * 1000;
const ROOM_SWEEP_MS = Math.max(50, parseInt(process.env.ROOM_SWEEP_MS || String(5 * 60 * 1000), 10));
const BOOT_AT = Date.now();
const MAX_ROOMS = 300;
const ROOT = path.join(__dirname, '..');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

// ---------------------------------------------------------------------------
// Static files (whitelisted)
// ---------------------------------------------------------------------------
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};
const STATIC_DIRS = ['js', 'css', 'assets'];
const gzCache = new Map();

function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel === '/index.html') rel = '/index.html';
    else {
        const top = rel.split('/')[1];
        if (!STATIC_DIRS.includes(top)) return notFound(res);
    }
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return notFound(res);
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return notFound(res);
        const ext = path.extname(file).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        const isText = /text|javascript|json|svg/.test(type);
        const headers = {
            'Content-Type': type,
            'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=604800',
            'Last-Modified': st.mtime.toUTCString(),
        };
        if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
            res.writeHead(304, headers); return res.end();
        }
        const acceptGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        if (isText && acceptGz) {
            const key = file + ':' + st.mtimeMs;
            let buf = gzCache.get(key);
            if (!buf) { buf = zlib.gzipSync(fs.readFileSync(file)); gzCache.set(key, buf); }
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
            headers['Content-Length'] = buf.length;
            res.writeHead(200, headers);
            return res.end(req.method === 'HEAD' ? undefined : buf);
        }
        headers['Content-Length'] = st.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }

const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        let active = 0;
        for (const r of rooms.values()) if (r.emptySince == null) active++;
        return res.end(JSON.stringify({
            ok: true, rooms: rooms.size, activeRooms: active, idleRooms: rooms.size - active,
            idleTtlSec: ROOM_IDLE_TTL_MS / 1000, rssMB: Math.round(process.memoryUsage().rss / 1048576),
            uptime: Math.round(process.uptime()),
        }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    try { serveStatic(req, res, urlPath); } catch (e) { notFound(res); }
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();          // code -> room
const conns = new Set();          // live ws connections
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
    for (let i = 0; i < 1000; i++) {
        let c = '';
        for (let j = 0; j < 4; j++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
        if (!rooms.has(c)) return c;
    }
    throw new Error('no code');
}
function cleanName(n) {
    n = String(n || '').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 16);
    return n || '玩家';
}
function cleanToken(t) { t = String(t || ''); return /^[A-Za-z0-9_-]{16,64}$/.test(t) ? t : null; }

function newRoom(hostToken, hostName, numSeats) {
    const code = genCode();
    const room = {
        code, createdAt: Date.now(), updatedAt: Date.now(), hostToken,
        status: 'lobby', numSeats,
        seats: Array.from({ length: 4 }, () => ({ token: null, name: '', ai: false, difficulty: 'normal' })),
        members: {},                // token -> { name }
        game: null,                 // GameState instance (runtime)
        version: 0, log: [], pendingBonus: null, event: null, eventSeq: 0,
        emptySince: null,           // ms timestamp when the last human connection left (null = someone online)
    };
    room.members[hostToken] = { name: hostName };
    room.seats[0].token = hostToken;
    room.seats[0].name = hostName;
    rooms.set(code, room);
    return room;
}

function seatOf(room, token) {
    for (let i = 0; i < room.numSeats; i++) if (room.seats[i].token === token) return i;
    return -1;
}
function onlineTokens(room) {
    const s = new Set();
    for (const c of conns) if (c.code === room.code && c.token) s.add(c.token);
    return s;
}
function hasHumanConn(code) {
    for (const c of conns) if (c.code === code && c.token) return true;
    return false;
}
// Re-evaluate whether a room currently has any live human connection and
// start/stop its idle clock accordingly.
function notePresence(code) {
    const room = code && rooms.get(code);
    if (!room) return;
    if (hasHumanConn(code)) {
        if (room.emptySince != null) { room.emptySince = null; scheduleSave(); }
    } else if (room.emptySince == null) {
        room.emptySince = Date.now();
        scheduleSave();
    }
}
function setConnRoom(ws, code) {
    const prev = ws.code;
    ws.code = code;
    if (prev && prev !== code) notePresence(prev);
    if (code) notePresence(code);
}
function addLog(room, playerId, message, type = 'action') {
    room.log.unshift({ playerId, message, type });
    if (room.log.length > 150) room.log.length = 150;
}

function publicRoom(room) {
    const online = onlineTokens(room);
    const seats = room.seats.slice(0, room.numSeats).map((s, i) => {
        const p = room.game ? room.game.players[i] : null;
        return {
            index: i,
            name: s.name || (s.ai ? `AI ${i + 1}` : ''),
            human: !!s.token,
            ai: room.game ? !!p.isAI : s.ai,
            difficulty: room.game ? p.aiDifficulty : s.difficulty,
            online: !!s.token && online.has(s.token),
            host: !!s.token && s.token === room.hostToken,
        };
    });
    const seatTokens = new Set(room.seats.slice(0, room.numSeats).map(s => s.token).filter(Boolean));
    const spectators = Object.entries(room.members)
        .filter(([t]) => !seatTokens.has(t) && online.has(t)).map(([, m]) => m.name);
    return { code: room.code, status: room.status, numSeats: room.numSeats, seats, spectators };
}

function viewFor(room, seat) {
    if (!room.game) return null;
    const v = E.cloneData(room.game);
    v.players.forEach((p, i) => { if (i !== seat) p.hand = p.hand.map(() => ({ type: 'hidden' })); });
    v.drawDeck = v.drawDeck.map(() => 0);
    return v;
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function sendRoom(ws, room) {
    const seat = seatOf(room, ws.token);
    send(ws, {
        t: 'room',
        room: publicRoom(room),
        you: { seat, isHost: ws.token === room.hostToken },
        game: viewFor(room, seat),
        version: room.version,
        log: room.log.slice(0, 100),
        pendingBonus: room.pendingBonus && room.pendingBonus.playerId === seat && seat >= 0
            ? { count: room.pendingBonus.count, types: E.developableTypes(room.game, seat) }
            : (room.pendingBonus ? { waiting: room.pendingBonus.playerId } : null),
        event: room.event,
    });
}

function broadcast(room) {
    for (const c of conns) if (c.code === room.code) sendRoom(c, room);
}

function touch(room, changedGame) {
    room.updatedAt = Date.now();
    if (changedGame) room.version++;
    scheduleSave();
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
function startGame(room) {
    const n = room.numSeats;
    const names = [], ai = [];
    for (let i = 0; i < n; i++) {
        const s = room.seats[i];
        names.push(s.token ? s.name : (s.name || `AI ${i + 1}`));
        ai.push({ isAI: !s.token && s.ai, difficulty: s.difficulty || 'normal' });
    }
    room.game = E.newGame(names, ai);
    room.status = 'playing';
    room.log = [];
    room.pendingBonus = null;
    room.event = null;
    addLog(room, null, `游戏开始：${n} 名玩家`, 'system');
    addLog(room, null, '运河时代', 'era');
    addLog(room, null, `轮到 ${room.game.currentPlayer.name}`, 'system');
}

function advance(room, prevPid) {
    const s = room.game;
    const tr = s.advanceTurn();
    for (const ev of s.lastRoundEvents || []) addLog(room, ev.playerId, ev.message);
    s.lastRoundEvents = [];
    if (tr === 'endCanalEra') {
        addLog(room, null, '运河时代计分', 'era');
        const scores = s.endCanalEra();
        addLog(room, null, '铁路时代', 'era');
        room.event = { id: ++room.eventSeq, kind: 'scoring', title: '运河时代结束', scores };
        addLog(room, null, `轮到 ${s.currentPlayer.name}`, 'system');
    } else if (tr === 'endGame') {
        addLog(room, null, '最终计分', 'era');
        const scores = s.endGame();
        room.status = 'ended';
        room.event = { id: ++room.eventSeq, kind: 'gameover', scores };
    } else if (s.currentPlayerId !== prevPid) {
        addLog(room, null, `轮到 ${s.currentPlayer.name}`, 'system');
    }
}

function doAction(room, pid, msg, isAI) {
    const r = E.applyAction(room.game, pid, msg, isAI);
    if (!r.ok) return r;
    addLog(room, pid, r.logText || r.message);
    if (r.pendingDevelopBonuses > 0 && E.developableTypes(room.game, pid).length > 0) {
        room.pendingBonus = { playerId: pid, count: r.pendingDevelopBonuses };
    } else {
        advance(room, pid);
    }
    return r;
}

function finishBonus(room) {
    const pid = room.pendingBonus.playerId;
    room.pendingBonus = null;
    advance(room, pid);
}

const aiTimers = new Map();
function scheduleAI(room) {
    if (aiTimers.has(room.code)) return;
    if (room.status !== 'playing' || !room.game || room.game.gameOver) return;
    const s = room.game;
    if (room.pendingBonus) {
        if (!s.players[room.pendingBonus.playerId].isAI) return;
    } else if (!s.currentPlayer.isAI) return;
    aiTimers.set(room.code, setTimeout(() => {
        aiTimers.delete(room.code);
        if (!rooms.has(room.code) || room.status !== 'playing') return;
        try { aiStep(room); } catch (e) { console.error('AI error', room.code, e); }
        touch(room, true);
        broadcast(room);
        scheduleAI(room);
    }, AI_DELAY_MS));
}

function aiStep(room) {
    const s = room.game;
    if (room.pendingBonus) {
        const pid = room.pendingBonus.playerId;
        const removed = s.players[pid].isAI ? new E.GameLogic(s).applyFreeDevelop(pid, room.pendingBonus.count) : [];
        if (removed.length) addLog(room, pid, `使用商人奖励：免费发展 ${removed.join('、')}`);
        return finishBonus(room);
    }
    const pid = s.currentPlayerId;
    const d = E.chooseAI(s, pid);
    let r = doAction(room, pid, d, true);
    if (!r.ok) {
        console.warn('AI action rejected', room.code, d.action, r.message);
        r = doAction(room, pid, { action: 'pass', cardIndex: 0 }, true);
    }
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });

wss.on('connection', (ws) => {
    ws.token = null; ws.code = null; ws.isAlive = true;
    conns.add(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        try { handle(ws, msg); } catch (e) {
            console.error('handler error', e);
            send(ws, { t: 'error', message: '服务器错误' });
        }
    });
    ws.on('close', () => {
        conns.delete(ws);
        const room = ws.code && rooms.get(ws.code);
        if (room) { notePresence(room.code); broadcast(room); }
    });
});

setInterval(() => {
    for (const ws of conns) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    }
}, 30000);

function noRoomMsg(code) {
    return `房间 ${code || '?'} 已关闭或不存在（房间内无人在线满 ${fmtTtl()}会自动关闭）`;
}
function fmtTtl() {
    const s = ROOM_IDLE_TTL_MS / 1000;
    return s >= 3600 && s % 3600 === 0 ? `${s / 3600} 小时` : s >= 60 && s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`;
}
function err(ws, message) { send(ws, { t: 'error', message }); }

function handle(ws, msg) {
    if (msg.t === 'hello') {
        const tok = cleanToken(msg.token);
        if (!tok) return err(ws, '无效身份');
        ws.token = tok;
        return send(ws, { t: 'hello', ok: true });
    }
    if (!ws.token) return err(ws, '请先连接');
    if (msg.t === 'ping') return send(ws, { t: 'pong' });

    if (msg.t === 'create') {
        if (rooms.size >= MAX_ROOMS) return err(ws, '房间数已满，请稍后再试');
        const n = [2, 3, 4].includes(msg.seats) ? msg.seats : 4;
        const room = newRoom(ws.token, cleanName(msg.name), n);
        setConnRoom(ws, room.code);
        touch(room, true);
        return broadcast(room);
    }
    if (msg.t === 'join') {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', message: noRoomMsg(code), code: 'noroom' });
        const name = cleanName(msg.name);
        setConnRoom(ws, code);
        const seat = seatOf(room, ws.token);
        if (!room.members[ws.token]) room.members[ws.token] = { name };
        if (seat < 0 && room.status === 'lobby') {
            room.members[ws.token].name = name;
            const free = room.seats.slice(0, room.numSeats).findIndex(s => !s.token && !s.ai);
            if (free >= 0) { room.seats[free].token = ws.token; room.seats[free].name = name; }
        }
        touch(room, false);
        return broadcast(room);
    }

    const room = ws.code && rooms.get(ws.code);
    if (!room) {
        if (ws.code) { const c = ws.code; ws.code = null; return send(ws, { t: 'error', message: noRoomMsg(c), code: 'noroom' }); }
        return err(ws, '你不在房间中');
    }
    const isHost = ws.token === room.hostToken;
    const mySeat = seatOf(room, ws.token);

    switch (msg.t) {
        case 'leave': {
            if (room.status === 'lobby' && mySeat >= 0) {
                room.seats[mySeat] = { token: null, name: '', ai: false, difficulty: 'normal' };
                if (isHost) {
                    const other = room.seats.slice(0, room.numSeats).find(s => s.token);
                    if (other) room.hostToken = other.token;
                }
            }
            setConnRoom(ws, null);
            touch(room, false);
            broadcast(room);
            return send(ws, { t: 'left' });
        }
        case 'sit': { // lobby: take a specific free seat (or move)
            if (room.status !== 'lobby') return err(ws, '游戏已开始');
            const i = msg.seat;
            if (!Number.isInteger(i) || i < 0 || i >= room.numSeats) return;
            const s = room.seats[i];
            if (s.token || s.ai) return err(ws, '该座位已被占用');
            if (mySeat >= 0) room.seats[mySeat] = { token: null, name: '', ai: false, difficulty: 'normal' };
            room.seats[i] = { token: ws.token, name: room.members[ws.token].name, ai: false, difficulty: 'normal' };
            touch(room, false); return broadcast(room);
        }
        case 'standUp': {
            if (room.status !== 'lobby' || mySeat < 0) return;
            room.seats[mySeat] = { token: null, name: '', ai: false, difficulty: 'normal' };
            touch(room, false); return broadcast(room);
        }
        case 'setSeats': {
            if (!isHost || room.status !== 'lobby') return err(ws, '只有房主可以修改');
            const n = msg.n;
            if (![2, 3, 4].includes(n)) return;
            for (let i = n; i < 4; i++) {
                if (room.seats[i].token === room.hostToken) return err(ws, '请先换到前面的座位');
            }
            for (let i = n; i < 4; i++) room.seats[i] = { token: null, name: '', ai: false, difficulty: 'normal' };
            room.numSeats = n;
            touch(room, false); return broadcast(room);
        }
        case 'setAI': {
            if (!isHost) return err(ws, '只有房主可以设置 AI');
            const i = msg.seat;
            if (!Number.isInteger(i) || i < 0 || i >= room.numSeats) return;
            const diff = ['easy', 'normal', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'normal';
            if (room.status === 'lobby') {
                const s = room.seats[i];
                if (s.token) return err(ws, '该座位有玩家，请先移出');
                room.seats[i] = { token: null, name: msg.on ? `AI ${i + 1}` : '', ai: !!msg.on, difficulty: diff };
                touch(room, false); return broadcast(room);
            }
            if (room.status === 'playing') {
                const p = room.game.players[i];
                if (!msg.on && !room.seats[i].token) return err(ws, '该座位没有真人玩家，只能由 AI 控制');
                p.isAI = !!msg.on;
                if (msg.on) p.aiDifficulty = diff;
                addLog(room, i, msg.on ? '由 AI 接管' : '恢复为真人操作');
                touch(room, true); broadcast(room); return scheduleAI(room);
            }
            return;
        }
        case 'kick': {
            if (!isHost || room.status !== 'lobby') return;
            const i = msg.seat;
            if (!Number.isInteger(i) || i < 0 || i >= room.numSeats) return;
            if (room.seats[i].token === room.hostToken) return;
            room.seats[i] = { token: null, name: '', ai: false, difficulty: 'normal' };
            touch(room, false); return broadcast(room);
        }
        case 'reclaim': { // seat owner takes their seat back from the AI
            if (room.status !== 'playing' || mySeat < 0) return;
            room.game.players[mySeat].isAI = false;
            addLog(room, mySeat, '恢复为真人操作');
            touch(room, true); return broadcast(room);
        }
        case 'start': {
            if (!isHost) return err(ws, '只有房主可以开始');
            if (room.status !== 'lobby') return;
            const seats = room.seats.slice(0, room.numSeats);
            if (seats.some(s => !s.token && !s.ai)) return err(ws, '还有空座位：等人加入，或设为 AI');
            startGame(room);
            touch(room, true); broadcast(room); return scheduleAI(room);
        }
        case 'restart': { // back to lobby after a finished game
            if (!isHost || room.status !== 'ended') return;
            room.status = 'lobby'; room.game = null; room.event = null; room.pendingBonus = null; room.log = [];
            touch(room, true); return broadcast(room);
        }
        case 'action': {
            if (room.status !== 'playing' || !room.game) return err(ws, '游戏未在进行');
            const s = room.game;
            if (mySeat < 0) return err(ws, '观战者不能操作');
            if (room.pendingBonus) return err(ws, '等待奖励选择');
            if (s.currentPlayerId !== mySeat) return err(ws, '还没轮到你');
            if (s.players[mySeat].isAI) return err(ws, '你的座位正由 AI 控制');
            if (msg.version !== undefined && msg.version !== room.version) {
                sendRoom(ws, room);
                return err(ws, '局面已更新，请重新操作');
            }
            const r = doAction(room, mySeat, msg, false);
            if (!r.ok) { sendRoom(ws, room); return send(ws, { t: 'result', ok: false, message: r.message }); }
            touch(room, true);
            send(ws, { t: 'result', ok: true, message: r.message });
            broadcast(room); return scheduleAI(room);
        }
        case 'bonus': {
            const pb = room.pendingBonus;
            if (!pb || pb.playerId !== mySeat) return;
            if (msg.type === 'skip') {
                finishBonus(room);
            } else {
                const removed = E.applyFreeDevelop(room.game, mySeat, msg.type);
                if (!removed) return err(ws, '无效选择');
                addLog(room, mySeat, `使用商人奖励：免费发展 ${removed}`);
                pb.count--;
                if (pb.count <= 0 || E.developableTypes(room.game, mySeat).length === 0) finishBonus(room);
            }
            touch(room, true); broadcast(room); return scheduleAI(room);
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
}
function saveNow() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const out = [];
        for (const r of rooms.values()) {
            const { game, ...rest } = r;
            out.push({ ...rest, game: game ? JSON.parse(E.serialize(game)) : null });
        }
        const tmp = ROOMS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(out));
        fs.renameSync(tmp, ROOMS_FILE);
    } catch (e) { console.error('save failed', e); }
}
function load() {
    try {
        const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        for (const r of arr) {
            if (r.game) r.game = E.hydrate(r.game);
            // Nobody is connected right after a restart. Keep a persisted idle
            // clock; rooms that were active (or saved by an older version)
            // start counting from boot.
            if (typeof r.emptySince !== 'number') { r.emptySince = BOOT_AT; scheduleSave(); }
            rooms.set(r.code, r);
        }
        console.log(`loaded ${rooms.size} rooms`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('load failed', e);
    }
}
function closeRoom(room, reason) {
    const code = room.code;
    const t = aiTimers.get(code);
    if (t) { clearTimeout(t); aiTimers.delete(code); }
    for (const c of conns) {
        if (c.code !== code) continue;
        c.code = null;
        send(c, { t: 'error', message: noRoomMsg(code), code: 'noroom' });
    }
    rooms.delete(code);
    console.log(`[cleanup] closed room ${code} (${reason}; status=${room.status}, seats=${room.numSeats})`);
}
function sweepRooms() {
    const now = Date.now();
    let n = 0;
    for (const room of [...rooms.values()]) {
        if (hasHumanConn(room.code)) { if (room.emptySince != null) { room.emptySince = null; scheduleSave(); } continue; }
        if (room.emptySince == null) { room.emptySince = now; scheduleSave(); continue; }
        const idle = now - room.emptySince;
        if (idle >= ROOM_IDLE_TTL_MS) { closeRoom(room, `no human online for ${Math.round(idle / 1000)}s`); n++; }
    }
    if (n) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        saveNow();
        console.log(`[cleanup] closed ${n} idle room(s); ${rooms.size} left, rss ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
    }
    return n;
}

load();
sweepRooms();
for (const r of rooms.values()) scheduleAI(r);
setInterval(sweepRooms, ROOM_SWEEP_MS).unref();
console.log(`[cleanup] room idle sweeper started: close after ${ROOM_IDLE_TTL_MS / 1000}s with no human online, check every ${ROOM_SWEEP_MS / 1000}s; ${rooms.size} rooms loaded`);

function shutdown() { if (saveTimer) clearTimeout(saveTimer); saveNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log(`Brass online listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));

module.exports = { rooms };
