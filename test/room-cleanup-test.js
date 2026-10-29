// Room auto-close test: rooms with no live human connection for
// ROOM_IDLE_TTL_S are deleted (memory + rooms.json); reconnecting before the
// deadline keeps them; AI-only rooms are not kept alive; the idle clock
// survives a restart.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = 29100 + Math.floor(Math.random() * 500);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bbclean-'));
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const TTL_S = 2, SWEEP_MS = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv = null, logs = '';
let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }

function startServer() {
    return new Promise((resolve) => {
        srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, AI_DELAY_MS: '50',
                ROOM_IDLE_TTL_S: String(TTL_S), ROOM_SWEEP_MS: String(SWEEP_MS) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        srv.stdout.on('data', d => { logs += d; if (/listening/.test(d)) resolve(); });
        srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
    });
}
function stopServer() { return new Promise(r => { srv.once('exit', r); srv.kill('SIGTERM'); }); }
function health() {
    return new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/health`, r => {
        let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
    }).on('error', rej));
}
function savedCodes() {
    try { return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')).map(r => r.code); } catch { return []; }
}

class Client {
    constructor(token) { this.token = token || crypto.randomBytes(16).toString('hex'); this.msgs = []; }
    open() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
            this.ws.on('open', () => { this.send({ t: 'hello', token: this.token }); resolve(); });
            this.ws.on('error', reject);
            this.ws.on('message', d => this.msgs.push(JSON.parse(d)));
        });
    }
    send(o) { this.ws.send(JSON.stringify(o)); }
    close() { return new Promise(r => { this.ws.once('close', r); this.ws.close(); }); }
    async waitFor(pred, ms = 3000) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const m = this.msgs.find(pred); if (m) return m; await sleep(20); }
        throw new Error('timeout waiting for message');
    }
    async createRoom(seats = 2) {
        this.send({ t: 'create', name: 'T', seats });
        const m = await this.waitFor(x => x.t === 'room');
        return m.room.code;
    }
    async join(code) {
        this.msgs = [];
        this.send({ t: 'join', code, name: 'T' });
        return this.waitFor(x => x.t === 'room' || (x.t === 'error' && x.code === 'noroom'));
    }
}

(async () => {
    await startServer();
    check(/room idle sweeper started/.test(logs), 'sweeper start logged');

    // 1) all humans leave -> deleted after TTL
    const a = new Client(); await a.open();
    const codeA = await a.createRoom(2);
    const b = new Client(); await b.open(); await b.join(codeA); // second human (seated)
    await a.close(); await sleep(TTL_S * 1000 + 600);
    check((await health()).rooms >= 1 && savedCodes().includes(codeA), 'room kept while one human still connected');
    await b.close();
    await sleep(TTL_S * 1000 + 3 * SWEEP_MS + 500);
    check(!savedCodes().includes(codeA), 'idle room removed from rooms.json');
    check(new RegExp(`closed room ${codeA}`).test(logs), 'close logged');
    const c = new Client(); await c.open();
    const r1 = await c.join(codeA);
    check(r1.t === 'error' && r1.code === 'noroom' && /已关闭/.test(r1.message), `rejoin closed room -> "${r1.message}"`);
    await c.close();

    // 2) reconnect before TTL -> kept, timer reset
    const d = new Client(); await d.open();
    const codeB = await d.createRoom(2);
    await d.close(); await sleep(TTL_S * 1000 * 0.6);
    const d2 = new Client(d.token); await d2.open();
    const r2 = await d2.join(codeB);
    check(r2.t === 'room', 'reconnect before TTL -> room still there');
    await sleep(TTL_S * 1000 + 600);
    check(savedCodes().includes(codeB), 'room survives past TTL while reconnected human online');
    await d2.close();
    const tLeft = Date.now();

    // 3) AI-only game (host sets AI seats, starts, then leaves) -> still deleted
    const e = new Client(); await e.open();
    const codeC = await e.createRoom(2);
    e.send({ t: 'setAI', seat: 1, on: true, difficulty: 'easy' }); await sleep(150);
    e.send({ t: 'start' }); await e.waitFor(x => x.t === 'room' && x.room.status === 'playing');
    e.send({ t: 'setAI', seat: 0, on: true, difficulty: 'easy' }); await sleep(300);
    await e.close();
    const vBefore = (JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')).find(r => r.code === codeC) || {}).version;
    await sleep(800);
    const vMid = (JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')).find(r => r.code === codeC) || {}).version;
    check(vMid > vBefore, `AI keeps playing in empty room (version ${vBefore} -> ${vMid})`);
    await sleep(TTL_S * 1000 + 3 * SWEEP_MS);
    check(!savedCodes().includes(codeC), 'AI-only room deleted after TTL');
    check(!savedCodes().includes(codeB), 'room B deleted after its human left again');

    // 4) restart keeps the idle clock
    const f = new Client(); await f.open();
    const codeD = await f.createRoom(2);
    await f.close();
    await sleep(TTL_S * 1000 * 0.6);
    await stopServer();
    const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')).find(r => r.code === codeD);
    check(saved && typeof saved.emptySince === 'number', 'emptySince persisted');
    const leftAt = saved.emptySince;
    // also an "old format" room with no emptySince -> clock starts at boot
    const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    const legacy = { ...saved, code: 'OLD2', emptySince: undefined }; delete legacy.emptySince;
    arr.push(legacy); fs.writeFileSync(ROOMS_FILE, JSON.stringify(arr));
    logs = '';
    await startServer();
    const bootAt = Date.now();
    await sleep(Math.max(0, leftAt + TTL_S * 1000 + 2 * SWEEP_MS + 200 - Date.now()));
    const elapsedSinceBoot = Date.now() - bootAt;
    check(!savedCodes().includes(codeD) && elapsedSinceBoot < TTL_S * 1000,
        `restarted room closed ${((Date.now() - leftAt) / 1000).toFixed(1)}s after leave (only ${(elapsedSinceBoot / 1000).toFixed(1)}s after boot)`);
    check(savedCodes().includes('OLD2'), 'legacy room (no timestamp) kept right after boot');
    await sleep(TTL_S * 1000 + 3 * SWEEP_MS);
    check(!savedCodes().includes('OLD2'), 'legacy room closed TTL after boot');
    const h = await health();
    check(h.rooms === 0 && h.idleTtlSec === TTL_S, `health: ${JSON.stringify(h)}`);
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
    process.exit(failures ? 1 : 0);
})().catch(async e => { console.error(e); if (srv) srv.kill(); process.exit(1); });
