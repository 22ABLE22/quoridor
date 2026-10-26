'use strict';
/* =========================================================================
 * QSite — page level behaviour that is not part of the game
 *
 *   - the decorative hero board, drawn once on load and once per theme flip
 *   - scroll reveals (IntersectionObserver, play once, never on scroll events)
 *   - the tagline reveal: each word lights as it crosses a trigger line
 *   - the floating nav tucks away once the page is scrolled past the hero
 *
 * Everything here is optional decoration: with JavaScript off the page still
 * reads, because every revealed element starts visible in that case.
 * ========================================================================= */
var QSite = (function () {

    const reduced = () => window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------------- hero art ---------------- */
    /* A small Quoridor position drawn on the canvas: the board, a few walls,
       and one route threading between them. Purely decorative. */

    const WALLS_H = [[1, 3], [3, 3], [5, 3], [2, 5], [4, 5], [6, 5]];
    const WALLS_V = [[4, 1], [4, 2], [2, 4], [6, 4], [3, 6], [5, 6]];
    const ROUTE = [[4, 8], [4, 7], [4, 6], [3, 6], [3, 5], [3, 4], [2, 4], [2, 3], [2, 2], [3, 2], [3, 1], [3, 0]];

    function drawHero() {
        const canvas = document.getElementById('heroArt');
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth || 920;
        const h = canvas.clientHeight || 440;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const cs = getComputedStyle(document.documentElement);
        const v = name => cs.getPropertyValue(name).trim();
        const cell = v('--cell') || '#efe6d3';
        const cellLine = v('--cell-line') || '#dbd0b8';
        const accent = v('--accent') || '#9c5322';
        const ink = v('--text-strong') || '#241f18';

        // Rotate the whole motif a touch so it reads as a detail, not a UI.
        ctx.save();
        ctx.translate(w * 0.52, h * 0.5);
        ctx.rotate(-0.16);

        const N = 9;
        const gap = 6;
        // Fit the board to whichever axis is tighter, then keep a little air.
        const unit = Math.min((h * 0.9) / N - gap, (w * 0.62) / N - gap);
        const step = unit + gap;
        const size = unit * N + gap * (N - 1);
        const x0 = -size / 2, y0 = -size / 2;

        // cells
        ctx.lineWidth = 1;
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                ctx.fillStyle = cell;
                ctx.strokeStyle = cellLine;
                const px = x0 + x * step, py = y0 + y * step;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(px, py, unit, unit, 3);
                else ctx.rect(px, py, unit, unit);
                ctx.fill();
                ctx.stroke();
            }
        }

        // route
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(2, unit * 0.09);
        ctx.setLineDash([unit * 0.28, unit * 0.24]);
        ctx.beginPath();
        ROUTE.forEach((p, i) => {
            const cx = x0 + p[0] * step + unit / 2;
            const cy = y0 + p[1] * step + unit / 2;
            if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // walls
        const thickness = Math.max(4, unit * 0.2);
        const length = unit * 2 + gap;
        const wall = (x, y, isH) => {
            const cx = x0 + x * step + unit / 2 + (isH ? step / 2 : 0) + (isH ? 0 : unit / 2 + gap / 2);
            const cy = y0 + y * step + unit / 2 + (isH ? unit / 2 + gap / 2 : step / 2);
            ctx.fillStyle = ink;
            ctx.globalAlpha = 0.82;
            ctx.beginPath();
            const ww = isH ? length : thickness;
            const hh = isH ? thickness : length;
            if (ctx.roundRect) ctx.roundRect(cx - ww / 2, cy - hh / 2, ww, hh, thickness / 2);
            else ctx.rect(cx - ww / 2, cy - hh / 2, ww, hh);
            ctx.fill();
            ctx.globalAlpha = 1;
        };
        WALLS_H.forEach(([x, y]) => wall(x, y, true));
        WALLS_V.forEach(([x, y]) => wall(x, y, false));

        // two pawns
        const pawn = (x, y, colour) => {
            const cx = x0 + x * step + unit / 2;
            const cy = y0 + y * step + unit / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, unit * 0.32, 0, Math.PI * 2);
            ctx.fillStyle = colour;
            ctx.fill();
            ctx.lineWidth = Math.max(1.5, unit * 0.06);
            ctx.strokeStyle = v('--surface') || '#fff';
            ctx.stroke();
        };
        pawn(4, 8, accent);
        pawn(4, 0, ink);

        ctx.restore();
    }

    /* ---------------- scroll reveals ---------------- */
    function initReveals() {
        const items = document.querySelectorAll('.reveal');
        if (!items.length) return;
        if (reduced() || !('IntersectionObserver' in window)) {
            items.forEach(el => el.classList.add('in'));
            return;
        }
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                entry.target.classList.add('in');
                io.unobserve(entry.target);   // play once, never on scroll back
            }
        }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
        items.forEach((el, i) => {
            el.style.transitionDelay = Math.min(i * 70, 350) + 'ms';
            io.observe(el);
        });
    }

    /* ---------------- tagline reveal ---------------- */
    /* Each word lights on its own as it crosses the trigger line, in reading
       order. One throttled scroll handler, never a per-frame one, and the
       words are measured rather than guessed so wrapping stays honest. */
    function initTagline() {
        const block = document.querySelector('[data-tagline]');
        if (!block) return;
        const words = block.textContent.trim().split(/\s+/);
        block.textContent = '';
        const spans = words.map(word => {
            const span = document.createElement('span');
            span.className = 'w';
            span.textContent = word + ' ';
            block.appendChild(span);
            return span;
        });
        if (reduced()) {
            spans.forEach(s => s.classList.add('lit'));
            return;
        }

        let ticking = false;
        function update() {
            ticking = false;
            // A word lights once its top has crossed 78% of the viewport.
            // Deliberately generous: a line below the fold should not sit at
            // 30% opacity looking like a disabled block of text.
            const trigger = window.innerHeight * 0.78;
            for (const span of spans) {
                if (span.classList.contains('lit')) continue;
                if (span.getBoundingClientRect().top < trigger) span.classList.add('lit');
            }
        }
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(update);
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        // Run after fonts settle: measuring before the face swaps measures
        // the fallback's line boxes.
        const ready = document.fonts && document.fonts.ready
            ? document.fonts.ready
            : Promise.resolve();
        ready.then(() => { update(); requestAnimationFrame(update); }).catch(update);
    }

    /* ---------------- nav tuck ---------------- */
    function initNav() {
        const nav = document.getElementById('nav');
        if (!nav) return;
        let ticking = false;
        function update() {
            ticking = false;
            nav.classList.toggle('tucked', window.scrollY > window.innerHeight * 0.9);
        }
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(update);
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        update();
    }

    /* ---------------- boot ---------------- */
    function init() {
        drawHero();
        initReveals();
        initTagline();
        initNav();
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(drawHero, 150);
        });
        document.addEventListener('quoridor:theme', drawHero);
        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onScheme = () => drawHero();
            if (mq.addEventListener) mq.addEventListener('change', onScheme);
            else if (mq.addListener) mq.addListener(onScheme);
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(drawHero).catch(() => { /* ignore */ });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { drawHero };
})();
