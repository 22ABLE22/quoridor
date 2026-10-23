'use strict';
/* =========================================================================
 * QAI — Quoridor computer player and win-probability estimator
 * Depends on: global QRules (js/rules.js loaded first).
 *
 * Search engine:
 *   - Iterative-deepening alpha-beta with a hard time budget (soft limit is
 *     caller-provided; the engine checks the clock in the search loop and
 *     between iterations, returning the best move from the last completed
 *     depth, so it always answers in time).
 *   - Zobrist hashing + transposition table (1M slots, typed arrays) with a
 *     generation stamp instead of a per-decision clear, and full exact /
 *     lower / upper bound usage. Mate scores are stored ply-normalized so a
 *     bound hit stays sound at any ply.
 *   - Candidate generation is "relevant wall" pruned: a wall is only tried
 *     when it blocks an edge of some player's current shortest path. That
 *     filter is sound (a wall that raises nobody's distance, or that seals
 *     somebody off, must block that player's shortest path), so it removes
 *     only useless walls while cutting the wall scan by an order of
 *     magnitude — which is what buys the extra search depth.
 *   - 2 players: strict alpha-beta; 3+: paranoid approximation.
 *
 * Win probability (for the UI):
 *   - simulateWinRates(st, rollouts): one Monte-Carlo pass that plays every
 *     rollout once and credits every player from the same sample set, so all
 *     bars are mutually consistent and the cost is paid once per position
 *     instead of once per player.
 *   - simulateWinRate(st, pi, rollouts): single-player convenience wrapper.
 * ========================================================================= */
var QAI = (function () {

    const WIN = 29000;              // fits Int16 with room for mate-ply adjustment
    const MATE_START = 28000;       // scores >= this encode mate-in-N via (WIN - ply)
    const MAX_CAND_2P = 26;     // candidate cap per node, 2-player
    const MAX_CAND_NP = 18;     // candidate cap per node, 3+ players
    const MAX_DEPTH_2P = 9;     // iterative-deepening ceiling, 2-player
    const MAX_DEPTH_NP = 6;     // ceiling, 3+ players
    const MAX_PLY = 40;         // killers/history table depth
    const ASPIRATION = 140;     // first aspiration window (eval units, 1 step ≈ 1)
    const LMR = false;           // late move reductions

    const N = QRules.N;
    const ANCH = QRules.ANCH;
    const WALL_SLOTS = ANCH * ANCH * 2;      // 128 anchors × 2 orientations

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

    /** Copy the mutable position of `src` into an existing clone `dst`. */
    function restoreState(dst, src) {
        const nP = src.players.length;
        for (let i = 0; i < nP; i++) {
            const d = dst.players[i], s = src.players[i];
            d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.walls = s.walls;
        }
        for (let y = 0; y < ANCH; y++) {
            const dh = dst.hw[y], dv = dst.vw[y], sh = src.hw[y], sv = src.vw[y];
            for (let x = 0; x < ANCH; x++) { dh[x] = sh[x]; dv[x] = sv[x]; }
        }
        dst.turn = src.turn;
        dst.winner = src.winner;
    }

    /* ---------------- Zobrist / transposition table ---------------- */
    const TT_BITS = 20;                // 1M slots (~16 MB of typed arrays)
    const TT_SIZE = 1 << TT_BITS;
    const TT_MASK = TT_SIZE - 1;
    let zob = null;
    let ttKey = null;      // Int32Array  (hash, signed)
    let ttGen = null;      // Uint16Array (search generation that wrote the slot)
    let ttDepth = null;    // Int8Array
    let ttScore = null;    // Int16Array (ply-normalized for mates)
    let ttFlag = null;     // Uint8Array  (0 empty, 1 exact, 2 lower, 3 upper)
    let ttMove = null;     // Int32Array  (encoded move, 0 = none)
    let ttGeneration = 0;

    function initZobrist() {
        // Deterministic PRNG so Worker and main-thread runs agree.
        let seed = 0x2F6E2B1;
        const rand = () => {
            seed ^= seed << 13; seed >>>= 0;
            seed ^= seed >> 17;
            seed ^= seed << 5; seed >>>= 0;
            return seed;
        };
        zob = {
            h: Array.from({ length: ANCH }, () => Array.from({ length: ANCH }, () => rand() >>> 0)),
            v: Array.from({ length: ANCH }, () => Array.from({ length: ANCH }, () => rand() >>> 0)),
            pos: Array.from({ length: 4 }, () => new Array(N * N).fill(0).map(() => rand() >>> 0))
        };
        ttKey = new Int32Array(TT_SIZE);
        ttGen = new Uint16Array(TT_SIZE);
        ttDepth = new Int8Array(TT_SIZE);
        ttScore = new Int16Array(TT_SIZE);
        ttFlag = new Uint8Array(TT_SIZE);
        ttMove = new Int32Array(TT_SIZE);
    }

    function hashState(st) {
        let h = 0 >>> 0;
        for (let y = 0; y < ANCH; y++) {
            for (let x = 0; x < ANCH; x++) {
                const hv = st.hw[y][x];
                if (hv) h = (h ^ (zob.h[y][x] + (hv << 20)) >>> 0) >>> 0;   // owner folded in
                const vv = st.vw[y][x];
                if (vv) h = (h ^ (zob.v[y][x] + (vv << 20)) >>> 0) >>> 0;
            }
        }
        for (const p of st.players) {
            h = (h ^ zob.pos[p.id][p.pos.y * N + p.pos.x]) >>> 0;
            // wall stock matters: same layout with different remaining walls
            // is a different position (walls are spendable resources)
            h = (h ^ ((0x8FCD2A9 * (p.id + 3)) * (p.walls + 1))) >>> 0;
        }
        // side to move
        h = (h ^ (0x9E3779B9 * (st.turn + 1))) >>> 0;
        return h >>> 0;
    }

    /** Start a new search: bump the generation instead of clearing 1M slots. */
    function ttNewSearch() {
        ttGeneration++;
        if (ttGeneration > 65000) { ttGen.fill(0); ttGeneration = 1; }
    }

    /* Move encoding: 0 = empty; otherwise 1 + (kind | isH<<1 | x<<2 | y<<6). */
    function encodeMove(c) {
        if (!c) return 0;
        const isWall = c.kind === 'wall';
        const x = isWall ? c.wall.x : c.target.x;
        const y = isWall ? c.wall.y : c.target.y;
        const isH = isWall && c.wall.isH ? 1 : 0;
        return 1 + ((isWall ? 1 : 0) | (isH << 1) | (x << 2) | (y << 6));
    }

    function decodeMove(code) {
        if (!code) return null;
        const v = code - 1;
        const x = (v >> 2) & 15, y = (v >> 6) & 15;
        if (v & 1) return { kind: 'wall', wall: { x, y, isH: !!(v & 2) } };
        return { kind: 'move', target: { x, y, jump: null } };
    }

    function ttProbe(hash, depth, alpha, beta, ply) {
        const idx = hash & TT_MASK;
        if (ttKey[idx] !== (hash | 0) || ttGen[idx] !== ttGeneration) return null;
        if (ttDepth[idx] < depth) return null;
        let score = ttScore[idx];
        // Undo the ply normalization applied on store.
        if (score > MATE_START) score -= ply;
        else if (score < -MATE_START) score += ply;
        const move = decodeMove(ttMove[idx]);
        const flag = ttFlag[idx];
        if (flag === 1) return { score, move, cutoff: true };
        if (flag === 2 && score >= beta) return { score, move, cutoff: true };
        if (flag === 3 && score <= alpha) return { score, move, cutoff: true };
        return { move, cutoff: false };     // keep the move for ordering only
    }

    function ttStore(hash, depth, score, flag, move, ply) {
        const idx = hash & TT_MASK;
        // depth-preferred replacement within the same search
        if (ttGen[idx] === ttGeneration && ttDepth[idx] > depth) return;
        let s = score;
        // Mate scores are ply-relative; normalize so a re-hit at another ply is sound.
        if (s > MATE_START) s += ply;
        else if (s < -MATE_START) s -= ply;
        ttKey[idx] = hash | 0;
        ttGen[idx] = ttGeneration;
        ttDepth[idx] = depth;
        ttScore[idx] = clamp16(s);
        ttFlag[idx] = flag;
        ttMove[idx] = encodeMove(move);
    }

    function clamp16(v) {
        if (v > 32700) return 32700;
        if (v < -32700) return -32700;
        return Math.round(v);
    }

    /* ---------------- shortest-path wall relevance ---------------- */

    // Scratch buffers (single-threaded per engine instance).
    const _seen = new Uint8Array(N * N);
    const _prev = new Int16Array(N * N);
    const _bfsQ = new Int16Array(N * N);
    const _pmark = new Uint8Array(WALL_SLOTS);    // one player's path-blocking walls
    const _wallMask = new Uint8Array(WALL_SLOTS); // bit i = blocks player i's shortest path
    const _base = new Float64Array(8);            // per-player base distances

    const wallIdxH = (x, y) => ((y * ANCH + x) << 1);
    const wallIdxV = (x, y) => (((y * ANCH + x) << 1) | 1);

    function markH(mark, x, y) {
        if (x < 0 || y < 0 || x >= ANCH || y >= ANCH) return;
        mark[wallIdxH(x, y)] = 1;
    }
    function markV(mark, x, y) {
        if (x < 0 || y < 0 || x >= ANCH || y >= ANCH) return;
        mark[wallIdxV(x, y)] = 1;
    }

    function isGoal(goal, x, y) {
        switch (goal) {
            case 'N': return y === 0;
            case 'S': return y === N - 1;
            case 'E': return x === N - 1;
            case 'W': return x === 0;
        }
        return false;
    }

    /**
     * Mark every wall anchor that blocks one edge of player pi's canonical
     * shortest path into `mark` (cleared first).
     *
     * Soundness: a wall can only increase a player's distance (or seal them
     * off) if it blocks *every* shortest path — in particular this one. So a
     * wall that is not marked here cannot change that player's distance.
     */
    function markPathWalls(st, pi, mark) {
        mark.fill(0);
        const p = st.players[pi];
        if (isGoal(p.goal, p.pos.x, p.pos.y)) return;
        const hw = st.hw, vw = st.vw;
        _seen.fill(0);
        const start = p.pos.y * N + p.pos.x;
        _seen[start] = 1;
        _prev[start] = -1;
        let head = 0, tail = 0;
        _bfsQ[tail++] = start;
        let goalCell = -1;
        while (head < tail) {
            const cur = _bfsQ[head++];
            const cx = cur % N, cy = (cur - cx) / N;
            // up (row groove cy-1, h anchors (cx,·)/(cx-1,·))
            if (cy > 0 && !((cx < ANCH && hw[cy - 1][cx] > 0) || (cx > 0 && hw[cy - 1][cx - 1] > 0))) {
                const ni = cur - N;
                if (!_seen[ni]) {
                    _seen[ni] = 1; _prev[ni] = cur;
                    if (isGoal(p.goal, cx, cy - 1)) { goalCell = ni; break; }
                    _bfsQ[tail++] = ni;
                }
            }
            // down
            if (cy < N - 1 && !((cx < ANCH && hw[cy][cx] > 0) || (cx > 0 && hw[cy][cx - 1] > 0))) {
                const ni = cur + N;
                if (!_seen[ni]) {
                    _seen[ni] = 1; _prev[ni] = cur;
                    if (isGoal(p.goal, cx, cy + 1)) { goalCell = ni; break; }
                    _bfsQ[tail++] = ni;
                }
            }
            // left
            if (cx > 0 && !((cy < ANCH && vw[cy][cx - 1] > 0) || (cy > 0 && vw[cy - 1][cx - 1] > 0))) {
                const ni = cur - 1;
                if (!_seen[ni]) {
                    _seen[ni] = 1; _prev[ni] = cur;
                    if (isGoal(p.goal, cx - 1, cy)) { goalCell = ni; break; }
                    _bfsQ[tail++] = ni;
                }
            }
            // right
            if (cx < N - 1 && !((cy < ANCH && vw[cy][cx] > 0) || (cy > 0 && vw[cy - 1][cx] > 0))) {
                const ni = cur + 1;
                if (!_seen[ni]) {
                    _seen[ni] = 1; _prev[ni] = cur;
                    if (isGoal(p.goal, cx + 1, cy)) { goalCell = ni; break; }
                    _bfsQ[tail++] = ni;
                }
            }
        }
        if (goalCell < 0) return;
        let cur = goalCell;
        while (true) {
            const from = _prev[cur];
            if (from < 0) break;
            const fx = from % N, fy = (from - fx) / N;
            const tx = cur % N, ty = (cur - tx) / N;
            if (ty === fy - 1) {                 // stepped up
                markH(mark, fx, fy - 1);
                markH(mark, fx - 1, fy - 1);
            } else if (ty === fy + 1) {          // stepped down
                markH(mark, fx, fy);
                markH(mark, fx - 1, fy);
            } else if (tx === fx - 1) {          // stepped left
                markV(mark, fx - 1, fy);
                markV(mark, fx - 1, fy - 1);
            } else {                             // stepped right
                markV(mark, fx, fy);
                markV(mark, fx, fy - 1);
            }
            cur = from;
        }
    }

    /**
     * Wall anchors that block at least one player's shortest path, each with
     * a bitmask of the players it affects (geometrically legal only).
     */
    function candidateWalls(st) {
        _wallMask.fill(0);
        const nP = st.players.length;
        for (let i = 0; i < nP; i++) {
            markPathWalls(st, i, _pmark);
            const bit = 1 << i;
            for (let idx = 0; idx < WALL_SLOTS; idx++) {
                if (_pmark[idx]) _wallMask[idx] |= bit;
            }
        }
        const out = [];
        for (let idx = 0; idx < WALL_SLOTS; idx++) {
            const mask = _wallMask[idx];
            if (!mask) continue;
            const isH = (idx & 1) === 0;
            const a = idx >> 1;
            const x = a % ANCH;
            const y = (a - x) / ANCH;
            if (QRules.wallConflicts(st, x, y, isH)) continue;
            out.push({ x, y, isH, mask });
        }
        return out;
    }

    /* ---------------- candidate generation ---------------- */

    function candidates(st, mover, ttMove) {
        const list = [];
        const moves = QRules.legalMoves(st, mover);
        const me = st.players[mover];
        const baseD = QRules.distanceToGoal(st, mover);
        const px = me.pos.x, py = me.pos.y;
        for (const m of moves) {
            // evaluate the move in place (apply/undo) — no clone
            me.pos.x = m.x; me.pos.y = m.y;
            const d = QRules.distanceToGoal(st, mover);
            me.pos.x = px; me.pos.y = py;
            list.push({ kind: 'move', target: m, gain: (baseD - d) * 2 + (isGoal(me.goal, m.x, m.y) ? 100 : 0) });
        }
        if (me.walls > 0) {
            const walls = candidateWalls(st);
            if (walls.length) {
                const nP = st.players.length;
                for (let i = 0; i < nP; i++) _base[i] = QRules.distanceToGoal(st, i);
                for (const w of walls) {
                    if (timeUp()) { searchAborted = true; break; }   // clock check in the wall scan
                    if (w.isH) st.hw[w.y][w.x] = mover + 1; else st.vw[w.y][w.x] = mover + 1;
                    let legal = true, gain = 0;
                    for (let i = 0; i < nP; i++) {
                        if (!(w.mask & (1 << i))) continue;          // distance cannot change
                        const d = QRules.distanceToGoal(st, i);
                        if (!isFinite(d)) { legal = false; break; }  // seals someone off → illegal
                        const delta = d - _base[i];
                        gain += (i === mover) ? -1.5 * delta : 2 * delta;
                    }
                    if (w.isH) st.hw[w.y][w.x] = 0; else st.vw[w.y][w.x] = 0;
                    if (!legal) continue;
                    list.push({ kind: 'wall', wall: w, gain });
                }
            }
        }
        list.sort((a, b) => b.gain - a.gain);
        const cap = st.players.length === 2 ? MAX_CAND_2P : MAX_CAND_NP;
        const out = list.slice(0, cap);
        if (ttMove) {
            // Move the TT move to the front (only if it survived pruning, so a
            // stale/hash-aliased entry can never inject an illegal action).
            for (let i = 0; i < out.length; i++) {
                const c = out[i];
                const same = c.kind === ttMove.kind && (c.kind === 'move'
                    ? (c.target.x === ttMove.target.x && c.target.y === ttMove.target.y)
                    : (c.wall.x === ttMove.wall.x && c.wall.y === ttMove.wall.y && c.wall.isH === ttMove.wall.isH));
                if (same) {
                    if (i > 0) { const t = out[0]; out[0] = c; out[i] = t; }
                    break;
                }
            }
        }
        return out;
    }

    /* ---------------- evaluation ---------------- */

    // Same evaluation as 8fffbff, scaled by 100 for integer TT/PVS scores.
    // Search correctness is tested separately from evaluation changes.
    function evalLeaf(st, rootPi, ply) {
        if (st.winner !== null) return st.winner === rootPi ? WIN - ply : -(WIN - ply);
        const myD = QRules.distanceToGoal(st, rootPi);
        if (!isFinite(myD)) return -(WIN - ply);
        let value = 0;
        for (let i = 0; i < st.players.length; i++) {
            if (i === rootPi) continue;
            const od = QRules.distanceToGoal(st, i);
            if (!isFinite(od)) { value += WIN / 2; continue; }
            const urgency = od <= 2 ? 220 : od <= 4 ? 140 : 100;
            value += (od - myD) * urgency;
            value += (st.players[rootPi].walls - st.players[i].walls) * 30;
        }
        return value;
    }

    /* ---------------- search ---------------- */

    let usePVS = true;
    let useTT = true;
    let searchAborted = false;
    let nodeCount = 0;

    /** Apply one candidate in place (no allocation, no validation). */
    function applyCand(st, c, mover) {
        if (c.kind === 'move') {
            const p = st.players[mover];
            p.pos.x = c.target.x; p.pos.y = c.target.y;
            if (isGoal(p.goal, p.pos.x, p.pos.y)) st.winner = mover;
            else st.turn = (mover + 1) % st.players.length;
        } else {
            if (c.wall.isH) st.hw[c.wall.y][c.wall.x] = mover + 1;
            else st.vw[c.wall.y][c.wall.x] = mover + 1;
            st.players[mover].walls--;
            st.turn = (mover + 1) % st.players.length;
        }
    }

    /** Undo applyCand for the same mover (pawn position is caller-supplied). */
    function undoCand(st, c, mover, fromX, fromY) {
        if (c.kind === 'move') {
            const p = st.players[mover];
            p.pos.x = fromX; p.pos.y = fromY;
            st.winner = null;
        } else {
            if (c.wall.isH) st.hw[c.wall.y][c.wall.x] = 0;
            else st.vw[c.wall.y][c.wall.x] = 0;
            st.players[mover].walls++;
        }
        st.turn = mover;
    }

    function search(st, rootPi, depth, alpha, beta, ply) {
        if (st.winner !== null) return evalLeaf(st, rootPi, ply);
        if (depth <= 0) return evalLeaf(st, rootPi, ply);
        if ((ply & 3) === 0 && timeUp()) { searchAborted = true; return 0; }
        nodeCount++;

        const hash = hashState(st);
        const alphaOrig = alpha;
        const betaOrig = beta;
        const probe = useTT ? ttProbe(hash, depth, alpha, beta, ply) : null;
        if (probe && probe.cutoff) return probe.score;
        const ttBest = probe ? probe.move : null;

        const mover = st.turn;
        const cands = candidates(st, mover, ttBest);
        if (searchAborted) return 0;
        if (!cands.length) return evalLeaf(st, rootPi, ply);
        const maximizing = (mover === rootPi);
        let best = maximizing ? -Infinity : Infinity;
        let bestMove = null;
        const fromX = st.players[mover].pos.x, fromY = st.players[mover].pos.y;

        for (let ci = 0; ci < cands.length; ci++) {
            const c = cands[ci];
            // apply / undo on the live state (no cloning in the hot loop)
            applyCand(st, c, mover);
            const v = search(st, rootPi, depth - 1, alpha, beta, ply + 1);
            undoCand(st, c, mover, fromX, fromY);
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
        if (!searchAborted && useTT) {
            const flag = best <= alphaOrig ? 3 : (best >= betaOrig ? 2 : 1);
            ttStore(hash, depth, best, flag, bestMove, ply);
        }
        return best;
    }

    /* ---------------- move ordering memory ---------------- */

    // Killers: two moves per ply that recently caused a cutoff there. Tried right
    // after the TT move, because a quiet move that refutes one sibling usually
    // refutes the next.
    const KILLERS = 2;
    let killers = null;        // Int32Array(MaxPly * 2) of encoded moves
    let history = null;        // Int32Array(WALL_SLOTS) — wall cutoffs by slot
    let pawnHistory = null;    // Int32Array(N * N) — pawn-move cutoffs by destination

    function initOrderingMemory() {
        killers = new Int32Array(MAX_PLY * KILLERS);
        history = new Int32Array(WALL_SLOTS);
        pawnHistory = new Int32Array(N * N);
    }

    function resetOrderingMemory() {
        killers.fill(0);
        history.fill(0);
        pawnHistory.fill(0);
    }

    /** Wall-slot index of a candidate (0..WALL_SLOTS-1), or -1 for a pawn move. */
    function slotOf(c) {
        if (c.kind === 'move') return -1;
        return c.wall.isH ? wallIdxH(c.wall.x, c.wall.y) : wallIdxV(c.wall.x, c.wall.y);
    }

    function isKiller(code, ply) {
        if (!code) return false;
        const base = ply * KILLERS;
        return killers[base] === code || killers[base + 1] === code;
    }

    function rememberKiller(code, ply) {
        if (!code) return;
        const base = ply * KILLERS;
        if (killers[base] === code) return;
        killers[base + 1] = killers[base];
        killers[base] = code;
    }

    /**
     * How promising a candidate looks before searching it. Pawn moves are ordered
     * by the progress they make (already in `gain`); walls by whether they are a
     * killer, then by cutoff history, then by their static gain. The sort is a
     * stable insertion sort because these lists are short and already nearly
     * ordered — Array.prototype.sort would allocate a comparator closure per node.
     */
    function orderCandidates(list, ply, preferred) {
        for (let i = 1; i < list.length; i++) {
            const c = list[i];
            const key = orderKey(c, ply, preferred);
            let j = i - 1;
            while (j >= 0 && orderKey(list[j], ply, preferred) < key) {
                list[j + 1] = list[j];
                j--;
            }
            list[j + 1] = c;
        }
    }

    function orderKey(c, ply, preferred) {
        if (preferred && encodeMove(c) === encodeMove(preferred)) return 1e12;
        if (c.kind === 'move') return c.gain * 1024 + pawnHistory[c.target.y * N + c.target.x] / 64;      // pawn steps first
        const slot = slotOf(c);
        const code = encodeMove(c);
        if (isKiller(code, ply)) return 1e8 + c.gain;
        return c.gain * 1024 + history[slot] / 64;
    }

    /* ---------------- root-relative MAX/MIN PVS ---------------- */
    // Root player maximizes; all opponents minimize (paranoid multiplayer model).
    // Scout windows follow the node direction: MAX tests alpha; MIN tests beta.
    // Full finite root bounds keep each scout window valid. LMR is deliberately
    // disabled until its tactical safety has independent regression coverage.
    function pvs(st, rootPi, depth, alpha, beta, ply) {
        if (st.winner !== null) return evalLeaf(st, rootPi, ply);
        if (depth <= 0) return evalLeaf(st, rootPi, ply);
        if ((ply & 7) === 0 && timeUp()) { searchAborted = true; return 0; }
        nodeCount++;

        const hash = hashState(st);
        const alphaOrig = alpha;
        const betaOrig = beta;
        const isPV = (beta - alpha) > 1;
        const probe = useTT ? ttProbe(hash, depth, alpha, beta, ply) : null;
        if (probe && probe.cutoff) return probe.score;
        const ttBest = probe ? probe.move : null;

        const mover = st.turn;
        const maximizing = (mover === rootPi);
        const cands = candidates(st, mover, ttBest);
        if (searchAborted) return 0;
        if (!cands.length) return evalLeaf(st, rootPi, ply);
        orderCandidates(cands, ply, ttBest);

        // A maximizing node raises alpha, a minimizing node lowers beta; both are
        // expressed here as the score that is good for the side we are scoring.
        let best = maximizing ? -Infinity : Infinity;
        let bestMove = null;
        const fromX = st.players[mover].pos.x, fromY = st.players[mover].pos.y;
        let first = true;

        for (let ci = 0; ci < cands.length; ci++) {
            const c = cands[ci];
            applyCand(st, c, mover);

            // The null window used to prove "this move is not better than the one
            // before it" has to be placed on the correct side of the bound. This is
            // a max/min tree, not a negamax tree: a MAXIMIZING node is trying to beat
            // alpha, so its test window is (alpha, alpha+1); a MINIMIZING node is
            // trying to undercut beta, so its test window is (beta-1, beta). Using
            // the maximizing window at a minimizing node searches a range that cannot
            // contain the answer, and the bound that comes back is wrong — the engine
            // then plays moves the score does not support (in practice: it shuffles
            // pawns backwards and the game never ends).
            const testAlpha = maximizing ? alpha : beta - 1;
            const testBeta = maximizing ? alpha + 1 : beta;
            const improvesBound = maximizing;

            let v;
            if (first || !usePVS) {
                v = pvs(st, rootPi, depth - 1, alpha, beta, ply + 1);
                first = false;
            } else {
                // Late move reductions: deep in the list and deep in the tree, a wall
                // is unlikely to be the move. Search it shallower on a null window and
                // re-search properly if it surprises us.
                let reduction = 0;
                if (LMR && depth >= 3 && ci >= 3 && !isPV && c.kind === 'wall') {
                    reduction = ci >= 10 ? 2 : 1;
                    const slot = slotOf(c);
                    if (history[slot] > 2000) reduction--;
                }
                if (reduction > 0) {
                    v = pvs(st, rootPi, depth - 1 - reduction, testAlpha, testBeta, ply + 1);
                    if ((improvesBound ? v > alpha : v < beta)) v = pvs(st, rootPi, depth - 1, testAlpha, testBeta, ply + 1);
                } else {
                    v = pvs(st, rootPi, depth - 1, testAlpha, testBeta, ply + 1);
                }
                if ((improvesBound ? v > alpha : v < beta)) {
                    v = pvs(st, rootPi, depth - 1, alpha, beta, ply + 1);
                }
            }

            undoCand(st, c, mover, fromX, fromY);
            if (searchAborted) return 0;

            if (maximizing) {
                if (v > best) { best = v; bestMove = c; }
                if (best > alpha) alpha = best;
            } else {
                if (v < best) { best = v; bestMove = c; }
                if (best < beta) beta = best;
            }
            if (beta <= alpha) {
                // Record the refutation so the next sibling at this ply tries it early.
                if (c.kind === 'wall') {
                    const slot = slotOf(c);
                    if (history[slot] < 1e9) history[slot] += depth * depth;
                    rememberKiller(encodeMove(c), ply);
                } else {
                    const cell = c.target.y * N + c.target.x;
                    if (pawnHistory[cell] < 1e9) pawnHistory[cell] += depth * depth;
                }
                break;
            }
        }
        if (!searchAborted && useTT) {
            const flag = best <= alphaOrig ? 3 : (best >= betaOrig ? 2 : 1);
            ttStore(hash, depth, best, flag, bestMove, ply);
        }
        return best;
    }

    /**
     * Root search for one depth. Returns the score of the best move and leaves
     * the chosen candidate in `out`.
     *
     * Two deliberate choices here:
     *   - A move only replaces the best when it actually raises alpha. Every other
     *     score came from a null window and is an upper bound; picking the largest
     *     of several "at most" claims is how a root ends up choosing badly.
     *   - The previous iteration's best is searched first, and a forced win ends
     *     iterative deepening immediately.
     */
    function searchRoot(st, rootPi, depth, alpha, beta, out) {
        const mover = st.turn;
        const cands = candidates(st, mover, out.prevBest);
        if (searchAborted || !cands.length) return { score: out.score, done: false };
        orderCandidates(cands, 0, out.prevBest);

        let bestScore = -Infinity;
        let best = null;
        const fromX = st.players[mover].pos.x, fromY = st.players[mover].pos.y;
        let first = true;

        for (let ci = 0; ci < cands.length; ci++) {
            const c = cands[ci];
            applyCand(st, c, mover);
            let v;
            if (first) {
                v = pvs(st, rootPi, depth - 1, alpha, beta, 1);
                first = false;
            } else {
                v = pvs(st, rootPi, depth - 1, alpha, alpha + 1, 1);
                if (v > alpha && v < beta) v = pvs(st, rootPi, depth - 1, alpha, beta, 1);
            }
            undoCand(st, c, mover, fromX, fromY);
            if (searchAborted) return { score: bestScore, done: false };

            if (v > bestScore) bestScore = v;
            if (v > alpha) {
                alpha = v;
                best = c;
            }
            if (alpha >= beta) break;
        }
        return { score: bestScore, best, done: true };
    }

    /**
     * Decide with iterative deepening under a time budget (ms).
     * Returns the best action; always answers within the budget.
     * The returned action may carry `stats` = { depth, score, nodes, ms }.
     */
    function decide(st, pi, budgetMs) {
        if (st.winner !== null) return null;
        st = clone(st);
        st.turn = pi;
        const budget = Math.max(30, Math.min(budgetMs || 2400, 2900));
        const t0 = Date.now();
        deadline = t0 + budget;
        searchAborted = false;
        nodeCount = 0;
        if (!zob) initZobrist();
        if (!killers) initOrderingMemory();
        ttNewSearch();
        resetOrderingMemory();

        // Win now if possible.
        const moves = QRules.legalMoves(st, pi);
        for (const m of moves) {
            if (isGoal(st.players[pi].goal, m.x, m.y)) return { type: 'move', target: m };
        }
        if (!moves.length) return null;

        const maxDepth = st.players.length === 2 ? MAX_DEPTH_2P : MAX_DEPTH_NP;
        let bestAction = null;
        let completedDepth = 0;
        let bestScore = 0;
        let prevBest = null;   // PV from the previous iteration, searched first
        let hasScore = false;  // is bestScore a real score (for aspiration)?
        // Callers normally pass pi === st.turn, but decide() is also usable as
        // "what would pi do here"; restoring the ORIGINAL turn keeps that
        // non-mutating in either case.
        const startTurn = st.turn;

        for (let depth = 2; depth <= maxDepth; depth++) {
            // Aspiration windows: once the previous iteration's score is worth
            // trusting, search a narrow band around it instead of the whole range.
            // A score that falls outside means the guess was wrong, so widen and
            // retry rather than trusting a bound as if it were a score.
            let window = (hasScore && depth >= 4 && Math.abs(bestScore) < MATE_START) ? ASPIRATION : -1;
            let out = { prevBest, score: bestScore };
            let result = null;
            if (window < 0) {
                result = searchRoot(st, pi, depth, -32000, 32000, out);
            } else {
                for (let attempt = 0; attempt < 6; attempt++) {
                    const alpha = bestScore - window;
                    const beta = bestScore + window;
                    out.prevBest = prevBest;
                    result = searchRoot(st, pi, depth, alpha, beta, out);
                    if (searchAborted || !result.done) break;
                    if (result.score > alpha && result.score < beta) break;
                    window *= 4;
                    if (window > 4000) {
                        result = searchRoot(st, pi, depth, -32000, 32000, out);
                        break;
                    }
                }
            }
            if (searchAborted || !result || !result.done) break;
            if (!result.best) break;

            bestAction = result.best;
            bestScore = result.score;
            completedDepth = depth;
            hasScore = true;
            prevBest = result.best;   // search the previous best first next iteration
            if (bestScore >= MATE_START) break;    // forced win found
            // Do not start a depth that clearly cannot finish; a half-searched
            // iteration costs time and cannot improve on the previous answer.
            if (Date.now() - t0 > budget / 2) break;
        }
        if (!bestAction) {
            // fallback: first legal move
            return { type: 'move', target: moves[0] };
        }
        const result = bestAction.kind === 'move'
            ? { type: 'move', target: bestAction.target }
            : { type: 'wall', wall: bestAction.wall };
        result.stats = {
            depth: completedDepth,
            score: Math.round(bestScore * 10) / 10,
            nodes: nodeCount,
            ms: Date.now() - t0
        };
        return result;
    }

    /* ---------------- Monte-Carlo win rate ---------------- */

    /**
     * Estimate every player's win probability from ONE Monte-Carlo batch.
     * Playing each rollout once and crediting all players from the same
     * sample set keeps the bars mutually consistent (they sum to ~1) and
     * costs one pass instead of one pass per player.
     *
     * @param st game state (not modified)
     * @param rollouts number of simulations (default 120)
     * @returns {number[]} win rate per player index, each in [0,1]
     */
    function simulateWinRates(st, rollouts) {
        const nP = st.players.length;
        const wins = new Float64Array(nP);
        if (st.winner !== null) {
            if (st.winner < nP) wins[st.winner] = 1;
            return Array.from(wins);
        }
        const R = Math.max(20, Math.min(rollouts || 120, 400));
        const g = clone(st);
        for (let r = 0; r < R; r++) {
            restoreState(g, st);
            let steps = 0;
            while (g.winner === null && steps < 240) {
                const mover = g.turn;
                const act = greedyAct(g, mover);
                if (!act) break;
                rolloutApply(g, act, mover);
                steps++;
            }
            if (g.winner !== null) {
                wins[g.winner] += 1;
            } else {
                // rollout cap: split the point between the closest racers
                let best = Infinity, tied = [];
                for (let i = 0; i < nP; i++) {
                    const d = QRules.distanceToGoal(g, i);
                    if (d < best) { best = d; tied.length = 0; tied.push(i); }
                    else if (d === best) tied.push(i);
                }
                const share = 1 / tied.length;
                for (const i of tied) wins[i] += share;
            }
        }
        const out = new Array(nP);
        for (let i = 0; i < nP; i++) out[i] = wins[i] / R;
        return out;
    }

    /** Single-player convenience wrapper (kept for tests / callers). */
    function simulateWinRate(st, pi, rollouts) {
        const rates = simulateWinRates(st, rollouts);
        return rates[pi] || 0;
    }

    /** Apply a rollout action in place (already validated by greedyAct). */
    function rolloutApply(g, act, mover) {
        if (act.type === 'move') {
            const p = g.players[mover];
            p.pos.x = act.target.x; p.pos.y = act.target.y;
            if (isGoal(p.goal, p.pos.x, p.pos.y)) g.winner = mover;
            else g.turn = (mover + 1) % g.players.length;
        } else {
            const w = act.wall;
            if (w.isH) g.hw[w.y][w.x] = mover + 1;
            else g.vw[w.y][w.x] = mover + 1;
            g.players[mover].walls--;
            g.turn = (mover + 1) % g.players.length;
        }
    }

    /**
     * Fast greedy policy for rollouts: race along the shortest path; if the
     * leading opponent is not behind, occasionally (at random) drop a wall on
     * their route. The randomness diversifies rollouts — without it every
     * simulation from the same state plays out identically and the estimate
     * degenerates to 0 or 1.
     */
    function greedyAct(st, mover) {
        const me = st.players[mover];
        const moves = QRules.legalMoves(st, mover);
        if (!moves.length) return null;
        // winning move?
        for (const m of moves) {
            if (isGoal(me.goal, m.x, m.y)) return { type: 'move', target: m };
        }
        const myD = QRules.distanceToGoal(st, mover);
        let leader = -1, leaderD = Infinity;
        for (let i = 0; i < st.players.length; i++) {
            if (i === mover) continue;
            const d = QRules.distanceToGoal(st, i);
            if (d < leaderD) { leaderD = d; leader = i; }
        }
        // reactive wall with random chance
        if (me.walls > 0 && leaderD <= myD && Math.random() < 0.25) {
            const w = pickRolloutWall(st, mover, leader);
            if (w) return { type: 'wall', wall: w };
        }
        // otherwise: race (ties broken randomly so mirror games diverge)
        let bestD = Infinity;
        const bests = [];
        const px = me.pos.x, py = me.pos.y;
        for (const m of moves) {
            me.pos.x = m.x; me.pos.y = m.y;          // in place, no clone
            const d = QRules.distanceToGoal(st, mover);
            me.pos.x = px; me.pos.y = py;
            if (d < bestD) { bestD = d; bests.length = 0; bests.push(m); }
            else if (d === bestD) bests.push(m);
        }
        return { type: 'move', target: bests[Math.floor(Math.random() * bests.length)] };
    }

    /**
     * Pick a wall that slows the leading opponent down. Only walls on that
     * player's canonical shortest path are considered (cheap: ~18 anchors
     * instead of the 128-entry legalWalls scan), scored by the distance they
     * add.
     */
    function pickRolloutWall(st, mover, leader) {
        if (leader < 0) return null;
        markPathWalls(st, leader, _pmark);
        const cands = [];
        for (let idx = 0; idx < WALL_SLOTS; idx++) {
            if (!_pmark[idx]) continue;
            const isH = (idx & 1) === 0;
            const a = idx >> 1;
            const x = a % ANCH;
            const y = (a - x) / ANCH;
            if (QRules.wallConflicts(st, x, y, isH)) continue;
            cands.push({ x, y, isH });
        }
        if (!cands.length) return null;
        const baseLeader = QRules.distanceToGoal(st, leader);
        let best = null, bestGain = 0.5;
        const limit = Math.min(cands.length, 10);
        for (let k = 0; k < limit; k++) {
            const c = cands[k];
            if (c.isH) st.hw[c.y][c.x] = mover + 1; else st.vw[c.y][c.x] = mover + 1;
            const d = QRules.distanceToGoal(st, leader);
            const gain = isFinite(d) ? d - baseLeader : 0;
            if (c.isH) st.hw[c.y][c.x] = 0; else st.vw[c.y][c.x] = 0;
            if (gain > bestGain) { bestGain = gain; best = c; if (gain >= 3) break; }
        }
        if (!best) return null;
        // final legality check (a wall may not seal anyone off)
        return QRules.canPlaceWall(st, mover, best.x, best.y, best.isH) ? best : null;
    }

    /* ---------------- public API ---------------- */

    return {
        decide, simulateWinRate, simulateWinRates, evalLeaf, clone
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QAI;
