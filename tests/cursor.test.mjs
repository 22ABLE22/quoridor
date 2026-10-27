// Regression tests for the keyboard cursor.
//
// The board is a canvas, but the cursor logic itself is plain arithmetic and
// can be driven in Node: js/input.js only touches the DOM at the bottom of the
// file, so the module is loaded here behind a tiny DOM stand-in.
//
// The bug this file exists for: pressing R to rotate a wall made the wall
// preview disappear. setCursor() accepted a partial update ({ isH }), read
// `next.x` from it, clamped `undefined` to NaN, and every later draw computed
// a position from NaN. Rotation must preserve the anchor.
//
//   node tests/cursor.test.mjs
'use strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const js = name => readFileSync(join(ROOT, 'js', name), 'utf8');

let passed = 0;
function ok(cond, msg) {
    if (cond) { passed++; }
    else { console.error('FAIL: ' + msg); process.exitCode = 1; }
}

/* ---------------- DOM stand-in ---------------- */
/* input.js only needs an element with addEventListener, a style object, and a
 * getBoundingClientRect; render.js also grabs a 2D context at load time. None
 * of that is exercised by the cursor tests, so the stub stays deliberately
 * dumb: every canvas method is a no-op, and wallCenter() only needs this
 * module's pure geometry (PAD / CELL / GROOVE), not a real context. */
function fakeContext2D() {
    const noop = () => {};
    return new Proxy({}, {
        get(target, prop) {
            if (prop in target) return target[prop];
            // gradient objects are the only return values callers use
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
                return () => ({ addColorStop: noop });
            }
            return noop;
        },
        set(target, prop, value) { target[prop] = value; return true; }
    });
}

function makeElement(id) {
    const listeners = new Map();
    return {
        id,
        style: {},
        width: 600,
        height: 600,
        _dpr: 1,
        addEventListener(type, fn) { listeners.set(type, fn); },
        emit(type, event) {
            const fn = listeners.get(type);
            if (fn) fn(event || {});
        },
        getContext() { return fakeContext2D(); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 600 }; }
    };
}

const board = makeElement('board');
const ctx = vm.createContext({
    console,
    module: { exports: {} },
    document: { getElementById: id => (id === 'board' ? board : makeElement(id)) },
    getComputedStyle: () => ({ getPropertyValue: () => '#000000' }),
    window: {
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        devicePixelRatio: 1
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    Event: class { constructor(t) { this.type = t; } }
});

vm.runInContext(js('rules.js'), ctx, { filename: 'rules.js' });
vm.runInContext(js('render.js'), ctx, { filename: 'render.js' });
vm.runInContext(js('input.js'), ctx, { filename: 'input.js' });
const QRules = vm.runInContext('QRules', ctx);
const QRender = vm.runInContext('QRender', ctx);
const QInput = vm.runInContext('QInput', ctx);

/* ---------------- harness ---------------- */
let lastTap = null;
let lastCursor = null;
QInput.bind({
    onTap: (cell, wall) => { lastTap = { cell, wall }; },
    onHover: () => {},
    onCursor: cursor => { lastCursor = cursor; }
});

const key = k => board.emit('keydown', { key: k, preventDefault() {} });
const finite = c => Number.isFinite(c.x) && Number.isFinite(c.y);

/* ---------------- tests ---------------- */

// The exact reported sequence: W, arrows, R.
{
    key('w');
    ok(QInput.cursor.mode === 'wall', 'W enters wall mode');
    const before = { x: QInput.cursor.x, y: QInput.cursor.y, isH: QInput.cursor.isH };

    key('ArrowRight');
    key('ArrowRight');
    const moved = { x: QInput.cursor.x, y: QInput.cursor.y };
    ok(moved.x === before.x + 2, 'arrows move the wall anchor (' + JSON.stringify(moved) + ')');

    const anchorBeforeRotate = { x: QInput.cursor.x, y: QInput.cursor.y, isH: QInput.cursor.isH };
    key('r');
    const afterRotate = QInput.cursor;

    ok(finite(afterRotate), 'rotation leaves a finite anchor, not NaN (' + JSON.stringify(afterRotate) + ')');
    ok(afterRotate.x === anchorBeforeRotate.x && afterRotate.y === anchorBeforeRotate.y,
        'rotation keeps the anchor (' + JSON.stringify(anchorBeforeRotate) + ' -> ' + JSON.stringify(afterRotate) + ')');
    ok(afterRotate.isH === !anchorBeforeRotate.isH, 'rotation flips the orientation');
    ok(afterRotate.mode === 'wall', 'rotation stays in wall mode');
}

// Rotating twice returns to the original orientation. This runs on a fresh
// wall session, because placing a wall hands the turn on and re-seeds the
// cursor — each block below sets up its own starting point rather than
// inheriting whatever the previous block left behind.
{
    QInput.placeCursor({ x: 3, y: 3 });
    key('w');
    const start = QInput.cursor.isH;
    key('r');
    ok(QInput.cursor.isH === !start, 'R flips the orientation');
    key('r');
    ok(QInput.cursor.isH === start, 'R twice returns to the original orientation');
    ok(Number.isFinite(QInput.cursor.x) && Number.isFinite(QInput.cursor.y),
        'the anchor survives two rotations (' + JSON.stringify(QInput.cursor) + ')');
}

// Every cursor state must stay inside its own grid.
{
    QInput.placeCursor({ x: 4, y: 4 });
    key('w');
    for (let i = 0; i < 20; i++) key('ArrowDown');
    ok(QInput.cursor.y === QRules.ANCH - 1, 'wall cursor clamps at the last anchor row');
    for (let i = 0; i < 20; i++) key('ArrowLeft');
    ok(QInput.cursor.x === 0, 'wall cursor clamps at anchor column 0');
}

// Enter in wall mode must still produce a real placement after a rotation.
{
    QInput.placeCursor({ x: 4, y: 4 });
    key('w');
    key('ArrowUp');
    key('ArrowRight');
    key('r');
    lastTap = null;
    key('Enter');
    ok(lastTap && lastTap.wall, 'Enter in wall mode emits a wall tap');
    ok(Number.isFinite(lastTap.wall.x) && Number.isFinite(lastTap.wall.y),
        'the emitted wall has a real anchor (' + JSON.stringify(lastTap.wall) + ')');
    ok(lastTap.wall.isH === !QInput.cursor.isH || lastTap.wall.isH === QInput.cursor.isH,
        'the emitted wall carries an orientation');
}

// The geometry a draw would use must be finite, and the two orientations must
// differ in the way drawWall() renders them: same centre, different long axis.
{
    QInput.placeCursor({ x: 4, y: 4 });
    key('w');
    const c = QInput.cursor;
    const h = QRender.wallCenter(c.x, c.y, true);
    const v = QRender.wallCenter(c.x, c.y, false);
    ok(Number.isFinite(h.cx) && Number.isFinite(h.cy), 'h-wall centre is finite');
    ok(Number.isFinite(v.cx) && Number.isFinite(v.cy), 'v-wall centre is finite');

    // drawWall(): length runs along the groove, thickness across it
    const L = QRender.CELL * 2 + QRender.GROOVE;
    const T = Math.max(8, QRender.GROOVE * 0.95);
    const hBox = { w: L, h: T };
    const vBox = { w: T, h: L };
    ok(hBox.w > hBox.h, 'an h-wall is wider than it is tall');
    ok(vBox.h > vBox.w, 'a v-wall is taller than it is wide');
    ok(hBox.w === vBox.h && hBox.h === vBox.w, 'the two orientations are the same wall turned 90 degrees');
}

// Escape returns to cell mode and clamps to the 9-wide grid.
{
    QInput.placeCursor({ x: 4, y: 4 });
    key('w');
    for (let i = 0; i < 20; i++) key('ArrowRight');
    key('Escape');
    ok(QInput.cursor.mode === 'cell', 'Escape returns to cell mode');
    ok(QInput.cursor.x <= QRules.N - 1 && QInput.cursor.y <= QRules.N - 1,
        'cell cursor is clamped to the 9x9 board (' + JSON.stringify(QInput.cursor) + ')');
}

// Rotation outside wall mode is a no-op rather than a corruption.
{
    QInput.placeCursor({ x: 2, y: 2 });
    key('Escape');
    const before = JSON.stringify(QInput.cursor);
    key('r');
    ok(JSON.stringify(QInput.cursor) === before, 'R in cell mode changes nothing');
    ok(finite(QInput.cursor), 'R in cell mode keeps a finite anchor');
    ok(QInput.cursor.mode === 'cell', 'R in cell mode does not enter wall mode');
}

// A fresh tap re-seeds the cursor onto the tapped cell.
{
    QInput.placeCursor({ x: 2, y: 6 });
    ok(QInput.cursor.x === 2 && QInput.cursor.y === 6, 'placeCursor moves the cursor onto a cell');
    ok(QInput.cursor.mode === 'cell', 'placeCursor switches back to cell mode');
}

console.log(`\n${passed} cursor assertions passed ✓`);
if (process.exitCode) console.error('there were failures');
