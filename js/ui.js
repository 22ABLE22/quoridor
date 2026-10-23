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

    /* ---------------- win-rate animation ---------------- */
    /* Last *displayed* win rate per player position, and the latest estimate.
     * Keeping them separate is what makes the bars feel continuous: while the
     * AI thinks, app.js re-renders the cards with the previous winRates and
     * the displayed values simply stay where they are; when a fresh estimate
     * arrives the numbers ease from where they are to the new value instead
     * of snapping or blanking out. */
    let shownRates = [];        // player position → currently displayed percent
    let targetRates = [];       // player position → latest estimate (0..1)
    let animRaf = null;
    const ANIM_MS = 460;        // a touch under half a second

    /** smoothstep: slow at both ends, fast through the middle. */
    function ease(t) { return t * t * (3 - 2 * t); }

    function stopAnim() {
        if (animRaf !== null) {
            cancelAnimationFrame(animRaf);
            animRaf = null;
        }
    }

    function now() {
        return (typeof performance !== 'undefined' ? performance : Date).now();
    }

    function paintCard(pidx, pct) {
        const card = playersList.children[pidx];
        if (!card) return;
        const fill = card.querySelector('.pc-winrate-fill');
        const txt = card.querySelector('.pc-winrate-txt');
        if (!fill || !txt) return;
        fill.style.width = pct + '%';
        txt.textContent = Math.round(pct) + '%';
    }

    /**
     * Animate every visible bar from its currently displayed value to
     * targetRates. Both the fill width and the percentage text are driven
     * from the same frame, so the number glides 51 → 52 → … → 72 with the
     * bar instead of jumping ahead of it.
     */
    function animateRates() {
        stopAnim();
        const from = shownRates.slice();
        const to = targetRates.map(v => (v == null || !isFinite(v)) ? null : v * 100);
        const changed = to.some((v, i) => v != null && v !== from[i]);
        if (!changed) return;
        const reduced = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced || typeof requestAnimationFrame !== 'function') {
            for (let i = 0; i < to.length; i++) {
                if (to[i] == null) continue;
                shownRates[i] = to[i];
                paintCard(i, to[i]);
            }
            return;
        }
        const t0 = now();
        const step = () => {
            const t = Math.min(1, (now() - t0) / ANIM_MS);
            const e = ease(t);
            for (let i = 0; i < to.length; i++) {
                if (to[i] == null) continue;
                const a = (from[i] == null || !isFinite(from[i])) ? to[i] : from[i];
                const v = a + (to[i] - a) * e;
                shownRates[i] = v;
                paintCard(i, v);
            }
            if (t < 1) animRaf = requestAnimationFrame(step);
            else { animRaf = null; shownRates = to.slice(); }
        };
        animRaf = requestAnimationFrame(step);
    }

    /** Forget the animation history (new game / undo / player count change). */
    function resetWinRates() {
        stopAnim();
        shownRates = [];
        targetRates = [];
    }

    /* ---------------- player cards ---------------- */
    /**
     * Render player cards. winRates is an optional array indexed by the
     * player's POSITION in st.players (not by seat id — seats can be skipped
     * with 'off', so id and array index may differ).
     *
     * `animate` (default true) eases the bars toward winRates. Pass false for
     * structural re-renders that must not restart the animation — in
     * particular the re-render while the AI is thinking, which must keep the
     * previous numbers on screen untouched.
     */
    function renderPlayers(st, winRates, animate) {
        playersList.innerHTML = '';
        const rates = winRates || null;
        // A new estimate arrives as a whole array: retarget, but keep the
        // numbers currently on screen as the animation's starting point.
        if (rates) {
            targetRates = rates.slice();
            if (shownRates.length !== st.players.length) shownRates = rates.map(v => v * 100);
        }
        st.players.forEach((p, pidx) => {
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
            const d = QRules.distanceToGoal(st, pidx);
            card.querySelector('.pc-dist b').textContent = isFinite(d) ? d : '∞';
            // win rate (indexed by player position, matching winRates)
            const fill = card.querySelector('.pc-winrate-fill');
            const txt = card.querySelector('.pc-winrate-txt');
            if (st.winner === p.id) {
                shownRates[pidx] = 100;
                fill.style.width = '100%';
                txt.textContent = '100%';
            } else if (st.winner !== null) {
                shownRates[pidx] = 0;
                fill.style.width = '0%';
                txt.textContent = '0%';
            } else if (shownRates[pidx] != null && isFinite(shownRates[pidx])) {
                // Keep the number that is on screen right now; animateRates()
                // below glides it toward the latest estimate.
                const pct = Math.round(shownRates[pidx]);
                fill.style.width = pct + '%';
                txt.textContent = pct + '%';
            } else if (rates && rates[pidx] != null && isFinite(rates[pidx])) {
                // First estimate for this game: nothing to glide from.
                shownRates[pidx] = rates[pidx] * 100;
                const pct = Math.round(shownRates[pidx]);
                fill.style.width = pct + '%';
                txt.textContent = pct + '%';
            } else {
                fill.style.width = '0%';
                txt.textContent = '—';
            }
            playersList.appendChild(card);
        });
        if (rates && animate !== false) animateRates();
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
        setStatus, renderPlayers, renderHistory, resetWinRates,
        showSetup, hideSetup, showWin, hideWin,
        showToast,
        get showWinRate() { return showWinRate; },
        get showPaths() { return showPaths; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = QUI;
