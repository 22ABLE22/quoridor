'use strict';
/* =========================================================================
 * QApp — 主控制器
 * 依赖：QRules, QAI, QRender, QInput, QUI（按 index.html 加载顺序）
 * 职责：
 *   - 对局生命周期（新局 / 进行 / 结束 / 再来一局）
 *   - 走子与放墙的交互流程（合法校验、反馈）
 *   - AI 回合调度（setTimeout 让 UI 先绘制）
 *   - 悔棋（一次撤销到最近一次真人行动前）
 *   - 设置弹层（2/4 人、每座位 真人/电脑/空 + AI 难度 + 名字）
 * ========================================================================= */
var QApp = (function () {

    /* ---------------- 状态 ---------------- */
    let st = null;             // 当前局面（QRules.createGame 产物）
    let mode = 'move';         // 'move' | 'wall'
    let hoverCell = null, hoverWall = null;
    let aiTimer = null;
    let aiThinking = false;

    const modeMoveBtn = document.getElementById('modeMoveBtn');
    const modeWallBtn = document.getElementById('modeWallBtn');
    const undoBtn = document.getElementById('undoBtn');
    const newGameBtn = document.getElementById('newGameBtn');
    const setupOverlay = QUI.setupOverlay;
    const winOverlay = QUI.winOverlay;

    /* ---------------- 绘制 ---------------- */

    function redraw() {
        if (!st) return;
        const cur = st.winner === null ? st.turn : null;
        const legalCells = (cur !== null && st.players[cur].type === 'human' && mode === 'move')
            ? QRules.legalMoves(st, cur) : [];
        const lastRec = st.history[st.history.length - 1];
        QRender.draw(st, {
            hoverCell, hoverWall,
            legalCells,
            mode,
            currentPi: st.winner === null ? st.turn : st.winner,
            lastMove: lastRec && lastRec.type === 'move' ? lastRec : null,
            lastWall: lastRec && lastRec.type === 'wall' ? lastRec : null,
            winPi: st.winner
        });
    }

    function refreshUI() {
        if (!st) return;
        QUI.renderPlayers(st);
        QUI.renderHistory(st);
        updateStatus();
        updateButtons();
        redraw();
    }

    function updateStatus() {
        if (st.winner !== null) {
            const p = st.players[st.winner];
            QUI.setStatus('<b style="color:' + p.color + '">' + esc(p.name) + '</b> 率先抵达目标边，获胜！🏆');
            return;
        }
        const p = st.players[st.turn];
        const d = QRules.distanceToGoal(st, st.turn);
        const distText = isFinite(d) ? '距终点 <b>' + d + '</b> 步' : '路径被封锁';
        if (p.type === 'ai') {
            QUI.setStatus('<b style="color:' + p.color + '">' + esc(p.name) + '</b>（' + QUI.levelName(p.aiLevel) + ' AI）思考中… ' + distText);
        } else {
            const modeText = mode === 'move' ? '点击高亮格子走子（紧邻对手可跳跃）' : '移到格线交点放墙，双击切换横竖';
            QUI.setStatus('轮到 <b style="color:' + p.color + '">' + esc(p.name) + '</b> · 剩余挡板 ' + p.walls + ' · ' + distText + ' —— ' + modeText);
        }
    }

    function updateButtons() {
        const humanTurn = st && st.winner === null && st.players[st.turn].type === 'human';
        modeMoveBtn.disabled = !humanTurn;
        modeWallBtn.disabled = !humanTurn || st.players[st.turn].walls <= 0;
        modeMoveBtn.setAttribute('aria-pressed', mode === 'move');
        modeWallBtn.setAttribute('aria-pressed', mode === 'wall');
        undoBtn.disabled = st && st.history.length === 0;
    }

    /* ---------------- 模式切换 ---------------- */
    modeMoveBtn.addEventListener('click', () => setMode('move'));
    modeWallBtn.addEventListener('click', () => setMode('wall'));
    function setMode(m) {
        mode = m;
        hoverWall = null;
        updateButtons();
        updateStatus();
        redraw();
    }

    /* ---------------- 输入处理 ---------------- */
    QInput.bind({
        onTap: onBoardTap,
        onHover: onHover
    });

    function onBoardTap(cell, wall, isDouble) {
        if (!st || st.winner !== null || aiThinking) return;
        const pi = st.turn;
        if (st.players[pi].type !== 'human') return;

        if (mode === 'move') {
            if (!cell) return;
            const legal = QRules.legalMoves(st, pi).find(m => m.x === cell.x && m.y === cell.y);
            if (!legal) { QUI.showToast('不能走到那里', true); return; }
            QRules.applyMove(st, pi, cell);
            afterAction();
        } else {
            if (!wall) return;
            if (isDouble) {
                wall.isH = !wall.isH;   // 双击切换横竖
            }
            placeWall(pi, wall);
        }
    }

    function placeWall(pi, wall) {
        const ok = QRules.canPlaceWall(st, pi, wall.x, wall.y, wall.isH);
        if (!ok) {
            const p = st.players[pi];
            let why = '此处不能放墙';
            if (p.walls <= 0) why = '挡板已用完';
            else if (QRules.wallConflicts(st, wall.x, wall.y, wall.isH)) why = '与已有挡板重叠或交叉';
            else why = '不能把任何玩家完全围死';
            QUI.showToast(why, true);
            return;
        }
        QRules.applyWall(st, pi, wall.x, wall.y, wall.isH);
        afterAction();
    }

    function onHover(cell, wall) {
        let changed = false;
        const pi = st && st.winner === null ? st.turn : -1;
        const humanTurn = pi >= 0 && st.players[pi].type === 'human';
        const newCell = (mode === 'move' && humanTurn) ? cell : null;
        if ((newCell && !hoverCell) || (!newCell && hoverCell) ||
            (newCell && hoverCell && (newCell.x !== hoverCell.x || newCell.y !== hoverCell.y))) changed = true;
        hoverCell = newCell;

        let newWall = null;
        if (mode === 'wall' && humanTurn && wall) {
            const legal = QRules.canPlaceWall(st, pi, wall.x, wall.y, wall.isH);
            newWall = { x: wall.x, y: wall.y, isH: wall.isH, legal };
        }
        if ((newWall && !hoverWall) || (!newWall && hoverWall) ||
            (newWall && hoverWall && (newWall.x !== hoverWall.x || newWall.y !== hoverWall.y || newWall.isH !== hoverWall.isH || newWall.legal !== hoverWall.legal))) changed = true;
        hoverWall = newWall;
        if (changed) redraw();
    }

    /* ---------------- 动作后处理 ---------------- */
    function afterAction() {
        hoverCell = hoverWall = null;
        refreshUI();
        if (st.winner !== null) {
            setTimeout(() => QUI.showWin(st), 600);
            return;
        }
        scheduleAI();
    }

    /* ---------------- AI 调度 ---------------- */
    function scheduleAI() {
        clearTimeout(aiTimer);
        if (!st || st.winner !== null) return;
        if (st.players[st.turn].type !== 'ai') return;
        aiThinking = true;
        updateStatus();
        updateButtons();
        aiTimer = setTimeout(() => {
            const pi = st.turn;
            const action = QAI.decide(st, pi);
            aiThinking = false;
            if (!action) { refreshUI(); return; }
            if (action.type === 'move') {
                QRules.applyMove(st, pi, action.target);
            } else {
                QRules.applyWall(st, pi, action.wall.x, action.wall.y, action.wall.isH);
            }
            afterAction();
        }, 480);
    }

    /* ---------------- 悔棋 ---------------- */
    undoBtn.addEventListener('click', () => {
        if (!st || !st.history.length) return;
        clearTimeout(aiTimer);
        aiThinking = false;
        let n = 0;
        // 撤销到最近一次“真人”行动之前：先把 AI 的动作撤掉，再撤真人那步
        do {
            QRules.undoLast(st);
            n++;
        } while (st.history.length > 0 && st.players[st.turn].type !== 'human' && n < 12);
        // 若中途轮到 AI（例如全 AI 局），也允许继续撤
        if (st.players[st.turn].type !== 'human' && st.history.length === 0) { /* 全 AI 开局，无妨 */ }
        QUI.hideWin();
        QUI.showToast('已撤销 ' + n + ' 步');
        refreshUI();
        scheduleAI();
    });

    /* ---------------- 设置弹层 ---------------- */
    const modeSeg = document.getElementById('modeSeg');
    const seatRows = document.getElementById('seatRows');
    const startBtn = document.getElementById('startBtn');
    const rematchBtn = document.getElementById('rematchBtn');
    const reconfigBtn = document.getElementById('reconfigBtn');

    let setupMode = 2;
    let seatConfig = defaultSeats(2);

    function defaultSeats(mode) {
        return [
            { name: '红方', type: 'human', aiLevel: 2 },
            { name: '蓝方', type: 'ai', aiLevel: 2 },
            { name: '绿方', type: 'ai', aiLevel: 2 },
            { name: '黄方', type: 'ai', aiLevel: 2 }
        ];
    }

    function renderSeatRows() {
        seatRows.innerHTML = '';
        const defs = QRules.SEAT_DEFS.slice(0, setupMode);
        for (let i = 0; i < setupMode; i++) {
            const def = defs[i];
            const cfg = seatConfig[i];
            const row = document.createElement('div');
            row.className = 'seat-row' + (cfg.type === 'off' ? ' off' : '');
            row.innerHTML =
                '<span class="seat-dot" style="background:' + def.color + '"></span>' +
                '<span class="seat-name"><input maxlength="12"></span>' +
                '<span class="seat-type">' +
                    '<button type="button" data-t="human">真人</button>' +
                    '<button type="button" data-t="ai">电脑</button>' +
                    '<button type="button" data-t="off">空</button>' +
                '</span>' +
                '<span class="seat-ai"></span>';
            const nameInput = row.querySelector('input');
            nameInput.value = cfg.name;
            nameInput.addEventListener('input', () => { cfg.name = nameInput.value; });
            row.querySelectorAll('.seat-type button').forEach(btn => {
                btn.setAttribute('aria-pressed', btn.dataset.t === cfg.type);
                btn.addEventListener('click', () => {
                    cfg.type = btn.dataset.t;
                    renderSeatRows();
                });
            });
            const aiBox = row.querySelector('.seat-ai');
            if (cfg.type === 'ai') {
                aiBox.innerHTML = '';
                const sel = document.createElement('select');
                for (const lv of [1, 2, 3]) {
                    const opt = document.createElement('option');
                    opt.value = lv;
                    opt.textContent = QUI.levelName(lv) + ' AI';
                    if (cfg.aiLevel === lv) opt.selected = true;
                    sel.appendChild(opt);
                }
                sel.addEventListener('change', () => { cfg.aiLevel = +sel.value; });
                aiBox.appendChild(sel);
            }
            seatRows.appendChild(row);
        }
    }

    modeSeg.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            setupMode = +btn.dataset.mode;
            modeSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.mode === setupMode));
            renderSeatRows();
        });
    });

    startBtn.addEventListener('click', () => {
        try {
            st = QRules.createGame(setupMode, seatConfig.slice(0, setupMode));
        } catch (err) {
            QUI.showToast(err.message, true);
            return;
        }
        QUI.hideSetup();
        QUI.hideWin();
        mode = 'move';
        hoverCell = hoverWall = null;
        refreshUI();
        scheduleAI();
    });

    rematchBtn.addEventListener('click', () => {
        // 保留座位配置重开
        const seats = st.players.map(p => ({ name: p.name, type: p.type, aiLevel: p.aiLevel }));
        st = QRules.createGame(st.mode, seats);
        QUI.hideWin();
        mode = 'move';
        refreshUI();
        scheduleAI();
    });

    reconfigBtn.addEventListener('click', () => {
        QUI.hideWin();
        QUI.showSetup();
        // 同步当前配置到弹层
        setupMode = st.mode;
        modeSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.mode === setupMode));
        const active = st.players;
        for (let i = 0; i < setupMode; i++) {
            const found = active.find(p => p.id === i);
            seatConfig[i] = found
                ? { name: found.name, type: found.type, aiLevel: found.aiLevel }
                : { name: QRules.SEAT_DEFS[i].name, type: 'off', aiLevel: 2 };
        }
        renderSeatRows();
    });

    newGameBtn.addEventListener('click', () => {
        QUI.showSetup();
        renderSeatRows();
    });

    /* ---------------- 主题变化重绘 ---------------- */
    document.addEventListener('quoridor:redraw', redraw);
    // 系统主题变化时（auto 模式）也重绘
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onScheme = () => { if (document.documentElement.dataset.theme === 'auto') redraw(); };
        if (mq.addEventListener) mq.addEventListener('change', onScheme);
        else if (mq.addListener) mq.addListener(onScheme);
    }

    /* ---------------- 尺寸自适应 ---------------- */
    function fitBoard() {
        const wrap = board.parentElement;
        const size = Math.max(280, Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth));
        QRender.resize(Math.floor(size));
        redraw();
    }
    const board = QRender.board;
    window.addEventListener('resize', fitBoard);

    /* ---------------- 逃逸 ---------------- */
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------------- 启动 ---------------- */
    function init() {
        fitBoard();
        renderSeatRows();
        QUI.showSetup();
        QUI.setStatus('配置座位后开始对局');
        // 测试钩子：?autotest=1 跳过弹层直接开一局 AI 对 AI（浏览器冒烟测试用）
        try {
            if (new URLSearchParams(location.search).get('autotest') === '1') {
                QUI.hideSetup();
                st = QRules.createGame(2, [
                    { name: '红', type: 'ai', aiLevel: 2 },
                    { name: '蓝', type: 'ai', aiLevel: 2 }
                ]);
                mode = 'move';
                refreshUI();
                scheduleAI();
            }
        } catch (e) { /* ignore */ }
    }
    init();

    return {
        get state() { return st; },
        get mode() { return mode; },
        redraw, refreshUI, scheduleAI
    };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QApp;
