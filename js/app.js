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
    let winRates = null;          // per-player-id array of [0,1] or null
    let gameEpoch = 0;            // bumped on every applied action (guards AI replies)
    let wrEpoch = 0;              // bumped on every win-rate request (guards WR replies)

    const AI_BUDGET_MS = 2400;    // hard search budget (< 3s user tolerance)
    const undoBtn = document.getElementById('undoBtn');
    const newGameBtn = document.getElementById('newGameBtn');
    const board = QRender.board;

    /* ---------------- drawing ---------------- */

    let pathCache = { key: null, paths: null };   // recompute only when the position changes

    function computePaths() {
        if (!st || st.winner !== null || !QUI.showPaths) return null;
        // cache key: pawn positions + wall grids + player list identity
        const key = JSON.stringify([
            st.players.map(p => [p.id, p.pos.x, p.pos.y]),
            st.hw, st.vw
        ]);
        if (pathCache.key === key) return pathCache.paths;
        const paths = [];
        for (const p of st.players) {
            const cells = QRules.shortestPath(st, p.id);
            if (cells && cells.length > 1) paths.push({ color: p.color, cells });
        }
        pathCache = { key, paths };
        return paths;
    }

    function redraw() {
        if (!st) return;
        const humanTurn = st.winner === null && st.players[st.turn].type === 'human';
        const legalCells = humanTurn ? QRules.legalMoves(st, st.turn) : [];
        const lastRec = st.history[st.history.length - 1];
        QRender.draw(st, {
            hoverCell, hoverWall,
            legalCells,
            paths: computePaths(),
            currentPi: st.winner === null ? st.turn : st.winner,
            lastMove: lastRec && lastRec.type === 'move' ? lastRec : null,
            lastWall: lastRec && lastRec.type === 'wall' ? lastRec : null
        });
    }

    function refreshUI() {
        if (!st) return;
        // animate:false — a structural re-render (AI thinking, hover, undo)
        // must not restart the bar animation or clear the numbers on screen.
        QUI.renderPlayers(st, QUI.showWinRate ? winRates : null, false);
        QUI.renderHistory(st);
        updateStatus();
        updateButtons();
        redraw();
    }

    /** Serialize the game state for the worker (plain data only). */
    function exportState() {
        return {
            mode: st.mode,
            players: st.players.map(p => ({
                id: p.id, seatKey: p.seatKey, name: p.name, color: p.color, goal: p.goal,
                type: p.type, wallQuota: p.wallQuota, walls: p.walls,
                pos: { x: p.pos.x, y: p.pos.y }
            })),
            hw: st.hw.map(r => r.slice()),
            vw: st.vw.map(r => r.slice()),
            turn: st.turn, moveNo: st.moveNo,
            history: [],
            winner: st.winner
        };
    }

    /**
     * Update win-rate bars.
     *
     * One Monte-Carlo batch now yields every player's rate at once
     * (simulateWinRates), so the cost is paid once per position instead of
     * once per player. The batch runs in a dedicated sampler worker so a
     * 4-player estimate can never freeze the board; the same worker source
     * also serves the heavy AI search (separate instance, so a 2.4 s search
     * can never starve a short sampling job).
     *
     * Results are applied through the wrEpoch guard: only the newest request
     * wins. Until a new estimate lands, `winRates` keeps the previous array,
     * so the cards keep showing the old bars instead of blanking out.
     */
    function refreshWinRates() {
        if (!st || st.winner !== null) return;
        if (!QUI.showWinRate) return;
        const epoch = ++wrEpoch;
        const snapshot = exportState();
        const rollouts = st.players.length > 2 ? 96 : 160;
        const apply = (rates) => {
            if (epoch !== wrEpoch || !st || st.winner !== null) return;
            winRates = rates;
            QUI.renderPlayers(st, winRates);      // animates from what is shown
        };
        const computeSync = () => {
            try { apply(QAI.simulateWinRates(snapshot, rollouts)); }
            catch (e) { /* keep the previous bars */ }
        };
        // Defer one tick so the board paints (and the AI can start) first.
        setTimeout(() => {
            if (epoch !== wrEpoch || !st || st.winner !== null) return;
            if (AIWorkerHelper.available) {
                AIWorkerHelper.winRates(snapshot, rollouts)
                    .then(res => {
                        if (res && res.rates) apply(res.rates);
                        else computeSync();
                    })
                    .catch(computeSync);
            } else {
                computeSync();
            }
        }, 0);
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

    /** Show the AI's last search stats in the status bar (thinking insight). */
    function showAIStats(pName, pColor, stats) {
        if (!stats) return;
        const nodes = stats.nodes >= 1000 ? (stats.nodes / 1000).toFixed(1) + 'k' : stats.nodes;
        QUI.setStatus('<b style="color:' + pColor + '">' + esc(pName) + '</b> (AI) · depth <b>' + stats.depth + '</b> · eval <b>' +
            (stats.score > 0 ? '+' : '') + stats.score + '</b> · ' + nodes + ' nodes · ' + stats.ms + 'ms');
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
        gameEpoch++;
        // Deliberately KEEP winRates here: the previous estimate stays on
        // screen while the AI thinks, then glides to the new numbers when
        // refreshWinRates() lands. Clearing it would blank the bars.
        pathCache = { key: null, paths: null };   // position changed
        refreshUI();
        if (st.winner !== null) {
            setTimeout(() => QUI.showWin(st), 600);
            return;
        }
        scheduleAI();
        refreshWinRates();
    }

    /* ---------------- AI scheduling ---------------- */
    function scheduleAI() {
        clearTimeout(aiTimer);
        if (!st || st.winner !== null) return;
        if (st.players[st.turn].type !== 'ai') return;
        aiThinking = true;
        // Only the status line and buttons change here; the player cards keep
        // the previous win-rate bars untouched while the AI thinks.
        updateStatus();
        updateButtons();
        const pi = st.turn;
        const epoch = gameEpoch;   // bumped by every applied action
        aiTimer = setTimeout(() => {
            const snapshot = exportState();
            const applyAction = (action) => {
                aiThinking = false;
                if (epoch !== gameEpoch || !st || st.winner !== null) { refreshUI(); return; }
                if (!action) { refreshUI(); return; }
                if (action.type === 'move') {
                    QRules.applyMove(st, pi, action.target);
                } else {
                    QRules.applyWall(st, pi, action.wall.x, action.wall.y, action.wall.isH);
                }
                // show what the AI was thinking before the next status overwrite
                const mover = st.players[pi];
                showAIStats(mover.name, mover.color, action.stats);
                afterAction();
            };
            // Prefer the worker (deep search off the main thread); fall back
            // to a synchronous search when workers are unavailable (file://).
            const think = (viaWorker) => {
                if (viaWorker) {
                    AIWorkerHelper.decide(snapshot, pi, AI_BUDGET_MS)
                        .then(res => {
                            if (res && res.action) applyAction(res.action);
                            else applyAction(QAI.decide(snapshot, pi, 400));
                        })
                        .catch(() => applyAction(QAI.decide(snapshot, pi, 400)));
                } else {
                    applyAction(QAI.decide(snapshot, pi, 400));
                }
            };
            if (AIWorkerHelper.available) think(true);
            else AIWorkerHelper.init().then(ok => think(ok));
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
        gameEpoch++;
        // Undo rewinds the position: keep the current bars on screen and let
        // the next estimate glide to the rewound value (QUI.resetWinRates()
        // is only for a brand-new game).
        pathCache = { key: null, paths: null };
        refreshUI();
        scheduleAI();
        refreshWinRates();
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
        gameEpoch++;
        winRates = null;
        QUI.resetWinRates();
        pathCache = { key: null, paths: null };
        refreshUI();
        scheduleAI();
        refreshWinRates();
    });

    rematchBtn.addEventListener('click', () => {
        const seats = st.players.map(p => ({ name: p.name, type: p.type }));
        st = QRules.createGame(st.mode, seats);
        QUI.hideWin();
        hoverCell = hoverWall = null;
        gameEpoch++;
        winRates = null;
        QUI.resetWinRates();
        pathCache = { key: null, paths: null };
        refreshUI();
        scheduleAI();
        refreshWinRates();
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
                QUI.resetWinRates();
                refreshUI();
                scheduleAI();
                refreshWinRates();
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
