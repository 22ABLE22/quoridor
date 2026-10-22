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

    /* ---------------- status bar ---------------- */
    function setStatus(html) { statusBar.innerHTML = html; }

    /* ---------------- player cards ---------------- */
    function renderPlayers(st) {
        playersList.innerHTML = '';
        for (const p of st.players) {
            const card = document.createElement('div');
            card.className = 'player-card' +
                (st.winner === null && st.players[st.turn].id === p.id ? ' turn' : '') +
                (st.winner === p.id ? ' win' : '');
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
    return {
        themeBtn, statusBar, playersList, historyList,
        setupOverlay, winOverlay,
        setStatus, renderPlayers, renderHistory,
        showSetup, hideSetup, showWin, hideWin,
        showToast
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QUI;
