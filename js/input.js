'use strict';
/* =========================================================================
 * QInput — pointer input (mouse + touch via Pointer Events)
 * Depends on: global QRender (hit-testing), QRules.
 *
 * Interaction (no mode switch):
 *   - Hover/click a cell → move the pawn there (if legal).
 *   - Hover/click in a groove → place a wall there (orientation is decided
 *     by which groove the pointer is in: row groove = horizontal wall,
 *     column groove = vertical wall).
 *   - Both previews are always live: legal move targets glow, the wall
 *     under the pointer shows green (legal) or red (illegal).
 *   - Input is ignored during AI turns and after the game is over.
 * ========================================================================= */
var QInput = (function () {

    const board = QRender.board;
    let handler = null;   // {onHover, onTap} injected by app.js

    function bind(h) { handler = h; }

    function boardPos(e) {
        const rect = board.getBoundingClientRect();
        const cssW = parseFloat(board.style.width) || rect.width;
        const scale = cssW / rect.width;
        return { px: (e.clientX - rect.left) * scale, py: (e.clientY - rect.top) * scale };
    }

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
        handler.onTap(QRender.pixelToCell(px, py), QRender.pixelToWall(px, py));
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
    board.style.touchAction = 'none';

    return { bind };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QInput;
