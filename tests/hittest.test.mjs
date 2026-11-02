// Pins the pixel → cell / wall hit-test geometry.
//
// The rule the design settled on: the clickable region of a cell is a square
// covering the middle 80% of the cell, at every board size, with no pixel
// constants — so a phone and a desktop behave identically. This test fails if
// anyone reintroduces a fixed offset or drifts the ratio.
//
//   node tests/hittest.test.mjs
'use strict';
import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = n => readFileSync(path.join(ROOT, 'js', n), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
    if (cond) { passed++; console.log('  ok   ' + label); }
    else { failed++; console.log('  FAIL ' + label); }
}

/* ---------------- harness ---------------- */

function fakeCtx() {
    const noop = () => {};
    return new Proxy({}, {
        get(t, p) {
            if (p in t) return t[p];
            if (p === 'createRadialGradient' || p === 'createLinearGradient') {
                return () => ({ addColorStop: noop });
            }
            return noop;
        },
        set(t, p, v) { t[p] = v; return true; }
    });
}

function load(size) {
    const el = {
        id: 'board', style: {}, width: size, height: size, _dpr: 1,
        addEventListener() {},
        getContext: () => fakeCtx(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size })
    };
    const ctx = vm.createContext({
        console,
        module: { exports: {} },
        document: { getElementById: () => el },
        getComputedStyle: () => ({ getPropertyValue: () => '#000000' }),
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }), devicePixelRatio: 1 },
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        Event: class { constructor(t) { this.type = t; } }
    });
    vm.runInContext(src('rules.js'), ctx);
    vm.runInContext(src('render.js'), ctx);
    const R = vm.runInContext('QRender', ctx);
    R.resize(size);
    return R;
}

const classify = (R, px, py) => R.pixelToWall(px, py) ? 'wall'
    : (R.pixelToCell(px, py) ? 'cell' : 'none');

/** Walk from the cell centre outward; return the distance where it stops being a cell. */
function halfSpan(R, cx, cy, dx, dy) {
    for (let d = 0; d <= R.CELL; d += 0.02) {
        if (classify(R, cx + dx * d, cy + dy * d) !== 'cell') return d;
    }
    return R.CELL / 2;
}

/* ---------------- the design rule ---------------- */

const SIZES = [280, 320, 366, 390, 480, 520, 600, 640, 720, 900];

console.log('\nThe inner region is 80% of the cell, at every board size');
for (const size of SIZES) {
    const R = load(size);
    const r = R.cellRect(4, 4);
    const w = Math.min(halfSpan(R, r.cx, r.cy, -1, 0), halfSpan(R, r.cx, r.cy, 1, 0)) * 2;
    const h = Math.min(halfSpan(R, r.cx, r.cy, 0, -1), halfSpan(R, r.cx, r.cy, 0, 1)) * 2;
    const pct = w / R.CELL * 100;
    ok(Math.abs(w - h) < 0.05, `board ${size}: the region is square (${w.toFixed(2)} x ${h.toFixed(2)})`);
    ok(Math.abs(pct - 80) < 0.6, `board ${size}: inner width is ${pct.toFixed(1)}% of the cell`);
}

console.log('\nThe ratio does not depend on the board size');
{
    const pcts = SIZES.map(size => {
        const R = load(size);
        const r = R.cellRect(4, 4);
        return Math.min(halfSpan(R, r.cx, r.cy, -1, 0), halfSpan(R, r.cx, r.cy, 1, 0)) * 2 / R.CELL * 100;
    });
    const spread = Math.max(...pcts) - Math.min(...pcts);
    ok(spread < 0.6, `drift across ${SIZES.length} sizes is ${spread.toFixed(2)}% (a pixel constant would drift ~20%)`);
}

console.log('\nNo pixel constant is hiding in the snap radius');
{
    // A pure ratio means snap / CELL is identical everywhere.
    const ratios = SIZES.map(size => load(size).CELL * load(size).SNAP_RATIO / load(size).CELL);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    ok(spread < 1e-9, `SNAP_RATIO is constant (spread ${spread.toExponential(1)})`);
    const R = load(640);
    ok(Math.abs(R.SNAP_RATIO - 0.18) < 1e-9, `SNAP_RATIO is 0.18 (groove half 0.08 + 0.10 cut)`);
    // 0.18 * CELL - GROOVE/2 must equal 0.10 * CELL for the 80% rule to hold.
    const intrude = R.CELL * R.SNAP_RATIO - R.GROOVE / 2;
    ok(Math.abs(intrude - R.CELL * 0.10) < 0.01,
        `intrusion is exactly 10% of the cell (${intrude.toFixed(2)}px of ${R.CELL.toFixed(2)}px)`);
}

console.log('\nBoth orientations are reachable from their own groove');
{
    const R = load(640);
    // A horizontal wall at anchor (4,4) sits on the row groove between rows 4 and 5.
    const hc = R.hWallCenter(4, 4);
    const hitH = R.pixelToWall(hc.cx, hc.cy);
    ok(hitH && hitH.isH === true, 'the centre of an h-wall groove hits an h-wall');

    const vc = R.vWallCenter(4, 4);
    const hitV = R.pixelToWall(vc.cx, vc.cy);
    ok(hitV && hitV.isH === false, 'the centre of a v-wall groove hits a v-wall');

    // Approaching along the groove line keeps the orientation.
    const along = R.pixelToWall(hc.cx + R.CELL * 0.3, hc.cy);
    ok(along && along.isH === true, 'sliding along a row groove stays horizontal');
}

console.log('\nEvery cell still resolves to itself at its centre');
{
    const R = load(640);
    let bad = 0;
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const r = R.cellRect(x, y);
            const hit = R.pixelToCell(r.cx, r.cy);
            if (!hit || hit.x !== x || hit.y !== y) bad++;
            if (R.pixelToWall(r.cx, r.cy)) bad++;
        }
    }
    ok(bad === 0, `all 81 cell centres resolve to a cell, never a wall (${bad} bad)`);
}

console.log('\nBorder cells keep their outward edge');
{
    const R = load(640);
    const half = R.CELL / 2;
    const corner = R.cellRect(0, 0);
    // The board edge side has no neighbouring groove, so it should reach the full half-cell.
    const outward = halfSpan(R, corner.cx, corner.cy, -1, 0);
    const inward = halfSpan(R, corner.cx, corner.cy, 1, 0);
    ok(Math.abs(outward - half) < 0.1, `a corner cell reaches the board edge (${outward.toFixed(2)} of ${half.toFixed(2)})`);
    ok(inward < half, `and is still trimmed on the groove side (${inward.toFixed(2)})`);
}

console.log('\nVertical position does not change the horizontal result');
{
    const R = load(640);
    const mid = R.cellRect(4, 4);
    const top = R.cellRect(4, 0);
    const a = halfSpan(R, mid.cx, mid.cy, 1, 0);
    const b = halfSpan(R, top.cx, top.cy, 1, 0);
    ok(Math.abs(a - b) < 0.1, `row 4 (${a.toFixed(2)}) matches row 0 (${b.toFixed(2)})`);
}

console.log(`\n${passed} hit-test assertions passed${failed ? `, ${failed} FAILED` : ' \u2713'}`);
process.exit(failed ? 1 : 0);
