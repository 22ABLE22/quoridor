'use strict';
/* =========================================================================
 * QRules — 步步为营（Quoridor）规则引擎
 * 纯逻辑实现，不依赖 DOM，可直接在浏览器（经典 script）与 Node（vm）中运行。
 *
 * 坐标系：棋盘 9×9 格，x 为列（0..8，自左向右），y 为行（0..8，自上向下）。
 *   2 人：红方 (4,8)→北 y=0；蓝方 (4,0)→南 y=8
 *   4 人：红 (4,8)→北 y=0；蓝 (4,0)→南 y=8；绿 (0,4)→东 x=8；黄 (8,4)→西 x=0
 *
 * 挡板锚点：8×8 内部格点，锚 (x,y) ∈ [0,7]²，
 *   h 墙 (x,y)：位于行间隙 y（行 y 与 y+1 之间），覆盖列 x 与 x+1，中心格点 (x+1,y+1)
 *   v 墙 (x,y)：位于列间隙 x（列 x 与 x+1 之间），覆盖行 y 与 y+1，中心格点 (x+1,y+1)
 * 墙的存储值：hw[y][x] / vw[y][x] ∈ {0=无墙, 1..players.length=放置者下标+1}。
 *   存归属是为了渲染时按放置者颜色着色；所有判定统一用 >0。
 * 冲突规则：
 *   平行重叠：h(x,y) 与 h(x±1,y) / v(x,y) 与 v(x,y±1) 共享通路 → 非法
 *   十字交叉：h(x,y) 与 v(x,y) 共享中心格点（"＋"形）→ 非法
 *   端点相接（L 形 / T 形 / 直线延续，如 h(x,y) 与 h(x+2,y)）→ 合法
 *   另外任何墙不得使任意玩家完全无法到达目标边（BFS 校验）
 * ========================================================================= */
var QRules = (function () {

    const N = 9;          // 棋盘边长
    const ANCH = N - 1;   // 挡板锚点边长（8）

    // Seat templates: color / default name / start cell / goal edge
    const SEAT_DEFS = [
        { key: 'N', name: 'Red',   color: '#d64545', start: { x: 4, y: 8 }, goal: 'N' },
        { key: 'S', name: 'Blue',  color: '#3f6fd8', start: { x: 4, y: 0 }, goal: 'S' },
        { key: 'E', name: 'Green', color: '#2e9e63', start: { x: 0, y: 4 }, goal: 'E' },
        { key: 'W', name: 'Gold',  color: '#cf9430', start: { x: 8, y: 4 }, goal: 'W' }
    ];

    // 四个移动方向：上右下左（屏幕坐标，y 向下）
    const DIRS = [
        { dx: 0, dy: -1, name: '上' },
        { dx: 1, dy: 0, name: '右' },
        { dx: 0, dy: 1, name: '下' },
        { dx: -1, dy: 0, name: '左' }
    ];

    const inBoard = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
    const inAnchor = (x, y) => x >= 0 && x < ANCH && y >= 0 && y < ANCH;

    /* ------------------------------------------------------------------ */
    /* 创建对局                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Create a game.
     * @param {number} mode 2 or 4
     * @param {Array} seats seat config, length = mode, each element:
     *   { name: string, type: 'human'|'ai'|'off' }
     *   seats with type 'off' are dropped (not part of the game).
     */
    function createGame(mode, seats) {
        if (mode !== 2 && mode !== 4) throw new Error('mode must be 2 or 4');
        const defs = SEAT_DEFS.slice(0, mode);
        const players = [];
        for (let i = 0; i < mode; i++) {
            const seat = seats && seats[i] ? seats[i] : {};
            if (seat.type === 'off') continue;
            players.push({
                id: i,
                seatKey: defs[i].key,
                name: (seat.name || defs[i].name).slice(0, 12) || defs[i].name,
                color: defs[i].color,
                goal: defs[i].goal,
                type: seat.type === 'ai' ? 'ai' : 'human',
                wallQuota: mode === 2 ? 10 : 5,
                walls: mode === 2 ? 10 : 5,
                pos: { x: defs[i].start.x, y: defs[i].start.y }
            });
        }
        if (players.length < 2) throw new Error('at least 2 players are required');
        return {
            mode,
            players,
            hw: emptyAnchors(),   // hw[y][x] = 1 → horizontal wall at anchor (x,y)
            vw: emptyAnchors(),   // vw[y][x] = 1 → vertical wall at anchor (x,y)
            turn: 0,              // index into players
            moveNo: 1,
            history: [],
            winner: null
        };
    }

    function emptyAnchors() {
        return Array.from({ length: ANCH }, () => new Array(ANCH).fill(0));
    }

    /* ------------------------------------------------------------------ */
    /* 通路（passage）与墙的几何                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 相邻两格之间是否有墙（不考虑棋子）。
     * from → to 必须正交相邻。
     */
    function wallBetween(st, from, to) {
        const dx = to.x - from.x, dy = to.y - from.y;
        if (dx === 0 && dy === -1) {          // 上：行间隙 y-1，覆盖列边界 x 的 h 墙锚 x 或 x-1
            const gy = from.y - 1;
            return (from.x < ANCH && st.hw[gy][from.x] > 0) ||
                   (from.x > 0 && st.hw[gy][from.x - 1] > 0);
        }
        if (dx === 0 && dy === 1) {           // 下：行间隙 y，锚 x 或 x-1
            const gy = from.y;
            return (from.x < ANCH && st.hw[gy][from.x] > 0) ||
                   (from.x > 0 && st.hw[gy][from.x - 1] > 0);
        }
        if (dx === -1 && dy === 0) {          // 左：列间隙 x-1，锚 y 或 y-1
            const gx = from.x - 1;
            return (from.y < ANCH && st.vw[from.y][gx] > 0) ||
                   (from.y > 0 && st.vw[from.y - 1][gx] > 0);
        }
        if (dx === 1 && dy === 0) {           // 右：列间隙 x，锚 y 或 y-1
            const gx = from.x;
            return (from.y < ANCH && st.vw[from.y][gx] > 0) ||
                   (from.y > 0 && st.vw[from.y - 1][gx] > 0);
        }
        throw new Error('wallBetween: cells must be orthogonally adjacent');
    }

    /**
     * 墙放置冲突检查（不含可达性检查）。
     * @param isH true = 水平墙
     */
    function wallConflicts(st, x, y, isH) {
        if (!inAnchor(x, y)) return true;
        if (isH) {
            if (st.hw[y][x] > 0) return true;                    // 原位已占用
            if (x > 0 && st.hw[y][x - 1] > 0) return true;       // 左侧重叠
            if (x < ANCH - 1 && st.hw[y][x + 1] > 0) return true;// 右侧重叠
            if (st.vw[y][x] > 0) return true;                    // 同锚十字交叉
        } else {
            if (st.vw[y][x] > 0) return true;
            if (y > 0 && st.vw[y - 1][x] > 0) return true;       // 上侧重叠
            if (y < ANCH - 1 && st.vw[y + 1][x] > 0) return true;// 下侧重叠
            if (st.hw[y][x] > 0) return true;                    // 同锚十字交叉
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* BFS：忽略棋子的最短距离（用于可达性校验与 AI 评估）                   */
    /* ------------------------------------------------------------------ */

    /** goal 判定（对象版，外部 API；BFS 内部用坐标版 atGoalXY） */
    function atGoal(p, cell) {
        return atGoalXY(p.goal, cell.x, cell.y);
    }

    // 可复用的 scratch buffers：规则引擎是单线程使用（浏览器主线程或
    // Worker 内各持一份 QRules 实例），避免每次 BFS 分配 81 格数组。
    const _dist = Array.from({ length: N }, () => new Int16Array(N));
    const _queue = new Int16Array(N * N);

    /**
     * 玩家从当前位置到目标边的最短步数（忽略其它棋子，只考虑墙）。
     * 不可达返回 Infinity。零堆分配（scratch buffer 复用）。
     */
    function distanceToGoal(st, pi) {
        const p = st.players[pi];
        const px = p.pos.x, py = p.pos.y;
        if (atGoalXY(p.goal, px, py)) return 0;
        const hw = st.hw, vw = st.vw;
        const dist = _dist;
        // 惰性代：用 moveNo×玩家数+1 做世代标记，避免每次清 81 格。
        // 简化做法：由于 81 格很小，直接 fill(-1) 也远快于分配新数组。
        for (let y = 0; y < N; y++) dist[y].fill(-1);
        const q = _queue;
        let head = 0, tail = 0;
        q[tail++] = py * N + px;
        dist[py][px] = 0;
        while (head < tail) {
            const cell = q[head++];
            const cx = cell % N, cy = (cell - cx) / N;
            const d = dist[cy][cx] + 1;
            // 上（行间隙 cy-1，h 锚 (cx,·)/(cx-1,·)）
            if (cy > 0 && dist[cy - 1][cx] < 0) {
                const gy = cy - 1;
                if (!((cx < ANCH && hw[gy][cx] > 0) || (cx > 0 && hw[gy][cx - 1] > 0))) {
                    if (atGoalXY(p.goal, cx, cy - 1)) return d;
                    dist[cy - 1][cx] = d;
                    q[tail++] = (cy - 1) * N + cx;
                }
            }
            // 下（行间隙 cy）
            if (cy < N - 1 && dist[cy + 1][cx] < 0) {
                const gy = cy;
                if (!((cx < ANCH && hw[gy][cx] > 0) || (cx > 0 && hw[gy][cx - 1] > 0))) {
                    if (atGoalXY(p.goal, cx, cy + 1)) return d;
                    dist[cy + 1][cx] = d;
                    q[tail++] = (cy + 1) * N + cx;
                }
            }
            // 左（列间隙 cx-1，v 锚 (·,cy)/(·,cy-1)）
            if (cx > 0 && dist[cy][cx - 1] < 0) {
                const gx = cx - 1;
                if (!((cy < ANCH && vw[cy][gx] > 0) || (cy > 0 && vw[cy - 1][gx] > 0))) {
                    if (atGoalXY(p.goal, cx - 1, cy)) return d;
                    dist[cy][cx - 1] = d;
                    q[tail++] = cy * N + (cx - 1);
                }
            }
            // 右（列间隙 cx）
            if (cx < N - 1 && dist[cy][cx + 1] < 0) {
                const gx = cx;
                if (!((cy < ANCH && vw[cy][gx] > 0) || (cy > 0 && vw[cy - 1][gx] > 0))) {
                    if (atGoalXY(p.goal, cx + 1, cy)) return d;
                    dist[cy][cx + 1] = d;
                    q[tail++] = cy * N + (cx + 1);
                }
            }
        }
        return Infinity;
    }

    /** goal 判定（坐标版，BFS 内联用，避免构造对象） */
    function atGoalXY(goal, x, y) {
        switch (goal) {
            case 'N': return y === 0;
            case 'S': return y === N - 1;
            case 'E': return x === N - 1;
            case 'W': return x === 0;
        }
        return false;
    }

    /**
     * 玩家 pi 的一条最短路径（忽略其它棋子）。
     * 返回 [{x,y}, ...]（含起点与终点格）；不可达返回 null。
     * 供 UI 画"最短路径可视化"。BFS 从目标边反向回溯。
     */
    function shortestPath(st, pi) {
        const p = st.players[pi];
        const px = p.pos.x, py = p.pos.y;
        if (atGoalXY(p.goal, px, py)) return [{ x: px, y: py }];
        const hw = st.hw, vw = st.vw;
        // dist: 从起点出发的步数；prev: BFS 树父节点（用于回溯）
        const dist = Array.from({ length: N }, () => new Array(N).fill(-1));
        const prev = Array.from({ length: N }, () => new Array(N).fill(null));
        const q = [];
        q.push([px, py]);
        dist[py][px] = 0;
        let head = 0, goalCell = null;
        while (head < q.length && !goalCell) {
            const [cx, cy] = q[head++];
            const d = dist[cy][cx] + 1;
            const tryStep = (nx, ny, wall) => {
                if (wall || dist[ny][nx] >= 0) return false;
                dist[ny][nx] = d;
                prev[ny][nx] = [cx, cy];
                if (atGoalXY(p.goal, nx, ny)) { goalCell = [nx, ny]; return true; }
                q.push([nx, ny]);
                return false;
            };
            // 四方向（与 distanceToGoal 相同的墙检查；边界先判，防止 hw/vw 越界）
            if (cy > 0) {
                const gy = cy - 1;
                tryStep(cx, cy - 1, (cx < ANCH && hw[gy][cx] > 0) || (cx > 0 && hw[gy][cx - 1] > 0));
                if (goalCell) break;
            }
            if (cy < N - 1) {
                const gy = cy;
                tryStep(cx, cy + 1, (cx < ANCH && hw[gy][cx] > 0) || (cx > 0 && hw[gy][cx - 1] > 0));
                if (goalCell) break;
            }
            if (cx > 0) {
                const gx = cx - 1;
                tryStep(cx - 1, cy, (cy < ANCH && vw[cy][gx] > 0) || (cy > 0 && vw[cy - 1][gx] > 0));
                if (goalCell) break;
            }
            if (cx < N - 1) {
                const gx = cx;
                tryStep(cx + 1, cy, (cy < ANCH && vw[cy][gx] > 0) || (cy > 0 && vw[cy - 1][gx] > 0));
                if (goalCell) break;
            }
        }
        if (!goalCell) return null;
        const path = [];
        let cur = goalCell;
        while (cur) {
            path.push({ x: cur[0], y: cur[1] });
            cur = prev[cur[1]][cur[0]];
        }
        path.reverse();
        return path;
    }

    /** 所有玩家是否都仍能到达各自目标边（忽略棋子） */
    function allReachable(st) {
        for (let i = 0; i < st.players.length; i++) {
            if (!isFinite(distanceToGoal(st, i))) return false;
        }
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* 合法动作                                                            */
    /* ------------------------------------------------------------------ */

    function occupiedBy(st, cell, exceptPi) {
        for (let i = 0; i < st.players.length; i++) {
            if (i === exceptPi) continue;
            const q = st.players[i].pos;
            if (q.x === cell.x && q.y === cell.y) return i;
        }
        return -1;
    }

    /**
     * 当前玩家 pi 的全部合法走子目标（含直跳与斜跳）。
     * 返回 [{x, y, jump: null|'straight'|'diag'}]
     */
    function legalMoves(st, pi) {
        const me = st.players[pi];
        const out = [];
        for (const dir of DIRS) {
            const t1 = { x: me.pos.x + dir.dx, y: me.pos.y + dir.dy };
            if (!inBoard(t1.x, t1.y)) continue;
            if (wallBetween(st, me.pos, t1)) continue;
            const occ = occupiedBy(st, t1, pi);
            if (occ === -1) {
                out.push({ x: t1.x, y: t1.y, jump: null });
                continue;
            }
            // 正前方是棋子：尝试直跳
            const t2 = { x: me.pos.x + 2 * dir.dx, y: me.pos.y + 2 * dir.dy };
            const straightOk = inBoard(t2.x, t2.y) &&
                !wallBetween(st, t1, t2) &&
                occupiedBy(st, t2, pi) === -1;
            if (straightOk) {
                out.push({ x: t2.x, y: t2.y, jump: 'straight' });
                continue;   // 直跳可行时，该方向只允许直跳（斜跳不可选）
            }
            // 直跳被墙 / 边界 / 第三棋子阻挡 → 斜跳到两侧
            for (const s of [1, 3]) {   // 与 dir 垂直的两个方向（右/左）
                const side = DIRS[(dirIndex(dir) + s) % 4];
                const ts = { x: t1.x + side.dx, y: t1.y + side.dy };
                if (!inBoard(ts.x, ts.y)) continue;
                if (wallBetween(st, t1, ts)) continue;
                if (occupiedBy(st, ts, pi) !== -1) continue;
                out.push({ x: ts.x, y: ts.y, jump: 'diag' });
            }
        }
        return out;
    }

    function dirIndex(dir) {
        return DIRS.findIndex(d => d.dx === dir.dx && d.dy === dir.dy);
    }

    /**
     * 墙是否可由玩家 pi 放置（有库存 + 无冲突 + 不围死任何人）。
     */
    function canPlaceWall(st, pi, x, y, isH) {
        if (st.winner !== null) return false;
        if (st.players[pi].walls <= 0) return false;
        if (wallConflicts(st, x, y, isH)) return false;
        // 试放后所有玩家仍可达（临时值 1，仅作占位）
        if (isH) st.hw[y][x] = 1; else st.vw[y][x] = 1;
        const ok = allReachable(st);
        if (isH) st.hw[y][x] = 0; else st.vw[y][x] = 0;
        return ok;
    }

    /** 玩家 pi 的全部合法墙 [{x, y, isH}]（无库存时为空） */
    function legalWalls(st, pi) {
        const out = [];
        if (st.players[pi].walls <= 0) return out;
        for (let y = 0; y < ANCH; y++) {
            for (let x = 0; x < ANCH; x++) {
                if (!wallConflicts(st, x, y, true) ) {
                    st.hw[y][x] = 1;
                    if (allReachable(st)) out.push({ x, y, isH: true });
                    st.hw[y][x] = 0;
                }
                if (!wallConflicts(st, x, y, false)) {
                    st.vw[y][x] = 1;
                    if (allReachable(st)) out.push({ x, y, isH: false });
                    st.vw[y][x] = 0;
                }
            }
        }
        return out;
    }

    /**
     * 读取锚点 (x,y) 处墙的放置者（players 下标）。
     * 无墙返回 -1；返回值可直接用于渲染着色。
     */
    function wallOwner(st, x, y, isH) {
        const v = isH ? st.hw[y][x] : st.vw[y][x];
        return v > 0 ? v - 1 : -1;
    }

    /* ------------------------------------------------------------------ */
    /* 执行动作 / 悔棋                                                     */
    /* ------------------------------------------------------------------ */

    function nextTurn(st) {
        st.turn = (st.turn + 1) % st.players.length;
        if (st.turn === 0) st.moveNo++;
    }

    /** 走子（target 必须在 legalMoves 中），返回记录用的描述对象 */
    function applyMove(st, pi, target) {
        if (st.winner !== null) throw new Error('game over');
        if (pi !== st.turn) throw new Error('not your turn');
        const p = st.players[pi];
        const move = legalMoves(st, pi).find(m => m.x === target.x && m.y === target.y);
        if (!move) throw new Error('illegal move');
        const from = { x: p.pos.x, y: p.pos.y };
        p.pos = { x: target.x, y: target.y };
        const rec = { type: 'move', pi, from, to: { x: target.x, y: target.y }, jump: move.jump };
        st.history.push(rec);
        if (atGoal(p, p.pos)) st.winner = pi;
        else nextTurn(st);
        return rec;
    }

    /** 放墙（必须通过 canPlaceWall）。存储值为 pi+1（放置者归属，用于渲染着色） */
    function applyWall(st, pi, x, y, isH) {
        if (st.winner !== null) throw new Error('game over');
        if (pi !== st.turn) throw new Error('not your turn');
        if (!canPlaceWall(st, pi, x, y, isH)) throw new Error('illegal wall');
        if (isH) st.hw[y][x] = pi + 1; else st.vw[y][x] = pi + 1;
        st.players[pi].walls--;
        const rec = { type: 'wall', pi, x, y, isH: !!isH };
        st.history.push(rec);
        nextTurn(st);
        return rec;
    }

    /** 撤销最后一步（无悔可撤时返回 false） */
    function undoLast(st) {
        const rec = st.history.pop();
        if (!rec) return false;
        st.winner = null;
        if (rec.type === 'move') {
            st.players[rec.pi].pos = { x: rec.from.x, y: rec.from.y };
        } else {
            if (rec.isH) st.hw[rec.y][rec.x] = 0; else st.vw[rec.y][rec.x] = 0;
            st.players[rec.pi].walls++;
        }
        // 回到该步行动者的回合
        st.turn = rec.pi;
        // moveNo 用“已走步数 / 人数”整除计算，天然回退
        st.moveNo = Math.floor(st.history.length / st.players.length) + 1;
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* 坐标记号（用于历史记录显示）                                          */
    /* ------------------------------------------------------------------ */

    const COLS = 'ABCDEFGHI';
    function cellName(x, y) { return COLS[x] + (y + 1); }
    function wallName(x, y, isH) { return cellName(x, y) + (isH ? 'h' : 'v'); }
    function moveDesc(rec) {
        if (rec.type === 'move') {
            const tag = rec.jump ? ' (jump)' : '';
            return cellName(rec.from.x, rec.from.y) + '→' + cellName(rec.to.x, rec.to.y) + tag;
        }
        return 'wall ' + wallName(rec.x, rec.y, rec.isH);
    }

    /* ------------------------------------------------------------------ */

    return {
        N, ANCH, SEAT_DEFS, DIRS,
        createGame,
        inBoard, inAnchor,
        wallBetween, wallConflicts, wallOwner,
        distanceToGoal, allReachable, atGoal, shortestPath,
        legalMoves, canPlaceWall, legalWalls,
        applyMove, applyWall, undoLast,
        cellName, wallName, moveDesc
    };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QRules;
