'use strict';
/* =========================================================================
 * QAI — 步步为营（Quoridor）电脑玩家
 * 依赖：全局 QRules（js/rules.js 先于本文件加载）
 *
 * 三档水平（双人 / 四人通用）：
 *   1 入门 —— 只会沿最短路走子，从不放墙。相向竞速时会借助跳跃（规则使然）。
 *   2 进阶 —— 走子 + 攻防启发式：自己领先就竞速；被追平/落后时，在对手
 *              最短路上放墙（选“延长对手多、延长自己少”的墙）。
 *   3 大师 —— 浅层极小极大搜索（双人 3 层、三人及以上 2 层，paranoid 近似）：
 *              候选动作 = 全部走子 + 剪枝后的“相关墙”（仅在棋子附近 / 已有墙旁 /
 *              最短路走廊上），叶子评估 = 距离差 ×紧迫度 + 墙资源差。
 *              搜索使用真实走子生成器，因此能预见跳跃（含被跳反超）战术。
 * 全部为同步计算，单步决策耗时约几十到几百毫秒。
 * ========================================================================= */
var QAI = (function () {

    const WIN = 100000;
    const MAX_CAND_2P = 22;    // 双人搜索每节点候选上限
    const MAX_CAND_NP = 16;    // 多人搜索每节点候选上限

    /* ---------------- 工具 ---------------- */

    function opponentsOf(st, pi) {
        const out = [];
        for (let i = 0; i < st.players.length; i++) if (i !== pi) out.push(i);
        return out;
    }

    function clone(st) {
        return {
            mode: st.mode,
            players: st.players.map(p => ({
                id: p.id, seatKey: p.seatKey, name: p.name, color: p.color, goal: p.goal,
                type: p.type, aiLevel: p.aiLevel, wallQuota: p.wallQuota, walls: p.walls,
                pos: { x: p.pos.x, y: p.pos.y }
            })),
            hw: st.hw.map(r => r.slice()),
            vw: st.vw.map(r => r.slice()),
            turn: st.turn, moveNo: st.moveNo,
            history: [],
            winner: st.winner
        };
    }

    /* ---------------- 1 级：沿最短路走 ---------------- */

    function stepLevel1(st, pi) {
        const moves = QRules.legalMoves(st, pi);
        if (!moves.length) return null;
        let best = null, bestD = Infinity;
        for (const m of moves) {
            const tmp = clone(st);
            tmp.players[pi].pos = { x: m.x, y: m.y };
            const d = QRules.distanceToGoal(tmp, pi);
            if (d < bestD) { bestD = d; best = m; }
        }
        return { type: 'move', target: best };
    }

    /* ---------------- 2 级：攻防启发式 ---------------- */

    function stepLevel2(st, pi) {
        const me = st.players[pi];
        const myD = QRules.distanceToGoal(st, pi);
        const opps = opponentsOf(st, pi).map(i => ({ i, d: QRules.distanceToGoal(st, i) }));
        opps.sort((a, b) => a.d - b.d);
        const lead = opps[0];

        // 一步制胜 → 直接走
        const moves = QRules.legalMoves(st, pi);
        for (const m of moves) {
            if (QRules.atGoal(me, m)) return { type: 'move', target: m };
        }

        // 被追平或落后，且有墙 → 放“性价比”最高的墙
        if (me.walls > 0 && lead.d <= myD) {
            const wall = bestValueWall(st, pi);
            if (wall) return { type: 'wall', wall };
        }
        return stepLevel1(st, pi);
    }

    /**
     * 遍历全部合法墙，选 增量(对手合计) − 1.5×增量(自己) 最大且 > 0.5 者。
     * （墙每回合只能放一块，必须“划算”才放。）
     */
    function bestValueWall(st, pi) {
        const legal = QRules.legalWalls(st, pi);
        if (!legal.length) return null;
        const base = st.players.map((_, i) => QRules.distanceToGoal(st, i));
        let best = null, bestGain = 0.5;
        for (const w of legal) {
            const tmp = clone(st);
            if (w.isH) tmp.hw[w.y][w.x] = 1; else tmp.vw[w.y][w.x] = 1;
            let gain = 0;
            for (let i = 0; i < st.players.length; i++) {
                const nd = QRules.distanceToGoal(tmp, i);
                const delta = nd - base[i];
                if (i === pi) gain -= 1.5 * delta;
                else gain += delta;
            }
            if (gain > bestGain) { bestGain = gain; best = w; }
        }
        return best;
    }

    /* ---------------- 3 级：浅层搜索 ---------------- */

    /** 生成 mover 的候选动作（走子优先 + 相关墙），供搜索使用 */
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
            const walls = probableWalls(st, mover);
            const base = st.players.map((_, i) => QRules.distanceToGoal(st, i));
            for (const w of walls) {
                if (QRules.wallConflicts(st, w.x, w.y, w.isH)) continue;
                const tmp = clone(st);
                if (w.isH) tmp.hw[w.y][w.x] = 1; else tmp.vw[w.y][w.x] = 1;
                if (!QRules.allReachable(tmp)) continue;   // 围死任何人的墙排除
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
     * 相关墙锚点（未过滤合法性）：
     *  - 任意棋子周边（切比雪夫距离 ≤ 2）
     *  - 已放置墙的邻接锚点（含对角）
     *  - 任意玩家最短路边经过的墙位（真正能挡到人的地方）
     */
    function probableWalls(st, mover) {
        const set = new Set();
        const add = (x, y, isH) => {
            if (x < 0 || y < 0 || x >= QRules.ANCH || y >= QRules.ANCH) return;
            set.add(x + ',' + y + ',' + (isH ? 'h' : 'v'));
        };
        // 棋子周边（水平与垂直都考虑）
        for (const p of st.players) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const ax = p.pos.x + dx, ay = p.pos.y + dy;
                    add(ax, ay, true);
                    add(ax, ay, false);
                }
            }
        }
        // 已有墙邻接
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
        // 各玩家最短路走廊：BFS 记录树边，把跨越树边的墙位加入
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

    /** 玩家 pi 一条最短路上的所有“拦截墙”位 */
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
        // 回溯路径，把每条边对应的拦截墙加入
        let cur = goalCell;
        while (prev[cur.y][cur.x]) {
            const from = prev[cur.y][cur.x];
            out.push(...edgeBlockingWalls(from, cur));
            cur = from;
        }
        return out;
    }

    /** 跨越 (from→to) 一条边的所有墙位 */
    function edgeBlockingWalls(from, to) {
        const dx = to.x - from.x, dy = to.y - from.y;
        if (dy === -1) {            // 上：h 墙位于行间隙 from.y-1，锚 (from.x,·) 或 (from.x-1,·)
            return [
                { x: from.x, y: from.y - 1, isH: true },
                { x: from.x - 1, y: from.y - 1, isH: true }
            ];
        }
        if (dy === 1) {             // 下：行间隙 from.y
            return [
                { x: from.x, y: from.y, isH: true },
                { x: from.x - 1, y: from.y, isH: true }
            ];
        }
        if (dx === -1) {            // 左：v 墙位于列间隙 from.x-1，锚 (·,from.y) 或 (·,from.y-1)
            return [
                { x: from.x - 1, y: from.y, isH: false },
                { x: from.x - 1, y: from.y - 1, isH: false }
            ];
        }
        // 右
        return [
            { x: from.x, y: from.y, isH: false },
            { x: from.x, y: from.y - 1, isH: false }
        ];
    }

    /**
     * 叶子评估（对 rootPi 而言越大越好）
     */
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
     * 极小极大（alpha-beta）。双人严格 minimax；
     * 三人以上采用 paranoid 近似（所有对手都极小化我的评分），深度降为 2。
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
                // 直接落子（candidates 已保证合法）
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

    function stepLevel3(st, pi) {
        // 一步制胜 → 直接走
        const moves = QRules.legalMoves(st, pi);
        for (const m of moves) {
            if (QRules.atGoal(st.players[pi], m)) return { type: 'move', target: m };
        }
        const depth = st.players.length === 2 ? 3 : 2;
        const cands = candidates(st, pi);
        if (!cands.length) return stepLevel1(st, pi);
        let bestAction = null, bestScore = -Infinity;
        let alpha = -Infinity, beta = Infinity;
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
            let score = search(child, pi, depth - 1, alpha, beta);
            if (c.kind === 'wall') score -= 0.15;   // 平分秋色时优先走子（省墙）
            if (score > bestScore) { bestScore = score; bestAction = c; }
            if (score > alpha) alpha = score;
        }
        if (!bestAction) return stepLevel1(st, pi);
        return bestAction.kind === 'move'
            ? { type: 'move', target: bestAction.target }
            : { type: 'wall', wall: bestAction.wall };
    }

    /* ---------------- 对外接口 ---------------- */

    /**
     * 计算电脑玩家的下一步。
     * @returns {type:'move', target:{x,y}} 或 {type:'wall', wall:{x,y,isH}} 或 null
     */
    function decide(st, pi) {
        if (st.winner !== null) return null;
        const level = st.players[pi].aiLevel;
        if (level <= 1) return stepLevel1(st, pi);
        if (level === 2) return stepLevel2(st, pi);
        return stepLevel3(st, pi);
    }

    return { decide, evalLeaf, clone };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QAI;
