'use strict';
/* =========================================================================
 * QRender — board rendering (Canvas 2D)
 * Depends on: global QRules. Theme colors are read from CSS variables
 * (index.html data-theme system), so theme switching triggers a redraw.
 *
 * Geometry (CSS pixels; the canvas is scaled for devicePixelRatio):
 *   pad      outer margin (board frame)
 *   cell     square cell size; groove = cell * 0.16 (wall channel)
 *   Cell (x,y) occupies  [pad + x*(cell+groove), +cell] in both axes.
 *
 * WALL GEOMETRY (fixes the "only horizontal walls" bug):
 *   An h-wall at anchor (x,y) lives in the ROW groove between rows y and y+1
 *   and spans columns x and x+1. Its center line is the groove's horizontal
 *   center: cy = pad + y*(cell+groove) + cell + groove/2.
 *   A v-wall at anchor (x,y) lives in the COLUMN groove between columns x
 *   and x+1 and spans rows y and y+1. Its center line: cx = pad + x*(cell+groove)
 *   + cell + groove/2.
 *   Hit-testing mirrors this: the pointer picks whichever wall center line
 *   it is closest to, so hovering along a row groove snaps horizontal walls
 *   and along a column groove snaps vertical walls — no mode switch needed.
 * ========================================================================= */
var QRender = (function () {

    const board = document.getElementById('board');
    const ctx = board.getContext('2d');

    /* ---------------- geometry ---------------- */
    let PAD = 24, CELL = 54, GROOVE = 9;

    function computeMetrics(size) {
        const n = QRules.N;
        // n cells + (n-1) grooves + 2*pad; groove ≈ 16% of a cell
        const unit = size / (n + (n - 1) * 0.16 + 2 * 0.46);
        CELL = unit;
        GROOVE = unit * 0.16;
        PAD = unit * 0.46;
    }

    function cellRect(x, y) {
        const left = PAD + x * (CELL + GROOVE);
        const top = PAD + y * (CELL + GROOVE);
        return { left, top, cx: left + CELL / 2, cy: top + CELL / 2 };
    }

    /** Center of the h-wall at anchor (x,y): middle of row groove y, spanning columns x..x+1. */
    function hWallCenter(x, y) {
        const gy = PAD + y * (CELL + GROOVE) + CELL + GROOVE / 2;
        // center x = midpoint between column x center and column x+1 center
        const c0 = PAD + x * (CELL + GROOVE) + CELL / 2;
        const c1 = PAD + (x + 1) * (CELL + GROOVE) + CELL / 2;
        return { cx: (c0 + c1) / 2, cy: gy };
    }

    /** Center of the v-wall at anchor (x,y): middle of column groove x, spanning rows y..y+1. */
    function vWallCenter(x, y) {
        const gx = PAD + x * (CELL + GROOVE) + CELL + GROOVE / 2;
        const r0 = PAD + y * (CELL + GROOVE) + CELL / 2;
        const r1 = PAD + (y + 1) * (CELL + GROOVE) + CELL / 2;
        return { cx: gx, cy: (r0 + r1) / 2 };
    }

    function wallCenter(x, y, isH) {
        return isH ? hWallCenter(x, y) : vWallCenter(x, y);
    }

    /* ---------------- theme colors ---------------- */
    let theme = {};
    let themeCache = { mode: null, valid: false };
    function readTheme() {
        // Cache: only re-read the CSS variables when the theme mode changes
        // (or on first draw). Hover-triggered redraws skip getComputedStyle.
        const mode = document.documentElement.dataset.theme || 'auto';
        if (themeCache.valid && themeCache.mode === mode) return theme;
        const cs = getComputedStyle(document.documentElement);
        const v = name => cs.getPropertyValue(name).trim();
        theme = {
            boardBg: v('--board-bg'),
            boardEdge: v('--board-edge'),
            cell: v('--cell'),
            cellLine: v('--cell-line'),
            groove: v('--groove'),
            wall: v('--wall'),
            wallEdge: v('--wall-edge'),
            goalDim: parseFloat(v('--goal-dim')) || 0.55,
            pieceRing: v('--piece-ring'),
            text: v('--text'),
            muted: v('--muted'),
            brand: v('--brand')
        };
        themeCache = { mode, valid: true };
        return theme;
    }

    /* ---------------- main draw ---------------- */

    /**
     * Draw the whole board.
     * @param st game state
     * @param opts {
     *   hoverCell, hoverWall {x,y,isH,legal}, legalCells [],
     *   lastMove {from,to} | lastWall {x,y,isH}, currentPi, winPi,
     *   paths []  (optional) shortest paths per player [{color, cells:[{x,y}]}]
     * }
     */
    function draw(st, opts) {
        const sizeCss = board.width / (board._dpr || 1);
        const dpr = board._dpr || 1;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (dpr > 1) ctx.scale(dpr, dpr);
        readTheme();

        const n = QRules.N;

        // Board frame
        ctx.fillStyle = theme.boardBg;
        roundRect(0, 0, sizeCss, sizeCss, 12);
        ctx.fill();
        ctx.strokeStyle = theme.boardEdge;
        ctx.lineWidth = 2;
        roundRect(1, 1, sizeCss - 2, sizeCss - 2, 11);
        ctx.stroke();

        // Goal edge highlight for the current player
        drawGoalEdge(st, opts.currentPi, sizeCss);

        // Cells
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const r = cellRect(x, y);
                ctx.fillStyle = theme.cell;
                ctx.strokeStyle = theme.cellLine;
                ctx.lineWidth = 1;
                roundRect(r.left, r.top, CELL, CELL, 3);
                ctx.fill();
                ctx.stroke();
            }
        }

        // Grooves (subtle channels)
        ctx.strokeStyle = theme.groove;
        ctx.lineWidth = GROOVE * 0.66;
        ctx.lineCap = 'round';
        for (let i = 0; i < n - 1; i++) {
            const gp = PAD + i * (CELL + GROOVE) + CELL + GROOVE / 2;
            ctx.beginPath();
            ctx.moveTo(PAD + GROOVE / 3, gp);
            ctx.lineTo(sizeCss - PAD - GROOVE / 3, gp);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(gp, PAD + GROOVE / 3);
            ctx.lineTo(gp, sizeCss - PAD - GROOVE / 3);
            ctx.stroke();
        }

        // Shortest-path overlays — above cells/grooves, beneath walls & pawns
        // (drawn AFTER the opaque cell fill, otherwise it would be hidden)
        if (opts.paths) drawPaths(opts.paths);

        // Placed walls — colored by the player who placed them
        for (let y = 0; y < QRules.ANCH; y++) {
            for (let x = 0; x < QRules.ANCH; x++) {
                if (st.hw[y][x] > 0) drawWall(x, y, true, 1, ownerColor(st, x, y, true));
                if (st.vw[y][x] > 0) drawWall(x, y, false, 1, ownerColor(st, x, y, false));
            }
        }

        // Last wall emphasis (slightly stronger owner color)
        if (opts.lastWall) {
            const ow = ownerColor(st, opts.lastWall.x, opts.lastWall.y, opts.lastWall.isH);
            drawWall(opts.lastWall.x, opts.lastWall.y, opts.lastWall.isH, 1.06, ow);
        }

        // Legal move highlights (always shown for the human on turn)
        for (const c of (opts.legalCells || [])) {
            const r = cellRect(c.x, c.y);
            ctx.fillStyle = withAlpha(theme.brand, c.jump ? 0.30 : 0.20);
            roundRect(r.left + 3, r.top + 3, CELL - 6, CELL - 6, 3);
            ctx.fill();
            if (c.jump) {
                ctx.strokeStyle = withAlpha(theme.brand, 0.7);
                ctx.lineWidth = 2;
                roundRect(r.left + 3, r.top + 3, CELL - 6, CELL - 6, 3);
                ctx.stroke();
            }
        }

        // Hover cell preview
        if (opts.hoverCell) {
            const r = cellRect(opts.hoverCell.x, opts.hoverCell.y);
            ctx.fillStyle = withAlpha(theme.brand, 0.36);
            roundRect(r.left + 2, r.top + 2, CELL - 4, CELL - 4, 3);
            ctx.fill();
        }

        // Hover wall preview — shown in the current player's color
        // (semi-transparent when legal, red-crossed when not)
        if (opts.hoverWall) {
            const pc = st.players[st.turn] ? st.players[st.turn].color : theme.wall;
            drawWall(opts.hoverWall.x, opts.hoverWall.y, opts.hoverWall.isH,
                opts.hoverWall.legal === false ? 0 : (opts.hoverWall.legal ? 1 : 0), pc);
            if (opts.hoverWall.legal === false) {
                drawWallDenied(opts.hoverWall);
            }
        }

        // Pawns
        for (let i = 0; i < st.players.length; i++) {
            drawPiece(st.players[i], i === opts.currentPi && st.winner === null);
        }

        // Last move trail
        if (opts.lastMove) {
            const a = cellRect(opts.lastMove.from.x, opts.lastMove.from.y);
            const b = cellRect(opts.lastMove.to.x, opts.lastMove.to.y);
            ctx.strokeStyle = withAlpha('#f5a623', 0.8);
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

    /* ---------------- sub-draws ---------------- */

    /**
     * Shortest-path overlays: each player's current best route as a soft
     * dashed polyline in their color (drawn beneath pawns and walls).
     */
    function drawPaths(paths) {
        ctx.save();
        ctx.lineWidth = 3;
        for (const p of paths) {
            if (!p.cells || p.cells.length < 2) continue;
            ctx.strokeStyle = withAlpha(p.color, 0.35);
            ctx.setLineDash([7, 6]);
            ctx.beginPath();
            const first = cellRect(p.cells[0].x, p.cells[0].y);
            ctx.moveTo(first.cx, first.cy);
            for (let i = 1; i < p.cells.length; i++) {
                const r = cellRect(p.cells[i].x, p.cells[i].y);
                ctx.lineTo(r.cx, r.cy);
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    function drawGoalEdge(st, pi, sizeCss) {
        if (pi == null || !st.players[pi]) return;
        const p = st.players[pi];
        const t = Math.max(7, GROOVE);
        let x, y, w, h;
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

    /**
     * Draw a wall. alpha: 1 = solid, 0 = preview (translucent).
     * Orientation matters:
     *   h-wall → wide × thin (long axis horizontal, lying in a row groove)
     *   v-wall → thin × tall (long axis vertical, lying in a column groove)
     */
    function drawWall(x, y, isH, alpha, ownerColorHex) {
        const L = CELL * 2 + GROOVE;             // wall length (along the groove span)
        const T = Math.max(8, GROOVE * 0.95);    // wall thickness
        const { cx, cy } = wallCenter(x, y, isH);
        const w = isH ? L : T;
        const h = isH ? T : L;
        // Walls painted in the placing player's color (darkened for
        // contrast against the cells); fall back to the wooden default.
        const body = ownerColorHex ? darken(ownerColorHex, 0.18) : theme.wall;
        const edge = ownerColorHex ? darken(ownerColorHex, 0.45) : theme.wallEdge;
        ctx.save();
        ctx.globalAlpha = alpha === 1 ? 1 : alpha === 0 ? 0.5 : Math.min(1, alpha);
        // drop shadow
        ctx.fillStyle = withAlpha(edge, 0.55);
        roundRect(cx - w / 2 + 1.5, cy - h / 2 + 1.5, w, h, 4);
        ctx.fill();
        // body
        ctx.fillStyle = body;
        roundRect(cx - w / 2, cy - h / 2, w, h, 4);
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.2;
        roundRect(cx - w / 2, cy - h / 2, w, h, 4);
        ctx.stroke();
        ctx.restore();
    }

    function drawWallDenied(hover) {
        const L = CELL * 2 + GROOVE, T = Math.max(8, GROOVE * 0.95);
        const { cx, cy } = wallCenter(hover.x, hover.y, hover.isH);
        const w = hover.isH ? L : T;
        const h = hover.isH ? T : L;
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 2.5;
        roundRect(cx - w / 2, cy - h / 2, w, h, 4);
        ctx.stroke();
        // slash across the long axis
        ctx.beginPath();
        if (hover.isH) {
            ctx.moveTo(cx - w / 2 + 4, cy - h / 2 - 2);
            ctx.lineTo(cx + w / 2 - 4, cy + h / 2 + 2);
        } else {
            ctx.moveTo(cx - w / 2 - 2, cy - h / 2 + 4);
            ctx.lineTo(cx + w / 2 + 2, cy + h / 2 - 4);
        }
        ctx.stroke();
        ctx.restore();
    }

    function drawPiece(p, isCurrent) {
        const r = cellRect(p.pos.x, p.pos.y);
        const cx = r.cx, cy = r.cy;
        const rad = CELL * 0.36;
        ctx.save();
        // shadow
        ctx.beginPath();
        ctx.arc(cx + 1.5, cy + 2.5, rad, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        // body
        const grad = ctx.createRadialGradient(cx - rad * 0.35, cy - rad * 0.4, rad * 0.2, cx, cy, rad);
        grad.addColorStop(0, lighten(p.color, 0.45));
        grad.addColorStop(1, p.color);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.pieceRing;
        ctx.stroke();
        // turn ring
        if (isCurrent) {
            ctx.beginPath();
            ctx.arc(cx, cy, rad + 4.5, 0, Math.PI * 2);
            ctx.strokeStyle = withAlpha(p.color, 0.6);
            ctx.lineWidth = 3;
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ---------------- helpers ---------------- */

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
        if (!hex) return hex;
        if (hex.startsWith('#')) {
            let h = hex.slice(1);
            if (h.length === 3) h = h.split('').map(c => c + c).join('');
            const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${a})`;
        }
        return hex;
    }

    /** Player color of the wall's owner at anchor (x,y); null if none. */
    function ownerColor(st, x, y, isH) {
        const owner = QRules.wallOwner(st, x, y, isH);
        return owner >= 0 && st.players[owner] ? st.players[owner].color : null;
    }

    function lighten(hex, k) {
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const f = v => Math.round(v + (255 - v) * k);
        return `rgb(${f(r)},${f(g)},${f(b)})`;
    }

    function darken(hex, k) {
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const f = v => Math.round(v * (1 - k));
        return `rgb(${f(r)},${f(g)},${f(b)})`;
    }

    /* ---------------- hit-testing (pixel → cell / wall intent) ---------------- */

    function pixelToCell(px, py) {
        const n = QRules.N;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const r = cellRect(x, y);
                if (px >= r.left && px <= r.left + CELL && py >= r.top && py <= r.top + CELL) {
                    return { x, y };
                }
            }
        }
        return null;
    }

    /**
     * Pixel → wall intent. Distance from the pointer to each wall's CENTER
     * LINE (horizontal groove center for h-walls, column groove center for
     * v-walls); the nearest candidate within the snap radius wins. This is
     * what makes both orientations reachable:
     *   - pointer inside/near a row groove → nearest h-wall
     *   - pointer inside/near a column groove → nearest v-wall
     */
    function pixelToWall(px, py) {
        const A = QRules.ANCH;
        const snap = GROOVE * 1.35 + 5;
        const halfLen = CELL + GROOVE / 2;   // half of wall length
        let best = null, bestDist = Infinity;
        for (let y = 0; y < A; y++) {
            for (let x = 0; x < A; x++) {
                // horizontal wall candidates
                const hc = hWallCenter(x, y);
                if (Math.abs(px - hc.cx) <= halfLen) {
                    const d = Math.abs(py - hc.cy);
                    if (d < snap && d < bestDist) { bestDist = d; best = { x, y, isH: true }; }
                }
                // vertical wall candidates
                const vc = vWallCenter(x, y);
                if (Math.abs(py - vc.cy) <= halfLen) {
                    const d = Math.abs(px - vc.cx);
                    if (d < snap && d < bestDist) { bestDist = d; best = { x, y, isH: false }; }
                }
            }
        }
        return best;
    }

    /* ---------------- DPI handling ---------------- */

    /** Force the theme cache to refresh on the next draw (system scheme flip). */
    function invalidateTheme() {
        themeCache.valid = false;
    }
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onScheme = () => { invalidateTheme(); };
        if (mq.addEventListener) mq.addEventListener('change', onScheme);
        else if (mq.addListener) mq.addListener(onScheme);
    }

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
        cellRect, hWallCenter, vWallCenter, wallCenter,
        pixelToCell, pixelToWall,
        invalidateTheme,
        get CELL() { return CELL; }, get GROOVE() { return GROOVE; }, get PAD() { return PAD; },
        readTheme
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QRender;
