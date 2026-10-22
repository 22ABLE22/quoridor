import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const js = name => readFileSync(join(ROOT, 'js', name), 'utf8');

// ---- load the DOM-free modules (rules.js / ai.js are pure logic) ----
const ctx = vm.createContext({ console, module: { exports: {} } });
vm.runInContext(js('rules.js'), ctx, { filename: 'rules.js' });
vm.runInContext(js('ai.js'), ctx, { filename: 'ai.js' });
const QRules = vm.runInContext('QRules', ctx);
const QAI = vm.runInContext('QAI', ctx);

let passed = 0;
function ok(cond, msg) {
    if (cond) { passed++; }
    else { console.error('FAIL: ' + msg); process.exitCode = 1; }
}

// ================= basic setup =================
{
    const g = QRules.createGame(2, [
        { name: 'Red', type: 'human' },
        { name: 'Blue', type: 'ai' }
    ]);
    ok(g.players.length === 2, '2-player game: player count');
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 8, 'Red starts at (4,8)');
    ok(g.players[1].pos.x === 4 && g.players[1].pos.y === 0, 'Blue starts at (4,0)');
    ok(g.players[0].walls === 10 && g.players[1].walls === 10, '2-player game: 10 walls each');
    ok(QRules.distanceToGoal(g, 0) === 8, 'Red initial distance 8');
    ok(QRules.distanceToGoal(g, 1) === 8, 'Blue initial distance 8');
}

{
    const g = QRules.createGame(4, [
        { name: 'Red', type: 'human' },
        { name: 'Blue', type: 'ai' },
        { name: 'Green', type: 'ai' },
        { name: 'Gold', type: 'off' }   // dropped
    ]);
    ok(g.players.length === 3, '4-player game with one off seat → 3 players');
    ok(g.players[2].seatKey === 'E' && g.players[2].pos.x === 0 && g.players[2].pos.y === 4, 'Green starts at (0,4)');
    ok(g.players.every(p => p.walls === 5), '4-player game: 5 walls each');
    ok(g.players.every(p => p.aiLevel === undefined), 'no aiLevel field (single AI)');
}

// fewer than 2 active players must throw
{
    let threw = false;
    try {
        QRules.createGame(2, [
            { name: 'Red', type: 'human' },
            { name: 'Blue', type: 'off' }
        ]);
    } catch (e) { threw = true; }
    ok(threw, 'fewer than 2 active players throws');
}

// ================= moves =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    const moves = QRules.legalMoves(g, 0);
    ok(moves.length === 3, 'start (4,8) on bottom edge: 3 targets');
    ok(moves.some(m => m.x === 4 && m.y === 7 && !m.jump), 'can move up');
    ok(!moves.some(m => m.x === 4 && m.y === 9), 'cannot leave the board');
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    ok(g.turn === 1, 'turn passes after a move');
    let threw = false;
    try { QRules.applyMove(g, 1, { x: 4, y: 7 }); } catch (e) { threw = true; }
    ok(threw, 'two-square move is illegal');
}

// ================= walls: conflicts and reachability =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    ok(QRules.canPlaceWall(g, 0, 0, 0, true), 'h-wall (0,0) is placeable');
    QRules.applyWall(g, 0, 0, 0, true);
    ok(g.players[0].walls === 9, 'wall stock decrements');
    ok(!QRules.canPlaceWall(g, 1, 0, 0, true), 'same slot twice is illegal');
    ok(!QRules.canPlaceWall(g, 1, 1, 0, true), 'adjacent parallel overlap is illegal (h1,0 vs h0,0)');
    ok(!QRules.canPlaceWall(g, 1, 0, 0, false), 'cross at the same anchor is illegal (v0,0 vs h0,0)');
    ok(QRules.canPlaceWall(g, 1, 2, 0, true), 'gap-parallel is fine (h2,0)');
    ok(QRules.canPlaceWall(g, 1, 0, 1, false), 'offset vertical is fine (v0,1)');
    ok(QRules.wallConflicts(g, 0, 0, true) === true, 'wallConflicts: same slot');
    ok(QRules.wallConflicts(g, 2, 0, true) === false, 'wallConflicts: h2,0 vs h0,0');
}

// walls block moves
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 4, 7, true);   // h(4,7): row groove 7, columns 4-5
    ok(QRules.wallBetween(g, { x: 4, y: 8 }, { x: 4, y: 7 }), 'h(4,7) blocks (4,8)→(4,7)');
    ok(!QRules.wallBetween(g, { x: 3, y: 8 }, { x: 3, y: 7 }), 'h(4,7) does not affect column 3');
    ok(QRules.wallBetween(g, { x: 5, y: 8 }, { x: 5, y: 7 }), 'h(4,7) blocks column 5');
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 7), 'cannot move up through the wall');
    ok(moves.some(m => m.x === 3 && m.y === 8) && moves.some(m => m.x === 5 && m.y === 8), 'can still move sideways');
}

// v-wall geometry
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 3, 3, false);  // v(3,3): column groove 3, rows 3-4
    ok(QRules.wallBetween(g, { x: 3, y: 3 }, { x: 4, y: 3 }), 'v(3,3) blocks (3,3)→(4,3)');
    ok(QRules.wallBetween(g, { x: 3, y: 4 }, { x: 4, y: 4 }), 'v(3,3) blocks (3,4)→(4,4)');
    ok(!QRules.wallBetween(g, { x: 3, y: 2 }, { x: 4, y: 2 }), 'v(3,3) does not block row 2');
    ok(!QRules.wallBetween(g, { x: 3, y: 5 }, { x: 4, y: 5 }), 'v(3,3) does not block row 5');
}

// ================= reachability: sealing detection =================
{
    // Pen Red (4,8) into the two-cell pocket {(3,8),(4,8)}:
    //   top h(3,7), left v(2,7), right v(4,7). The last one must be rejected.
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 3, 7, true);
    QRules.applyWall(g, 1, 2, 7, false);
    ok(QRules.wallConflicts(g, 4, 7, false) === false, 'v(4,7) has no geometric conflict (T-touch is legal)');
    ok(QRules.canPlaceWall(g, 0, 4, 7, false) === false, 'the sealing wall is illegal (self-seal included)');
    ok(QRules.canPlaceWall(g, 1, 4, 7, false) === false, 'the sealing wall is illegal (opponent)');
    ok(QRules.canPlaceWall(g, 1, 0, 0, true), 'other positions remain legal');
    ok(QRules.allReachable(g), 'everyone reachable in the current position');
}

// ================= jumps =================
// straight jump
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 4, y: 4 };
    g.players[1].pos = { x: 4, y: 3 };
    g.turn = 0;
    const moves = QRules.legalMoves(g, 0);
    ok(moves.some(m => m.x === 4 && m.y === 2 && m.jump === 'straight'), 'face-to-face allows a straight jump');
    ok(!moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), 'no diagonal jump when straight is open');
    ok(moves.some(m => m.x === 3 && m.y === 4 && !m.jump), 'normal left move still allowed');
    ok(moves.some(m => m.x === 5 && m.y === 4 && !m.jump), 'normal right move still allowed');
    QRules.applyMove(g, 0, { x: 4, y: 2 });
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 2, 'jump destination correct');
    ok(g.turn === 1, 'turn passes after a jump');
}

// diagonal jump: straight blocked by a wall
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 4, y: 4 };
    g.players[1].pos = { x: 4, y: 3 };
    g.turn = 0;
    g.hw[2][4] = 1;   // h(4,2) blocks (4,3)→(4,2)
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 2), 'straight jump blocked by wall');
    ok(moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), 'diagonal jump to (3,3)');
    ok(moves.some(m => m.x === 5 && m.y === 3 && m.jump === 'diag'), 'diagonal jump to (5,3)');
}

// diagonal jump: straight landing square occupied by a third pawn (4-player)
{
    const g = QRules.createGame(4, [
        { type: 'human' }, { type: 'human' }, { type: 'human' }, { type: 'human' }
    ]);
    g.players[0].pos = { x: 4, y: 4 };
    g.players[1].pos = { x: 4, y: 3 };
    g.players[2].pos = { x: 4, y: 2 };
    g.turn = 0;
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 2), 'no straight jump through two pawns');
    ok(moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), 'diagonal jump around');
    ok(moves.some(m => m.x === 5 && m.y === 3 && m.jump === 'diag'), 'diagonal jump around (right)');
}

// ================= winning =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 2, y: 1 };
    g.turn = 0;
    QRules.applyMove(g, 0, { x: 2, y: 0 });
    ok(g.winner === 0, 'Red wins on reaching the north edge');
    const before = g.history.length;
    let threw = false;
    try { QRules.applyMove(g, 1, { x: 4, y: 1 }); } catch (e) { threw = true; }
    ok(threw, 'no actions after the game is over');
    ok(g.history.length === before, 'rejected action not recorded');
}

// ================= undo =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 0, 0, true);
    QRules.applyMove(g, 1, { x: 4, y: 1 });
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    const histLen = g.history.length;
    ok(QRules.undoLast(g) === true, 'undo succeeds');
    ok(g.history.length === histLen - 1, 'history shrinks');
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 8, 'Red back at start');
    ok(g.turn === 0, 'turn returns to Red');
    QRules.undoLast(g);
    ok(g.players[1].pos.y === 0 && g.players[1].walls === 10, 'undo Blue move');
    QRules.undoLast(g);
    ok(g.players[0].walls === 10 && g.hw[0][0] === 0, 'undo Red wall');
    ok(QRules.undoLast(g) === false, 'nothing left to undo');
}

// undo restores winner
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 2, y: 1 };
    g.turn = 0;
    QRules.applyMove(g, 0, { x: 2, y: 0 });
    ok(g.winner === 0, 'win first');
    QRules.undoLast(g);
    ok(g.winner === null, 'winner cleared after undo');
    ok(g.turn === 0, 'turn restored');
}

// ================= notation =================
{
    ok(QRules.cellName(0, 0) === 'A1', 'cellName A1');
    ok(QRules.cellName(8, 8) === 'I9', 'cellName I9');
    ok(/^wall [A-I][1-9][hv]$/.test(QRules.moveDesc({ type: 'wall', pi: 0, x: 3, y: 5, isH: true })), 'wall notation is ASCII');
}

// ================= AI vs AI: 2-player (time-budgeted search) =================
{
    const g = QRules.createGame(2, [{ type: 'ai' }, { type: 'ai' }]);
    let steps = 0;
    let invariantOk = true;
    const t0 = Date.now();
    let maxStepMs = 0;
    while (g.winner === null && steps < 300) {
        const pi = g.turn;
        const s0 = Date.now();
        const act = QAI.decide(g, pi, 600);   // small budget for the test suite
        maxStepMs = Math.max(maxStepMs, Date.now() - s0);
        if (!act) break;
        if (act.type === 'move') QRules.applyMove(g, pi, act.target);
        else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
        steps++;
        if (!QRules.allReachable(g)) { invariantOk = false; break; }
    }
    ok(invariantOk, 'AI keeps everyone reachable');
    ok(g.winner !== null, 'AI vs AI game finishes (no deadlock)');
    ok(maxStepMs < 3000, 'AI respects the time budget (max step ' + maxStepMs + 'ms)');
    const wallsPlaced = g.history.filter(r => r.type === 'wall').length;
    ok(wallsPlaced <= 20, 'wall budget respected');
    // both orientations must appear across a full AI game (regression for the
    // "only horizontal walls" geometry bug)
    const hasH = g.history.some(r => r.type === 'wall' && r.isH);
    const hasV = g.history.some(r => r.type === 'wall' && !r.isH);
    ok(hasH && hasV, 'AI places both horizontal and vertical walls');
}

// ================= AI: state must be untouched by the search =================
{
    const g = QRules.createGame(2, [{ type: 'ai' }, { type: 'ai' }]);
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    QRules.applyMove(g, 1, { x: 4, y: 1 });
    QRules.applyWall(g, 0, 4, 6, true);
    QRules.applyWall(g, 1, 4, 2, true);
    const before = JSON.stringify({
        pos: g.players.map(p => p.pos),
        walls: g.players.map(p => p.walls),
        hw: g.hw, vw: g.vw, turn: g.turn, winner: g.winner
    });
    QAI.decide(g, 1, 300);
    const after = JSON.stringify({
        pos: g.players.map(p => p.pos),
        walls: g.players.map(p => p.walls),
        hw: g.hw, vw: g.vw, turn: g.turn, winner: g.winner
    });
    ok(before === after, 'decide() must not mutate the game state');
}

// ================= AI vs AI: 4-player =================
{
    const g = QRules.createGame(4, [
        { type: 'ai' }, { type: 'ai' }, { type: 'ai' }, { type: 'ai' }
    ]);
    let steps = 0;
    while (g.winner === null && steps < 600) {
        const pi = g.turn;
        const act = QAI.decide(g, pi, 250);
        if (!act) break;
        if (act.type === 'move') QRules.applyMove(g, pi, act.target);
        else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
        steps++;
    }
    ok(g.winner !== null, '4-player AI game finishes (no deadlock)');
    ok(g.history.length < 600, 'reasonable move count');
}

// ================= win-rate simulation =================
{
    const g = QRules.createGame(2, [{ type: 'ai' }, { type: 'ai' }]);
    // symmetrical start: both far from goal, second player benefits from the
    // jump rule, so rates must be roughly balanced (not 0/100)
    const r0 = QAI.simulateWinRate(g, 0, 120);
    const r1 = QAI.simulateWinRate(g, 1, 120);
    ok(r0 >= 0 && r0 <= 1 && r1 >= 0 && r1 <= 1, 'win rates are probabilities');
    ok(r0 > 0.15 && r0 < 0.85, 'symmetric start is not a landslide (' + r0.toFixed(2) + ')');
    // one step from victory → near-1
    g.players[0].pos = { x: 4, y: 1 };
    g.turn = 0;
    const rWin = QAI.simulateWinRate(g, 0, 120);
    ok(rWin > 0.9, 'one step from goal ≈ certain win (' + rWin.toFixed(2) + ')');
    // decided game
    g.players[0].pos = { x: 4, y: 0 };
    g.winner = 0;
    ok(QAI.simulateWinRate(g, 0, 10) === 1, 'winner has win rate 1');
    ok(QAI.simulateWinRate(g, 1, 10) === 0, 'loser has win rate 0');
}

// ================= legalWalls completeness =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    const walls = QRules.legalWalls(g, 0);
    ok(walls.length === 128, 'empty board: 128 legal walls (64 h + 64 v)');
    ok(walls.some(w => w.isH) && walls.some(w => !w.isH), 'both orientations present');
}

console.log(`\n${passed} assertions passed ✓`);
if (process.exitCode) console.error('there were failures');
