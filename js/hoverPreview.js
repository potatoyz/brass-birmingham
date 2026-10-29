// Large previews and readable tooltips.
//
// - Hand cards: hovering (or long-pressing on touch) shows the card face at a
//   readable size, above the hand and clear of the card itself.
// - Industry tiles on the player mat and built tiles on the board: the chip
//   art enlarged, with its stats.
// - The mat heading: the whole printed player mat.
// - Every `title` attribute is shown in a styled 14px tooltip instead of the
//   browser's tiny native one.
// The preview never takes pointer events, so it can't get in the way of play.
(() => {
    'use strict';

    const MARGIN = 8;
    const LONG_PRESS_MS = 450;
    let preview, tip;
    let current = null;          // element the preview belongs to
    let tipTarget = null;
    let suppressClickUntil = 0;
    let pressTimer = null;
    let pressPoint = null;
    let lastTouch = 0;

    function ensureEls() {
        if (preview) return;
        preview = document.createElement('div');
        preview.id = 'card-preview';
        preview.setAttribute('aria-hidden', 'true');
        document.body.appendChild(preview);
        tip = document.createElement('div');
        tip.id = 'ui-tip';
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

    // Put a box of size w×h next to `rect`, preferring above, then the sides,
    // then below — never overlapping the rect, never past the viewport.
    function place(el, rect, w, h, prefer) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const cx = rect.left + rect.width / 2;
        const opts = {
            above: () => ({ x: cx - w / 2, y: rect.top - h - 12, ok: rect.top - h - 12 >= MARGIN }),
            right: () => ({ x: rect.right + 14, y: rect.top + rect.height / 2 - h / 2, ok: rect.right + 14 + w <= vw - MARGIN }),
            left: () => ({ x: rect.left - w - 14, y: rect.top + rect.height / 2 - h / 2, ok: rect.left - w - 14 >= MARGIN }),
            below: () => ({ x: cx - w / 2, y: rect.bottom + 12, ok: rect.bottom + 12 + h <= vh - MARGIN }),
        };
        const order = prefer === 'side' ? ['right', 'left', 'above', 'below'] : ['above', 'right', 'left', 'below'];
        let p = null;
        for (const k of order) { const c = opts[k](); if (c.ok) { p = c; break; } }
        if (!p) p = opts[order[0]]();
        el.style.left = clamp(p.x, MARGIN, Math.max(MARGIN, vw - w - MARGIN)) + 'px';
        el.style.top = clamp(p.y, MARGIN, Math.max(MARGIN, vh - h - MARGIN)) + 'px';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // ---- What a given element previews ----
    function describe(el) {
        const card = el.closest && el.closest('#player-hand .card');
        if (card) {
            const img = card.querySelector('img');
            const label = card.querySelector('.card-art-label');
            const name = (label && (label.dataset.full || label.textContent)) || (img && img.alt) || card.textContent.trim();
            if (img) return { kind: 'card', src: img.currentSrc || img.src, caption: name, anchor: card };
            return { kind: 'text', caption: name, anchor: card };
        }
        const matTile = el.closest && el.closest('.mat-tile');
        if (matTile) {
            const img = matTile.querySelector('img');
            const info = matTile.getAttribute('data-tip') || matTile.getAttribute('title') || '';
            const [first, ...rest] = info.split('\n');
            return { kind: 'chip', src: img ? (img.currentSrc || img.src) : null, caption: first, info: rest.join('\n'), anchor: matTile };
        }
        if (el.id === 'mat-label' && typeof BoardAssets !== 'undefined' && BoardAssets.matReady && BoardAssets.matReady()) {
            return { kind: 'mat', src: BoardAssets.matUrl(), caption: '玩家板', anchor: el };
        }
        if (el.tagName && el.tagName.toLowerCase() === 'image' && el.classList.contains('built-tile')) {
            const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            const slot = el.closest('.industry-slot');
            let caption = '', info = '';
            try {
                const key = slot && `${slot.dataset.city}_${slot.dataset.slot}`;
                const st = window.gameState;
                const tile = st && st.boardIndustries && st.boardIndustries[key];
                if (tile) {
                    const disp = (typeof INDUSTRY_DISPLAY !== 'undefined' && INDUSTRY_DISPLAY[tile.type]) || {};
                    const owner = st.players[tile.playerId];
                    caption = `${disp.name || tile.type} Lv${tile.tileData.level}`;
                    const lines = [];
                    if (owner) lines.push(`所属：${owner.name}`);
                    if (typeof locationName === 'function') lines.push(`位置：${locationName(slot.dataset.city)}`);
                    lines.push(tile.flipped ? '已翻面' : '未翻面');
                    info = lines.join('\n');
                }
            } catch (e) { /* preview is best-effort */ }
            return { kind: 'chip', src: href, caption, info, anchor: el, onBoard: true };
        }
        return null;
    }

    function show(d) {
        ensureEls();
        hideTip();
        current = d.anchor;
        preview.className = 'show' + (d.kind === 'chip' ? ' pv-chip' : '');
        const vw = window.innerWidth, vh = window.innerHeight;
        let w, h;
        if (d.kind === 'card') {
            // Big enough to read the printed names, small enough to fit.
            const ih = Math.round(clamp(vh * 0.56, 260, 470));
            const iw = Math.round(ih * 500 / 702);
            preview.innerHTML = `<img src="${escapeHtml(d.src)}" width="${iw}" height="${ih}" alt="">` +
                (d.caption ? `<div class="pv-caption">${escapeHtml(d.caption)}</div>` : '');
            w = iw + 14; h = ih + 14 + (d.caption ? 30 : 0);
        } else if (d.kind === 'mat') {
            const iw = Math.round(Math.min(vw * 0.62, 760, (vh * 0.8) * 1920 / 1553));
            const ih = Math.round(iw * 1553 / 1920);
            preview.innerHTML = `<img src="${escapeHtml(d.src)}" width="${iw}" height="${ih}" alt="">`;
            w = iw + 14; h = ih + 14;
        } else if (d.kind === 'chip') {
            preview.innerHTML = (d.src ? `<img src="${escapeHtml(d.src)}" alt="">` : '') +
                (d.caption ? `<div class="pv-caption">${escapeHtml(d.caption)}</div>` : '') +
                (d.info ? `<div class="pv-info">${escapeHtml(d.info)}</div>` : '');
            w = 248;
            preview.style.width = w + 'px';
            h = preview.getBoundingClientRect().height || 300;
        } else {
            preview.innerHTML = `<div class="pv-caption">${escapeHtml(d.caption)}</div>`;
            w = preview.getBoundingClientRect().width || 160;
            h = preview.getBoundingClientRect().height || 40;
        }
        preview.style.width = w + 'px';
        const rect = d.anchor.getBoundingClientRect();
        place(preview, rect, w, h, d.onBoard ? 'side' : 'above');
    }

    function hide() {
        current = null;
        if (preview) { preview.className = ''; preview.innerHTML = ''; }
    }

    // ---- Styled tooltips ----
    function takeTitle(el) {
        const t = el.getAttribute('title');
        if (t !== null) {
            if (t) el.setAttribute('data-tip', t);
            el.removeAttribute('title');
        }
        return el.getAttribute('data-tip');
    }

    function showTip(el) {
        const text = takeTitle(el);
        if (!text) return;
        ensureEls();
        tipTarget = el;
        tip.textContent = text;
        tip.classList.add('show');
        const r = el.getBoundingClientRect();
        const w = tip.offsetWidth, h = tip.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = r.left + r.width / 2 - w / 2;
        let y = r.top - h - 8;
        if (y < MARGIN) y = r.bottom + 8;
        tip.style.left = clamp(x, MARGIN, vw - w - MARGIN) + 'px';
        tip.style.top = clamp(y, MARGIN, vh - h - MARGIN) + 'px';
    }

    function hideTip() {
        tipTarget = null;
        if (tip) tip.classList.remove('show');
    }

    // ---- Mouse ----
    document.addEventListener('mouseover', (e) => {
        if (Date.now() - lastTouch < 800) return; // emulated after a tap
        const t = e.target;
        if (!(t instanceof Element)) return;
        const d = describe(t);
        if (d) {
            // Mat tiles carry their stats into the preview; no tooltip as well.
            const tipped = t.closest('[title],[data-tip]');
            if (tipped && d.kind === 'chip') takeTitle(tipped);
            if (d.anchor !== current) show(d);
            return;
        }
        if (current && !current.contains(t)) hide();
        const tipped = t.closest('[title],[data-tip]');
        if (tipped && !(tipped instanceof SVGElement)) {
            if (tipped !== tipTarget) showTip(tipped);
        } else if (tipTarget) {
            hideTip();
        }
    }, true);

    document.addEventListener('mouseout', (e) => {
        const to = e.relatedTarget;
        if (current && (!to || !current.contains(to))) {
            if (!(to instanceof Element) || !describe(to) || describe(to).anchor !== current) hide();
        }
        if (tipTarget && (!to || !tipTarget.contains(to))) hideTip();
    }, true);

    // Anything that changes what's under the pointer drops the overlays.
    ['scroll', 'wheel', 'resize', 'keydown'].forEach(ev =>
        window.addEventListener(ev, () => { hide(); hideTip(); }, { passive: true, capture: true }));
    document.addEventListener('mousedown', () => { hideTip(); }, true);

    // ---- Touch: long-press to preview ----
    document.addEventListener('touchstart', (e) => {
        lastTouch = Date.now();
        if (e.touches.length !== 1) return;
        const t = e.target;
        if (!(t instanceof Element)) return;
        const d = describe(t);
        if (!d) return;
        const p = e.touches[0];
        pressPoint = { x: p.clientX, y: p.clientY };
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            pressTimer = null;
            show(d);
            suppressClickUntil = Date.now() + 800;
        }, LONG_PRESS_MS);
    }, { passive: true, capture: true });

    document.addEventListener('touchmove', (e) => {
        if (!pressTimer || !pressPoint) return;
        const p = e.touches[0];
        if (Math.hypot(p.clientX - pressPoint.x, p.clientY - pressPoint.y) > 10) {
            clearTimeout(pressTimer); pressTimer = null;
        }
    }, { passive: true, capture: true });

    const endPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        if (current) hide();
    };
    document.addEventListener('touchend', endPress, { capture: true });
    document.addEventListener('touchcancel', endPress, { capture: true });

    // A long-press is a look, not a play: swallow the click it would cause.
    document.addEventListener('click', (e) => {
        if (Date.now() < suppressClickUntil) {
            suppressClickUntil = 0;
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
    document.addEventListener('contextmenu', (e) => {
        if (Date.now() - lastTouch < 1500 && e.target instanceof Element && describe(e.target)) e.preventDefault();
    }, true);

    window.HoverPreview = { show: (el) => { const d = describe(el); if (d) show(d); }, hide };
})();
