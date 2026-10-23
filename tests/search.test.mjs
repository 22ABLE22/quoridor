// Fixed-depth search correctness, not a timing/playing-style benchmark.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const rules = fs.readFileSync(new URL('../js/rules.js', import.meta.url), 'utf8');
let source = fs.readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8');
// Expose internals only inside this isolated test VM; production API is unchanged.
source = source.replace('decide, simulateWinRate, simulateWinRates, evalLeaf, clone', `
    decide, simulateWinRate, simulateWinRates, evalLeaf, clone,
    pack: encodeMove, unpack: decodeMove,
    fixed(st, depth, optimized, cached) {
        if (!zob) initZobrist();
        if (!killers) initOrderingMemory();
        resetOrderingMemory(); ttNewSearch();
        deadline = Infinity; searchAborted = false; nodeCount = 0;
        usePVS = optimized; useTT = cached;
        const before = JSON.stringify(st);
        const value = optimized ? pvs(st, st.turn, depth, -32000, 32000, 0)
                                : search(st, st.turn, depth, -32000, 32000, 0);
        if (before !== JSON.stringify(st)) throw Error('search mutated position');
        return value;
    }`);
const context = vm.createContext({ console, Math, Date, module: { exports: {} } });
vm.runInContext(rules, context);
vm.runInContext(source, context);
const R = vm.runInContext('QRules', context);
const A = vm.runInContext('QAI', context);
let checks = 0;
// Every edge/corner coordinate must survive TT move packing.
for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const move = A.unpack(A.pack({ kind: 'move', target: { x, y } }));
    assert.equal(move.target.x, x); assert.equal(move.target.y, y); checks++;
}
for (const mode of [2, 4]) {
    const g = R.createGame(mode, Array.from({ length: mode }, () => ({ type: 'ai' })));
    // Include both MAX/MIN root turns and nonempty wall layouts.
    for (let position = 0; position < 4; position++) {
        const exact = A.fixed(g, 3, false, false);
        assert.equal(A.fixed(g, 3, true, false), exact, `PVS/reference mode=${mode} position=${position}`);
        assert.equal(A.fixed(g, 3, true, true), exact, `PVS+TT/reference mode=${mode} position=${position}`);
        assert.equal(A.fixed(g, 3, false, true), exact, `AB+TT/reference mode=${mode} position=${position}`);
        checks += 3;
        const moves = R.legalMoves(g, g.turn);
        if (position % 2 === 0) R.applyMove(g, g.turn, moves[0]);
        else {
            const walls = R.legalWalls(g, g.turn);
            const wall = walls[Math.floor(walls.length / 2)];
            R.applyWall(g, g.turn, wall.x, wall.y, wall.isH);
        }
    }
}
console.log(`${checks} fixed-depth/TT checks passed`);
