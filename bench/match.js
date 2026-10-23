// Head-to-head match runner for two engine builds.
//
// Loads each engine into its own Node `vm` context (they are classic scripts that
// expect globals), then plays them against each other from a set of positions,
// alternating colours, and reports the score.
//
// Usage:
//   node bench/match.js --a js/ai.js --b path/to/old-ai.js --games 24 --budget 400
//
// Both engines must share the same rules engine, so js/rules.js is loaded into
// both contexts. The engine under test is "A"; it plays seat 0 in even games and
// seat 1 in odd games, so a first-move advantage shows up as a draw rather than as
// a win for one side.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.dirname(path.dirname(__filename));

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}

function loadEngine(rulesSrc, engineSrc, label) {
    const ctx = vm.createContext({ console, Math, Date, module: { exports: {} } });
    vm.runInContext(rulesSrc, ctx, { filename: label + ':rules.js' });
    vm.runInContext(engineSrc, ctx, { filename: label + ':ai.js' });
    return {
        QAI: vm.runInContext('QAI', ctx),
        QRules: vm.runInContext('QRules', ctx)
    };
}

/** A handful of openings that avoid the same game being played 24 times. */
const OPENINGS = [
    [],                                                       // empty board
    [{ m: 'move', pi: 0, x: 4, y: 7 }],
    [{ m: 'move', pi: 0, x: 4, y: 7 }, { m: 'move', pi: 1, x: 4, y: 1 }],
    [{ m: 'move', pi: 0, x: 4, y: 7 }, { m: 'move', pi: 1, x: 4, y: 1 },
     { m: 'wall', pi: 0, x: 4, y: 6, isH: true }],
    [{ m: 'move', pi: 0, x: 3, y: 8 }, { m: 'move', pi: 1, x: 5, y: 0 }],
    [{ m: 'move', pi: 0, x: 4, y: 7 }, { m: 'move', pi: 1, x: 4, y: 1 },
     { m: 'move', pi: 0, x: 4, y: 6 }, { m: 'move', pi: 1, x: 4, y: 2 }],
    [{ m: 'move', pi: 0, x: 5, y: 8 }, { m: 'move', pi: 1, x: 3, y: 0 },
     { m: 'wall', pi: 0, x: 4, y: 7, isH: true }],
    [{ m: 'move', pi: 0, x: 4, y: 7 }, { m: 'move', pi: 1, x: 4, y: 1 },
     { m: 'move', pi: 0, x: 3, y: 7 }, { m: 'move', pi: 1, x: 5, y: 1 }],
    [{ m: 'move', pi: 0, x: 4, y: 7 }, { m: 'move', pi: 1, x: 4, y: 1 },
     { m: 'wall', pi: 0, x: 3, y: 6, isH: true },
     { m: 'wall', pi: 1, x: 4, y: 2, isH: true }]
];
function applyOpening(QRules, st, opening) {
    for (const o of opening) {
        // Openings are written from Red's point of view; when the boards are
        // mirrored for the second seat we simply replay them as-is, because the
        // game is symmetric under a 180° rotation only for the empty opening.
        // Keep it simple: every opening below is legal from the start position.
        if (o.m === 'move') QRules.applyMove(st, o.pi, { x: o.x, y: o.y });
        else QRules.applyWall(st, o.pi, o.x, o.y, o.isH);
    }
}

/**
 * Play one game. `engines[seat]` decides for that seat.
 * Returns the winner seat (or null for an unfinished game).
 */
function playGame(rulesSrc, engines, opening, budgetMs, maxPlies) {
    const QRules = engines[0].QRules;      // both contexts share identical rules
    const st = QRules.createGame(2, [{ type: 'ai' }, { type: 'ai' }]);
    applyOpening(QRules, st, opening);
    let plies = 0;
    while (st.winner === null && plies < maxPlies) {
        const pi = st.turn;
        const engine = engines[pi];
        const act = engine.QAI.decide(st, pi, budgetMs);
        if (!act) break;
        if (act.type === 'move') QRules.applyMove(st, pi, act.target);
        else QRules.applyWall(st, pi, act.wall.x, act.wall.y, act.wall.isH);
        plies++;
    }
    return { winner: st.winner, plies, walls: st.history.filter(r => r.type === 'wall').length };
}

(function main() {
    const aPath = arg('a', path.join(ROOT, 'js', 'ai.js'));
    const bPath = arg('b', null);
    const games = Number(arg('games', 24));
    const budget = Number(arg('budget', 400));
    const maxPlies = Number(arg('plies', 400));
    const quiet = !!arg('quiet', false);

    if (!bPath) {
        console.error('usage: node bench/match.js --a <engine> --b <engine> [--games N] [--budget MS]');
        process.exit(2);
    }

    const rulesSrc = fs.readFileSync(path.join(ROOT, 'js', 'rules.js'), 'utf8');
    const A = loadEngine(rulesSrc, fs.readFileSync(aPath, 'utf8'), 'A');
    const B = loadEngine(rulesSrc, fs.readFileSync(bPath, 'utf8'), 'B');

    let aWins = 0, bWins = 0, draws = 0;
    const t0 = Date.now();
    const rows = [];

    for (let g = 0; g < games; g++) {
        // Alternate seats; cycle openings.
        const aSeat = g % 2;
        const opening = OPENINGS[Math.floor(g / 2) % OPENINGS.length];
        const engines = aSeat === 0 ? [A, B] : [B, A];
        const r = playGame(rulesSrc, engines, opening, budget, maxPlies);
        if (r.winner === null) draws++;
        else if (r.winner === aSeat) aWins++;
        else bWins++;

        const verdict = r.winner === null ? 'unfinished'
            : (r.winner === aSeat ? 'A' : 'B');
        rows.push(`  game ${String(g + 1).padStart(2)}  A=seat${aSeat}  opening#${Math.floor(g / 2) % OPENINGS.length}  ` +
            `plies=${String(r.plies).padStart(3)}  walls=${String(r.walls).padStart(2)}  -> ${verdict}`);
        if (!quiet) console.log(rows[rows.length - 1]);
    }

    const decided = aWins + bWins;
    const pct = decided ? (100 * aWins / decided) : 0;
    // Standard error of a binomial proportion, for "is this real?" sanity.
    const se = decided ? Math.sqrt(pct * (100 - pct) / decided) : 0;
    console.log('');
    console.log(`A: ${aPath}`);
    console.log(`B: ${bPath}`);
    console.log(`budget ${budget} ms/move, ${games} games in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(`A wins ${aWins}  B wins ${bWins}  unfinished ${draws}`);
    console.log(`A score ${pct.toFixed(1)}% of decided games  (+/- ${(1.96 * se).toFixed(1)} at 95%)`);
    console.log(pct > 50 + 1.96 * se ? 'VERDICT: A stronger'
        : pct < 50 - 1.96 * se ? 'VERDICT: B stronger'
        : 'VERDICT: no significant difference');
})();
