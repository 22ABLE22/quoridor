'use strict';
/* =========================================================================
 * AIWorkerHelper — main-thread side of the AI Web Worker(s)
 *
 * Two independent workers are created from the same inlined source:
 *   - thinker: serves 'decide' (long searches, ~2.4 s)
 *   - sampler: serves 'winrate' (fast Monte-Carlo batches, ~0.3 s)
 * Splitting them keeps win-rate refreshes from queueing behind a long AI
 * search (a single worker processes messages serially, which starved the
 * win-rate bars in PVE games).
 *
 * Protocol (request → response, both carry an id):
 *   → { id, cmd:'decide',  state, pi, budgetMs }
 *   → { id, cmd:'winrate', state, pi, rollouts }
 *   ← { id, ok:true, action | rate } | { id, ok:false, error }
 *
 * init() ALWAYS returns a Promise<boolean>; on any failure the helper
 * reports unavailable and callers fall back to synchronous computation.
 * ========================================================================= */
var AIWorkerHelper = (function () {

    let thinker = null;      // decides
    let sampler = null;      // win rates
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
            for (const [, p] of pending.entries()) {
                if (p.worker !== w) continue;
                p.reject(new Error('worker error'));
                pending.delete(p.id);
            }
            try { w.terminate(); } catch (e) { /* ignore */ }
            if (w === thinker) thinker = null;
            if (w === sampler) sampler = null;
            if (!thinker && !sampler) failed = true;   // sync fallback from now on
        };
        return w;
    }

    /**
     * Initialize both workers. Always resolves to boolean (true = ready).
     * Concurrent calls share one boot.
     */
    function init() {
        if (thinker && sampler) return Promise.resolve(true);
        if (failed) return Promise.resolve(false);
        if (booting) return booting;
        booting = Promise.all([fetchText(scriptUrl('rules.js')), fetchText(scriptUrl('ai.js'))])
            .then(([rulesSrc, aiSrc]) => {
                const src = buildWorkerSource(rulesSrc, aiSrc);
                if (!thinker) thinker = attachWorker(src);
                if (!sampler) sampler = attachWorker(src);
                return true;
            })
            .catch(() => {
                failed = true;
                return false;
            });
        return booting;
    }

    /**
     * Send a command to a specific worker; resolves to the reply, or to null
     * when unavailable (callers compute synchronously instead).
     */
    function send(worker, cmd, state, extra) {
        if (!worker || failed) return Promise.resolve(null);
        const id = ++requestId;
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, worker, id };
            pending.set(id, entry);
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
        return send(thinker, 'decide', state, { pi, budgetMs });
    }

    function winRate(state, pi, rollouts) {
        return send(sampler, 'winrate', state, { pi, rollouts });
    }

    return {
        init, decide, winRate,
        get available() { return (!!thinker || !!sampler) && !failed; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = AIWorkerHelper;
