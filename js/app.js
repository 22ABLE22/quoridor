'use strict';
/* =========================================================================
 * QApp — main controller
 * Depends on: QRules, QAI, QRender, QInput, QUI (in index.html load order).
 * Owns:
 *   - game lifecycle (new game / running / finished / rematch)
 *   - unified input handling: click a cell to move, click a groove to place
 *     a wall (orientation inferred from the groove — no mode toggle)
 *   - AI turn scheduling (setTimeout lets the UI paint first)
 *   - undo (rolls back to before the last human action)
 *   - setup modal (2/4 players, per-seat Human/AI/Off + names)
 * ========================================================================= */
var QApp = (function () {

    /* ---------------- state ---------------- */
    let st = null;
    let hoverCell = null, hoverWall = null;
    let aiTimer = null;
    let aiThinking = false;

    const undoBtn = document.getElementById('undoBtn');
    const newGameBtn = document.getElementById('newGameBtn');
    const board = QRender.board;

    /* ---------------- drawing ---------------- */

    function redraw() {
        if (!st) return;
        const humanTurn = st.winner === null && st.players[st.turn].type === 'human';
        const legalCells = humanTurn ? QRules.legalMoves(st, st.turn) : [];
        const lastRec = st.history[st.history.length - 1];
        QRender.draw(st, {
            hoverCell, hoverWall,
            legalCells,
            currentPi: st.winner === null ? st.turn : st.winner,
            lastMove: lastRec && lastRec.type === 'move' ? lastRec : null,
            lastWall: lastRec && lastRec.type === 'wall' ? lastRec : null
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
        if (!st) return;
        if (st.winner !== null) {
            const p = st.players[st.winner];
            QUI.setStatus('<b style="color:' + p.color + '">' + esc(p.name) + '</b> reached the goal edge and wins! 🏆');
            return;
        }
        const p = st.players[st.turn];
        const d = QRules.distanceToGoal(st, st.turn);
        const distText = isFinite(d) ? '<b>' + d + '</b> to goal' : 'no path';
        if (p.type === 'ai') {
            QUI.setStatus('<b style="color:' + p.color + '">' + esc(p.name) + '</b> (AI) is thinking… ' + distText);
        } else {
            QUI.setStatus('Your move, <b style="color:' + p.color + '">' + esc(p.name) + '</b> · ' + p.walls + ' walls left · ' +
                distText + ' — click a cell to move, or a groove to place a wall');
        }
    }

    function updateButtons() {
        undoBtn.disabled = !st || st.history.length === 0;
    }

    /* ---------------- input ---------------- */
    QInput.bind({
        onTap: onBoardTap,
        onHover: onHover
    });

    function onBoardTap(cell, wall) {
        if (!st || st.winner !== null || aiThinking) return;
        const pi = st.turn;
        if (st.players[pi].type !== 'human') return;

        // Wall placement wins if the pointer is in a groove.
        if (wall) {
            const ok = QRules.canPlaceWall(st, pi, wall.x, wall.y, wall.isH);
            if (!ok) {
                let why = 'Illegal wall position';
                const p = st.players[pi];
                if (p.walls <= 0) why = 'No walls left';
                else if (QRules.wallConflicts(st, wall.x, wall.y, wall.isH)) why = 'Overlaps or crosses an existing wall';
                else why = 'You cannot seal off any player completely';
                QUI.showToast(why, true);
                return;
            }
            QRules.applyWall(st, pi, wall.x, wall.y, wall.isH);
            afterAction();
            return;
        }
        // Otherwise: pawn move.
        if (!cell) return;
        const legal = QRules.legalMoves(st, pi).find(m => m.x === cell.x && m.y === cell.y);
        if (!legal) { QUI.showToast('Illegal move', true); return; }
        QRules.applyMove(st, pi, cell);
        afterAction();
    }

    function onHover(cell, wall) {
        if (!st || st.winner !== null || aiThinking) { cell = null; wall = null; }
        else if (st.players[st.turn].type !== 'human') { cell = null; wall = null; }
        let changed = false;
        if ((cell && !hoverCell) || (!cell && hoverCell) ||
            (cell && hoverCell && (cell.x !== hoverCell.x || cell.y !== hoverCell.y))) changed = true;
        hoverCell = cell;
        if (wall) {
            const legal = QRules.canPlaceWall(st, st.turn, wall.x, wall.y, wall.isH);
            wall = { x: wall.x, y: wall.y, isH: wall.isH, legal };
        }
        if ((wall && !hoverWall) || (!wall && hoverWall) ||
            (wall && hoverWall && (wall.x !== hoverWall.x || wall.y !== hoverWall.y || wall.isH !== hoverWall.isH || wall.legal !== hoverWall.legal))) changed = true;
        hoverWall = wall;
        if (changed) redraw();
    }

    /* ---------------- post-action ---------------- */
    function afterAction() {
        hoverCell = hoverWall = null;
        refreshUI();
        if (st.winner !== null) {
            setTimeout(() => QUI.showWin(st), 600);
            return;
        }
        scheduleAI();
    }

    /* ---------------- AI scheduling ---------------- */
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
        }, 420);
    }

    /* ---------------- undo ---------------- */
    undoBtn.addEventListener('click', () => {
        if (!st || !st.history.length) return;
        clearTimeout(aiTimer);
        aiThinking = false;
        let n = 0;
        // Roll back AI replies plus the last human action.
        do {
            QRules.undoLast(st);
            n++;
        } while (st.history.length > 0 && st.players[st.turn].type !== 'human' && n < 12);
        QUI.hideWin();
        QUI.showToast('Undid ' + n + ' move' + (n > 1 ? 's' : ''));
        refreshUI();
        scheduleAI();
    });

    /* ---------------- setup modal ---------------- */
    const modeSeg = document.getElementById('modeSeg');
    const seatRows = document.getElementById('seatRows');
    const startBtn = document.getElementById('startBtn');
    const rematchBtn = document.getElementById('rematchBtn');
    const reconfigBtn = document.getElementById('reconfigBtn');

    let setupMode = 2;
    let seatConfig = defaultSeats();

    function defaultSeats() {
        return [
            { name: 'Red', type: 'human' },
            { name: 'Blue', type: 'ai' },
            { name: 'Green', type: 'ai' },
            { name: 'Gold', type: 'ai' }
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
                    '<button type="button" data-t="human">Human</button>' +
                    '<button type="button" data-t="ai">AI</button>' +
                    '<button type="button" data-t="off">Off</button>' +
                '</span>';
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
            QUI.showToast(err.message === 'at least 2 players are required'
                ? 'At least 2 seats must be active' : err.message, true);
            return;
        }
        QUI.hideSetup();
        QUI.hideWin();
        hoverCell = hoverWall = null;
        refreshUI();
        scheduleAI();
    });

    rematchBtn.addEventListener('click', () => {
        const seats = st.players.map(p => ({ name: p.name, type: p.type }));
        st = QRules.createGame(st.mode, seats);
        QUI.hideWin();
        hoverCell = hoverWall = null;
        refreshUI();
        scheduleAI();
    });

    reconfigBtn.addEventListener('click', () => {
        QUI.hideWin();
        QUI.showSetup();
        setupMode = st.mode;
        modeSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.mode === setupMode));
        const active = st.players;
        for (let i = 0; i < setupMode; i++) {
            const found = active.find(p => p.id === i);
            seatConfig[i] = found
                ? { name: found.name, type: found.type }
                : { name: QRules.SEAT_DEFS[i].name, type: 'off' };
        }
        renderSeatRows();
    });

    newGameBtn.addEventListener('click', () => {
        QUI.showSetup();
        renderSeatRows();
    });

    /* ---------------- dismiss modals without starting a game ----------------
     * Clicking the dim backdrop (or pressing Esc) cancels the setup modal and
     * returns to the game in progress. A finished game goes back to the result
     * modal (Rematch stays reachable). With no game created yet, the setup
     * modal stays — there is nothing to return to. */
    function cancelSetup() {
        if (!st) return;
        QUI.hideSetup();
        if (st.winner !== null) QUI.showWin(st);
        refreshUI();
        scheduleAI();
    }
    setupOverlay.addEventListener('click', (e) => {
        if (e.target !== setupOverlay) return;   // only the backdrop itself
        cancelSetup();
    });
    winOverlay.addEventListener('click', (e) => {
        if (e.target !== winOverlay) return;
        QUI.hideWin();
        refreshUI();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (!setupOverlay.classList.contains('hidden')) cancelSetup();
        else if (!winOverlay.classList.contains('hidden')) { QUI.hideWin(); refreshUI(); }
    });

    /* ---------------- theme change redraws ---------------- */
    document.addEventListener('quoridor:redraw', redraw);
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onScheme = () => { if (document.documentElement.dataset.theme === 'auto') redraw(); };
        if (mq.addEventListener) mq.addEventListener('change', onScheme);
        else if (mq.addListener) mq.addListener(onScheme);
    }

    /* ---------------- responsive sizing ---------------- */
    function fitBoard() {
        const wrap = board.parentElement;
        const size = Math.max(280, Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth));
        QRender.resize(Math.floor(size));
        redraw();
    }
    window.addEventListener('resize', fitBoard);

    /* ---------------- escape helper ---------------- */
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------------- boot ---------------- */
    function init() {
        fitBoard();
        renderSeatRows();
        QUI.showSetup();
        QUI.setStatus('Set up the seats to start a game');
        // Test hook: ?autotest=1 skips the modal and starts AI vs AI (browser smoke test).
        try {
            if (new URLSearchParams(location.search).get('autotest') === '1') {
                QUI.hideSetup();
                st = QRules.createGame(2, [
                    { name: 'Red', type: 'ai' },
                    { name: 'Blue', type: 'ai' }
                ]);
                refreshUI();
                scheduleAI();
            }
        } catch (e) { /* ignore */ }
    }
    init();

    return {
        get state() { return st; },
        redraw, refreshUI, scheduleAI
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QApp;
