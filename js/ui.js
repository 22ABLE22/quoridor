'use strict';
/* =========================================================================
 * QUI — 页面 UI 控制
 * 依赖：全局 QRules。
 * 职责：主题切换（Auto/Light/Dark 循环 + localStorage）、玩家卡片、
 *       历史列表、状态栏、设置弹层、胜利弹层、toast。
 * ========================================================================= */
var QUI = (function () {

    /* ---------------- 主题 ---------------- */
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
        if (window.QRender && QRender.readTheme) document.dispatchEvent(new Event('quoridor:redraw'));
    }
    let themeMode = readTheme();
    if (!THEME_LABEL[themeMode]) themeMode = 'auto';
    applyTheme(themeMode);
    themeBtn.addEventListener('click', () => {
        themeMode = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
        writeTheme(themeMode);
        applyTheme(themeMode);
    });

    /* ---------------- 常用 DOM ---------------- */
    const statusBar = document.getElementById('statusBar');
    const playersList = document.getElementById('playersList');
    const historyList = document.getElementById('historyList');
    const setupOverlay = document.getElementById('setupOverlay');
    const winOverlay = document.getElementById('winOverlay');
    const toastEl = document.getElementById('toast');

    /* ---------------- 状态栏 ---------------- */
    function setStatus(html) { statusBar.innerHTML = html; }

    /* ---------------- 玩家卡片 ---------------- */
    function renderPlayers(st) {
        playersList.innerHTML = '';
        for (const p of st.players) {
            const card = document.createElement('div');
            card.className = 'player-card' + (st.winner === null && st.players[st.turn].id === p.id ? ' turn' : '') +
                (st.winner === p.id ? ' win' : '');
            card.style.setProperty('--pc', p.color);
            const typeTag = p.type === 'ai' ? 'AI · ' + levelName(p.aiLevel) : '真人';
            card.innerHTML =
                '<div class="pc-row1">' +
                    '<span class="pc-dot"></span>' +
                    '<span class="pc-name"></span>' +
                    '<span class="pc-tag"></span>' +
                '</div>' +
                '<div class="pc-row2">' +
                    '<span>挡板</span>' +
                    '<span class="pc-walls"></span>' +
                    '<span class="pc-dist">距终点 <b>—</b></span>' +
                '</div>';
            card.querySelector('.pc-name').textContent = p.name;
            card.querySelector('.pc-tag').textContent = typeTag;
            // 挡板余量
            const wallsBox = card.querySelector('.pc-walls');
            for (let i = 0; i < p.wallQuota; i++) {
                const w = document.createElement('span');
                w.className = 'pc-wall' + (i < p.wallQuota - p.walls ? ' used' : '');
                wallsBox.appendChild(w);
            }
            // 距离
            const d = QRules.distanceToGoal(st, p.id);
            card.querySelector('.pc-dist b').textContent = isFinite(d) ? d : '∞';
            playersList.appendChild(card);
        }
    }

    function levelName(lv) { return lv <= 1 ? '入门' : lv === 2 ? '进阶' : '大师'; }

    /* ---------------- 历史 ---------------- */
    function renderHistory(st) {
        historyList.innerHTML = '';
        if (!st.history.length) {
            historyList.innerHTML = '<div class="hist-empty">对局尚未开始</div>';
            return;
        }
        // 倒序显示，最新在上
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

    /* ---------------- 弹层 ---------------- */
    function showSetup() { setupOverlay.classList.remove('hidden'); }
    function hideSetup() { setupOverlay.classList.add('hidden'); }
    function showWin(st) {
        const p = st.players[st.winner];
        const winTitle = document.getElementById('winTitle');
        const winSub = document.getElementById('winSub');
        const modal = winOverlay.querySelector('.modal');
        winTitle.textContent = p.name + ' 获胜';
        winSub.textContent = '共 ' + st.history.length + ' 手 · ' + st.mode + ' 人局';
        modal.style.setProperty('--win-color', p.color);
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

    /* ---------------- 对外 ---------------- */
    return {
        themeBtn, statusBar, playersList, historyList,
        setupOverlay, winOverlay,
        setStatus, renderPlayers, renderHistory,
        showSetup, hideSetup, showWin, hideWin,
        showToast, levelName
    };
})();

/* Node（测试）环境下挂到 module.exports，浏览器下保持全局变量 */
if (typeof module !== 'undefined' && module.exports) module.exports = QUI;
