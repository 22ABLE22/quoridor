'use strict';
/* =========================================================================
 * AIWorkerHelper — main-thread side of the AI Web Workers
 *
 * The worker source EMBEDS the full sources of js/rules.js and js/ai.js
 * (Blob-URL workers have an opaque origin, so sync-XHR / importScripts
 * loading silently fails — embedding sidesteps loading entirely). The main
 * thread fetches both scripts once; under file:// fetch is blocked, in which
 * case the helper reports unavailable and callers fall back to computing on
 * the main thread.
 *
 * TWO worker instances are built from the same source:
 *   - "thinker" serves 'decide' (the ~2.4 s search). Keeping it alone means
 *     the UI never blocks while the AI thinks.
 *   - "sampler" serves 'winrate' (a short Monte-Carlo batch). It is separate
 *     so a long search can never queue ahead of a sampling job — the failure
 *     mode that once made the bars stay empty in PVE games.
 *
 * Protocol (request → response, both carry an id):
 *   → { id, cmd:'decide',  state, pi, budgetMs }
 *   ← { id, ok:true, action } | { id, ok:false, error }
 *   → { id, cmd:'winrate', state, rollouts }
 *   ← { id, ok:true, rates:[…] } | { id, ok:false, error }
 *
 * init() ALWAYS returns a Promise<boolean>.
 * ========================================================================= */
var AIWorkerHelper = (function () {

    let thinker = null;
    let sampler = null;
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
            '      var rates = QAI.simulateWinRates(msg.state, msg.rollouts);',
            '      self.postMessage({ id: msg.id, ok: true, rates: rates });',
            '    }',
            '  } catch (err) {',
            '    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });',
            '  }',
            '};'
        ].join('\n');
    }

    function attachWorker(src, slot) {
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
            if (slot === 'thinker') thinker = null; else sampler = null;
            // A sampler failure only costs the off-main-thread optimisation;
            // a thinker failure means every caller computes synchronously.
            if (slot === 'thinker') failed = true;
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
                if (!thinker) thinker = attachWorker(src, 'thinker');
                if (!sampler) sampler = attachWorker(src, 'sampler');
                return true;
            })
            .catch(() => {
                failed = true;
                return false;
            });
        return booting;
    }

    /**
     * Send a command to one worker slot; resolves to the reply, or to null
     * when that worker is unavailable (callers compute synchronously).
     */
    function send(slot, cmd, state, extra) {
        const w = slot === 'thinker' ? thinker : sampler;
        if (!w) return Promise.resolve(null);
        const id = ++requestId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, worker: w, id });
            try {
                w.postMessage(Object.assign({ id, cmd, state }, extra || {}));
            } catch (e) {
                pending.delete(id);
                if (slot === 'thinker') failed = true;
                resolve(null);
            }
        });
    }

    function decide(state, pi, budgetMs) {
        return send('thinker', 'decide', state, { pi, budgetMs });
    }

    /** Estimate every player's win rate in the sampler worker. */
    function winRates(state, rollouts) {
        return send('sampler', 'winrate', state, { rollouts });
    }

    return {
        init, decide, winRates,
        get available() { return !!thinker && !failed; }
    };
})();

/* Node (tests) export; browser keeps the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = AIWorkerHelper;
