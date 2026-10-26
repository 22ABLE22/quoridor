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
 * WALL GEOMETRY
 *   An h-wall at anchor (x,y) lives in the ROW groove between rows y and y+1
 *   and spans columns x and x+1. Its center line is the groove's horizontal
 *   center: cy = pad + y*(cell+groove) + cell + groove/2.
 *   A v-wall at anchor (x,y) lives in the COLUMN groove between columns x
 *   and x+1 and spans rows y and y+1. Its center line: cx = pad + x*(cell+groove)
 *   + cell + groove/2.
 *   Hit-testing mirrors this: the pointer picks whichever wall center line
 *   it is closest to, so hovering along a row groove snaps horizontal walls
 *   and along a column groove snaps vertical walls — no mode switch needed.
 *
 * MOTION
 *   The canvas has no CSS transitions, so this module runs its own short
 *   animation pass and asks for a redraw through the same 'quoridor:redraw'
 *   event the theme system uses. Nothing loops: a pass starts on a pawn move,
 *   a wall landing, or a new path, and stops when every track has landed.
 *   A pawn slides between cells, a new wall drops into its groove with a
 *   small overshoot, and a shortest path draws itself on from the pawn.
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
            goalDim: parseFloat(v('--goal-dim')) || 0.55,
            pieceRing: v('--piece-ring'),
            text: v('--text'),
            muted: v('--muted'),
            accent: v('--accent')
        };
        themeCache = { mode, valid: true };
        return theme;
    }

    /* ---------------- motion tracks ---------------- */

    const DUR_MOVE = 260;    // pawn slide between cells
    const DUR_WALL = 320;    // wall dropping into its groove
    const DUR_PATH = 620;    // shortest path drawing itself on

    /** player id → {fx, fy, tx, ty, t0} in cell coordinates */
    const pawnTracks = new Map();
    /** "x,y,isH" → t0 of the frame the wall landed */
    const wallTracks = new Map();
    let pathTrack = { t0: 0, key: null };
    let rafId = null;

    function reducedMotion() {
        return typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function clock() {
        return (typeof performance !== 'undefined' ? performance : Date).now();
    }

    const easeOut = t => 1 - Math.pow(1 - t, 3);
    const easeBack = t => {
        const c = 1.70158;
        const p = t - 1;
        return 1 + (c + 1) * p * p * p + c * p * p;
    };
    const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

    /** Advance every track; true when at least one is still running. */
    function stepTracks(now) {
        let busy = false;
        for (const [id, tr] of pawnTracks) {
            if (now - tr.t0 >= DUR_MOVE) pawnTracks.delete(id);
            else busy = true;
        }
        for (const [k, t0] of wallTracks) {
            if (now - t0 >= DUR_WALL) wallTracks.delete(k);
            else busy = true;
        }
        if (pathTrack.key && now - pathTrack.t0 >= DUR_PATH) pathTrack.key = null;
        else if (pathTrack.key) busy = true;
        return busy;
    }

    function ensureLoop() {
        if (rafId !== null || reducedMotion()) return;
        if (typeof requestAnimationFrame !== 'function') return;
        const tick = () => {
            rafId = null;
            const busy = stepTracks(clock());
            document.dispatchEvent(new Event('quoridor:redraw'));
            if (busy) rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    }

    /** Last drawn cell per player id, so a move can slide instead of teleport. */
    const lastPos = new Map();

    /** Compare against the previous frame and open a slide for anyone who moved. */
    function beginFrame(st) {
        if (!st) return;
        const now = clock();
        for (const p of st.players) {
            const prev = lastPos.get(p.id);
            if (!prev) continue;                       // first sighting: no slide
            if (prev.x === p.pos.x && prev.y === p.pos.y) continue;
            pawnTracks.set(p.id, { from: prev, to: { x: p.pos.x, y: p.pos.y }, t0: now });
        }
    }

    /** Record the cells just drawn as the next frame's starting point. */
    function endFrame(st) {
        if (!st) return;
        const seen = new Set();
        for (const p of st.players) {
            seen.add(p.id);
            lastPos.set(p.id, { x: p.pos.x, y: p.pos.y });
        }
        for (const id of [...lastPos.keys()]) if (!seen.has(id)) lastPos.delete(id);
        for (const id of [...pawnTracks.keys()]) if (!seen.has(id)) pawnTracks.delete(id);
    }

    function pawnDrawPos(p) {
        const tr = pawnTracks.get(p.id);
        if (!tr) return { x: p.pos.x, y: p.pos.y };
        const t = clamp01((clock() - tr.t0) / DUR_MOVE);
        const e = easeOut(t);
        return {
            x: tr.from.x + (tr.to.x - tr.from.x) * e,
            y: tr.from.y + (tr.to.y - tr.from.y) * e
        };
    }

    function wallScale(key) {
        const t0 = wallTracks.get(key);
        if (t0 === undefined) return 1;
        return easeBack(clamp01((clock() - t0) / DUR_WALL));
    }

    /** Start a wall-landing animation for a freshly placed wall. */
    function landed(x, y, isH) {
        wallTracks.set(x + ',' + y + ',' + (isH ? 1 : 0), clock());
        ensureLoop();
    }

    /** Start a path draw-on for a new position. */
    function pathChanged(key) {
        if (pathTrack.key === key) return;
        pathTrack = { t0: clock(), key };
        ensureLoop();
    }

    /* ---------------- main draw ---------------- */

    /**
     * Draw the whole board.
     * @param st game state
     * @param opts {
     *   hoverCell, hoverWall {x,y,isH,legal}, legalCells [],
     *   lastMove {from,to} | lastWall {x,y,isH}, currentPi,
     *   paths []  (optional) shortest paths per player [{color, cells:[{x,y}]}],
     *   cursor {mode:'cell'|'wall', x, y, isH}  keyboard focus ring
     * }
     */
    function draw(st, opts) {
        const sizeCss = board.width / (board._dpr || 1);
        const dpr = board._dpr || 1;
        beginFrame(st);
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
            ctx.fillStyle = withAlpha(theme.accent, c.jump ? 0.30 : 0.18);
            roundRect(r.left + 3, r.top + 3, CELL - 6, CELL - 6, 4);
            ctx.fill();
            if (c.jump) {
                ctx.strokeStyle = withAlpha(theme.accent, 0.7);
                ctx.lineWidth = 2;
                roundRect(r.left + 3, r.top + 3, CELL - 6, CELL - 6, 4);
                ctx.stroke();
            }
        }

        // Hover cell preview
        if (opts.hoverCell) {
            const r = cellRect(opts.hoverCell.x, opts.hoverCell.y);
            ctx.fillStyle = withAlpha(theme.accent, 0.32);
            roundRect(r.left + 2, r.top + 2, CELL - 4, CELL - 4, 4);
            ctx.fill();
        }

        // Hover wall preview — shown in the current player's color
        if (opts.hoverWall) {
            const pc = st.players[st.turn] ? st.players[st.turn].color : theme.accent;
            drawWall(opts.hoverWall.x, opts.hoverWall.y, opts.hoverWall.isH,
                opts.hoverWall.legal === false ? 0 : (opts.hoverWall.legal ? 1 : 0), pc);
            if (opts.hoverWall.legal === false) {
                drawWallDenied(opts.hoverWall);
            }
        }

        // Keyboard cursor
        if (opts.cursor) drawCursor(opts.cursor, st);

        // Pawns
        for (let i = 0; i < st.players.length; i++) {
            drawPiece(st.players[i], i === opts.currentPi && st.winner === null);
        }

        // Last move trail
        if (opts.lastMove) {
            const a = cellRect(opts.lastMove.from.x, opts.lastMove.from.y);
            const b = cellRect(opts.lastMove.to.x, opts.lastMove.to.y);
            ctx.strokeStyle = withAlpha('#e08a2e', 0.75);
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            ctx.moveTo(a.cx, a.cy);
            ctx.lineTo(b.cx, b.cy);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore();
        endFrame(st);
    }

    /* ---------------- sub-draws ---------------- */

    /**
     * Shortest-path overlays: each player's current best route as a dashed
     * polyline in their color, revealed from the pawn outward so the route
     * reads as "this is where I am heading".
     */
    function drawPaths(paths) {
        let reveal = 1;
        if (pathTrack.key) {
            reveal = easeOut(clamp01((clock() - pathTrack.t0) / DUR_PATH));
        }
        ctx.save();
        ctx.lineWidth = 3;
        for (const p of paths) {
            if (!p.cells || p.cells.length < 2) continue;
            ctx.strokeStyle = withAlpha(p.color, 0.38);
            ctx.setLineDash([7, 6]);
            let total = 0;
            for (let i = 1; i < p.cells.length; i++) {
                const a = cellRect(p.cells[i - 1].x, p.cells[i - 1].y);
                const b = cellRect(p.cells[i].x, p.cells[i].y);
                total += Math.hypot(b.cx - a.cx, b.cy - a.cy);
            }
            // a dash longer than the route draws exactly the first `shown` px
            ctx.setLineDash([Math.max(0.01, total * reveal), 1e6]);
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
     * A wall that just landed scales up from its groove center.
     */
    function drawWall(x, y, isH, alpha, ownerColorHex) {
        const L = CELL * 2 + GROOVE;             // wall length (along the groove span)
        const T = Math.max(8, GROOVE * 0.95);    // wall thickness
        const { cx, cy } = wallCenter(x, y, isH);
        const k = alpha === 1 ? wallScale(x + ',' + y + ',' + (isH ? 1 : 0)) : 1;
        const w = (isH ? L : T) * k;
        const h = (isH ? T : L) * k;
        // Walls painted in the placing player's color (darkened for
        // contrast against the cells).
        const body = ownerColorHex ? darken(ownerColorHex, 0.18) : theme.accent;
        const edge = ownerColorHex ? darken(ownerColorHex, 0.45) : darken(theme.accent, 0.4);
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
        ctx.strokeStyle = '#d94a3d';
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

    /** Keyboard focus ring: a cell outline, or a groove crosshair for walls. */
    function drawCursor(cursor, st) {
        ctx.save();
        ctx.strokeStyle = withAlpha(theme.accent, 0.95);
        ctx.lineWidth = 2.5;
        if (cursor.mode === 'wall') {
            const { cx, cy } = wallCenter(cursor.x, cursor.y, cursor.isH);
            const L = CELL * 2 + GROOVE;
            const T = Math.max(8, GROOVE * 0.95);
            const w = cursor.isH ? L : T;
            const h = cursor.isH ? T : L;
            ctx.setLineDash([5, 4]);
            roundRect(cx - w / 2 - 2, cy - h / 2 - 2, w + 4, h + 4, 5);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            const r = cellRect(cursor.x, cursor.y);
            roundRect(r.left + 1, r.top + 1, CELL - 2, CELL - 2, 4);
            ctx.stroke();
            ctx.fillStyle = withAlpha(theme.accent, 0.1);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawPiece(p, isCurrent) {
        const at = pawnDrawPos(p);
        const r = cellRect(at.x, at.y);
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
        invalidateTheme, landed, pathChanged,
        get CELL() { return CELL; }, get GROOVE() { return GROOVE; }, get PAD() { return PAD; },
        readTheme
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QRender;
