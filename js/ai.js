'use strict';
/* =========================================================================
 * QAI — Quoridor computer player and win-probability estimator
 * Depends on: global QRules (js/rules.js loaded first).
 *
 * Search engine (single AI):
 *   - Iterative-deepening alpha-beta with a hard time budget (soft limit is
 *     caller-provided; the engine checks the clock in the search loop and
 *     between iterations, returning the best move from the last completed
 *     depth, so it always answers in time).
 *   - Zobrist hashing + transposition table (2M-entry typed arrays) with
 *     depth-preferred replacement, shared across iterations and cleared
 *     per decision to bound memory.
 *   - Candidate generation with "relevant wall" pruning (near pawns,
 *     adjacent to existing walls, on shortest-path corridors), move
 *     ordering: TT move first, then by static gain.
 *   - 2 players: strict alpha-beta; 3+: paranoid approximation.
 *
 * Win probability (for the UI):
 *   - simulateWinRate(st, pi): Monte-Carlo rollout estimation. Each rollout
 *     plays a fast greedy policy (racing + reactive walls) to the end and
 *     records the winner; the win rate is the fraction of rollouts won by
 *     player pi. ~120 rollouts give a stable enough bar for humans.
 * ========================================================================= */
var QAI = (function () {

    const WIN = 100000;
    const MAX_CAND_2P = 26;     // candidate cap per node, 2-player
    const MAX_CAND_NP = 18;     // candidate cap per node, 3+ players
    const MAX_DEPTH_2P = 9;     // iterative-deepening ceiling, 2-player
    const MAX_DEPTH_NP = 5;     // ceiling, 3+ players

    /* ---------------- clock ---------------- */
    let deadline = Infinity;

    function timeUp() { return Date.now() >= deadline; }

    /* ---------------- utilities ---------------- */

    function clone(st) {
        return {
            mode: st.mode,
            players: st.players.map(p => ({
                id: p.id, seatKey: p.seatKey, name: p.name, color: p.color, goal: p.goal,
                type: p.type, wallQuota: p.wallQuota, walls: p.walls,
                pos: { x: p.pos.x, y: p.pos.y }
            })),
            hw: st.hw.map(r => r.slice()),
            vw: st.vw.map(r => r.slice()),
            turn: st.turn, moveNo: st.moveNo,
            history: [],
            winner: st.winner
        };
    }

    /* ---------------- Zobrist / transposition table ---------------- */
    const TT_SIZE = 1 << 21;           // 2M slots
    const TT_MASK = TT_SIZE - 1;
    // 8x8 h anchors + 8x8 v anchors + per-player pos (4 players * 81 cells)
    let zob = null;
    let ttKey = null, ttDepth = null, ttScore = null, ttFlag = null, ttMove = null;

    function initZobrist() {
        // Deterministic PRNG so Worker and main-thread runs agree.
        let seed = 0x2F6E2B1;
        const rand = () => {
            seed ^= seed << 13; seed >>>= 0;
            seed ^= seed >> 17;
            seed ^= seed << 5; seed >>>= 0;
            return seed;
        };
        const N = QRules.N, ANCH = QRules.ANCH;
        zob = {
            h: Array.from({ length: ANCH }, () => Array.from({ length: ANCH }, () => rand() >>> 0)),
            v: Array.from({ length: ANCH }, () => Array.from({ length: ANCH }, () => rand() >>> 0)),
            pos: Array.from({ length: 4 }, () => new Array(N * N).fill(0).map(() => rand() >>> 0))
        };
        ttKey = new Uint32Array(TT_SIZE);
        ttDepth = new Int8Array(TT_SIZE);
        ttScore = new Int16Array(TT_SIZE);
        ttFlag = new Int8Array(TT_SIZE);   // 0 empty, 1 exact, 2 lower, 3 upper
        ttMove = new Array(TT_SIZE).fill(null);
    }

    function hashState(st) {
        let h = 0 >>> 0;
        for (let y = 0; y < QRules.ANCH; y++) {
            for (let x = 0; x < QRules.ANCH; x++) {
                if (st.hw[y][x]) h = (h ^ zob.h[y][x]) >>> 0;
                if (st.vw[y][x]) h = (h ^ zob.v[y][x]) >>> 0;
            }
        }
        for (const p of st.players) {
            h = (h ^ zob.pos[p.id][p.pos.y * QRules.N + p.pos.x]) >>> 0;
        }
        // side-to-move matters (wall counts are folded in cheaply via turn)
        h = (h ^ (0x9E3779B9 * (st.turn + 1))) >>> 0;
        return h >>> 0;
    }

    function ttProbe(hash, depth, alpha, beta) {
        const idx = hash & TT_MASK;
        if (ttKey[idx] !== hash) return null;
        if (ttDepth[idx] < depth) return null;
        const score = ttScore[idx];
        const flag = ttFlag[idx];
        if (flag === 1) return { score, move: ttMove[idx] };
        if (flag === 2 && score > alpha) return { score, move: ttMove[idx] };       // lower bound
        if (flag === 3 && score < beta) return { score, move: ttMove[idx] };        // upper bound
        return null;
    }

    function ttStore(hash, depth, score, flag, move) {
        const idx = hash & TT_MASK;
        // depth-preferred replacement
        if (ttKey[idx] === hash && ttDepth[idx] > depth && ttFlag[idx] !== 0) return;
        ttKey[idx] = hash;
        ttDepth[idx] = depth;
        ttScore[idx] = clamp16(score);
        ttFlag[idx] = flag;
        ttMove[idx] = move || null;
    }

    function clamp16(v) {
        if (v > 32700) return 32700;
        if (v < -32700) return -32700;
        return Math.round(v);
    }

    function ttClear() {
        if (ttKey) { ttKey.fill(0); ttDepth.fill(0); ttScore.fill(0); ttFlag.fill(0); ttMove.fill(null); }
    }

    /* ---------------- candidate generation ---------------- */

    function candidates(st, mover, ttMove) {
        const list = [];
        const moves = QRules.legalMoves(st, mover);
        const baseD = QRules.distanceToGoal(st, mover);
        for (const m of moves) {
            const tmp = clone(st);
            tmp.players[mover].pos = { x: m.x, y: m.y };
            const d = QRules.distanceToGoal(tmp, mover);
            list.push({ kind: 'move', target: m, gain: (baseD - d) * 2 + (QRules.atGoal(st.players[mover], m) ? 100 : 0) });
        }
        if (st.players[mover].walls > 0) {
            const walls = probableWalls(st);
            const base = st.players.map((_, i) => QRules.distanceToGoal(st, i));
            for (const w of walls) {
                if (QRules.wallConflicts(st, w.x, w.y, w.isH)) continue;
                if (timeUp()) { searchAborted = true; break; }   // clock check in the wall scan
                const tmp = clone(st);
                if (w.isH) tmp.hw[w.y][w.x] = 1; else tmp.vw[w.y][w.x] = 1;
                if (!QRules.allReachable(tmp)) continue;
                let gain = 0;
                for (let i = 0; i < st.players.length; i++) {
                    const delta = QRules.distanceToGoal(tmp, i) - base[i];
                    gain += (i === mover) ? -1.5 * delta : 2 * delta;
                }
                list.push({ kind: 'wall', wall: w, gain });
            }
        }
        list.sort((a, b) => b.gain - a.gain);
        const cap = st.players.length === 2 ? MAX_CAND_2P : MAX_CAND_NP;
        let out = list.slice(0, cap);
        if (ttMove) {
            // TT move to the front (dedup)
            out = out.filter(c => !(c.kind === ttMove.kind &&
                (c.kind === 'move'
                    ? (c.target.x === ttMove.target.x && c.target.y === ttMove.target.y)
                    : (c.wall.x === ttMove.wall.x && c.wall.y === ttMove.wall.y && c.wall.isH === ttMove.wall.isH))));
            out.unshift(ttMove);
        }
        return out;
    }

    /**
     * Relevant wall anchors (unfiltered legality):
     *  - within Chebyshev distance 2 of any pawn
     *  - adjacent (incl. diagonal) to an existing wall
     *  - blocking any player's shortest path
     */
    function probableWalls(st) {
        const set = new Set();
        const add = (x, y, isH) => {
            if (x < 0 || y < 0 || x >= QRules.ANCH || y >= QRules.ANCH) return;
            set.add(x + ',' + y + ',' + (isH ? 'h' : 'v'));
        };
        for (const p of st.players) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    add(p.pos.x + dx, p.pos.y + dy, true);
                    add(p.pos.x + dx, p.pos.y + dy, false);
                }
            }
        }
        for (let y = 0; y < QRules.ANCH; y++) {
            for (let x = 0; x < QRules.ANCH; x++) {
                if (st.hw[y][x] || st.vw[y][x]) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            add(x + dx, y + dy, true);
                            add(x + dx, y + dy, false);
                        }
                    }
                }
            }
        }
        for (let pi = 0; pi < st.players.length; pi++) {
            for (const w of pathBlockingWalls(st, pi)) add(w.x, w.y, w.isH);
        }
        const out = [];
        for (const key of set) {
            const [x, y, o] = key.split(',');
            out.push({ x: +x, y: +y, isH: o === 'h' });
        }
        return out;
    }

    /** All wall placements that block one shortest path of player pi. */
    function pathBlockingWalls(st, pi) {
        const p = st.players[pi];
        if (QRules.atGoal(p, p.pos)) return [];
        const prev = Array.from({ length: QRules.N }, () => new Array(QRules.N).fill(null));
        const dist = Array.from({ length: QRules.N }, () => new Array(QRules.N).fill(-1));
        const queue = [[p.pos.x, p.pos.y]];
        dist[p.pos.y][p.pos.x] = 0;
        let head = 0;
        let goalCell = null;
        while (head < queue.length && !goalCell) {
            const [cx, cy] = queue[head++];
            for (const dir of QRules.DIRS) {
                const nx = cx + dir.dx, ny = cy + dir.dy;
                if (!QRules.inBoard(nx, ny)) continue;
                if (dist[ny][nx] !== -1) continue;
                if (QRules.wallBetween(st, { x: cx, y: cy }, { x: nx, y: ny })) continue;
                dist[ny][nx] = dist[cy][cx] + 1;
                prev[ny][nx] = { x: cx, y: cy };
                if (QRules.atGoal(p, { x: nx, y: ny })) { goalCell = { x: nx, y: ny }; break; }
                queue.push([nx, ny]);
            }
        }
        const out = [];
        if (!goalCell) return out;
        let cur = goalCell;
        while (prev[cur.y][cur.x]) {
            const from = prev[cur.y][cur.x];
            out.push(...edgeBlockingWalls(from, cur));
            cur = from;
        }
        return out;
    }

    /** All wall placements that block the edge (from→to). */
    function edgeBlockingWalls(from, to) {
        const dx = to.x - from.x, dy = to.y - from.y;
        if (dy === -1) {
            return [
                { x: from.x, y: from.y - 1, isH: true },
                { x: from.x - 1, y: from.y - 1, isH: true }
            ];
        }
        if (dy === 1) {
            return [
                { x: from.x, y: from.y, isH: true },
                { x: from.x - 1, y: from.y, isH: true }
            ];
        }
        if (dx === -1) {
            return [
                { x: from.x - 1, y: from.y, isH: false },
                { x: from.x - 1, y: from.y - 1, isH: false }
            ];
        }
        return [
            { x: from.x, y: from.y, isH: false },
            { x: from.x, y: from.y - 1, isH: false }
        ];
    }

    /* ---------------- evaluation ---------------- */

    /** Leaf evaluation (larger is better for rootPi). */
    function evalLeaf(st, rootPi) {
        if (st.winner !== null) {
            return st.winner === rootPi ? WIN - st.history.length : -WIN + st.history.length;
        }
        const myD = QRules.distanceToGoal(st, rootPi);
        if (!isFinite(myD)) return -WIN;
        let value = 0;
        for (let i = 0; i < st.players.length; i++) {
            if (i === rootPi) continue;
            const od = QRules.distanceToGoal(st, i);
            if (!isFinite(od)) { value += WIN / 2; continue; }
            const urgency = od <= 2 ? 2.2 : od <= 4 ? 1.4 : 1.0;
            value += (od - myD) * urgency;
            value += (st.players[rootPi].walls - st.players[i].walls) * 0.3;
        }
        return value;
    }

    /* ---------------- search ---------------- */

    let searchAborted = false;

    function applyCand(st, c) {
        if (c.kind === 'move') {
            const p = st.players[st.turn];
            p.pos = { x: c.target.x, y: c.target.y };
            if (QRules.atGoal(p, p.pos)) st.winner = st.turn;
            else st.turn = (st.turn + 1) % st.players.length;
        } else {
            if (c.wall.isH) st.hw[c.wall.y][c.wall.x] = 1;
            else st.vw[c.wall.y][c.wall.x] = 1;
            st.players[st.turn].walls--;
            st.turn = (st.turn + 1) % st.players.length;
        }
    }

    function search(st, rootPi, depth, alpha, beta, ply) {
        if (st.winner !== null) return evalLeaf(st, rootPi);
        if (depth === 0) return evalLeaf(st, rootPi);
        if ((ply & 3) === 0 && timeUp()) { searchAborted = true; return 0; }

        const hash = hashState(st);
        const alphaOrig = alpha;
        const probe = ttProbe(hash, depth, alpha, beta);
        let ttBest = probe ? probe.move : null;

        const mover = st.turn;
        const cands = candidates(st, mover, ttBest);
        if (!cands.length) return evalLeaf(st, rootPi);
        const maximizing = (mover === rootPi);
        let best = maximizing ? -Infinity : Infinity;
        let bestMove = null;

        for (const c of cands) {
            // apply / undo on the live state (no cloning in the hot loop)
            const snapshot = snap(st);
            applyCand(st, c);
            const v = search(st, rootPi, depth - 1, alpha, beta, ply + 1);
            restore(st, snapshot);
            if (searchAborted) return 0;
            if (maximizing) {
                if (v > best) { best = v; bestMove = c; }
                if (best > alpha) alpha = best;
            } else {
                if (v < best) { best = v; bestMove = c; }
                if (best < beta) beta = best;
            }
            if (beta <= alpha) break;
        }
        if (!searchAborted) {
            const flag = best <= alphaOrig ? 3 : (best >= beta ? 2 : 1);
            ttStore(hash, depth, best, flag, bestMove);
        }
        return best;
    }

    /** Snapshot for apply/undo (positions, walls, wall grids, turn, winner). */
    function snap(st) {
        return {
            pos: st.players.map(p => ({ x: p.pos.x, y: p.pos.y })),
            walls: st.players.map(p => p.walls),
            turn: st.turn, winner: st.winner,
            hw: st.hw.map(r => r.slice()),
            vw: st.vw.map(r => r.slice())
        };
    }

    function restore(st, s) {
        st.players.forEach((p, i) => { p.pos = s.pos[i]; p.walls = s.walls[i]; });
        st.turn = s.turn;
        st.winner = s.winner;
        for (let y = 0; y < QRules.ANCH; y++) {
            for (let x = 0; x < QRules.ANCH; x++) {
                st.hw[y][x] = s.hw[y][x];
                st.vw[y][x] = s.vw[y][x];
            }
        }
    }

    /**
     * Decide with iterative deepening under a time budget (ms).
     * Returns the best action; always answers within the budget.
     */
    function decide(st, pi, budgetMs) {
        if (st.winner !== null) return null;
        const budget = Math.max(30, Math.min(budgetMs || 2400, 2900));
        deadline = Date.now() + budget;
        searchAborted = false;
        if (!zob) initZobrist();
        ttClear();

        // Win now if possible.
        const moves = QRules.legalMoves(st, pi);
        for (const m of moves) {
            if (QRules.atGoal(st.players[pi], m)) return { type: 'move', target: m };
        }

        const maxDepth = st.players.length === 2 ? MAX_DEPTH_2P : MAX_DEPTH_NP;
        let bestAction = null;
        let completedDepth = 0;
        for (let depth = 2; depth <= maxDepth; depth++) {
            const cands = candidates(st, pi, null);
            if (!cands.length) break;
            let iterBest = null, iterBestScore = -Infinity;
            let alpha = -Infinity;
            let aborted = false;
            for (const c of cands) {
                const snapshot = snap(st);
                // apply candidate for the root mover directly
                if (c.kind === 'move') {
                    st.players[pi].pos = { x: c.target.x, y: c.target.y };
                    if (QRules.atGoal(st.players[pi], st.players[pi].pos)) st.winner = pi;
                    else st.turn = (pi + 1) % st.players.length;
                } else {
                    if (c.wall.isH) st.hw[c.wall.y][c.wall.x] = 1;
                    else st.vw[c.wall.y][c.wall.x] = 1;
                    st.players[pi].walls--;
                    st.turn = (pi + 1) % st.players.length;
                }
                const v = search(st, pi, depth - 1, alpha, Infinity, 1);
                restore(st, snapshot);
                if (searchAborted) { aborted = true; break; }
                let score = v;
                if (c.kind === 'wall') score -= 0.15;   // prefer moving when equal (save walls)
                if (score > iterBestScore) { iterBestScore = score; iterBest = c; }
                if (score > alpha) alpha = score;
            }
            if (aborted) break;
            bestAction = iterBest;
            completedDepth = depth;
            if (iterBestScore >= WIN / 2) break;    // forced win found
            if (timeUp()) break;
        }
        if (!bestAction) {
            // fallback: first legal move
            if (moves.length) return { type: 'move', target: moves[0] };
            return null;
        }
        return bestAction.kind === 'move'
            ? { type: 'move', target: bestAction.target }
            : { type: 'wall', wall: bestAction.wall };
    }

    /* ---------------- Monte-Carlo win rate ---------------- */

    /**
     * Estimate player pi's win probability via greedy rollouts.
     * @param st game state (not modified)
     * @param pi player index
     * @param rollouts number of simulations (default 120)
     * @returns {number} win rate in [0,1]
     */
    function simulateWinRate(st, pi, rollouts) {
        if (st.winner !== null) return st.winner === pi ? 1 : 0;
        const R = Math.max(20, Math.min(rollouts || 120, 400));
        let wins = 0;
        for (let r = 0; r < R; r++) {
            const g = clone(st);
            g.history = [];
            let steps = 0;
            while (g.winner === null && steps < 240) {
                const mover = g.turn;
                const act = greedyAct(g, mover);
                if (!act) break;
                if (act.type === 'move') QRules.applyMove(g, mover, act.target);
                else QRules.applyWall(g, mover, act.wall.x, act.wall.y, act.wall.isH);
                steps++;
            }
            if (g.winner === pi) wins++;
            else if (g.winner === null) {
                // rollout cap: closer pawn takes it
                const dPi = QRules.distanceToGoal(g, pi);
                let best = Infinity;
                for (let i = 0; i < g.players.length; i++) {
                    if (i === pi) continue;
                    const d = QRules.distanceToGoal(g, i);
                    if (d < best) best = d;
                }
                if (dPi < best) wins += 0.5;   // tie-ish
            }
        }
        return wins / R;
    }

    /**
     * Fast greedy policy for rollouts: race along the shortest path; if an
     * opponent is strictly ahead and walls remain, occasionally (at random)
     * drop a wall on their path. The randomness diversifies rollouts —
     * without it every simulation from the same state plays out identically
     * and the estimate degenerates to 0 or 1.
     */
    function greedyAct(st, mover) {
        const me = st.players[mover];
        const moves = QRules.legalMoves(st, mover);
        if (!moves.length) return null;
        // winning move?
        for (const m of moves) {
            if (QRules.atGoal(me, m)) return { type: 'move', target: m };
        }
        const myD = QRules.distanceToGoal(st, mover);
        let oppBest = Infinity;
        for (let i = 0; i < st.players.length; i++) {
            if (i === mover) continue;
            const d = QRules.distanceToGoal(st, i);
            if (d < oppBest) oppBest = d;
        }
        // reactive wall with random chance
        if (me.walls > 0 && oppBest <= myD && Math.random() < 0.25) {
            const walls = QRules.legalWalls(st, mover);
            if (walls.length) {
                const base = st.players.map((_, i) => QRules.distanceToGoal(st, i));
                let best = null, bestGain = 0.5;
                for (const w of walls) {
                    const tmp = clone(st);
                    if (w.isH) tmp.hw[w.y][w.x] = 1; else tmp.vw[w.y][w.x] = 1;
                    let gain = 0;
                    for (let i = 0; i < st.players.length; i++) {
                        const delta = QRules.distanceToGoal(tmp, i) - base[i];
                        gain += (i === mover) ? -1.5 * delta : 2 * delta;
                    }
                    if (gain > bestGain) {
                        bestGain = gain; best = w;
                        if (gain >= 4) break;
                    }
                }
                if (best) return { type: 'wall', wall: best };
            }
        }
        // otherwise: race (ties broken randomly so mirror games diverge)
        let bestD = Infinity;
        const bests = [];
        for (const m of moves) {
            const tmp = clone(st);
            tmp.players[mover].pos = { x: m.x, y: m.y };
            const d = QRules.distanceToGoal(tmp, mover);
            if (d < bestD) { bestD = d; bests.length = 0; bests.push(m); }
            else if (d === bestD) bests.push(m);
        }
        return { type: 'move', target: bests[Math.floor(Math.random() * bests.length)] };
    }

    /* ---------------- public API ---------------- */

    return {
        decide, simulateWinRate, evalLeaf, clone
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QAI;
