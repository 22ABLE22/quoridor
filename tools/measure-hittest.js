// Measure the pointer hit-test: how far from a cell's centre does the pointer
// still count as "this cell", and where does it flip to "place a wall here"?
//
// Loads the real js/render.js behind a small DOM stub so the numbers come from
// the shipping code rather than from a re-derivation that could drift.
'use strict';
const { readFileSync } = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const js = n => readFileSync(path.join(ROOT, 'js', n), 'utf8');

function fakeCtx() {
    const noop = () => {};
    return new Proxy({}, {
        get(t, p) {
            if (p in t) return t[p];
            if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop: noop });
            return noop;
        },
        set(t, p, v) { t[p] = v; return true; }
    });
}

function board() {
    return {
        id: 'board', style: {}, width: 600, height: 600, _dpr: 1,
        addEventListener() {}, getContext: () => fakeCtx(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 })
    };
}

function load(size) {
    const el = board();
    const ctx = vm.createContext({
        console, module: { exports: {} },
        document: { getElementById: () => el },
        getComputedStyle: () => ({ getPropertyValue: () => '#000000' }),
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }), devicePixelRatio: 1 },
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        Event: class { constructor(t) { this.type = t; } }
    });
    vm.runInContext(js('rules.js'), ctx);
    vm.runInContext(js('render.js'), ctx);
    const R = vm.runInContext('QRender', ctx);
    R.resize(size);
    return R;
}

/** Classify a point the way app.js does: a wall intent wins over a cell. */
function classify(R, px, py) {
    const wall = R.pixelToWall(px, py);
    if (wall) return 'wall';
    const cell = R.pixelToCell(px, py);
    return cell ? 'cell' : 'none';
}

/** Walk from the cell centre outward along one axis; return the flip offset. */
function flipOffset(R, cx, cy, dx, dy, limit) {
    let last = 0;
    for (let d = 0; d <= limit; d += 0.05) {
        const c = classify(R, cx + dx * d, cy + dy * d);
        if (c !== 'cell') return { offset: d, became: c };
        last = d;
    }
    return { offset: last, became: 'cell' };
}

const sizes = [280, 390, 520, 640, 720];
const rows = [];

for (const size of sizes) {
    const R = load(size);
    const CELL = R.CELL, GROOVE = R.GROOVE, PAD = R.PAD;
    const snap = GROOVE * 1.35 + 5;

    // a centre cell, fully surrounded by grooves
    const r = R.cellRect(4, 4);
    const left = flipOffset(R, r.cx, r.cy, -1, 0, CELL / 2 + 2);
    const right = flipOffset(R, r.cx, r.cy, 1, 0, CELL / 2 + 2);
    const up = flipOffset(R, r.cx, r.cy, 0, -1, CELL / 2 + 2);
    const down = flipOffset(R, r.cx, r.cy, 0, 1, CELL / 2 + 2);

    const halfW = Math.min(left.offset, right.offset);
    const halfH = Math.min(up.offset, down.offset);
    const innerW = halfW * 2, innerH = halfH * 2;
    const intrusion = (CELL - innerW) / 2;

    rows.push({
        size,
        CELL: +CELL.toFixed(2),
        GROOVE: +GROOVE.toFixed(2),
        PAD: +PAD.toFixed(2),
        snap: +snap.toFixed(2),
        intrusive_toward_cell: +(snap - GROOVE / 2).toFixed(2),
        measured_intrusion: +intrusion.toFixed(2),
        inner: +innerW.toFixed(1),
        inner_pct: +(innerW / CELL * 100).toFixed(1),
        edge_pct: +(intrusion / CELL * 100).toFixed(1),
        symmetric: Math.abs(left.offset - right.offset) < 0.11 && Math.abs(up.offset - down.offset) < 0.11,
        leftBecame: left.became, upBecame: up.became
    });
}

console.log('Pointer hit-test: inner square that still counts as "this cell"\n');
const head = ['board', 'cell', 'groove', 'snap', 'intrude', 'inner sq', 'inner %', 'edge %', 'sym'];
const widths = [6, 7, 8, 7, 8, 9, 8, 7, 4];
const fmt = (v, w) => String(v).padStart(w);
console.log(head.map((h, i) => fmt(h, widths[i])).join(' '));
console.log(widths.map(w => '-'.repeat(w)).join(' '));
for (const r of rows) {
    console.log([
        fmt(r.size, widths[0]), fmt(r.CELL, widths[1]), fmt(r.GROOVE, widths[2]),
        fmt(r.snap, widths[3]), fmt(r.measured_intrusion, widths[4]),
        fmt(r.inner, widths[5]), fmt(r.inner_pct, widths[6]),
        fmt(r.edge_pct, widths[7]), fmt(r.symmetric ? 'yes' : 'NO', widths[8])
    ].join(' '));
}

console.log('\nReference scale, cell edge = 100 px:');
const ref = rows.find(r => Math.abs(r.CELL - 100) < 1);
if (ref) console.log('  (exact 100 px cell not in the list; see the ratio line below)');
const k = 5; // the +5px constant in snap
console.log('  intrusion% = 13.6% + ' + k + 'px / cell');
for (const u of [40, 57.14, 72, 100, 120]) {
    const intr = 0.16 * u * 0.85 + k;
    console.log(`  cell ${String(u.toFixed(2)).padStart(6)} px -> intrude ${intr.toFixed(2).padStart(6)} px ` +
        `(${(intr / u * 100).toFixed(1)}%), inner ${(u - 2 * intr).toFixed(1)} px (${((u - 2 * intr) / u * 100).toFixed(1)}%)`);
}

// Where exactly does a click near a corner land?
{
    const R = load(640);
    const r = R.cellRect(4, 4);
    const q = CELLQUAD(R, r);
    function CELLQUAD(R, r) { return { left: r.left, top: r.top, w: R.CELL }; }
    console.log('\nCorner probe at a 640 px board (cell 4,4, centre ' +
        r.cx.toFixed(1) + ',' + r.cy.toFixed(1) + '):');
    const probes = [
        ['exact centre', 0, 0],
        ['25% in from corner', -R.CELL * 0.25, -R.CELL * 0.25],
        ['10% in from corner', -R.CELL * 0.35, -R.CELL * 0.35],
        ['on the corner itself', -R.CELL / 2 + 0.5, -R.CELL / 2 + 0.5]
    ];
    for (const [label, dx, dy] of probes) {
        const px = r.cx + dx, py = r.cy + dy;
        console.log('  ' + label.padEnd(22) + classify(R, px, py));
    }
}
