'use strict';
/* =========================================================================
 * QInput — 指针输入（鼠标 + 触摸，Pointer Events 统一处理）
 * 依赖：全局 QRender（几何反查）、QRules。
 *
 * 交互设计：
 *   走子模式：点击合法落点走子；悬停高亮（触摸按下即高亮，抬起确认）。
 *   放墙模式：指针在墙位附近移动 → 按横/纵贴近自动选择水平/垂直墙预览；
 *             双击（350ms 内同锚点）切换横竖；单击/抬起确认放置。
 *   AI 回合或已分胜负时输入被忽略。
 * ========================================================================= */
var QInput = (function () {

    const board = QRender.board;
    let handler = null;      // {onCellTap, onWallTap, onHover} 由 ui/app 注入
    let lastTapTime = 0, lastTapWallKey = '';

    function bind(h) { handler = h; }

    function boardPos(e) {
        const rect = board.getBoundingClientRect();
        // CSS 像素 → 画布 CSS 尺寸（render 内部按 CSS 尺寸计算几何）
        const scale = (parseFloat(board.style.width) || board.getBoundingClientRect().width) / rect.width;
        return { px: (e.clientX - rect.left) * scale, py: (e.clientY - rect.top) * scale };
    }

    function onPointerMove(e) {
        if (!handler || !handler.onHover) return;
        const { px, py } = boardPos(e);
        handler.onHover(QRender.pixelToCell(px, py), QRender.pixelToWall(px, py));
    }

    function onPointerDown(e) {
        if (!handler || !handler.onHover) return;
        // 触摸：按下即预览（等同 hover）
        const { px, py } = boardPos(e);
        handler.onHover(QRender.pixelToCell(px, py), QRender.pixelToWall(px, py));
    }

    function onPointerUp(e) {
        if (!handler || !handler.onTap) return;
        const { px, py } = boardPos(e);
        const cell = QRender.pixelToCell(px, py);
        const wall = QRender.pixelToWall(px, py);
        // 双击检测（放墙模式切横竖）
        const now = Date.now();
        const wallKey = wall ? wall.x + ',' + wall.y : '';
        const isDouble = wall && now - lastTapTime < 350 && wallKey === lastTapWallKey;
        lastTapTime = now;
        lastTapWallKey = wallKey;
        handler.onTap(cell, wall, isDouble);
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
    // 阻止触摸滚动/缩放棋盘（CSS touch-action 亦已设置）
    board.style.touchAction = 'none';

    return { bind };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QInput;
