'use strict';
/* =========================================================================
 * QRender — 棋盘渲染（Canvas 2D）
 * 依赖：全局 QRules。
 * 主题：CSS 变量由 index.html 的 data-theme 体系提供，
 *       渲染前用 getComputedStyle 读取实时颜色，主题切换即重绘。
 * 布局常量：
 *   pad           棋盘外边距（留出边框线）
 *   cell          格子边长；groove = cell * 0.14（放墙的凹槽）
 *   棋盘点 (x,y) → 像素 cx = pad + x*(cell+groove) + cell/2（中心）
 * ========================================================================= */
var QRender = (function () {

    const board = document.getElementById('board');
    const ctx = board.getContext('2d');

    /* ---------------- 几何 ---------------- */
    let PAD = 22, CELL = 54, GROOVE = 8;

    function computeMetrics(size) {
        const n = QRules.N;
        // 9 格 + 8 凹槽 + 2 边距；凹槽约占格宽 14%
        const unit = size / (n + (n - 1) * 0.14 + 2 * 0.42);
        CELL = unit;
        GROOVE = unit * 0.14;
        PAD = unit * 0.42;
        return { PAD, CELL, GROOVE, size };
    }

    function cellCenter(x, y) {
        return {
            cx: PAD + x * (CELL + GROOVE) + CELL / 2,
            cy: PAD + y * (CELL + GROOVE) + CELL / 2
        };
    }

    /** 格点 (gx,gy) 中心像素（格点 = 格子角点交叉处，gx,gy ∈ [0,9]） */
    function anchorCenter(gx, gy) {
        return {
            cx: PAD + gx * (CELL + GROOVE),
            cy: PAD + gy * (CELL + GROOVE)
        };
    }

    /**
     * 墙锚点 (x,y) ∈ [0,7]² 的墙体中心像素。
     * 与规则引擎的标准约定一致：h(x,y) 位于行间隙 y（行 y 与 y+1 之间）、
     * 覆盖列 x 与 x+1，墙体中心在格点 (x+1, y+1)。
     */
    function wallCenter(x, y) {
        return anchorCenter(x + 1, y + 1);
    }

    /* ---------------- 主题色 ---------------- */
    let theme = {};
    function readTheme() {
        const cs = getComputedStyle(document.documentElement);
        const v = name => cs.getPropertyValue(name).trim();
        theme = {
            boardBg: v('--board-bg'),
            boardEdge: v('--board-edge'),
            cell: v('--cell'),
            cellLine: v('--cell-line'),
            wall: v('--wall'),
            wallEdge: v('--wall-edge'),
            goalDim: parseFloat(v('--goal-dim')) || 0.55,
            pieceRing: v('--piece-ring'),
            text: v('--text'),
            muted: v('--muted'),
            brand: v('--brand')
        };
    }

    /* ---------------- 主绘制 ---------------- */

    /**
     * 绘制整盘。
     * @param st 局面
     * @param opts {
     *   hoverCell, hoverWall {x,y,isH}, legalCells [], legalWalls [],
     *   lastMove {from,to} | lastWall {x,y,isH}, mode ('move'|'wall'),
     *   currentPi, winPi
     * }
     */
    function draw(st, opts) {
        const size = board.width;
        const dpr = board._dpr || 1;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (dpr > 1) ctx.scale(dpr, dpr);
        readTheme();

        const n = QRules.N;

        // 底色
        ctx.fillStyle = theme.boardBg;
        roundRect(0, 0, size / dpr, size / dpr, 10);
        ctx.fill();

        // 目标边高亮（当前玩家的目标边）
        drawGoalEdge(st, opts.currentPi, size / dpr);

        // 格子
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const { cx, cy } = cellCenter(x, y);
                ctx.fillStyle = theme.cell;
                ctx.strokeStyle = theme.cellLine;
                ctx.lineWidth = 1;
                roundRect(cx - CELL / 2, cy - CELL / 2, CELL, CELL, 4);
                ctx.fill();
                ctx.stroke();
            }
        }

        // 已放置的墙
        for (let y = 0; y < QRules.ANCH; y++) {
            for (let x = 0; x < QRules.ANCH; x++) {
                if (st.hw[y][x]) drawWall(x, y, true, false);
                if (st.vw[y][x]) drawWall(x, y, false, false);
            }
        }

        // 最后一手标记
        if (opts.lastWall) drawWall(opts.lastWall.x, opts.lastWall.y, opts.lastWall.isH, true);

        // 走子模式：合法落点高亮 + 悬停
        if (opts.mode === 'move') {
            for (const c of (opts.legalCells || [])) {
                const { cx, cy } = cellCenter(c.x, c.y);
                ctx.fillStyle = withAlpha(theme.brand, c.jump ? 0.22 : 0.16);
                roundRect(cx - CELL / 2 + 3, cy - CELL / 2 + 3, CELL - 6, CELL - 6, 4);
                ctx.fill();
                if (c.jump) {
                    ctx.strokeStyle = withAlpha(theme.brand, 0.65);
                    ctx.lineWidth = 2;
                    roundRect(cx - CELL / 2 + 3, cy - CELL / 2 + 3, CELL - 6, CELL - 6, 4);
                    ctx.stroke();
                }
            }
            if (opts.hoverCell) {
                const { cx, cy } = cellCenter(opts.hoverCell.x, opts.hoverCell.y);
                ctx.fillStyle = withAlpha(theme.brand, 0.34);
                roundRect(cx - CELL / 2 + 2, cy - CELL / 2 + 2, CELL - 4, CELL - 4, 4);
                ctx.fill();
            }
        }

        // 放墙模式：悬停墙预览
        if (opts.mode === 'wall' && opts.hoverWall && opts.hoverWall.legal !== false) {
            drawWall(opts.hoverWall.x, opts.hoverWall.y, opts.hoverWall.isH, true);
        }
        // 放墙模式：非法位置提示（红色）
        if (opts.mode === 'wall' && opts.hoverWall && opts.hoverWall.legal === false) {
            drawIllegalHint(opts.hoverWall);
        }

        // 棋子
        for (let i = 0; i < st.players.length; i++) {
            drawPiece(st.players[i], i === opts.currentPi && st.winner === null);
        }

        // 最后一手走子轨迹
        if (opts.lastMove) {
            const a = cellCenter(opts.lastMove.from.x, opts.lastMove.from.y);
            const b = cellCenter(opts.lastMove.to.x, opts.lastMove.to.y);
            ctx.strokeStyle = withAlpha('#f59e0b', 0.75);
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            ctx.moveTo(a.cx, a.cy);
            ctx.lineTo(b.cx, b.cy);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore();
    }

    /* ---------------- 子绘制 ---------------- */

    function drawGoalEdge(st, pi, sizeCss) {
        if (pi == null || !st.players[pi]) return;
        const p = st.players[pi];
        let x, y, w, h;
        const t = Math.max(6, GROOVE);
        if (p.goal === 'N') { x = PAD - t / 2; y = 0; w = sizeCss - 2 * (PAD - t / 2); h = t; }
        else if (p.goal === 'S') { x = PAD - t / 2; y = sizeCss - t; w = sizeCss - 2 * (PAD - t / 2); h = t; }
        else if (p.goal === 'W') { x = 0; y = PAD - t / 2; w = t; h = sizeCss - 2 * (PAD - t / 2); }
        else { x = sizeCss - t; y = PAD - t / 2; w = t; h = sizeCss - 2 * (PAD - t / 2); }
        ctx.save();
        ctx.globalAlpha = theme.goalDim;
        ctx.fillStyle = p.color;
        roundRect(x, y, w, h, 4);
        ctx.fill();
        ctx.restore();
    }

    function drawWall(x, y, isH, isGhost) {
        const { cx, cy } = wallCenter(x, y);
        const L = CELL * 2 + GROOVE;   // 墙长两格
        const T = Math.max(7, GROOVE * 0.9);   // 墙厚
        ctx.save();
        if (isGhost) ctx.globalAlpha = 0.55;
        // 阴影
        ctx.fillStyle = withAlpha(theme.wallEdge, 0.5);
        roundRect(cx - L / 2 + 1.5, cy - T / 2 + 1.5, L, T, 3);
        ctx.fill();
        ctx.fillStyle = theme.wall;
        roundRect(cx - L / 2, cy - T / 2, L, T, 3);
        ctx.fill();
        ctx.strokeStyle = theme.wallEdge;
        ctx.lineWidth = 1;
        roundRect(cx - L / 2, cy - T / 2, L, T, 3);
        ctx.stroke();
        ctx.restore();
    }

    function drawIllegalHint(hover) {
        const { cx, cy } = wallCenter(hover.x, hover.y);
        const L = CELL * 2 + GROOVE, T = Math.max(7, GROOVE * 0.9);
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.5;
        roundRect(cx - L / 2, cy - T / 2, L, T, 3);
        ctx.stroke();
        ctx.restore();
    }

    function drawPiece(p, isCurrent) {
        const { cx, cy } = cellCenter(p.pos.x, p.pos.y);
        const r = CELL * 0.34;
        ctx.save();
        // 阴影
        ctx.beginPath();
        ctx.arc(cx + 1.5, cy + 2.5, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fill();
        // 主体
        const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.2, cx, cy, r);
        grad.addColorStop(0, lighten(p.color, 0.45));
        grad.addColorStop(1, p.color);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.pieceRing;
        ctx.stroke();
        // 当前回合光圈
        if (isCurrent) {
            ctx.beginPath();
            ctx.arc(cx, cy, r + 4.5, 0, Math.PI * 2);
            ctx.strokeStyle = withAlpha(p.color, 0.55);
            ctx.lineWidth = 3;
            ctx.stroke();
            // 呼吸动画由 app.js 定时触发重绘实现
        }
        ctx.restore();
    }

    /* ---------------- 工具 ---------------- */

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function withAlpha(hex, a) {
        return rgbaString(hex, a);
    }

    function rgbaString(color, a) {
        if (color.startsWith('#')) {
            let h = color.slice(1);
            if (h.length === 3) h = h.split('').map(c => c + c).join('');
            const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${a})`;
        }
        return color;
    }

    function lighten(hex, k) {
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const f = v => Math.round(v + (255 - v) * k);
        return `rgb(${f(r)},${f(g)},${f(b)})`;
    }

    /* ---------------- 反查：像素 → 格子 / 墙锚 ---------------- */

    function pixelToCell(px, py) {
        const n = QRules.N;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const { cx, cy } = cellCenter(x, y);
                if (Math.abs(px - cx) <= CELL / 2 && Math.abs(py - cy) <= CELL / 2) return { x, y };
            }
        }
        return null;
    }

    /**
     * 像素 → 墙放置意图。对每个锚点，计算指针到“水平墙中心线”与
     * “垂直墙中心线”的距离，取两者中更近（且在吸附范围内）的作为意图。
     */
    function pixelToWall(px, py) {
        const A = QRules.ANCH;
        const reach = GROOVE * 1.1 + 6;   // 吸附半径
        let best = null, bestDist = Infinity;
        for (let y = 0; y < A; y++) {
            for (let x = 0; x < A; x++) {
                const { cx, cy } = wallCenter(x, y);
                const dH = Math.abs(py - cy);   // 水平墙：贴近其水平中心线
                const dV = Math.abs(px - cx);   // 垂直墙：贴近其垂直中心线
                // 指针须落在墙体的合理范围内（长度的 ±(CELL+GROOVE/2)）
                const alongH = Math.abs(px - cx) <= CELL + GROOVE / 2;
                const alongV = Math.abs(py - cy) <= CELL + GROOVE / 2;
                const cand = [];
                if (alongH && dH < reach) cand.push({ d: dH, w: { x, y, isH: true } });
                if (alongV && dV < reach) cand.push({ d: dV, w: { x, y, isH: false } });
                for (const c of cand) {
                    if (c.d < bestDist) { bestDist = c.d; best = c.w; }
                }
            }
        }
        return best;
    }

    /* ---------------- 高分屏自适应 ---------------- */

    function resize(cssSize) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        board._dpr = dpr;
        board.style.width = cssSize + 'px';
        board.style.height = cssSize + 'px';
        board.width = Math.round(cssSize * dpr);
        board.height = Math.round(cssSize * dpr);
        computeMetrics(cssSize);
    }

    return {
        board, ctx, draw, resize,
        cellCenter, anchorCenter, wallCenter, pixelToCell, pixelToWall,
        get CELL() { return CELL; }, get GROOVE() { return GROOVE; }, get PAD() { return PAD; },
        readTheme
    };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QRender;
