// Visual + behavioural QA for the redesigned page.
// Drives a real Chromium (playwright-core) against the built site, captures
// screenshots at three widths in both themes, and asserts the things a
// screenshot cannot: no horizontal overflow, keyboard play, focus ring,
// scroll reveals firing, and the tagline lighting word by word.
//
//   node tools/qa.js
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');

const PW = process.env.PW_CORE ||
    'C:/Users/Admin/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core';
const { chromium } = require(PW);

const ROOT = path.dirname(path.dirname(__filename));
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = Number(process.env.QA_PORT || 8151);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
    const srv = http.createServer((req, res) => {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/index.html';
        const f = path.join(ROOT, p);
        if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end(fs.readFileSync(path.join(ROOT, '404.html')));
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(fs.readFileSync(f));
    });
    return new Promise(r => srv.listen(PORT, () => r(srv)));
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const srv = await serve();
    const browser = await chromium.launch();
    const base = `http://127.0.0.1:${PORT}/`;

    /* ---------- 1. layout at three widths, both themes ---------- */
    const sizes = [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'tablet', width: 900, height: 1000 },
        { name: 'phone', width: 390, height: 844 }
    ];

    for (const size of sizes) {
        for (const theme of ['light', 'dark']) {
            const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
            const page = await ctx.newPage();
            await page.addInitScript(t => { try { localStorage.setItem('quoridor.theme', t); } catch (e) {} }, theme);
            await page.goto(base, { waitUntil: 'networkidle' });
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(OUT, `${size.name}-${theme}-setup.png`) });

            // start a game so the board itself is what gets photographed
            await page.click('#openSetupBtn');
            await page.waitForTimeout(300);
            await page.click('#startBtn');
            await page.waitForTimeout(1600);

            const overflow = await page.evaluate(() => ({
                scrollW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth
            }));
            check(`${size.name}/${theme} no horizontal overflow`,
                overflow.scrollW <= overflow.clientW + 1,
                `${overflow.scrollW} vs ${overflow.clientW}`);

            await page.evaluate(() => document.getElementById('play').scrollIntoView({ block: 'start' }));
            await page.waitForTimeout(700);
            await page.screenshot({ path: path.join(OUT, `${size.name}-${theme}-game.png`) });

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(900);
            await page.screenshot({ path: path.join(OUT, `${size.name}-${theme}-bottom.png`) });
            await ctx.close();
        }
    }

    /* ---------- 2. behaviour on desktop ---------- */
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base, { waitUntil: 'networkidle' });

    // font actually applied
    const font = await page.evaluate(() => {
        const el = document.querySelector('.hero h1');
        return { family: getComputedStyle(el).fontFamily, loaded: document.fonts.check('16px Manrope') };
    });
    check('Manrope is applied and loaded', /Manrope/.test(font.family) && font.loaded, JSON.stringify(font));

    // the page opens on a live board preview, not on a modal
    check('setup modal closed on load', await page.isHidden('#setupOverlay .modal'));
    check('board preview is shown on load', await page.isVisible('#boardEmpty'));
    await page.screenshot({ path: path.join(OUT, 'qa-first-paint.png') });

    await page.click('#openSetupBtn');
    await page.waitForTimeout(300);
    check('setup modal opens from the board', await page.isVisible('#setupOverlay .modal'));
    await page.click('#startBtn');
    await page.waitForTimeout(1200);
    check('modal closes after start', await page.isHidden('#setupOverlay .modal'));
    check('preview panel goes away', await page.isHidden('#boardEmpty'));

    const boardBox = await page.locator('#board').boundingBox();
    check('board has a real size', boardBox && boardBox.width > 300, boardBox && `${Math.round(boardBox.width)}px`);

    // nav links must not overlap the board (floating nav is fixed)
    const overlap = await page.evaluate(() => {
        const nav = document.getElementById('nav').getBoundingClientRect();
        const b = document.getElementById('board').getBoundingClientRect();
        return { navBottom: nav.bottom, boardTop: b.top };
    });
    check('floating nav clears the board', overlap.navBottom <= overlap.boardTop,
        `${Math.round(overlap.navBottom)} <= ${Math.round(overlap.boardTop)}`);

    // keyboard: focus the board, press arrows then Enter, expect a move
    const before = await page.evaluate(() => JSON.stringify(QApp.state.history.length));
    await page.locator('#board').focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    const cursorDrawn = await page.evaluate(() => document.activeElement.id === 'board');
    check('board is focusable and keeps focus', cursorDrawn);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => QApp.state.history.length);
    check('Enter plays a keyboard move', after > Number(before), `${before} -> ${after}`);

    // focus ring is visible (outline set on :focus-visible)
    const ring = await page.evaluate(() => {
        const el = document.getElementById('board');
        el.focus();
        const cs = getComputedStyle(el);
        return { outline: cs.outlineStyle, width: cs.outlineWidth };
    });
    check('board shows a focus ring', ring.outline !== 'none' && parseFloat(ring.width) > 0, JSON.stringify(ring));

    // scroll reveals fire
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.waitForTimeout(1000);
    const revealed = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.reveal')];
        return { total: all.length, shown: all.filter(e => e.classList.contains('in')).length };
    });
    check('scroll reveals fire', revealed.shown > 0, `${revealed.shown}/${revealed.total}`);

    // tagline lights word by word
    await page.evaluate(() => document.querySelector('#tagline').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(900);
    const tag = await page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-tagline] .w')];
        return { total: all.length, lit: all.filter(e => e.classList.contains('lit')).length };
    });
    check('tagline reveals words', tag.total >= 8 && tag.lit > 0, `${tag.lit}/${tag.total}`);

    // theme button cycles and repaints
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.click('#themeBtn');
    await page.waitForTimeout(300);
    const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
    check('theme button cycles', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`);

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'qa-desktop-game.png') });
    await ctx.close();

    /* ---------- 3. 404 and legal render ---------- */
    for (const p of ['legal.html', '404.html', 'does-not-exist']) {
        const c = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        const pg = await c.newPage();
        const r = await pg.goto(base + p, { waitUntil: 'domcontentloaded' });
        const ok = await pg.locator('h1').first().isVisible();
        check(`page renders: ${p}`, ok, 'status ' + r.status());
        await c.close();
    }

    await browser.close();
    srv.close();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.error('failures:\n' + failed.map(f => ' - ' + f.name).join('\n'));
        process.exit(1);
    }
})().catch(e => { console.error('QA crashed:', e); process.exit(1); });
