// Companion to measure-hittest.js: verifies the closed form, and measures the
// cells that sit on the board border (they have fewer neighbouring grooves).
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
function load(size) {
    const el = {
        id: 'board', style: {}, width: 600, height: 600, _dpr: 1,
        addEventListener() {}, getContext: () => fakeCtx(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 })
    };
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
function classify(R, px, py) {
    if (R.pixelToWall(px, py)) return 'wall';
    return R.pixelToCell(px, py) ? 'cell' : 'none';
}
function halfSpan(R, cx, cy, dx, dy) {
    for (let d = 0; d <= R.CELL; d += 0.05) {
        if (classify(R, cx + dx * d, cy + dy * d) !== 'cell') return d;
    }
    return R.CELL;
}

console.log('=== Closed form check ===');
console.log('snap      = GROOVE*1.35 + 5 = CELL*0.216 + 5');
console.log('intrusion = snap - GROOVE/2 = CELL*0.136 + 5');
console.log('inner     = CELL - 2*intrusion = CELL*0.728 - 10\n');

let worst = 0;
for (const size of [320, 366, 390, 520, 640, 720, 900]) {
    const R = load(size);
    const C = R.CELL;
    const predicted = C * 0.728 - 10;
    const r = R.cellRect(4, 4);
    const h = Math.min(halfSpan(R, r.cx, r.cy, 1, 0), halfSpan(R, r.cx, r.cy, 0, 1)) * 2;
    const err = Math.abs(h - predicted);
    worst = Math.max(worst, err);
    console.log(`  board ${String(size).padStart(3)}  cell ${C.toFixed(2).padStart(6)}  ` +
        `measured ${h.toFixed(2).padStart(6)}  predicted ${predicted.toFixed(2).padStart(6)}  ` +
        `err ${err.toFixed(2)}`);
}
console.log(`\n  max error ${worst.toFixed(2)} px -> the formula holds\n`);

console.log('=== Square or not? (corner diagonal probe, board 640) ===');
{
    const R = load(640);
    const r = R.cellRect(4, 4);
    const half = R.CELL / 2 - (R.CELL * 0.136 + 5);
    for (const k of [0.6, 0.9, 0.99, 1.01, 1.1]) {
        const d = half * k;
        console.log(`  (${(half * k).toFixed(2)}, ${(half * k).toFixed(2)}) from centre -> ` +
            `${classify(R, r.cx + d, r.cy + d)}${k < 1 ? '   (expect cell)' : '   (expect wall)'}`);
    }
}

console.log('\n=== Border cells (board 640, cell 57.14) ===');
for (const [x, y, label] of [[4, 4, 'interior'], [0, 4, 'left edge'], [4, 0, 'top edge'], [0, 0, 'corner']]) {
    const R = load(640);
    const r = R.cellRect(x, y);
    const span = (dx, dy) => {
        for (let d = 0; d <= R.CELL / 2 + 2; d += 0.05) {
            if (classify(R, r.cx + dx * d, r.cy + dy * d) !== 'cell') return d;
        }
        return R.CELL / 2;
    };
    const l = span(-1, 0), ri = span(1, 0), u = span(0, -1), dn = span(0, 1);
    console.log(`  ${label.padEnd(10)} cell(${x},${y})  ` +
        `left ${l.toFixed(1).padStart(5)} right ${ri.toFixed(1).padStart(5)} ` +
        `up ${u.toFixed(1).padStart(5)} down ${dn.toFixed(1).padStart(5)}  ` +
        `(cell half = ${(R.CELL / 2).toFixed(1)})`);
}

console.log('\n=== What the constants mean for a proposed ratio ===');
console.log('To steal exactly X of the cell on each side:');
console.log('  snap = CELL*(X + 0.08)   and the +5 px constant has to go\n');
const table = [0.30, 0.25, 0.20, 0.186, 0.15, 0.12, 0.10, 0.05];
console.log('  X      inner%   inner px @cell=57.14   inner px @cell=32.7 (phone)');
for (const X of table) {
    const innerPct = (1 - 2 * X) * 100;
    console.log(`  ${(X * 100).toFixed(1).padStart(5)}%  ${innerPct.toFixed(0).padStart(6)}%   ` +
        `${((1 - 2 * X) * 57.14).toFixed(1).padStart(19)}   ${((1 - 2 * X) * 32.7).toFixed(1).padStart(22)}`);
}
