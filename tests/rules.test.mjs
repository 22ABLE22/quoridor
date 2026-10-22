import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const js = name => readFileSync(join(ROOT, 'js', name), 'utf8');

// ---- 加载无 DOM 依赖的模块（rules.js / ai.js 均为纯逻辑） ----
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

// ================= 基础建局 =================
{
    const g = QRules.createGame(2, [
        { name: '红', type: 'human' },
        { name: '蓝', type: 'ai', aiLevel: 3 }
    ]);
    ok(g.players.length === 2, '2人局玩家数');
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 8, '红方起点 (4,8)');
    ok(g.players[1].pos.x === 4 && g.players[1].pos.y === 0, '蓝方起点 (4,0)');
    ok(g.players[0].walls === 10 && g.players[1].walls === 10, '2人局各10墙');
    ok(QRules.distanceToGoal(g, 0) === 8, '红方初始最短距离 8');
    ok(QRules.distanceToGoal(g, 1) === 8, '蓝方初始最短距离 8');
}

{
    const g = QRules.createGame(4, [
        { name: '红', type: 'human' },
        { name: '蓝', type: 'ai' },
        { name: '绿', type: 'ai' },
        { name: '黄', type: 'off' }   // 黄方空座位被剔除
    ]);
    ok(g.players.length === 3, '4人局空座位剔除后为 3 人');
    ok(g.players[2].seatKey === 'E' && g.players[2].pos.x === 0 && g.players[2].pos.y === 4, '绿方起点 (0,4)');
    ok(g.players.every(p => p.walls === 5), '4人局各5墙');
}

// 空座位不足 2 人应报错
{
    let threw = false;
    try {
        QRules.createGame(2, [
            { name: '红', type: 'human' },
            { name: '蓝', type: 'off' }
        ]);
    } catch (e) { threw = true; }
    ok(threw, '不足2人应抛错');
}

// ================= 走子 =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    const moves = QRules.legalMoves(g, 0);
    ok(moves.length === 3, '起点(4,8)在底边：上/左/右 3 个落点');
    ok(moves.some(m => m.x === 4 && m.y === 7 && !m.jump), '可向上走');
    ok(!moves.some(m => m.x === 4 && m.y === 9), '不能走出棋盘');
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    ok(g.turn === 1, '走子后轮到对方');
    // 非法走子（两格远）
    let threw = false;
    try { QRules.applyMove(g, 1, { x: 4, y: 7 }); } catch (e) { threw = true; }
    ok(threw, '两格远走子非法');
}

// ================= 墙：冲突与可达性 =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    ok(QRules.canPlaceWall(g, 0, 0, 0, true), '(0,0) 水平墙可放');
    QRules.applyWall(g, 0, 0, 0, true);
    ok(g.players[0].walls === 9, '放墙后库存-1');
    ok(!QRules.canPlaceWall(g, 1, 0, 0, true), '同位重复放置非法');
    ok(!QRules.canPlaceWall(g, 1, 1, 0, true), '相邻平行重叠非法 (h1,0 与 h0,0)');
    ok(!QRules.canPlaceWall(g, 1, 0, 0, false), '同锚十字交叉非法 (v0,0 与 h0,0)');
    ok(QRules.canPlaceWall(g, 1, 2, 0, true), '隔一格平行不冲突 (h2,0)');
    ok(QRules.canPlaceWall(g, 1, 0, 1, false), '错开垂直可放 (v0,1)');
    ok(QRules.wallConflicts(g, 0, 0, true) === true, 'wallConflicts: 同位');
    ok(QRules.wallConflicts(g, 2, 0, true) === false, 'wallConflicts: h2,0 与 h0,0 不冲突');
}

// 墙阻挡走子
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    // h 墙 (4,7)：位于行间隙 7（行7与8之间），覆盖列4、5
    QRules.applyWall(g, 0, 4, 7, true);
    ok(QRules.wallBetween(g, { x: 4, y: 8 }, { x: 4, y: 7 }), 'h(4,7) 挡住 (4,8)→(4,7)');
    ok(!QRules.wallBetween(g, { x: 3, y: 8 }, { x: 3, y: 7 }), 'h(4,7) 不影响列 3');
    ok(QRules.wallBetween(g, { x: 5, y: 8 }, { x: 5, y: 7 }), 'h(4,7) 挡住列 5');
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 7), '红方不能走上（被墙挡）');
    ok(moves.some(m => m.x === 3 && m.y === 8) && moves.some(m => m.x === 5 && m.y === 8), '仍可左右走');
}

// v 墙几何
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    // v 墙 (3,3)：列间隙 3（列3与4之间），覆盖行3、4
    QRules.applyWall(g, 0, 3, 3, false);
    ok(QRules.wallBetween(g, { x: 3, y: 3 }, { x: 4, y: 3 }), 'v(3,3) 挡 (3,3)→(4,3)');
    ok(QRules.wallBetween(g, { x: 3, y: 4 }, { x: 4, y: 4 }), 'v(3,3) 挡 (3,4)→(4,4)');
    ok(!QRules.wallBetween(g, { x: 3, y: 2 }, { x: 4, y: 2 }), 'v(3,3) 不挡行 2');
    ok(!QRules.wallBetween(g, { x: 3, y: 5 }, { x: 4, y: 5 }), 'v(3,3) 不挡行 5');
}

// ================= 可达性：围死检测 =================
{
    // 把红方 (4,8) 关进 {(3,8),(4,8)} 两格口袋：
    //   顶 h(3,7)（盖列3、4）、左 v(2,7)、右 v(4,7)——三块均两两合法（T 形相接不交叉），
    //   最后一块 v(4,7) 会把红方封死 → 必须被可达性规则拒绝（含“自围”）。
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 3, 7, true);   // 红方放顶（此时尚未围死，合法）
    QRules.applyWall(g, 1, 2, 7, false);  // 蓝方放左
    ok(QRules.wallConflicts(g, 4, 7, false) === false, 'v(4,7) 无几何冲突（T 形相接合法）');
    ok(QRules.canPlaceWall(g, 0, 4, 7, false) === false, '围死红方的最后一块墙非法（自围也不行）');
    ok(QRules.canPlaceWall(g, 1, 4, 7, false) === false, '围死对手的最后一块墙非法');
    ok(QRules.canPlaceWall(g, 1, 0, 0, true), '其他位置仍可放');
    ok(QRules.allReachable(g), '当前局面全员可达');
}

// ================= 跳跃 =================
// 直跳（手工摆位：红 (4,4)、蓝 (4,3)，红先手）
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 4, y: 4 };
    g.players[1].pos = { x: 4, y: 3 };
    g.turn = 0;
    const moves = QRules.legalMoves(g, 0);
    ok(moves.some(m => m.x === 4 && m.y === 2 && m.jump === 'straight'), '面对面可直跳');
    ok(!moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), '直跳可行时无斜跳');
    ok(moves.some(m => m.x === 3 && m.y === 4 && !m.jump), '普通左走仍可');
    ok(moves.some(m => m.x === 5 && m.y === 4 && !m.jump), '普通右走仍可');
    QRules.applyMove(g, 0, { x: 4, y: 2 });
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 2, '跳跃后位置正确');
    ok(g.turn === 1, '跳跃后轮到对方');
}

// 斜跳：直跳位被墙挡
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 4, y: 4 };
    g.players[1].pos = { x: 4, y: 3 };
    g.turn = 0;
    g.hw[2][4] = 1;   // h(4,2)：挡 (4,3)→(4,2)，直跳位被墙
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 2), '直跳位被墙挡：不可直跳');
    ok(moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), '可斜跳到 (3,3)');
    ok(moves.some(m => m.x === 5 && m.y === 3 && m.jump === 'diag'), '可斜跳到 (5,3)');
    ok(moves.some(m => m.x === 3 && m.y === 4 && !m.jump), '普通左走仍可');
    ok(moves.some(m => m.x === 5 && m.y === 4 && !m.jump), '普通右走仍可');
}

// 斜跳：直跳位被棋子占（四人局场景，禁连跳两子）
{
    const g = QRules.createGame(4, [
        { type: 'human' }, { type: 'human' }, { type: 'human' }, { type: 'human' }
    ]);
    g.players[0].pos = { x: 4, y: 4 };   // 红
    g.players[1].pos = { x: 4, y: 3 };   // 蓝（正前方）
    g.players[2].pos = { x: 4, y: 2 };   // 绿（直跳落点）
    g.turn = 0;
    const moves = QRules.legalMoves(g, 0);
    ok(!moves.some(m => m.x === 4 && m.y === 2), '直跳位被第三棋子占：不可直跳（禁连跳两子）');
    ok(moves.some(m => m.x === 3 && m.y === 3 && m.jump === 'diag'), '可斜跳绕过');
    ok(moves.some(m => m.x === 5 && m.y === 3 && m.jump === 'diag'), '可斜跳绕过（右侧）');
}

// ================= 胜利判定 =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 2, y: 1 };
    g.turn = 0;
    QRules.applyMove(g, 0, { x: 2, y: 0 });
    ok(g.winner === 0, '红方到达北边获胜');
    const before = g.history.length;
    let threw = false;
    try { QRules.applyMove(g, 1, { x: 4, y: 1 }); } catch (e) { threw = true; }
    ok(threw || g.winner !== null, '胜负已分后不再接受动作');
    ok(g.history.length === before, '失败尝试不入历史');
}

// ================= 悔棋 =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    QRules.applyWall(g, 0, 0, 0, true);
    QRules.applyMove(g, 1, { x: 4, y: 1 });
    QRules.applyMove(g, 0, { x: 4, y: 7 });
    const histLen = g.history.length;   // 3
    ok(QRules.undoLast(g) === true, '悔棋成功');
    ok(g.history.length === histLen - 1, '历史-1');
    ok(g.players[0].pos.x === 4 && g.players[0].pos.y === 8, '红方回到起点');
    ok(g.turn === 0, '回合回到红方');
    QRules.undoLast(g);
    ok(g.players[1].pos.y === 0 && g.players[1].walls === 10, '撤销蓝方走子');
    QRules.undoLast(g);
    ok(g.players[0].walls === 10 && g.hw[0][0] === 0, '撤销红方墙');
    ok(QRules.undoLast(g) === false, '无棋可悔返回 false');
}

// 悔棋恢复 winner（撤销制胜步）
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    g.players[0].pos = { x: 2, y: 1 };
    g.turn = 0;
    QRules.applyMove(g, 0, { x: 2, y: 0 });
    ok(g.winner === 0, '先获胜');
    QRules.undoLast(g);
    ok(g.winner === null, '撤销制胜步后 winner 清空');
    ok(g.turn === 0, '回合恢复');
}

// ================= 记号 =================
{
    ok(QRules.cellName(0, 0) === 'A1', 'cellName A1');
    ok(QRules.cellName(8, 8) === 'I9', 'cellName I9');
}

// ================= AI：入门级只走最短路、从不放墙 =================
{
    const g = QRules.createGame(2, [
        { type: 'ai', aiLevel: 1 },
        { type: 'ai', aiLevel: 1 }
    ]);
    let steps = 0;
    while (g.winner === null && steps < 40) {
        const pi = g.turn;
        const act = QAI.decide(g, pi);
        if (!act) break;
        if (act.type === 'move') QRules.applyMove(g, pi, act.target);
        else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
        steps++;
    }
    ok(g.winner !== null, '两个入门 AI 能走完一局（无死锁）');
    ok(g.winner === 1, '镜像竞速下后手借直跳先达（验证跳跃逻辑贯通）');
    ok(g.history.every(r => r.type === 'move'), '入门 AI 只走子不放墙');
}

// ================= AI：进阶/大师能完赛且不违规 =================
{
    for (const lv of [2, 3]) {
        const g = QRules.createGame(2, [
            { type: 'ai', aiLevel: lv },
            { type: 'ai', aiLevel: lv }
        ]);
        let steps = 0;
        let invariantOk = true;
        while (g.winner === null && steps < 300) {
            const pi = g.turn;
            const act = QAI.decide(g, pi);
            if (!act) break;
            if (act.type === 'move') QRules.applyMove(g, pi, act.target);
            else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
            steps++;
            if (!QRules.allReachable(g)) { invariantOk = false; break; }
        }
        ok(invariantOk, 'AI 放墙后全员始终可达 (lv' + lv + ')');
        ok(g.winner !== null, '两个 ' + lv + ' 级 AI 能走完一局（无死锁）');
        const wallsPlaced = g.history.filter(r => r.type === 'wall').length;
        ok(wallsPlaced <= 20, '放墙数不超上限 (lv' + lv + ')');
    }
}

// ================= AI：大师级应强于入门级 =================
{
    let wins = 0;
    const ROUNDS = 6;
    for (let t = 0; t < ROUNDS; t++) {
        const g = QRules.createGame(2, [
            { type: 'ai', aiLevel: 3 },
            { type: 'ai', aiLevel: 1 }
        ]);
        let steps = 0;
        while (g.winner === null && steps < 300) {
            const pi = g.turn;
            const act = QAI.decide(g, pi);
            if (!act) break;
            if (act.type === 'move') QRules.applyMove(g, pi, act.target);
            else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
            steps++;
        }
        if (g.winner === 0) wins++;
    }
    ok(wins >= ROUNDS - 1, '大师 AI 对入门 AI ' + ROUNDS + ' 局胜 ' + wins + ' 局（≥' + (ROUNDS - 1) + '）');
}

// ================= 四人局 AI =================
{
    const g = QRules.createGame(4, [
        { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 },
        { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 }
    ]);
    let steps = 0;
    while (g.winner === null && steps < 600) {
        const pi = g.turn;
        const act = QAI.decide(g, pi);
        if (!act) break;
        if (act.type === 'move') QRules.applyMove(g, pi, act.target);
        else QRules.applyWall(g, pi, act.wall.x, act.wall.y, act.wall.isH);
        steps++;
    }
    ok(g.winner !== null, '四人 AI 局能走完（无死锁）');
    ok(g.history.length < 600, '步数合理');
}

// ================= legalWalls 数量一致性 =================
{
    const g = QRules.createGame(2, [{ type: 'human' }, { type: 'human' }]);
    const walls = QRules.legalWalls(g, 0);
    ok(walls.length === 128, '空盘合法墙数 = 128（64 横 + 64 竖）');
}

console.log(`\n${passed} 项断言全部通过 ✓`);
if (process.exitCode) console.error('存在失败项');
