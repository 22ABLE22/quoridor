'use strict';
/* =========================================================================
 * QAI — Quoridor computer player
 * Depends on: global QRules (js/rules.js loaded first).
 *
 * Single AI: shallow alpha-beta search.
 *   - 2 players: 3 plies; 3+ players: 2 plies (paranoid approximation).
 *   - Candidates per node: all legal moves + pruned "relevant walls"
 *     (near pawns, adjacent to existing walls, on shortest-path corridors).
 *   - Leaf evaluation: distance differences weighted by urgency
 *     + remaining wall advantage.
 *   - The search uses the real move generator, so it sees jump tactics
 *     (including being jumped past) and wall counterplay.
 * Synchronous, tens to hundreds of milliseconds per decision.
 * ========================================================================= */
var QAI = (function () {

    const WIN = 100000;
    const MAX_CAND_2P = 22;    // candidate cap per node, 2-player
    const MAX_CAND_NP = 16;    // candidate cap per node, 3+ players

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

    /* ---------------- candidate generation ---------------- */

    function candidates(st, mover) {
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
                const tmp = clone(st);
                if (w.isH) tmp.hw[w.y][w.x] = 1; else tmp.vw[w.y][w.x] = 1;
                if (!QRules.allReachable(tmp)) continue;   // never trap anyone
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
        return list.slice(0, cap);
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
        if (dy === -1) {            // up: h walls in row groove from.y-1
            return [
                { x: from.x, y: from.y - 1, isH: true },
                { x: from.x - 1, y: from.y - 1, isH: true }
            ];
        }
        if (dy === 1) {             // down: row groove from.y
            return [
                { x: from.x, y: from.y, isH: true },
                { x: from.x - 1, y: from.y, isH: true }
            ];
        }
        if (dx === -1) {            // left: v walls in column groove from.x-1
            return [
                { x: from.x - 1, y: from.y, isH: false },
                { x: from.x - 1, y: from.y - 1, isH: false }
            ];
        }
        // right
        return [
            { x: from.x, y: from.y, isH: false },
            { x: from.x, y: from.y - 1, isH: false }
        ];
    }

    /* ---------------- search ---------------- */

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

    /**
     * Alpha-beta minimax. Strict minimax for 2 players;
     * paranoid approximation for 3+ (all opponents minimize my score).
     */
    function search(st, rootPi, depth, alpha, beta) {
        if (st.winner !== null || depth === 0) return evalLeaf(st, rootPi);
        const mover = st.turn;
        const cands = candidates(st, mover);
        if (!cands.length) return evalLeaf(st, rootPi);
        const maximizing = (mover === rootPi);
        let best = maximizing ? -Infinity : Infinity;
        for (const c of cands) {
            const child = clone(st);
            if (c.kind === 'move') {
                const p = child.players[mover];
                p.pos = { x: c.target.x, y: c.target.y };
                if (QRules.atGoal(p, p.pos)) child.winner = mover;
                else child.turn = (mover + 1) % child.players.length;
            } else {
                if (c.wall.isH) child.hw[c.wall.y][c.wall.x] = 1;
                else child.vw[c.wall.y][c.wall.x] = 1;
                child.players[mover].walls--;
                child.turn = (mover + 1) % child.players.length;
            }
            const v = search(child, rootPi, depth - 1, alpha, beta);
            if (maximizing) {
                if (v > best) best = v;
                if (best > alpha) alpha = best;
            } else {
                if (v < best) best = v;
                if (best < beta) beta = best;
            }
            if (beta <= alpha) break;
        }
        return best;
    }

    /* ---------------- public API ---------------- */

    /**
     * Decide the computer player's next action.
     * @returns {type:'move', target:{x,y}} or {type:'wall', wall:{x,y,isH}} or null
     */
    function decide(st, pi) {
        if (st.winner !== null) return null;
        // Win now if possible.
        const moves = QRules.legalMoves(st, pi);
        for (const m of moves) {
            if (QRules.atGoal(st.players[pi], m)) return { type: 'move', target: m };
        }
        const depth = st.players.length === 2 ? 3 : 2;
        const cands = candidates(st, pi);
        if (!cands.length) return null;
        let bestAction = null, bestScore = -Infinity;
        let alpha = -Infinity;
        for (const c of cands) {
            const child = clone(st);
            if (c.kind === 'move') {
                child.players[pi].pos = { x: c.target.x, y: c.target.y };
                child.winner = QRules.atGoal(child.players[pi], child.players[pi].pos) ? pi : null;
                if (child.winner === null) child.turn = (pi + 1) % child.players.length;
            } else {
                if (c.wall.isH) child.hw[c.wall.y][c.wall.x] = 1;
                else child.vw[c.wall.y][c.wall.x] = 1;
                child.players[pi].walls--;
                child.turn = (pi + 1) % child.players.length;
            }
            let score = search(child, pi, depth - 1, alpha, Infinity);
            if (c.kind === 'wall') score -= 0.15;   // prefer moving when equal (save walls)
            if (score > bestScore) { bestScore = score; bestAction = c; }
            if (score > alpha) alpha = score;
        }
        if (!bestAction) return null;
        return bestAction.kind === 'move'
            ? { type: 'move', target: bestAction.target }
            : { type: 'wall', wall: bestAction.wall };
    }

    return { decide, evalLeaf, clone };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QAI;
