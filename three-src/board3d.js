// 3D board: printed board as a textured slab, industry spaces / links as
// pickable meshes, built tiles, cubes, barrels and merchant tiles on top.
// Pure view: it never touches game rules; app.js feeds it state + highlights.
import {
    WebGLRenderer, Scene, Color, PerspectiveCamera, HemisphereLight, DirectionalLight,
    TextureLoader, SRGBColorSpace, MeshStandardMaterial, MeshBasicMaterial, Mesh, BoxGeometry,
    PlaneGeometry, CylinderGeometry, Group, Vector2, Vector3, Raycaster, CanvasTexture,
    PCFSoftShadowMap, DoubleSide, MOUSE, TOUCH, BufferGeometry, Float32BufferAttribute,
} from 'three';
import { ROUTES } from './routes.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const S = 20;                         // board edge in world units
const SLOT_W = 38.8 / 900 * S, SLOT_D = 36.3 / 850 * S;
const TILE = 0.80, TILE_H = 0.11;
// Seats 1-4 use the four printed tile sets (assets/tiles/<set>/). The UI
// accent colours match each set but are pushed further apart in hue AND
// lightness (teal tiles print as a pale grey-blue, so its accent is a vivid
// teal); every owned piece also carries a numbered badge, so colour is never
// the only cue.
export const PLAYER_SET = ['purple', 'yellow', 'orange', 'teal'];
export const PLAYER_CSS = ['#a46cf5', '#f5c518', '#ff6a2b', '#19d3c5'];
export const tilePath = (pid, file) => `assets/tiles/${PLAYER_SET[pid] ? PLAYER_SET[pid] + '/' : ''}${file}`;
const PLAYER_HEX = PLAYER_CSS.map(c => parseInt(c.slice(1), 16));
const PLAYER_INK = ['#fff', '#2a1d00', '#fff', '#05302c'];
const VER = '?v=3d1';

export const ownerInitial = name => { const ch = [...String(name || '?').trim()][0] || '?'; return ch.toUpperCase(); };
const toWorld = (u, v, y = 0) => new Vector3((u - 0.5) * S, y, (v - 0.5) * S);

export class Board3D {
    constructor(container, opts = {}) {
        this.container = container;
        this.low = !!opts.low;
        this.onPick = opts.onPick || (() => {});
        this.onHover = opts.onHover || (() => {});
        this.insets = { top: 60, bottom: 200, left: 0, right: 0 };
        this.dirty = true;
        this.texCache = new Map();
        this.hl = { slots: new Set(), links: new Set(), tiles: new Set(), sel: new Set() };

        const r = this.renderer = new WebGLRenderer({ antialias: !this.low, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
        r.setPixelRatio(this.low ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        r.outputColorSpace = SRGBColorSpace;
        r.shadowMap.enabled = !this.low;
        r.shadowMap.type = PCFSoftShadowMap;
        container.appendChild(r.domElement);
        r.domElement.style.touchAction = 'none';

        const sc = this.scene = new Scene();
        sc.background = new Color(0x15181f);
        this.camera = new PerspectiveCamera(32, 1, 0.5, 200);
        sc.add(new HemisphereLight(0xffffff, 0x445566, this.low ? 2.4 : 1.7));
        const sun = new DirectionalLight(0xfff4e0, this.low ? 0.9 : 1.7);
        sun.position.set(-6, 20, 8);
        if (!this.low) {
            sun.castShadow = true;
            sun.shadow.mapSize.set(2048, 2048);
            Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 50 });
            sun.shadow.bias = -0.0005;
        }
        sc.add(sun);

        this.loader = new TextureLoader();
        // board slab: printed board on the top face
        const side = new MeshStandardMaterial({ color: 0x2c2118, roughness: 0.9 });
        const top = new MeshStandardMaterial({ map: this.tex('assets/board.jpg'), roughness: 0.92 });
        const board = new Mesh(new BoxGeometry(S, 0.3, S), [side, side, top, side, side, side]);
        board.position.y = -0.15; board.receiveShadow = true;
        board.userData = { kind: 'board' };
        sc.add(board);
        this.boardMesh = board;

        this.gSlots = new Group(); this.gLinks = new Group(); this.gTiles = new Group();
        this.gBuiltLinks = new Group(); this.gMerch = new Group(); this.gMarket = new Group(); this.gFx = new Group();
        sc.add(this.gSlots, this.gLinks, this.gTiles, this.gBuiltLinks, this.gMerch, this.gMarket, this.gFx);
        this.anims = []; this.fxSpeed = 1; this.merchPos = [];

        this.buildSlots();
        this.buildLinkHits();

        const c = this.controls = new OrbitControls(this.camera, r.domElement);
        c.enableDamping = false;
        c.screenSpacePanning = false;
        c.minPolarAngle = 0; c.maxPolarAngle = 0.62;       // ≈35° tilt at most
        c.minDistance = 5; c.maxDistance = 90;
        c.minAzimuthAngle = -0.8; c.maxAzimuthAngle = 0.8;
        c.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
        c.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
        c.zoomToCursor = true;
        c.addEventListener('change', () => { this.clampTarget(); this.dirty = true; });

        this.ray = new Raycaster();
        this.ptr = new Vector2();
        this.bindPointer();
        this.resize();
        this.resetView();
        window.addEventListener('resize', () => { this.resize(); this.dirty = true; });
        r.setAnimationLoop((t) => this.tick(t));
    }

    tex(url, srgb = true) {
        let t = this.texCache.get(url);
        if (!t) {
            t = this.loader.load(url + VER, () => { this.dirty = true; });
            if (srgb) t.colorSpace = SRGBColorSpace;
            t.anisotropy = this.low ? 1 : Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
            this.texCache.set(url, t);
        }
        return t;
    }

    // ------------------------------------------------------------------ layout
    buildSlots() {
        this.slotMeshes = new Map();
        const geo = new PlaneGeometry(SLOT_W * 0.98, SLOT_D * 0.98);
        const add = (id, i, u, v) => {
            const m = new Mesh(geo, new MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0, depthWrite: false }));
            m.rotation.x = -Math.PI / 2;
            m.position.copy(toWorld(u, v, 0.012));
            m.userData = { kind: 'slot', cityId: id, slotIndex: i, key: `${id}_${i}` };
            this.gSlots.add(m);
            this.slotMeshes.set(`${id}_${i}`, m);
        };
        for (const id of Object.keys(CITIES)) (BoardAssets.slotPositions(id) || []).forEach(([u, v], i) => add(id, i, u, v));
        for (const id of Object.keys(BREWERY_FARMS)) {
            const p = BoardAssets.slotPositions(id) || [BoardAssets.OFFICIAL_LAYOUT[id]];
            add(id, 0, p[0][0], p[0][1]);
        }
    }

    slotUV(key) {
        const m = this.slotMeshes.get(key);
        return m ? m.position : null;
    }

    anchor(id) {
        const a = BoardAssets.OFFICIAL_LAYOUT[id];
        return a ? { x: a[0], y: a[1] } : null;
    }

    // Printed centre line of a route in board UV (traced from board.jpg by
    // scripts/trace-routes.py); straight anchor-to-anchor chord as fallback.
    route(conn) {
        const r = ROUTES[conn.id];
        const pt = ([u, v]) => ({ x: u, y: v });
        if (r) return { line: r.line.map(pt), spur: r.spur ? r.spur.map(pt) : null };
        const a = this.anchor(conn.cities[0]), b = this.anchor(conn.cities[1]);
        return a && b ? { line: [a, b], spur: null } : null;
    }

    // Where along the printed route a link tile lies: middle of the line unless
    // that covers a printed banner, industry space or another link tile.
    linkPlacement(conn, placed) {
        const rt = this.route(conn);
        if (!rt) return null;
        const L = rt.line, cum = [0];
        for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + Math.hypot(L[i].x - L[i - 1].x, L[i].y - L[i - 1].y));
        const total = cum[cum.length - 1] || 1;
        const at = t => {
            const d = t * total; let i = 1;
            while (i < L.length - 1 && cum[i] < d) i++;
            const a = L[i - 1], b = L[i], k = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
            return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, ang: Math.atan2(b.y - a.y, b.x - a.x) };
        };
        const obstacles = this.obstacles();
        const w = 0.062, h = 0.028;
        const dist = (px, py, q) => Math.hypot(Math.max(q[0] - px, 0, px - q[2]), Math.max(q[1] - py, 0, py - q[3]));
        const cost = t => {
            const p = at(t), ux = Math.cos(p.ang), uy = Math.sin(p.ang); let c = 0;
            for (let k = -2; k <= 2; k++) {
                const px = p.x + ux * (w / 2 - h / 2) * (k / 2), py = p.y + uy * (w / 2 - h / 2) * (k / 2);
                for (const q of obstacles) if (dist(px, py, q) < h / 2) c += 1;
                for (const q of placed) if (dist(px, py, q) < h / 4) c += 1;
            }
            return c;
        };
        let best = 0.5, bc = cost(0.5);
        for (let s = 1; s <= 30 && bc > 0; s++) {
            for (const t of [0.5 - s * 0.01, 0.5 + s * 0.01]) {
                if (t < 0.2 || t > 0.8) continue;
                const c = cost(t); if (c < bc) { bc = c; best = t; }
            }
        }
        const p = at(best);
        placed.push([p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]);
        return { u: p.x, v: p.y, angle: p.ang, line: L, spur: rt.spur };
    }

    // flat strip following a polyline (UV points) at height y
    ribbon(pts, width, y) {
        const P = pts.map(p => toWorld(p.x, p.y, y)), pos = [], idx = [];
        for (let i = 0; i < P.length; i++) {
            const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
            let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
            // mitre: widen at bends so the strip keeps its width
            let k = 1;
            if (i > 0 && i < P.length - 1) {
                const sx = P[i].x - a.x, sz = P[i].z - a.z, sl = Math.hypot(sx, sz) || 1;
                k = 1 / Math.max(0.5, (sx * tx + sz * tz) / sl);
            }
            const nx = -tz * width / 2 * k, nz = tx * width / 2 * k;
            pos.push(P[i].x + nx, y, P[i].z + nz, P[i].x - nx, y, P[i].z - nz);
            if (i) { const j = 2 * i; idx.push(j - 2, j - 1, j, j - 1, j + 1, j); }
        }
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        return g;
    }

    obstacles() {
        if (this._obs) return this._obs;
        const out = Object.values(BoardAssets.bannerRects()).map(r => r.slice());
        const sw = 38.8 / 900 / 2, sh = 36.3 / 850 / 2;
        for (const id of Object.keys(CITIES).concat(Object.keys(MERCHANTS))) {
            for (const [u, v] of BoardAssets.slotPositions(id) || []) out.push([u - sw, v - sh, u + sw, v + sh]);
        }
        return (this._obs = out);
    }

    buildLinkHits() {
        this.linkInfo = new Map();
        const placed = [];
        for (const conn of CONNECTIONS) {
            const p = this.linkPlacement(conn, placed);
            if (!p) continue;
            this.linkInfo.set(conn.id, p);
            // hit/highlight strip along the printed line (plus the spur to the
            // farm brewery: one link, one tile, three places connected)
            const group = new Group();
            group.userData = { kind: 'link', connId: conn.id };
            for (const pts of [p.line, p.spur].filter(Boolean)) {
                const m = new Mesh(this.ribbon(pts, 0.34, 0.02),
                    new MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0, depthWrite: false, side: DoubleSide }));
                m.userData = group.userData;
                group.add(m);
            }
            // a tile-shaped marker at the link space, shown while choosing
            const mk = new Mesh(new PlaneGeometry(0.062 * S, 0.028 * S),
                new MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0, depthWrite: false }));
            mk.rotation.x = -Math.PI / 2; mk.rotation.z = -p.angle;
            mk.position.copy(toWorld(p.u, p.v, 0.03));
            mk.userData = group.userData;
            group.add(mk);
            group.userData.marker = mk;
            this.gLinks.add(group);
        }
    }

    // ------------------------------------------------------------------ state
    update(state, viewerId) {
        this.state = state;
        this.viewerId = viewerId;
        const clear = g => { for (const ch of [...g.children]) { g.remove(ch); ch.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); }); } };
        clear(this.gTiles); clear(this.gBuiltLinks); clear(this.gMerch); clear(this.gMarket);
        this.finishAnims();
        for (const [key, t] of Object.entries(state.boardIndustries || {})) this.addTile(key, t);
        for (const [farm, t] of Object.entries(state.breweryFarmTiles || {})) if (t) this.addTile(`${farm}_0`, t, `farm_${farm}`);
        for (const [cid, l] of Object.entries(state.boardLinks || {})) this.addLink(cid, l);
        this.addMerchants(state);
        this.addMarkets(state);
        if (this.focus != null) { const f = this.focus; this.focus = undefined; this.setFocus(f); }
        this.applyHighlights();
        this.dirty = true;
    }

    // Coal / iron market cubes on the printed market squares (board.jpg px,
    // measured from the art). Index i is price space i (cheapest first); with
    // n cubes left the spaces len-n..len-1 are full, so cheap spaces empty first.
    marketSpaces(kind) {
        const rowY = [1061.5, 999, 938.5, 877.5, 816.5, 753.5, 691]; // price £1..£7
        const [xr, xl, rows] = kind === 'coal' ? [1775, 1730, 7] : [1886.5, 1842.5, 5];
        const out = [];
        for (let r = 0; r < rows; r++) out.push([xr, rowY[r]], [xl, rowY[r]]);
        return out;
    }
    addMarkets(state) {
        for (const [kind, n, col] of [['coal', state.coalMarket, 0x202020], ['iron', state.ironMarket, 0xe07a2c]]) {
            const sp = this.marketSpaces(kind);
            const geo = this._cubeGeo || (this._cubeGeo = Object.assign(new BoxGeometry(0.26, 0.26, 0.26), {}));
            geo.userData.shared = true;
            const m = this.mat(col, { roughness: 0.5, metalness: kind === 'coal' ? 0.15 : 0 });
            for (let i = Math.max(0, sp.length - (n || 0)); i < sp.length; i++) {
                const c = new Mesh(geo, m);
                const w = toWorld(sp[i][0] / 2048, sp[i][1] / 2048, 0.14);
                c.position.copy(w); c.rotation.y = ((i * 37) % 11 - 5) * 0.02;
                c.userData = { kind: 'cube', market: kind, idx: i };
                c.castShadow = !this.low;
                this.gMarket.add(c);
            }
        }
    }

    mat(color, extra = {}) { return new MeshStandardMaterial({ color, roughness: 0.6, ...extra }); }

    addTile(slotKey, t, resKey) {
        const pos = this.slotUV(slotKey);
        if (!pos) return;
        const stem = { cottonMill: 'cotton', coalMine: 'coal', ironWorks: 'iron', manufacturer: 'goods', pottery: 'pottery', brewery: 'brewery' }[t.type];
        const level = t.tileData ? t.tileData.level : t.level;
        const g = new Group();
        g.position.set(pos.x, 0, pos.z);
        const sideM = this.mat(PLAYER_HEX[t.playerId] || 0x888888);
        const topM = new MeshStandardMaterial({ map: this.tex(tilePath(t.playerId, `${stem}-${level}${t.flipped ? '-flipped' : ''}.jpg`)), roughness: 0.55 });
        const box = new Mesh(new BoxGeometry(TILE, TILE_H, TILE), [sideM, sideM, topM, sideM, sideM, sideM]);
        box.position.y = TILE_H / 2 + 0.05;
        box.castShadow = box.receiveShadow = !this.low;
        g.add(box);
        this.addOwnerMarks(g, t.playerId, TILE, TILE, TILE_H + 0.05);
        const n = t.resourceCubes || 0;
        if (n > 0 && !t.flipped) {
            for (let i = 0; i < n; i++) {
                let m;
                if (t.type === 'brewery') {
                    m = new Mesh(new CylinderGeometry(0.09, 0.09, 0.2, 14), this.mat(0x9a6a33));
                    m.rotation.z = Math.PI / 2;
                    m.position.set(-0.2 + (i % 3) * 0.2, TILE_H + 0.14, 0.24 - Math.floor(i / 3) * 0.2);
                } else {
                    m = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), this.mat(t.type === 'coalMine' ? 0x1b1b1b : 0xd8742a));
                    m.position.set(-0.24 + (i % 4) * 0.16, TILE_H + 0.125, 0.26 - Math.floor(i / 4) * 0.17);
                }
                m.castShadow = !this.low;
                g.add(m);
            }
        }
        const ud = { kind: 'tile', key: resKey || slotKey, slotKey, tile: t };
        g.userData = ud; g.traverse(o => { o.userData = ud; });
        this.gTiles.add(g);
    }

    addLink(connId, l) {
        const p = this.linkInfo.get(connId);
        if (!p) return;
        const g = new Group();
        const w = 0.062 * S, d = 0.028 * S;
        const sideM = this.mat(PLAYER_HEX[l.playerId] || 0x888888);
        const topM = new MeshStandardMaterial({ map: this.tex(tilePath(l.playerId, `${l.type === 'canal' ? 'canal' : 'rail'}.jpg`)), roughness: 0.55 });
        const box = new Mesh(new BoxGeometry(w, 0.08, d), [sideM, sideM, topM, sideM, sideM, sideM]);
        box.position.y = 0.09; box.castShadow = !this.low; g.add(box);
        this.addOwnerMarks(g, l.playerId, w, d, 0.13, true);
        g.position.copy(toWorld(p.u, p.v));
        g.rotation.y = -p.angle;
        const ud = { kind: 'builtLink', connId, link: l, playerId: l.playerId };
        g.traverse(o => { o.userData = ud; });
        g.userData = ud; g.name = 'linkTile';
        this.gBuiltLinks.add(g);
        // owner-coloured band along the whole printed route (and farm spur)
        const band = new Group();
        const bandM = new MeshBasicMaterial({ color: PLAYER_HEX[l.playerId] || 0x888888, transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide });
        for (const pts of [p.line, p.spur].filter(Boolean)) band.add(new Mesh(this.ribbon(pts, 0.17, 0.008), bandM));
        band.userData = ud; band.traverse(o => { o.userData = ud; }); band.name = 'linkBand';
        this.gBuiltLinks.add(band);
    }

    // Owner identity on a placed piece: thick coloured plinth, a soft coloured
    // shadow around it and a numbered badge on the corner.
    addOwnerMarks(g, pid, w, d, topY, isLink = false) {
        const col = PLAYER_HEX[pid] || 0x888888;
        const glow = new Mesh(new PlaneGeometry(w + (isLink ? 0.3 : 0.42), d + (isLink ? 0.3 : 0.42)),
            new MeshBasicMaterial({ map: this.glowTex(), color: col, transparent: true, opacity: 0.95, depthWrite: false }));
        glow.rotation.x = -Math.PI / 2; glow.position.y = 0.006; g.add(glow);
        const plinth = new Mesh(new BoxGeometry(w + 0.16, 0.06, d + 0.16), this.mat(col, { roughness: 0.45 }));
        plinth.position.y = 0.03; plinth.castShadow = !this.low; g.add(plinth);
        const bs = isLink ? 0.3 : 0.34;
        const badge = new Mesh(new PlaneGeometry(bs, bs), new MeshBasicMaterial({ map: this.badgeTex(pid), transparent: true, depthWrite: false }));
        badge.rotation.x = -Math.PI / 2;
        badge.position.set(-w / 2 + (isLink ? 0.02 : 0.04), topY + 0.012, -d / 2 + (isLink ? 0.02 : 0.04));
        badge.renderOrder = 2; g.add(badge);
    }

    glowTex() {
        if (this.texCache.has('glow')) return this.texCache.get('glow');
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const x = c.getContext('2d');
        const gr = x.createRadialGradient(32, 32, 10, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
        const t = new CanvasTexture(c); this.texCache.set('glow', t); return t;
    }

    // round badge: name initial big, seat number small, in the owner colour
    badgeTex(pid) {
        const p = this.state && this.state.players[pid];
        const ini = p ? ownerInitial(p.name) : '?';
        const key = `badge:${pid}:${ini}`;
        if (this.texCache.has(key)) return this.texCache.get(key);
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d');
        x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2);
        x.fillStyle = PLAYER_CSS[pid] || '#888'; x.fill();
        x.lineWidth = 9; x.strokeStyle = '#111'; x.stroke();
        x.fillStyle = PLAYER_INK[pid] || '#fff';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.font = 'bold 62px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
        x.fillText(ini, 54, 60);
        x.font = 'bold 36px sans-serif';
        x.fillText(String(pid + 1), 96, 92);
        const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; t.anisotropy = 4;
        this.texCache.set(key, t); return t;
    }

    // "只看某玩家": everyone else's pieces fade while hovering a player card
    setFocus(pid) {
        if (this.focus === pid) return;
        this.focus = pid;
        const apply = (g, owner) => {
            const dim = pid != null && owner !== pid;
            g.traverse(o => {
                if (!o.material) return;
                for (const m of [].concat(o.material)) {
                    if (m.userData.baseOp === undefined) m.userData.baseOp = m.opacity, m.userData.baseTr = m.transparent;
                    m.transparent = dim || m.userData.baseTr;
                    m.opacity = dim ? m.userData.baseOp * 0.18 : m.userData.baseOp;
                    m.needsUpdate = true;
                }
            });
        };
        for (const g of this.gTiles.children) apply(g, g.userData.tile.playerId);
        for (const g of this.gBuiltLinks.children) apply(g, g.userData.playerId);
        this.dirty = true;
    }

    merchantTex(buys) {
        const key = 'merch:' + buys;
        if (this.texCache.has(key)) return this.texCache.get(key);
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d');
        x.fillStyle = buys === 'blank' ? '#3b3b3b' : '#e9dcc0'; x.fillRect(0, 0, 128, 128);
        x.strokeStyle = '#6b5530'; x.lineWidth = 8; x.strokeRect(4, 4, 120, 120);
        const label = { any: '任意', blank: '—', cottonMill: '棉纺', manufacturer: '制造', pottery: '陶瓷' }[buys] || buys;
        x.fillStyle = buys === 'blank' ? '#999' : '#3a2a12';
        x.font = 'bold 40px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(label, 64, 66);
        const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace;
        this.texCache.set(key, t);
        return t;
    }

    addMerchants(state) {
        const byLoc = {};
        (state.merchantTiles || []).forEach((mt, i) => { (byLoc[mt.location] = byLoc[mt.location] || []).push({ mt, i }); });
        for (const [loc, list] of Object.entries(byLoc)) {
            const spaces = BoardAssets.slotPositions(loc) || [];
            list.forEach(({ mt, i }, k) => {
                const sp = spaces[k]; if (!sp) return;
                const P = toWorld(sp[0], sp[1]);
                const g = new Group(); g.position.copy(P);
                const side = this.mat(0x4a3a22);
                const box = new Mesh(new BoxGeometry(TILE * 0.9, 0.07, TILE * 0.9),
                    [side, side, new MeshStandardMaterial({ map: this.merchantTex(mt.buys) }), side, side, side]);
                box.position.y = 0.035; box.castShadow = !this.low; g.add(box);
                if (mt.hasBeer) {
                    const b = new Mesh(new CylinderGeometry(0.1, 0.1, 0.22, 14), this.mat(0x9a6a33));
                    b.rotation.z = Math.PI / 2; b.position.set(0, 0.17, 0.27); b.castShadow = !this.low; g.add(b);
                }
                this.merchPos[i] = P.clone().setY(0.2);
                const ud = { kind: 'merchant', index: i, mt };
                g.traverse(o => { o.userData = ud; });
                this.gMerch.add(g);
            });
        }
    }

    // ------------------------------------------------------------------ highlights
    setHighlights({ slots = [], links = [], tiles = [], sel = [] } = {}) {
        this.hl = { slots: new Set(slots), links: new Set(links), tiles: new Set(tiles), sel: new Set(sel) };
        this.applyHighlights();
        this.dirty = true;
    }

    applyHighlights() {
        for (const [key, m] of this.slotMeshes) {
            const on = this.hl.slots.has(key), s = this.hl.sel.has(key);
            m.material.opacity = s ? 0.55 : on ? 0.35 : 0;
            m.material.color.setHex(s ? 0x4dff88 : 0xffd34d);
            m.userData.active = on || s;
        }
        for (const g of this.gLinks.children) {
            const id = g.userData.connId, on = this.hl.links.has(id), s = this.hl.sel.has(id);
            g.children.forEach(m => {
                const isMk = m === g.userData.marker;
                m.material.opacity = s ? (isMk ? 0.85 : 0.42) : on ? (isMk ? 0.7 : 0.26) : 0;
                m.material.color.setHex(s ? 0x4dff88 : 0x5ff0ff);
            });
            g.userData.active = on || s;
        }
        for (const g of this.gTiles.children) {
            const k = g.userData.key, on = this.hl.tiles.has(k), s = this.hl.sel.has(k);
            g.position.y = s ? 0.22 : on ? 0.1 : 0;
            g.traverse(o => {
                if (!o.material) return;
                for (const mm of [].concat(o.material)) if (mm.emissive) mm.emissive.setHex(s ? 0x2a5a2a : on ? 0x4a3a00 : 0);
            });
            g.userData.active = on || s;
        }
    }

    // ------------------------------------------------------------------ camera
    resize() {
        const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
        this.renderer.setSize(w, h, false);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    // Fit the board into the visible area left between the HTML bars.
    resetView() {
        const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
        const ins = this.insets;
        const vw = Math.max(200, w - ins.left - ins.right), vh = Math.max(200, h - ins.top - ins.bottom);
        const fov = this.camera.fov * Math.PI / 180;
        const needH = S * 1.02 / (2 * Math.tan(fov / 2)) * (h / vh);
        const needW = S * 1.02 / (2 * Math.tan(fov / 2) * this.camera.aspect) * (w / vw);
        const dist = Math.min(this.controls.maxDistance, Math.max(needH, needW));
        // shift the target so the board centre lands in the middle of the free area
        const worldPerPx = 2 * Math.tan(fov / 2) * dist / h;
        const offX = ((ins.right - ins.left) / 2) * worldPerPx;
        const offZ = ((ins.bottom - ins.top) / 2) * worldPerPx;
        const place = (tx, tz, d) => {
            this.controls.target.set(tx, 0, tz);
            this.camera.position.set(tx, d * Math.cos(0.12), tz + d * Math.sin(0.12));
            this.camera.lookAt(this.controls.target);
            this.camera.updateMatrixWorld();
        };
        let tx = offX, tz = offZ, d = dist;
        place(tx, tz, d);
        // refine with the real projection (perspective + tilt make the near edge larger)
        const h2 = S / 2, v = new Vector3();
        for (let it = 0; it < 4; it++) {
            let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
            for (const [cx, cz] of [[-h2, -h2], [h2, -h2], [-h2, h2], [h2, h2]]) {
                v.set(cx, 0, cz).project(this.camera);
                const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h;
                x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
            }
            const k = Math.max((x1 - x0) / (vw * 0.98), (y1 - y0) / (vh * 0.98));
            const wpp = 2 * Math.tan(fov / 2) * d / h;
            tx -= ((ins.left + vw / 2) - (x0 + x1) / 2) * wpp;
            tz -= ((ins.top + vh / 2) - (y0 + y1) / 2) * wpp;
            d = Math.min(this.controls.maxDistance, d * k);
            place(tx, tz, d);
        }
        this.controls.update();
        this.dirty = true;
    }

    clampTarget() {
        const t = this.controls.target, lim = S * 0.6;
        const cx = Math.max(-lim, Math.min(lim, t.x)), cz = Math.max(-lim, Math.min(lim, t.z));
        if (cx !== t.x || cz !== t.z || t.y !== 0) {
            const d = new Vector3(cx - t.x, -t.y, cz - t.z);
            t.add(d); this.camera.position.add(d);
        }
    }

    zoom(f) {
        const c = this.controls, off = this.camera.position.clone().sub(c.target);
        const len = Math.max(c.minDistance, Math.min(c.maxDistance, off.length() * f));
        this.camera.position.copy(c.target).add(off.setLength(len));
        c.update(); this.dirty = true;
    }

    // ------------------------------------------------------------------ picking
    pickAt(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.ptr.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        this.ray.setFromCamera(this.ptr, this.camera);
        const objs = [this.gTiles, this.gBuiltLinks, this.gMerch, this.gSlots, this.gLinks];
        const hits = this.ray.intersectObjects(objs, true);
        // active (highlighted) things win over whatever sits above them
        const active = hits.find(h => h.object.userData.active || (h.object.parent && h.object.parent.userData && h.object.parent.userData.active));
        if (active) return active.object.userData;
        const first = hits.find(h => ['tile', 'builtLink', 'merchant', 'slot'].includes(h.object.userData.kind));
        return first ? first.object.userData : null;
    }

    bindPointer() {
        const el = this.renderer.domElement;
        let down = null;
        el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
        el.addEventListener('pointerup', e => {
            if (!down || down.id !== e.pointerId) return;
            const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            const dt = performance.now() - down.t;
            down = null;
            if (moved > 8 || e.button > 0) return;
            const hit = this.pickAt(e.clientX, e.clientY);
            this.onPick(hit, e, dt);
        });
        el.addEventListener('pointermove', e => {
            if (e.pointerType !== 'mouse') return;
            if (e.buttons) { this.onHover(null, e); return; }
            const hit = this.pickAt(e.clientX, e.clientY);
            el.style.cursor = hit && (hit.active || hit.kind === 'tile' || hit.kind === 'merchant') ? 'pointer' : 'grab';
            this.onHover(hit, e);
        });
        el.addEventListener('pointerleave', () => this.onHover(null));
        el.addEventListener('contextmenu', e => e.preventDefault());
    }

    // client-space position of a slot / link / tile (used by tests and popups)
    worldOf(kind, id) {
        let p = null;
        if (kind === 'slot') { const m = this.slotMeshes.get(id); if (m) p = m.position.clone(); }
        else if (kind === 'link') { const info = this.linkInfo.get(id); if (info) p = toWorld(info.u, info.v, 0.03); }
        else if (kind === 'tile') { const g = this.gTiles.children.find(g => g.userData.key === id); if (g) p = g.position.clone().setY(0.12); }
        return p;
    }

    // Pan (keeping zoom/angle) so an object sits in the middle of the screen.
    centerOn(kind, id) {
        const p = this.worldOf(kind, id); if (!p) return false;
        const d = new Vector3(p.x - this.controls.target.x, 0, p.z - this.controls.target.z);
        this.controls.target.add(d); this.camera.position.add(d);
        this.controls.update(); this.dirty = true;
        return true;
    }

    screenOf(kind, id) {
        let p = null;
        if (kind === 'slot') { const m = this.slotMeshes.get(id); if (m) p = m.position.clone(); }
        else if (kind === 'link') { const info = this.linkInfo.get(id); if (info) p = toWorld(info.u, info.v, 0.03); }
        else if (kind === 'tile') {
            const g = this.gTiles.children.find(g => g.userData.key === id);
            if (g) p = g.position.clone().setY(0.12);
        }
        if (!p) return null;
        this.camera.updateMatrixWorld();
        const v = p.project(this.camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
    }

    // ------------------------------------------------------------------ animation
    // Small tween runner: step(k) gets 0..1; delays and durations scale with
    // fxSpeed (0 = jump to the end). Rendering stays on-demand: only while
    // something moves is the scene redrawn every frame.
    animate(ms, step, delay = 0) {
        return new Promise(res => {
            const sp = this.fxSpeed;
            if (!(sp > 0)) { step(1); this.dirty = true; res(); return; }
            this.anims.push({ t0: performance.now() + delay / sp, dur: Math.max(1, ms / sp), step, res });
            this.dirty = true;
        });
    }
    finishAnims() { const a = this.anims; this.anims = []; for (const x of a) { try { x.step(1); } catch (e) { /* view rebuilt */ } x.res(); } this.clearFx(); }
    clearFx() { for (const ch of [...this.gFx.children]) this.gFx.remove(ch); }

    tileGroup(key) { return this.gTiles.children.find(g => g.userData.key === key) || null; }
    tileWorld(key) {
        const g = this.tileGroup(key); if (g) return g.position.clone().setY(0.2);
        const m = this.slotMeshes.get(key) || this.slotMeshes.get(key.replace(/^farm_/, '') + '_0');
        return m ? m.position.clone().setY(0.2) : null;
    }
    linkWorld(id) { const i = this.linkInfo.get(id); return i ? toWorld(i.u, i.v, 0.15) : null; }
    marketWorld(kind, i) { const sp = this.marketSpaces(kind)[i]; return sp ? toWorld(sp[0] / 2048, sp[1] / 2048, 0.14) : null; }
    marketCube(kind, i) { return this.gMarket.children.find(c => c.userData.market === kind && c.userData.idx === i) || null; }
    project(v) {
        this.camera.updateMatrixWorld();
        const p = v.clone().project(this.camera), r = this.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
    }

    // a built tile drops in from above, bounces and kicks up dust
    dropTile(key, delay = 0) {
        const g = this.tileGroup(key); if (!g) return Promise.resolve();
        const y0 = g.position.y; g.visible = false;
        return this.animate(560, k => {
            g.visible = true;
            g.position.y = y0 + 3.2 * (1 - bounce(k));
            g.rotation.y = (1 - k) * 0.35;
        }, delay).then(() => this.impact(g.position.clone().setY(0.05), PLAYER_HEX[g.userData.tile.playerId]));
    }
    impact(pos, color = 0xffd34d) {
        const ring = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: this.ringTex(), color, transparent: true, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.copy(pos).setY(0.03); this.gFx.add(ring);
        const parts = [];
        if (!this.low) for (let i = 0; i < 10; i++) {
            const d = new Mesh(new PlaneGeometry(0.26, 0.26), new MeshBasicMaterial({ map: this.glowTex(), color: 0xcdb48c, transparent: true, depthWrite: false }));
            d.rotation.x = -Math.PI / 2; d.position.copy(pos).setY(0.08);
            d.userData.dir = [Math.cos(i / 10 * Math.PI * 2 + Math.random() * 0.4), Math.sin(i / 10 * Math.PI * 2 + Math.random() * 0.4)];
            this.gFx.add(d); parts.push(d);
        }
        return this.animate(520, k => {
            const e = easeOut(k);
            ring.scale.setScalar(0.6 + 1.8 * e); ring.material.opacity = 0.9 * (1 - k);
            for (const d of parts) {
                d.position.x = pos.x + d.userData.dir[0] * 0.75 * e; d.position.z = pos.z + d.userData.dir[1] * 0.75 * e;
                d.position.y = 0.08 + 0.25 * Math.sin(Math.PI * k); d.material.opacity = 0.7 * (1 - k); d.scale.setScalar(1 + k);
            }
            if (k >= 1) { this.gFx.remove(ring); parts.forEach(d => this.gFx.remove(d)); }
        });
    }
    // a link grows along its printed route, then its tile pops in
    growLink(connId, delay = 0) {
        const parts = this.gBuiltLinks.children.filter(g => g.userData.connId === connId);
        if (!parts.length) return Promise.resolve();
        const bands = parts.filter(g => g.name === 'linkBand').flatMap(g => g.children);
        const tiles = parts.filter(g => g.name === 'linkTile');
        bands.forEach(m => m.geometry.setDrawRange(0, 0)); tiles.forEach(t => { t.visible = false; });
        return this.animate(650, k => {
            for (const m of bands) { const n = m.geometry.index.count; m.geometry.setDrawRange(0, k >= 1 ? Infinity : Math.floor(n * easeInOut(Math.min(1, k / 0.75)) / 6) * 6); }
            for (const t of tiles) { t.visible = k > 0.55; const q = Math.max(0, (k - 0.55) / 0.45); t.scale.setScalar(0.4 + 0.6 * back(q)); }
        }, delay).then(() => { const p = this.linkWorld(connId); if (p) this.impact(p.setY(0.05), PLAYER_HEX[parts[0].userData.playerId]); });
    }
    // sold tile flips over in the air
    flipTile(key, delay = 0) {
        const g = this.tileGroup(key); if (!g) return Promise.resolve();
        const y0 = g.position.y;
        g.rotation.z = Math.PI;
        return this.animate(620, k => {
            const e = easeInOut(k);
            g.rotation.z = Math.PI * (1 - e); g.position.y = y0 + Math.sin(Math.PI * k) * 0.9;
        }, delay).then(() => this.impact(g.position.clone().setY(0.05), 0xffe08a));
    }
    // coal / iron cube or beer barrel along an arc
    fly(kind, from, to, delay = 0, onLand) {
        if (!from || !to) return Promise.resolve();
        let m;
        if (kind === 'beer') { m = new Mesh(new CylinderGeometry(0.11, 0.11, 0.24, 14), this.mat(0x9a6a33)); }
        else m = new Mesh(new BoxGeometry(0.22, 0.22, 0.22), this.mat(kind === 'coal' ? 0x1d1d1d : 0xe07a2c, { emissive: kind === 'coal' ? 0x222222 : 0x331100 }));
        m.visible = false; this.gFx.add(m);
        const h = 1.4 + from.distanceTo(to) * 0.18;
        return this.animate(520, k => {
            m.visible = k < 1;
            const e = easeInOut(k);
            m.position.lerpVectors(from, to, e); m.position.y += Math.sin(Math.PI * e) * h;
            m.rotation.set(e * 5, e * 3, kind === 'beer' ? Math.PI / 2 : e * 2);
            if (k >= 1) { this.gFx.remove(m); onLand && onLand(); }
        }, delay);
    }
    // a soft pulse ring at a point (merchant bonus, develop, …)
    pulse(pos, color = 0xffd34d, delay = 0) { return this.animate(1, () => {}, delay).then(() => this.impact(pos, color)); }

    ringTex() {
        if (this.texCache.has('ring')) return this.texCache.get('ring');
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d');
        const gr = x.createRadialGradient(64, 64, 34, 64, 64, 62);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.55, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
        const t = new CanvasTexture(c); this.texCache.set('ring', t); return t;
    }

    tick(t) {
        if (this.anims.length) {
            const now = performance.now();
            this.anims = this.anims.filter(a => {
                if (now < a.t0) return true;
                const k = Math.min(1, (now - a.t0) / a.dur);
                a.step(k);
                if (k >= 1) { a.res(); return false; }
                return true;
            });
            this.dirty = true;
        }
        const pulsing = this.hl.slots.size || this.hl.links.size || this.hl.tiles.size;
        if (pulsing) {
            const k = 0.75 + 0.25 * Math.sin(t / 260);
            for (const key of this.hl.slots) { const m = this.slotMeshes.get(key); if (m && !this.hl.sel.has(key)) m.material.opacity = 0.18 + 0.32 * k; }
            this.dirty = true;
        }
        if (!this.dirty) return;
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
    }
}

const easeOut = k => 1 - (1 - k) ** 3;
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const back = k => { const c = 1.70158; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; };
function bounce(k) {
    const n = 7.5625, d = 2.75;
    if (k < 1 / d) return n * k * k;
    if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
    if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
    return n * (k -= 2.625 / d) * k + 0.984375;
}
