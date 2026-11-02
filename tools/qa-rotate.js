// End-to-end check for the W toggle (wall placement on and off) plus the
// rotation regression it sits next to.
//
//   node tools/qa-rotate.js
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');

const PW = process.env.PW_CORE ||
    'C:/Users/Admin/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core';
const { chromium } = require(PW);

const ROOT = path.dirname(path.dirname(__filename));
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = Number(process.env.QA_PORT || 8171);
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };

function serve() {
    const srv = http.createServer((req, res) => {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/index.html';
        const f = path.join(ROOT, p);
        if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
            res.writeHead(404); return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(fs.readFileSync(f));
    });
    return new Promise(r => srv.listen(PORT, () => r(srv)));
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}

function cursorState(page) {
    return page.evaluate(() => {
        const c = QInput.cursor;
        return {
            mode: c.mode, x: c.x, y: c.y, isH: c.isH,
            finite: Number.isFinite(c.x) && Number.isFinite(c.y)
        };
    });
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const srv = await serve();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.click('#openSetupBtn');
    await page.waitForTimeout(200);
    await page.click('#startBtn');
    await page.waitForTimeout(1200);

    await page.locator('#board').focus();

    /* ---------- W toggles both ways ---------- */
    // Capture the cell BEFORE pressing W: that is the cell W must return to.
    const originCell = await cursorState(page);
    check('the cursor starts on a cell', originCell.mode === 'cell', JSON.stringify(originCell));

    await page.keyboard.press('w');
    await page.waitForTimeout(120);
    let s = await cursorState(page);
    check('W enters wall mode', s.mode === 'wall', JSON.stringify(s));
    check('wall cursor starts finite', s.finite);
    // The anchor grid is 8x8 (0..7) while cells are 9x9, so a seed on a
    // border cell is clamped, not copied. Assert the clamp explicitly.
    const ANCH = 8;
    check('the wall anchor is seeded from the cell, clamped to the anchor grid',
        s.x === Math.min(originCell.x, ANCH - 1) && s.y === Math.min(originCell.y, ANCH - 1),
        JSON.stringify(originCell) + ' -> ' + JSON.stringify(s));

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(120);
    const moved = await cursorState(page);
    check('arrows move the wall anchor', moved.x !== s.x || moved.y !== s.y,
        JSON.stringify(moved));

    await page.evaluate(() => document.getElementById('play').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'w-1-wall-mode.png') });

    await page.keyboard.press('w');
    await page.waitForTimeout(200);
    const back = await cursorState(page);
    check('W again leaves wall mode', back.mode === 'cell', JSON.stringify(back));
    check('W again returns to the cell you left, not the anchor',
        back.x === originCell.x && back.y === originCell.y,
        JSON.stringify(originCell) + ' <- ' + JSON.stringify(back) +
        ' (anchor was ' + moved.x + ',' + moved.y + ')');
    check('the returned cursor is finite', back.finite);
    await page.screenshot({ path: path.join(OUT, 'w-2-back-to-move.png') });

    // a third press goes back in: it is a toggle, not a one-way switch
    await page.keyboard.press('w');
    await page.waitForTimeout(150);
    check('W is a toggle (third press re-enters)', (await cursorState(page)).mode === 'wall');
    await page.keyboard.press('w');
    await page.waitForTimeout(150);
    check('W toggles back out again', (await cursorState(page)).mode === 'cell');

    /* ---------- the rotation regression still holds ---------- */
    await page.keyboard.press('w');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const beforeRotate = await cursorState(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
    const afterRotate = await cursorState(page);
    check('R keeps a finite anchor', afterRotate.finite, JSON.stringify(afterRotate));
    check('R keeps the same anchor',
        afterRotate.x === beforeRotate.x && afterRotate.y === beforeRotate.y,
        JSON.stringify(beforeRotate) + ' -> ' + JSON.stringify(afterRotate));
    check('R flips the orientation', afterRotate.isH === !beforeRotate.isH,
        `${beforeRotate.isH} -> ${afterRotate.isH}`);

    /* ---------- Enter still places the rotated wall ---------- */
    const historyBefore = await page.evaluate(() => QApp.state.history.length);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const historyAfter = await page.evaluate(() => QApp.state.history.length);
    check('Enter places the wall', historyAfter > historyBefore, `${historyBefore} -> ${historyAfter}`);

    /* ---------- both status hints advertise the toggle ---------- */
    // Wait until it is the human's turn again, then read the hint in each mode.
    await page.waitForFunction(() => {
        const st = QApp.state;
        return st && st.winner === null && st.players[st.turn].type === 'human';
    }, null, { timeout: 15000 });
    await page.locator('#board').focus();

    const cellHint = await page.evaluate(() => document.getElementById('statusBar').textContent);
    check('the move-mode hint mentions W', /press W/i.test(cellHint), cellHint.trim().slice(0, 90));

    await page.keyboard.press('w');
    await page.waitForTimeout(200);
    const wallHint = await page.evaluate(() => document.getElementById('statusBar').textContent);
    check('the wall-mode hint mentions W or Esc returning', /W or Esc/i.test(wallHint),
        wallHint.trim().slice(0, 90));

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    srv.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('QA crashed:', e); process.exit(1); });
