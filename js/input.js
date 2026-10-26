'use strict';
/* =========================================================================
 * QInput — pointer and keyboard input
 * Depends on: global QRender (hit-testing), QRules.
 *
 * POINTER (no mode switch):
 *   - Hover/click a cell → move the pawn there (if legal).
 *   - Hover/click in a groove → place a wall there (orientation is decided
 *     by which groove the pointer is in: row groove = horizontal wall,
 *     column groove = vertical wall).
 *   - Both previews are always live: legal move targets glow, the wall
 *     under the pointer shows the player's colour (legal) or a red slash
 *     (illegal).
 *
 * KEYBOARD (the board is a tab stop):
 *   - Arrow keys move a cursor; Enter or Space plays the cursor.
 *   - W switches to wall placement (cursor moves on the 8x8 anchor grid),
 *     R rotates the wall, Escape returns to moving.
 *   - The cursor is announced through the same status line as the pointer,
 *     so a keyboard player gets the legality feedback a mouse player sees.
 *
 * Input is ignored during AI turns and after the game is over.
 * ========================================================================= */
var QInput = (function () {

    const board = QRender.board;
    let handler = null;   // {onHover, onTap, onCursor} injected by app.js

    /** Keyboard cursor: mode 'cell' → 9x9 grid, 'wall' → 8x8 anchor grid. */
    let cursor = { mode: 'cell', x: 4, y: 4, isH: true };

    function bind(h) { handler = h; }

    function boardPos(e) {
        const rect = board.getBoundingClientRect();
        const cssW = parseFloat(board.style.width) || rect.width;
        const scale = cssW / rect.width;
        return { px: (e.clientX - rect.left) * scale, py: (e.clientY - rect.top) * scale };
    }

    /* ---------------- cursor ---------------- */

    function maxIndex() { return cursor.mode === 'wall' ? QRules.ANCH - 1 : QRules.N - 1; }

    function setCursor(next, silent) {
        const lim = maxIndex();
        cursor = {
            mode: next.mode || cursor.mode,
            x: Math.max(0, Math.min(lim, next.x)),
            y: Math.max(0, Math.min(lim, next.y)),
            isH: next.isH === undefined ? cursor.isH : !!next.isH
        };
        if (!silent && handler && handler.onCursor) handler.onCursor(cursor);
    }

    function moveCursor(dx, dy) {
        setCursor({ x: cursor.x + dx, y: cursor.y + dy });
    }

    /** Reset the cursor onto a cell (pointer tap, mode switch, new game). */
    function placeCursor(cell, silent) {
        if (!cell) return;
        setCursor({ mode: 'cell', x: cell.x, y: cell.y }, silent);
    }

    /**
     * Park the cursor on the human player's pawn. A keyboard player should
     * start from "where am I", not from the middle of the board, and the
     * first arrow press should step toward a legal destination.
     */
    function focusPlayer(pos) {
        if (!pos) return;
        setCursor({ mode: 'cell', x: pos.x, y: pos.y }, true);
    }

    /** Keep the cursor inside the board after a resize or a game reset. */
    function clampCursor() { setCursor(cursor, true); }

    function onKeyDown(e) {
        if (!handler) return;
        const k = e.key;
        const isArrow = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight';
        if (isArrow) {
            e.preventDefault();
            if (k === 'ArrowUp') moveCursor(0, -1);
            else if (k === 'ArrowDown') moveCursor(0, 1);
            else if (k === 'ArrowLeft') moveCursor(-1, 0);
            else moveCursor(1, 0);
            return;
        }
        if (k === 'w' || k === 'W') {
            e.preventDefault();
            // Seed the wall cursor from the current cell so it lands nearby.
            const anchor = cursor.mode === 'wall'
                ? { x: cursor.x, y: cursor.y }
                : { x: Math.min(cursor.x, QRules.ANCH - 1), y: Math.min(cursor.y, QRules.ANCH - 1) };
            setCursor({ mode: 'wall', x: anchor.x, y: anchor.y });
            return;
        }
        if (k === 'r' || k === 'R') {
            e.preventDefault();
            if (cursor.mode === 'wall') setCursor({ isH: !cursor.isH });
            return;
        }
        if (k === 'Escape') {
            if (cursor.mode !== 'cell') {
                e.preventDefault();
                setCursor({ mode: 'cell', x: Math.min(cursor.x, QRules.N - 1), y: Math.min(cursor.y, QRules.N - 1) });
            }
            return;
        }
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
            e.preventDefault();
            if (!handler.onTap) return;
            if (cursor.mode === 'wall') {
                handler.onTap(null, { x: cursor.x, y: cursor.y, isH: cursor.isH });
            } else {
                handler.onTap({ x: cursor.x, y: cursor.y }, null);
            }
        }
    }

    /* ---------------- pointer ---------------- */

    function onPointerMove(e) {
        if (!handler || !handler.onHover) return;
        const { px, py } = boardPos(e);
        handler.onHover(QRender.pixelToCell(px, py), QRender.pixelToWall(px, py));
    }

    function onPointerDown(e) {
        if (!handler || !handler.onHover) return;
        // touch: show preview on press
        const { px, py } = boardPos(e);
        handler.onHover(QRender.pixelToCell(px, py), QRender.pixelToWall(px, py));
    }

    function onPointerUp(e) {
        if (!handler || !handler.onTap) return;
        const { px, py } = boardPos(e);
        const cell = QRender.pixelToCell(px, py);
        const wall = QRender.pixelToWall(px, py);
        // Keep the keyboard cursor where the pointer last acted, so switching
        // between mouse and keyboard does not jump across the board.
        if (cell) placeCursor(cell, true);
        handler.onTap(cell, wall);
    }

    function onPointerLeave() {
        if (!handler || !handler.onHover) return;
        handler.onHover(null, null);
    }

    board.addEventListener('pointermove', onPointerMove);
    board.addEventListener('pointerdown', onPointerDown);
    board.addEventListener('pointerup', onPointerUp);
    board.addEventListener('pointercancel', onPointerLeave);
    board.addEventListener('pointerleave', onPointerLeave);
    board.addEventListener('keydown', onKeyDown);
    board.style.touchAction = 'none';

    return {
        bind, clampCursor, placeCursor, focusPlayer,
        get cursor() { return cursor; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QInput;
