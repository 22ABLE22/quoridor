// End-to-end check for keyboard wall rotation.
//
// Reproduces the reported bug against the real page in a real browser:
// press W, move to an anchor, press R, and assert that a wall preview is
// still on screen afterwards (the cursor did not collapse to NaN).
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

/** Read the live cursor and whether a wall preview would be drawn. */
function cursorState(page) {
    return page.evaluate(() => {
        const c = QInput.cursor;
        // the app draws a groove preview when the cursor is in wall mode
        return {
            mode: c.mode,
            x: c.x, y: c.y, isH: c.isH,
            finite: Number.isFinite(c.x) && Number.isFinite(c.y),
            hasHandler: typeof QInput.bind === 'function'
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

    // W → wall mode
    await page.keyboard.press('w');
    await page.waitForTimeout(120);
    let s = await cursorState(page);
    check('W enters wall mode', s.mode === 'wall', JSON.stringify(s));
    check('wall cursor starts finite', s.finite, JSON.stringify(s));

    // move a couple of anchors
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(120);
    const beforeRotate = await cursorState(page);
    check('arrows move the wall anchor',
        beforeRotate.x !== s.x || beforeRotate.y !== s.y, JSON.stringify(beforeRotate));

    await page.evaluate(() => document.getElementById('play').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'rotate-1-before.png') });

    // R → rotate. This is the reported failure.
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
    const afterRotate = await cursorState(page);
    check('R keeps a finite anchor (the reported bug)', afterRotate.finite, JSON.stringify(afterRotate));
    check('R keeps the same anchor position',
        afterRotate.x === beforeRotate.x && afterRotate.y === beforeRotate.y,
        JSON.stringify(beforeRotate) + ' -> ' + JSON.stringify(afterRotate));
    check('R flips the orientation', afterRotate.isH === !beforeRotate.isH, `${beforeRotate.isH} -> ${afterRotate.isH}`);
    check('R stays in wall mode', afterRotate.mode === 'wall');
    await page.screenshot({ path: path.join(OUT, 'rotate-2-after.png') });

    // a second R returns to the original orientation
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
    const afterTwo = await cursorState(page);
    check('R twice restores the orientation', afterTwo.isH === beforeRotate.isH, `${beforeRotate.isH} -> ${afterTwo.isH}`);
    check('R twice keeps a finite anchor', afterTwo.finite, JSON.stringify(afterTwo));

    // the wall must actually be placeable after rotating
    await page.keyboard.press('r');
    await page.waitForTimeout(150);
    const historyBefore = await page.evaluate(() => QApp.state.history.length);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const historyAfter = await page.evaluate(() => QApp.state.history.length);
    check('Enter places the rotated wall', historyAfter > historyBefore, `${historyBefore} -> ${historyAfter}`);
    await page.screenshot({ path: path.join(OUT, 'rotate-3-placed.png') });

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    srv.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('QA crashed:', e); process.exit(1); });
