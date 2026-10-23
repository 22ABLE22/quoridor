// Browser end-to-end check for the win-rate bars.
//
// Asserts the two user-visible contracts around the AI's turn:
//   1. the previous estimate is never blanked out ("—" / 0%) while the AI
//      thinks, and never jumps in a single step
//   2. when a new estimate lands, the number glides through many distinct
//      values instead of snapping to the target
//
// Self-contained: starts its own static server, launches headless Edge or
// Chrome over the DevTools protocol, drives the real page, then exits 0/1.
// Skips (exit 0) when no browser is installed, so it is safe to wire into any
// environment. CI does not run this; use it locally:
//
//   node tests/e2e-browser.js
'use strict';
const net = require('net'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.dirname(path.dirname(__filename));
const PORT = Number(process.env.E2E_PORT || 8137);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9337);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- static server ---------------- */
function startServer() {
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    const srv = http.createServer((req, res) => {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/index.html';
        const f = path.join(ROOT, p);
        if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' });
        res.end(fs.readFileSync(f));
    });
    return new Promise(resolve => srv.listen(PORT, () => resolve(srv)));
}

/* ---------------- browser discovery ---------------- */
function findBrowser() {
    const candidates = [
        process.env.E2E_BROWSER,
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    return candidates.find(p => fs.existsSync(p)) || null;
}

/* ---------------- minimal CDP client (no npm dependencies) ---------------- */
function httpJson(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

function connect(url) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(Number(u.port), u.hostname, () => {
            sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
                `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let buf = Buffer.alloc(0), upgraded = false;
        const handlers = {};
        const client = { send: null, on: null, close: () => sock.destroy() };
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            if (!upgraded) {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                if (!/101/.test(buf.slice(0, idx).toString())) { reject(new Error('websocket upgrade failed')); return; }
                buf = buf.slice(idx + 4); upgraded = true; resolve(client);
            }
            while (buf.length >= 2) {
                const masked = (buf[1] & 0x80) !== 0;
                let len = buf[1] & 0x7f, off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                const maskLen = masked ? 4 : 0;
                if (buf.length < off + maskLen + len) return;
                let payload = buf.slice(off + maskLen, off + maskLen + len);
                if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
                buf = buf.slice(off + maskLen + len);
                if (handlers.message) handlers.message(payload.toString());
            }
        });
        sock.on('error', reject);
        client.on = (ev, fn) => { if (ev === 'message') handlers.message = fn; };
        client.send = obj => {
            const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
            let header;
            if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
            else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
            else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
            sock.write(Buffer.concat([header, mask, Buffer.from(data.map((v, i) => v ^ mask[i % 4]))]));
        };
    });
}

/* ---------------- main ---------------- */
(async () => {
    const browser = findBrowser();
    if (!browser) {
        console.log('SKIP: no Edge/Chrome found (set E2E_BROWSER to a browser path)');
        process.exit(0);
    }
    const server = await startServer();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quoridor-e2e-'));
    const proc = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
        '--window-size=1200,900', 'about:blank'
    ], { stdio: 'ignore' });

    const cleanup = () => {
        try { proc.kill(); } catch (e) { /* ignore */ }
        try { server.close(); } catch (e) { /* ignore */ }
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    };

    let ws = null;
    try {
        // wait for the DevTools endpoint
        let tabs = null;
        for (let i = 0; i < 40; i++) {
            try { tabs = await httpJson('/json/list'); if (tabs && tabs.length) break; } catch (e) { /* booting */ }
            await sleep(250);
        }
        if (!tabs) throw new Error('DevTools endpoint never came up');
        const page = tabs.find(t => t.type === 'page');
        ws = await connect(page.webSocketDebuggerUrl);

        let id = 0; const pend = new Map(); const errors = [];
        ws.on('message', m => {
            const o = JSON.parse(m);
            if (o.method === 'Runtime.exceptionThrown') {
                errors.push(o.params.exceptionDetails.exception?.description || o.params.exceptionDetails.text);
            }
            if (o.id && pend.has(o.id)) {
                const p = pend.get(o.id); pend.delete(o.id);
                o.error ? p.rej(new Error(JSON.stringify(o.error))) : p.res(o.result);
            }
        });
        const send = (method, params) => new Promise((res, rej) => {
            const i = ++id; pend.set(i, { res, rej }); ws.send({ id: i, method, params: params || {} });
        });
        const evaluate = async expr => {
            const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
            }
            return r.result.value;
        };

        await send('Page.enable'); await send('Runtime.enable');
        await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
        await sleep(1200);

        // Start a 2-player PVE game: Red human, Blue AI (the modal defaults).
        await evaluate(`document.getElementById('startBtn').click()`);
        await sleep(1800);

        const cardState = `(() => Array.from(document.querySelectorAll('#playersList .player-card')).map(c => ({
            name: c.querySelector('.pc-name').textContent,
            txt: c.querySelector('.pc-winrate-txt').textContent,
            width: c.querySelector('.pc-winrate-fill').style.width
        })))()`;

        const initial = await evaluate(cardState);
        console.log('initial cards:', JSON.stringify(initial));

        // Human move: click cell (4,7) through the app's real pointer path.
        await evaluate(`(() => {
            const c = document.getElementById('board');
            const rect = c.getBoundingClientRect();
            const size = parseFloat(c.style.width) || rect.width;
            const geo = QRender.cellRect(4, 7);
            const x = rect.left + geo.cx * (rect.width / size);
            const y = rect.top + geo.cy * (rect.height / size);
            const opts = { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true };
            c.dispatchEvent(new PointerEvent('pointerdown', opts));
            c.dispatchEvent(new PointerEvent('pointerup', opts));
            return true;
        })()`);

        // Sample every 100 ms for 7 s: the AI's ~2.4 s think plus the glide.
        const samples = [];
        for (let i = 0; i < 70; i++) {
            const cards = await evaluate(cardState);
            const turn = await evaluate(`(() => { const s = QApp.state; return s.players[s.turn].type + ':' + s.history.length; })()`);
            samples.push({ cards, turn });
            await sleep(100);
        }

        const redSeries = samples.map(s => s.cards[0] && s.cards[0].txt);
        const blanked = samples.filter(s => s.cards.some(c => c.txt === '—' || c.width === '0%'));
        const distinct = new Set(redSeries.filter(v => v && v !== '—'));
        const aiSamples = samples.filter(s => s.turn.startsWith('ai:'));
        const aiSeries = aiSamples.map(s => parseInt(s.cards[0] && s.cards[0].txt) || 0);
        let maxJump = 0;
        for (let i = 1; i < aiSeries.length; i++) maxJump = Math.max(maxJump, Math.abs(aiSeries[i] - aiSeries[i - 1]));
        const worker = await evaluate(`AIWorkerHelper.available`);
        const finalState = await evaluate(`(() => { const s = QApp.state; return { history: s.history.length }; })()`);

        console.log('\nRed percentage over 7 s:', redSeries.join(' '));
        console.log('distinct values:', distinct.size, '| blanked samples:', blanked.length);
        console.log('AI-thinking samples:', aiSamples.length, '| max step:', maxJump + 'pp');
        console.log('workers available:', worker, '| moves played:', finalState.history);
        console.log('page errors:', errors.length ? errors : 'none');

        const okBlank = blanked.length === 0;
        const okSmooth = maxJump <= 8;
        const okGlide = distinct.size >= 4;
        const okWorker = worker === true;
        const okMoves = finalState.history >= 2;

        console.log('\n' + (okBlank ? 'PASS' : 'FAIL') + ' previous bars survive the AI turn (never blanked)');
        console.log((okSmooth ? 'PASS' : 'FAIL') + ' bars never jump (max step ' + maxJump + 'pp)');
        console.log((okGlide ? 'PASS' : 'FAIL') + ' number glides through intermediate values');
        console.log((okWorker ? 'PASS' : 'FAIL') + ' both workers are live (off-main-thread estimation)');
        console.log((okMoves ? 'PASS' : 'FAIL') + ' a full human + AI exchange completed');

        const allOk = okBlank && okSmooth && okGlide && okWorker && okMoves;
        cleanup();
        process.exit(allOk ? 0 : 1);
    } catch (e) {
        console.error('E2E ERROR:', e.message);
        if (ws) ws.close();
        cleanup();
        process.exit(1);
    }
})();
