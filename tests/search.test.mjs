// Transposition-table move packing regression.
//
// The board is 9x9, so pawn coordinates run 0..8. Packing once reserved three
// bits per coordinate (0..7), which silently decoded moves to row or column 8 as
// a different cell — the engine then lost its own best move from the table and
// searched it later, or worse, in the wrong place. These checks pin the encoding.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const rules = fs.readFileSync(new URL('../js/rules.js', import.meta.url), 'utf8');
let source = fs.readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8');

// Expose the private packers to the test only; the shipped API is unchanged.
source = source.replace(
    'decide, simulateWinRate, simulateWinRates, evalLeaf, clone',
    'decide, simulateWinRate, simulateWinRates, evalLeaf, clone, __pack: encodeMove, __unpack: decodeMove'
);

const context = vm.createContext({ console, Math, Date, module: { exports: {} } });
vm.runInContext(rules, context, { filename: 'rules.js' });
vm.runInContext(source, context, { filename: 'ai.js' });
const QRules = vm.runInContext('QRules', context);
const QAI = vm.runInContext('QAI', context);

let checks = 0;

// 1. Every pawn destination on the board survives a pack/unpack round trip.
for (let y = 0; y < QRules.N; y++) {
    for (let x = 0; x < QRules.N; x++) {
        const back = QAI.__unpack(QAI.__pack({ kind: 'move', target: { x, y } }));
        assert.ok(back && back.kind === 'move', `pawn (${x},${y}) must decode as a move`);
        assert.equal(back.target.x, x, `pawn column ${x} must survive packing`);
        assert.equal(back.target.y, y, `pawn row ${y} must survive packing`);
        checks++;
    }
}

// 2. Wall anchors (0..7 on both axes) survive, in both orientations.
for (let y = 0; y < QRules.ANCH; y++) {
    for (let x = 0; x < QRules.ANCH; x++) {
        for (const isH of [true, false]) {
            const back = QAI.__unpack(QAI.__pack({ kind: 'wall', wall: { x, y, isH } }));
            assert.ok(back && back.kind === 'wall', `wall (${x},${y}) must decode as a wall`);
            assert.equal(back.wall.x, x);
            assert.equal(back.wall.y, y);
            assert.equal(back.wall.isH, isH);
            checks++;
        }
    }
}

// 3. Distinct moves must not collide onto the same code.
const seen = new Map();
for (let y = 0; y < QRules.N; y++) {
    for (let x = 0; x < QRules.N; x++) {
        const code = QAI.__pack({ kind: 'move', target: { x, y } });
        const key = `m${code}`;
        assert.ok(!seen.has(key), `pawn code collision at (${x},${y}) with ${seen.get(key)}`);
        seen.set(key, `(${x},${y})`);
        checks++;
    }
}
for (let y = 0; y < QRules.ANCH; y++) {
    for (let x = 0; x < QRules.ANCH; x++) {
        for (const isH of [true, false]) {
            const code = QAI.__pack({ kind: 'wall', wall: { x, y, isH } });
            const key = `w${code}`;
            assert.ok(!seen.has(key), `wall code collision at (${x},${y},${isH}) with ${seen.get(key)}`);
            seen.set(key, `wall(${x},${y},${isH})`);
            checks++;
        }
    }
}

// 4. The engine still plays a legal move and leaves the caller's game untouched.
{
    const g = QRules.createGame(2, [{ type: 'ai' }, { type: 'ai' }]);
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    const before = JSON.stringify({ p: g.players.map(p => p.pos), w: g.players.map(p => p.walls), h: g.hw, v: g.vw, t: g.turn, win: g.winner });
    const act = QAI.decide(g, 1, 150);
    const after = JSON.stringify({ p: g.players.map(p => p.pos), w: g.players.map(p => p.walls), h: g.hw, v: g.vw, t: g.turn, win: g.winner });
    assert.equal(before, after, 'decide() must not mutate the caller state');
    assert.ok(act && (act.type === 'move' || act.type === 'wall'), 'decide() returns an action');
    checks++;
}

console.log(`${checks} move-packing checks passed`);
