'use strict';
/* =========================================================================
 * AIWorkerHelper — main-thread side of the AI Web Worker
 *
 * The worker source EMBEDS the full sources of js/rules.js and js/ai.js
 * (Blob-URL workers have an opaque origin, so sync-XHR / importScripts
 * loading silently fails — embedding sidesteps loading entirely). The main
 * thread fetches both scripts once; under file:// fetch is blocked, in which
 * case the helper reports unavailable and callers fall back to computing on
 * the main thread.
 *
 * Only the heavy AI search runs here ('decide', ~2.4 s per move), so the
 * UI never blocks while the AI thinks. Win-rate estimation is a short
 * ~200 ms synchronous batch and runs on the main thread (see app.js) —
 * that keeps it immune to worker boot/queue failures.
 *
 * Protocol (request → response, both carry an id):
 *   → { id, cmd:'decide', state, pi, budgetMs }
 *   ← { id, ok:true, action } | { id, ok:false, error }
 *
 * init() ALWAYS returns a Promise<boolean>.
 * ========================================================================= */
var AIWorkerHelper = (function () {

    let worker = null;
    let failed = false;
    let booting = null;
    let requestId = 0;
    const pending = new Map();

    function scriptUrl(name) {
        return new URL('js/' + name, location.href).href;
    }

    function fetchText(url) {
        return fetch(url).then(r => {
            if (!r.ok) throw new Error('fetch failed ' + url + ' ' + r.status);
            return r.text();
        });
    }

    /** Build the worker source with the engine scripts inlined. */
    function buildWorkerSource(rulesSrc, aiSrc) {
        return [
            '// --- inlined js/rules.js ---',
            rulesSrc,
            '// --- inlined js/ai.js ---',
            aiSrc,
            '// --- command loop ---',
            'self.onmessage = function (e) {',
            '  var msg = e.data;',
            '  try {',
            '    if (msg.cmd === "decide") {',
            '      var action = QAI.decide(msg.state, msg.pi, msg.budgetMs);',
            '      self.postMessage({ id: msg.id, ok: true, action: action });',
            '    } else if (msg.cmd === "winrate") {',
            '      var rate = QAI.simulateWinRate(msg.state, msg.pi, msg.rollouts);',
            '      self.postMessage({ id: msg.id, ok: true, rate: rate });',
            '    }',
            '  } catch (err) {',
            '    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });',
            '  }',
            '};'
        ].join('\n');
    }

    function attachWorker(src) {
        const w = new Worker(URL.createObjectURL(
            new Blob([src], { type: 'application/javascript' })));
        w.onmessage = (e) => {
            const msg = e.data;
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.ok) p.resolve(msg);
            else p.reject(new Error(msg.error || 'worker error'));
        };
        w.onerror = () => {
            for (const [id, p] of pending.entries()) {
                if (p.worker !== w) continue;
                p.reject(new Error('worker error'));
                pending.delete(id);
            }
            try { w.terminate(); } catch (e) { /* ignore */ }
            worker = null;
            failed = true;   // sync fallback from now on
        };
        return w;
    }

    /**
     * Initialize the worker. Always resolves to boolean (true = ready).
     * Concurrent calls share one boot.
     */
    function init() {
        if (worker) return Promise.resolve(true);
        if (failed) return Promise.resolve(false);
        if (booting) return booting;
        booting = Promise.all([fetchText(scriptUrl('rules.js')), fetchText(scriptUrl('ai.js'))])
            .then(([rulesSrc, aiSrc]) => {
                worker = attachWorker(buildWorkerSource(rulesSrc, aiSrc));
                return true;
            })
            .catch(() => {
                failed = true;
                return false;
            });
        return booting;
    }

    /**
     * Send a command; resolves to the reply, or to null when the worker is
     * unavailable (callers compute synchronously instead).
     */
    function send(cmd, state, extra) {
        if (!worker || failed) return Promise.resolve(null);
        const id = ++requestId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, worker, id });
            try {
                worker.postMessage(Object.assign({ id, cmd, state }, extra || {}));
            } catch (e) {
                pending.delete(id);
                failed = true;
                resolve(null);
            }
        });
    }

    function decide(state, pi, budgetMs) {
        return send('decide', state, { pi, budgetMs });
    }

    return {
        init, decide,
        get available() { return !!worker && !failed; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = AIWorkerHelper;
