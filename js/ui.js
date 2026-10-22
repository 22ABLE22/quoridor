'use strict';
/* =========================================================================
 * QUI — page UI controls
 * Depends on: global QRules.
 * Owns: theme cycling (Auto/Light/Dark + localStorage), player cards,
 * history list, status bar, setup modal, win modal, toast.
 * ========================================================================= */
var QUI = (function () {

    /* ---------------- theme ---------------- */
    const THEME_ORDER = ['auto', 'light', 'dark'];
    const THEME_LABEL = { auto: '🌗 Auto', light: '☀️ Light', dark: '🌙 Dark' };
    const themeBtn = document.getElementById('themeBtn');

    function readTheme() {
        try { return localStorage.getItem('quoridor.theme'); } catch (e) { return null; }
    }
    function writeTheme(mode) {
        try { localStorage.setItem('quoridor.theme', mode); } catch (e) { /* file:// may deny storage */ }
    }
    function applyTheme(mode) {
        document.documentElement.dataset.theme = mode;
        themeBtn.textContent = THEME_LABEL[mode] || THEME_LABEL.auto;
        document.dispatchEvent(new Event('quoridor:redraw'));
    }
    let themeMode = readTheme();
    if (!THEME_LABEL[themeMode]) themeMode = 'auto';
    applyTheme(themeMode);
    themeBtn.addEventListener('click', () => {
        themeMode = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
        writeTheme(themeMode);
        applyTheme(themeMode);
    });

    /* ---------------- DOM handles ---------------- */
    const statusBar = document.getElementById('statusBar');
    const playersList = document.getElementById('playersList');
    const historyList = document.getElementById('historyList');
    const setupOverlay = document.getElementById('setupOverlay');
    const winOverlay = document.getElementById('winOverlay');
    const toastEl = document.getElementById('toast');
    const winRateBtn = document.getElementById('winRateBtn');
    const pathsBtn = document.getElementById('pathsBtn');

    /* ---------------- win-rate toggle ---------------- */
    const WR_KEY = 'quoridor.winrate';
    function readWinRatePref() {
        try { return localStorage.getItem(WR_KEY) !== '0'; } catch (e) { return true; }
    }
    let showWinRate = readWinRatePref();
    function applyWinRatePref() {
        winRateBtn.setAttribute('aria-pressed', showWinRate);
        document.querySelectorAll('.player-card').forEach(c => {
            c.classList.toggle('winrate-hidden', !showWinRate);
        });
    }
    winRateBtn.addEventListener('click', () => {
        showWinRate = !showWinRate;
        try { localStorage.setItem(WR_KEY, showWinRate ? '1' : '0'); } catch (e) { /* ignore */ }
        applyWinRatePref();
        document.dispatchEvent(new Event('quoridor:redraw'));
    });

    /* ---------------- shortest-path toggle ---------------- */
    const PATHS_KEY = 'quoridor.paths';
    function readPathsPref() {
        try { return localStorage.getItem(PATHS_KEY) !== '0'; } catch (e) { return true; }
    }
    let showPaths = readPathsPref();
    function applyPathsPref() {
        pathsBtn.setAttribute('aria-pressed', showPaths);
    }
    pathsBtn.addEventListener('click', () => {
        showPaths = !showPaths;
        try { localStorage.setItem(PATHS_KEY, showPaths ? '1' : '0'); } catch (e) { /* ignore */ }
        applyPathsPref();
        document.dispatchEvent(new Event('quoridor:redraw'));
    });

    /* ---------------- status bar ---------------- */
    function setStatus(html) { statusBar.innerHTML = html; }

    /* ---------------- player cards ---------------- */
    /**
     * Render player cards. winRates is an optional array (per player id) of
     * numbers in [0,1] or null (not computed yet).
     */
    function renderPlayers(st, winRates) {
        playersList.innerHTML = '';
        for (const p of st.players) {
            const card = document.createElement('div');
            card.className = 'player-card' +
                (st.winner === null && st.players[st.turn].id === p.id ? ' turn' : '') +
                (st.winner === p.id ? ' win' : '') +
                (showWinRate ? '' : ' winrate-hidden');
            card.style.setProperty('--pc', p.color);
            const typeTag = p.type === 'ai' ? 'AI' : 'Human';
            card.innerHTML =
                '<div class="pc-row1">' +
                    '<span class="pc-dot"></span>' +
                    '<span class="pc-name"></span>' +
                    '<span class="pc-tag"></span>' +
                '</div>' +
                '<div class="pc-row2">' +
                    '<span>Walls</span>' +
                    '<span class="pc-walls"></span>' +
                    '<span class="pc-dist"><b>—</b> to goal</span>' +
                '</div>' +
                '<div class="pc-row3">' +
                    '<span class="pc-winrate"><span class="pc-winrate-fill"></span></span>' +
                    '<span class="pc-winrate-txt">—</span>' +
                '</div>';
            card.querySelector('.pc-name').textContent = p.name;
            card.querySelector('.pc-tag').textContent = typeTag;
            const wallsBox = card.querySelector('.pc-walls');
            for (let i = 0; i < p.wallQuota; i++) {
                const w = document.createElement('span');
                w.className = 'pc-wall' + (i < p.wallQuota - p.walls ? ' used' : '');
                wallsBox.appendChild(w);
            }
            const d = QRules.distanceToGoal(st, p.id);
            card.querySelector('.pc-dist b').textContent = isFinite(d) ? d : '∞';
            // win rate
            const fill = card.querySelector('.pc-winrate-fill');
            const txt = card.querySelector('.pc-winrate-txt');
            const rate = winRates ? winRates[p.id] : null;
            if (st.winner === p.id) {
                fill.style.width = '100%';
                txt.textContent = '100%';
            } else if (st.winner !== null) {
                fill.style.width = '0%';
                txt.textContent = '0%';
            } else if (rate != null && isFinite(rate)) {
                const pct = Math.round(rate * 100);
                fill.style.width = pct + '%';
                txt.textContent = pct + '%';
            } else {
                fill.style.width = '0%';
                txt.textContent = '—';
            }
            playersList.appendChild(card);
        }
    }

    /* ---------------- history ---------------- */
    function renderHistory(st) {
        historyList.innerHTML = '';
        if (!st.history.length) {
            historyList.innerHTML = '<div class="hist-empty">No moves yet</div>';
            return;
        }
        for (let i = st.history.length - 1; i >= 0; i--) {
            const rec = st.history[i];
            const item = document.createElement('div');
            item.className = 'hist-item';
            const p = st.players[rec.pi];
            const no = document.createElement('span');
            no.className = 'no';
            no.textContent = (i + 1);
            const who = document.createElement('span');
            who.className = 'who';
            who.style.color = p.color;
            who.textContent = p.name;
            const what = document.createElement('span');
            what.className = 'what';
            what.textContent = QRules.moveDesc(rec);
            item.append(no, who, what);
            historyList.appendChild(item);
        }
    }

    /* ---------------- modals ---------------- */
    function showSetup() { setupOverlay.classList.remove('hidden'); }
    function hideSetup() { setupOverlay.classList.add('hidden'); }
    function showWin(st) {
        const p = st.players[st.winner];
        document.getElementById('winTitle').textContent = p.name + ' wins';
        document.getElementById('winSub').textContent =
            st.history.length + ' moves · ' + st.players.length + ' players';
        winOverlay.querySelector('.modal').style.setProperty('--win-color', p.color);
        winOverlay.classList.remove('hidden');
    }
    function hideWin() { winOverlay.classList.add('hidden'); }

    /* ---------------- toast ---------------- */
    let toastTimer = null;
    function showToast(msg, isError) {
        toastEl.textContent = msg;
        toastEl.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 1800);
    }

    /* ---------------- public ---------------- */
    applyWinRatePref();
    applyPathsPref();
    return {
        themeBtn, statusBar, playersList, historyList,
        setupOverlay, winOverlay, winRateBtn, pathsBtn,
        setStatus, renderPlayers, renderHistory,
        showSetup, hideSetup, showWin, hideWin,
        showToast,
        get showWinRate() { return showWinRate; },
        get showPaths() { return showPaths; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QUI;
