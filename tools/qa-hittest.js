// Browser proof for the pointer split: with the clickable region at the
// middle 80% of a cell, a click near a cell's own edge must still move the
// pawn, and a click in the groove must offer a wall.
//
//   node tools/qa-hittest.js
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');

const PW = process.env.PW_CORE ||
    'C:/Users/Admin/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core';
const { chromium } = require(PW);

const ROOT = path.dirname(path.dirname(__filename));
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = Number(process.env.QA_PORT || 8181);
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

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const srv = await serve();
    const browser = await chromium.launch();

    for (const width of [1440, 390]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
        await page.click('#openSetupBtn');
        await page.waitForTimeout(200);
        await page.click('#startBtn');
        await page.waitForTimeout(1000);
        await page.evaluate(() => document.getElementById('play').scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(400);

        const label = width > 800 ? 'desktop' : 'phone';

        // Ask the page itself where a probe pixel lands.
        const probe = (fx, fy) => page.evaluate(([fx, fy]) => {
            const c = document.getElementById('board');
            const rect = c.getBoundingClientRect();
            const size = parseFloat(c.style.width) || rect.width;
            const r = QRender.cellRect(4, 7);           // a legal destination for Red
            const scale = size / rect.width;
            const px = r.cx + fx * QRender.CELL;
            const py = r.cy + fy * QRender.CELL;
            return {
                cell: QRender.pixelToCell(px, py),
                wall: QRender.pixelToWall(px, py),
                cellSize: +QRender.CELL.toFixed(2),
                // screen coords for a real click
                clientX: rect.left + px / scale,
                clientY: rect.top + py / scale
            };
        }, [fx, fy]);

        // 40% of a cell out from the centre is inside the 80% box.
        const inside = await probe(0.38, 0.38);
        check(`${label}: a click 38% out still counts as the cell`,
            inside.cell && inside.cell.x === 4 && inside.cell.y === 7 && !inside.wall,
            `cell=${JSON.stringify(inside.cell)} wall=${JSON.stringify(inside.wall)} cellSize=${inside.cellSize}`);

        // 45% out is past the 40% half-width: it belongs to the groove.
        const outside = await probe(0.45, 0.45);
        check(`${label}: a click 45% out falls to the groove`,
            !outside.cell || outside.wall,
            `cell=${JSON.stringify(outside.cell)} wall=${JSON.stringify(outside.wall)}`);

        // Real pointer click at the 38% offset must play the move.
        const before = await page.evaluate(() => QApp.state.history.length);
        await page.mouse.move(inside.clientX, inside.clientY);
        await page.waitForTimeout(120);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(800);
        const after = await page.evaluate(() => QApp.state.history.length);
        check(`${label}: clicking near the cell edge plays the move`, after > before,
            `${before} -> ${after} at ${inside.clientSize || inside.cellSize}px cells`);

        if (width === 1440) {
            await page.screenshot({ path: path.join(OUT, 'hittest-desktop.png') });
        }
        check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
    }

    await browser.close();
    srv.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('QA crashed:', e); process.exit(1); });
