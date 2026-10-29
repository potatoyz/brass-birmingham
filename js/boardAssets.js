// ============================================================================
// Brass: Birmingham - Board image assets (optional, local)
// ============================================================================
// The game ships with original, procedurally drawn art. If you want it to use
// a scan or photograph of a board instead, supply one locally — nothing here
// is committed to the repository:
//
//   1. Drop a file at  assets/board.jpg  (or .png / .jpeg / .webp), or
//   2. Point it anywhere:
//        localStorage.brassBoardAsset = 'https://example.com/board.jpg'
//
// Then open the page with ?calibrate=1 to drag each town onto its printed
// space. Positions save automatically and persist across reloads.
//
// Supplying the image is your call and your responsibility — board artwork is
// usually the publisher's copyright, so only use art you have the right to use.
// ============================================================================

const BoardAssets = (() => {
    const STORAGE_URL = 'brassBoardAsset';
    const STORAGE_LAYOUT = 'brassBoardLayout';

    // Bumped whenever the shipped art changes: images are served with a
    // week-long max-age, so a new query string is what makes browsers refetch.
    const AV = '?v=zh2';

    const CANDIDATES = [
        'assets/board.jpg' + AV,
        'assets/board.jpeg',
        'assets/board.png',
        'assets/board.webp',
    ];

    // Where each location sits on a printed board, normalised to 0..1 of the
    // map's width and height. Measured off a photograph of the retail board
    // (perspective corrected), so it lands close but not exact — ?calibrate=1
    // is there to finish the job for whatever image you supply.
    const OFFICIAL_LAYOUT = {
        // Cities (warrington is a merchant, but is keyed with the cities)
        warrington:    [0.2794, 0.1123],
        leek:          [0.5532, 0.0732],
        belper:        [0.7515, 0.0873],
        stokeOnTrent:  [0.4115, 0.1450],
        uttoxeter:     [0.5651, 0.2308],
        stone:         [0.3056, 0.2515],
        derby:         [0.7610, 0.2592],
        stafford:      [0.4003, 0.3455],
        burtonOnTrent: [0.6826, 0.3729],
        cannock:       [0.4757, 0.4474],
        tamworth:      [0.6991, 0.4994],
        wolverhampton: [0.3697, 0.5399],
        walsall:       [0.5313, 0.5633],
        coalbrookdale: [0.2318, 0.5841],
        nuneaton:      [0.7894, 0.5994],
        dudley:        [0.4170, 0.6627],
        birmingham:    [0.6299, 0.7015],
        coventry:      [0.8132, 0.7324],
        kidderminster: [0.3476, 0.7666],
        redditch:      [0.5844, 0.8186],
        worcester:     [0.3592, 0.8965],
        // Merchants
        shrewsbury:    [0.0892, 0.5721],
        nottingham:    [0.9044, 0.1879],
        oxford:        [0.8295, 0.8527],
        gloucester:    [0.6030, 0.9259],
        // Brewery farms
        northern:      [0.2989, 0.4341],
        southern:      [0.2597, 0.8400],
    };

    // Our industry ids -> the filename stem used under assets/tiles/.
    const TILE_STEM = {
        cottonMill: 'cotton',
        coalMine: 'coal',
        ironWorks: 'iron',
        manufacturer: 'goods',
        pottery: 'pottery',
        brewery: 'brewery',
    };

    // Set once a probe confirms assets/tiles/ is populated.
    let tilesAvailable = false;

    function tilesReady() { return tilesAvailable; }

    function tileUrl(industryType, level, flipped) {
        const stem = TILE_STEM[industryType];
        if (!stem) return null;
        return `assets/tiles/${stem}-${level}${flipped ? '-flipped' : ''}.jpg${AV}`;
    }

    function linkUrl(type) {
        return `assets/tiles/${type === 'canal' ? 'canal' : 'rail'}.jpg${AV}`;
    }

    // Card faces live under assets/cards/, keyed by our own ids: a location
    // card by its city id, an industry card by its industry type.
    let cardsAvailable = false;
    let matAvailable = false;

    function cardsReady() { return cardsAvailable; }
    function matReady() { return matAvailable; }
    function matUrl() { return 'assets/player-mat.jpg' + AV; }

    function cardUrl(card) {
        if (!cardsAvailable || !card) return null;
        switch (card.type) {
            case CARD_TYPES.LOCATION:      return `assets/cards/${card.location}.jpg${AV}`;
            // Dual cards have no printed equivalent; use the first industry.
            case CARD_TYPES.INDUSTRY:      return `assets/cards/${card.industryTypes[0]}.jpg${AV}`;
            case CARD_TYPES.WILD_LOCATION: return 'assets/cards/wild-location.jpg' + AV;
            case CARD_TYPES.WILD_INDUSTRY: return 'assets/cards/wild-industry.jpg' + AV;
            default: return null;
        }
    }

    function cardBackUrl() { return 'assets/cards/back.jpg' + AV; }

    async function probeCards() {
        cardsAvailable = !!(await tryLoad('assets/cards/birmingham.jpg'));
        matAvailable = !!(await tryLoad('assets/player-mat.jpg'));
        return cardsAvailable;
    }

    async function probeTiles() {
        // One representative tile is enough to decide the set is present.
        tilesAvailable = !!(await tryLoad('assets/tiles/coal-1.jpg'));
        return tilesAvailable;
    }


    // How the printed board arranges each town's industry spaces, read off the
    // artwork. Rows run top to bottom; the LAST row sits on the location's
    // anchor (the anchor is derived from the name banner directly beneath it)
    // and each row above is one row-pitch higher. Counts match CITIES exactly.
    const SLOT_ROWS = {
        belper:        [3],
        derby:         [1, 2],
        leek:          [2],
        stokeOnTrent:  [1, 2],
        uttoxeter:     [2],
        stone:         [2],
        stafford:      [2],
        burtonOnTrent: [2],
        cannock:       [2],
        tamworth:      [2],
        walsall:       [2],
        wolverhampton: [2],
        coalbrookdale: [1, 2],
        dudley:        [2],
        kidderminster: [2],
        worcester:     [2],
        birmingham:    [2, 2],
        coventry:      [1, 2],
        nuneaton:      [2],
        redditch:      [2],
        // Merchants and brewery farms
        warrington:    [2],
        nottingham:    [2],
        shrewsbury:    [1],
        oxford:        [2],
        gloucester:    [2],
        northern:      [1],
        southern:      [1],
    };

    // Measured off the board: spaces are 38.8 x 36.3 board units, laid on a
    // 41.6 unit horizontal pitch and a 39.6 unit vertical one.
    const SLOT_PITCH_X = 41.6 / 900;
    const SLOT_PITCH_Y = 39.6 / 850;

    // Centres of a location's printed spaces, in reading order (top row first,
    // left to right), normalised to the board.
    function slotPositions(locationId, layout) {
        const a = (layout || OFFICIAL_LAYOUT)[locationId];
        const rows = SLOT_ROWS[locationId];
        if (!a || !rows) return null;
        const out = [];
        rows.forEach((n, r) => {
            const y = a[1] - (rows.length - 1 - r) * SLOT_PITCH_Y;
            for (let i = 0; i < n; i++) {
                out.push([a[0] + (i - (n - 1) / 2) * SLOT_PITCH_X, y]);
            }
        });
        return out;
    }

    // Printed name banners on the bundled board (0..1 of width/height, the
    // merchant ones including the coal cart beneath). Built link tiles are
    // nudged along their route so they never sit on top of a town's name.
    const BANNERS = {"warrington":[0.2168,0.0586,0.3384,0.0835],"leek":[0.5273,0.0981,0.5811,0.1152],"belper":[0.7197,0.1118,0.7842,0.1289],"nottingham":[0.8423,0.1221,0.9648,0.1465],"stokeOnTrent":[0.3633,0.1699,0.4595,0.187],"uttoxeter":[0.5234,0.2588,0.6069,0.2759],"stone":[0.2754,0.2764,0.3354,0.2935],"derby":[0.7285,0.2842,0.7944,0.3013],"stafford":[0.3667,0.3701,0.437,0.3877],"burtonOnTrent":[0.6279,0.3979,0.7393,0.415],"cannock":[0.4419,0.4717,0.5107,0.4893],"shrewsbury":[0.0298,0.5142,0.1494,0.5391],"tamworth":[0.6616,0.5244,0.7393,0.542],"wolverhampton":[0.3184,0.5649,0.4219,0.582],"walsall":[0.4956,0.5884,0.5645,0.6055],"coalbrookdale":[0.1836,0.6084,0.2803,0.6255],"nuneaton":[0.7534,0.6265,0.8267,0.6436],"dudley":[0.3862,0.6875,0.4487,0.7046],"birmingham":[0.5879,0.7246,0.6777,0.7417],"coventry":[0.7783,0.7573,0.8477,0.7744],"kidderminster":[0.2998,0.791,0.3955,0.8086],"oxford":[0.6924,0.834,0.7812,0.8584],"redditch":[0.5527,0.8438,0.6172,0.8608],"gloucester":[0.4512,0.9106,0.5703,0.9351],"worcester":[0.3228,0.9204,0.3979,0.9375]};
    function bannerRects() { return BANNERS; }

    function savedUrl() {
        try { return localStorage.getItem(STORAGE_URL) || null; } catch (e) { return null; }
    }

    function savedLayout() {
        try {
            const raw = localStorage.getItem(STORAGE_LAYOUT);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function saveLayout(layout) {
        try { localStorage.setItem(STORAGE_LAYOUT, JSON.stringify(layout)); } catch (e) { /* private mode */ }
    }

    function clearLayout() {
        try { localStorage.removeItem(STORAGE_LAYOUT); } catch (e) { /* ignore */ }
    }

    function tryLoad(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    // Resolves to a usable image URL, or null to keep the drawn-from-scratch board.
    async function resolve() {
        const explicit = savedUrl();
        if (explicit) {
            const ok = await tryLoad(explicit);
            if (ok) return ok;
            console.warn('[board] configured image failed to load:', explicit);
        }
        for (const path of CANDIDATES) {
            const ok = await tryLoad(path);
            if (ok) return ok;
        }
        return null;
    }

    // Layout actually in force: hand calibration wins, then the measured
    // defaults, then null (meaning "use the coordinates in gameData.js").
    function layoutFor(hasImage) {
        const custom = savedLayout();
        if (custom) return custom;
        return hasImage ? { ...OFFICIAL_LAYOUT } : null;
    }

    return {
        resolve, layoutFor, saveLayout, clearLayout, savedLayout,
        OFFICIAL_LAYOUT, STORAGE_URL, SLOT_ROWS, slotPositions,
        probeTiles, tilesReady, tileUrl, linkUrl, bannerRects,
        probeCards, cardsReady, cardUrl, cardBackUrl, matReady, matUrl,
    };
})();
