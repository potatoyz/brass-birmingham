// 3D board: printed board as a textured slab, industry spaces / links as
// pickable meshes, built tiles, cubes, barrels and merchant tiles on top.
// Pure view: it never touches game rules; app.js feeds it state + highlights.
import {
    WebGLRenderer, Scene, Color, PerspectiveCamera, HemisphereLight, DirectionalLight,
    TextureLoader, SRGBColorSpace, MeshStandardMaterial, MeshBasicMaterial, Mesh, BoxGeometry,
    PlaneGeometry, CylinderGeometry, Group, Vector2, Vector3, Raycaster, CanvasTexture,
    PCFSoftShadowMap, DoubleSide, MOUSE, TOUCH,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const S = 20;                         // board edge in world units
const SLOT_W = 38.8 / 900 * S, SLOT_D = 36.3 / 850 * S;
const TILE = 0.80, TILE_H = 0.11;
const PLAYER_HEX = [0xc0392b, 0xf39c12, 0x8e44ad, 0xd9d0c2];
const VER = '?v=3d1';

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
        this.gBuiltLinks = new Group(); this.gMerch = new Group();
        sc.add(this.gSlots, this.gLinks, this.gTiles, this.gBuiltLinks, this.gMerch);

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

    // Where along each route a link tile lies: midpoint unless that covers a
    // printed banner or industry space (ported from the SVG renderer).
    linkPlacement(conn, placed) {
        const a = this.anchor(conn.cities[0]), b = this.anchor(conn.cities[1]);
        if (!a || !b) return null;
        let p1 = a, p2 = b;
        if (conn.viaBrewery) {
            const m = this.anchor(conn.viaBrewery);
            // use the longer leg so the tile sits clear of the farm space
            const d1 = Math.hypot(m.x - a.x, m.y - a.y), d2 = Math.hypot(b.x - m.x, b.y - m.y);
            if (d1 >= d2) { p2 = m; } else { p1 = m; }
        }
        const obstacles = this.obstacles();
        const w = 0.062, h = 0.028;
        const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const dist = (px, py, q) => Math.hypot(Math.max(q[0] - px, 0, px - q[2]), Math.max(q[1] - py, 0, py - q[3]));
        const cost = t => {
            const cx = p1.x + dx * t, cy = p1.y + dy * t; let c = 0;
            for (let k = -2; k <= 2; k++) {
                const px = cx + ux * (w / 2 - h / 2) * (k / 2), py = cy + uy * (w / 2 - h / 2) * (k / 2);
                for (const q of obstacles) if (dist(px, py, q) < h / 2) c += 1;
                for (const q of placed) if (dist(px, py, q) < h / 4) c += 1;
            }
            return c;
        };
        let best = 0.5, bc = cost(0.5);
        for (let s = 1; s <= 20 && bc > 0; s++) {
            for (const t of [0.5 - s * 0.02, 0.5 + s * 0.02]) {
                if (t < 0.15 || t > 0.85) continue;
                const c = cost(t); if (c < bc) { bc = c; best = t; }
            }
        }
        const cx = p1.x + dx * best, cy = p1.y + dy * best;
        placed.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
        return { u: cx, v: cy, angle: Math.atan2(dy, dx), seg: [p1, p2, a, b] };
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
            // hit/highlight strip along the whole route (both legs for farm routes)
            const legs = conn.viaBrewery
                ? [[p.seg[2], this.anchor(conn.viaBrewery)], [this.anchor(conn.viaBrewery), p.seg[3]]]
                : [[p.seg[2], p.seg[3]]];
            const group = new Group();
            group.userData = { kind: 'link', connId: conn.id };
            for (const [a, b] of legs) {
                const A = toWorld(a.x, a.y), B = toWorld(b.x, b.y);
                const len = A.distanceTo(B);
                const m = new Mesh(new PlaneGeometry(len * 0.62, 0.34),
                    new MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0, depthWrite: false, side: DoubleSide }));
                m.rotation.x = -Math.PI / 2;
                m.rotation.z = -Math.atan2(B.z - A.z, B.x - A.x);
                m.position.copy(A.clone().add(B).multiplyScalar(0.5)).setY(0.02);
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
        clear(this.gTiles); clear(this.gBuiltLinks); clear(this.gMerch);
        for (const [key, t] of Object.entries(state.boardIndustries || {})) this.addTile(key, t);
        for (const [farm, t] of Object.entries(state.breweryFarmTiles || {})) if (t) this.addTile(`${farm}_0`, t, `farm_${farm}`);
        for (const [cid, l] of Object.entries(state.boardLinks || {})) this.addLink(cid, l);
        this.addMerchants(state);
        this.applyHighlights();
        this.dirty = true;
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
        const topM = new MeshStandardMaterial({ map: this.tex(`assets/tiles/${stem}-${level}${t.flipped ? '-flipped' : ''}.jpg`), roughness: 0.55 });
        const box = new Mesh(new BoxGeometry(TILE, TILE_H, TILE), [sideM, sideM, topM, sideM, sideM, sideM]);
        box.position.y = TILE_H / 2;
        box.castShadow = box.receiveShadow = !this.low;
        g.add(box);
        // owner rim so colours read from straight above too
        const rim = new Mesh(new BoxGeometry(TILE + 0.07, 0.04, TILE + 0.07), sideM);
        rim.position.y = 0.02; g.add(rim);
        const n = t.resourceCubes || 0;
        if (n > 0 && !t.flipped) {
            for (let i = 0; i < n; i++) {
                let m;
                if (t.type === 'brewery') {
                    m = new Mesh(new CylinderGeometry(0.09, 0.09, 0.2, 14), this.mat(0x9a6a33));
                    m.rotation.z = Math.PI / 2;
                    m.position.set(-0.2 + (i % 3) * 0.2, TILE_H + 0.09, 0.24 - Math.floor(i / 3) * 0.2);
                } else {
                    m = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), this.mat(t.type === 'coalMine' ? 0x1b1b1b : 0xd8742a));
                    m.position.set(-0.24 + (i % 4) * 0.16, TILE_H + 0.075, 0.26 - Math.floor(i / 4) * 0.17);
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
        const topM = new MeshStandardMaterial({ map: this.tex(`assets/tiles/${l.type === 'canal' ? 'canal' : 'rail'}.jpg`), roughness: 0.55 });
        const box = new Mesh(new BoxGeometry(w, 0.08, d), [sideM, sideM, topM, sideM, sideM, sideM]);
        box.position.y = 0.06; box.castShadow = !this.low; g.add(box);
        const rim = new Mesh(new BoxGeometry(w + 0.08, 0.035, d + 0.08), sideM);
        rim.position.y = 0.018; g.add(rim);
        g.position.copy(toWorld(p.u, p.v));
        g.rotation.y = -p.angle;
        const ud = { kind: 'builtLink', connId, link: l };
        g.traverse(o => { o.userData = ud; });
        this.gBuiltLinks.add(g);
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
                m.material.opacity = s ? (isMk ? 0.85 : 0.35) : on ? (isMk ? 0.7 : 0.18) : 0;
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

    tick(t) {
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
