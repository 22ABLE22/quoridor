# Quoridor

An open-source web version of Quoridor, the wall-placement race game: be the
first to bring your pawn to the opposite edge of the board. Pure front end,
zero dependencies, no build step. Open `index.html` and play.

Live site: <https://22able22.github.io/quoridor/>

## Features

- **2-player matches**: PVP (human vs human) and PVE (human vs AI)
- **4-player matches**: any mix of **Human / AI / Off** per seat
  (off seats are dropped, so 2–4 players in any combination work, e.g. one
  human against three AIs)
- **Live win probability**: every player card carries a win-rate bar,
  estimated by Monte-Carlo simulation after each move and toggleable with
  the **Win rate** button (preference is remembered). While the AI is
  thinking the previous bars stay on screen; a fresh estimate then eases the
  number and the bar together over ~0.45 s instead of snapping or blanking out
- **Three themes**: Auto / Light / Dark, cycled with one button and
  remembered across visits
- **Complete rules**: 9×9 board, two-cell walls, straight and diagonal jumps,
  no jumping over two pawns (any player count), walls may not overlap or
  cross, and no wall may seal any player off from their goal (BFS
  reachability check)
- **Unified input**: no mode toggle. Click a cell to move, click a groove to
  place a wall; the orientation follows the groove. Legal move targets glow,
  an illegal wall preview shows a red slash
- **Keyboard play**: the board is a tab stop. Arrow keys move a cursor,
  Enter plays, `W` switches to wall placement, `R` rotates the wall, `Esc`
  goes back to moving. Every action is announced in the status line
- **Color-coded walls**: every wall is painted in the color of the player
  who placed it, so you can read each side's blocking strategy at a glance
- **Game aids**: live shortest-distance counters, last-move trail, undo
  (rolls back through AI replies to your previous action), full move history
- **Strong single AI**: iterative-deepening alpha-beta with a Zobrist-hashed
  transposition table, time management (~2.4 s budget per move), relevant-wall
  pruning, and paranoid multi-opponent search for 3+ players. Two
  **Web Workers** share one inlined engine source: a "thinker" runs the search
  and a separate "sampler" estimates win rates, so a long search can never
  delay the bars. Under `file://` (no workers) both fall back to synchronous
  computation automatically
- **Touch-friendly** (Pointer Events: press to preview, release to act)

## About the game

Quoridor was designed by Mirko Marchesi and is published by Gigamic (1997).
This repository is a third-party reimplementation for personal study and
play; it is not affiliated with, endorsed by, or sponsored by the publisher.
Game names and trademarks belong to their respective owners.

## Play

Open the live site, or open `index.html` directly from `file://`.

- The board opens with a preview position behind a **Choose seats** panel;
  pick the player count and the seat types there
- Click a cell to move; hover a groove to preview a wall and click to place it
- **Undo** rewinds AI replies together with your own last action
- The header button cycles Auto / Light / Dark

## Rules at a glance

1. On your turn, either move your pawn one square (orthogonally) or place a
   wall (until you run out)
2. A wall spans two squares and sits in a groove; it must not overlap or
   cross an existing wall (touching end-to-end or in a T is fine)
3. After any wall placement, every player must still have a path to their
   goal edge (sealing anyone — including yourself — is illegal)
4. When orthogonally adjacent to an opponent, jump straight over it; if the
   landing square is blocked by a wall, the board edge, or a third pawn,
   jump diagonally to either side instead
5. Jumping over two pawns at once is never allowed (any player count)
6. 2-player: 10 walls each · 4-player: 5 walls each; first to reach the
   opposite edge wins

## Implementation

```
index.html        # landing page + game shell
legal.html        # privacy and terms
404.html          # branded not-found page
assets/css/app.css   # design system: tokens, layout, components
assets/fonts/        # self-hosted Manrope (no third-party requests)
js/rules.js       # rules engine (pure logic, no DOM; Node-testable)
js/ai.js          # iterative-deepening AI + win-rate simulator
js/ai-worker.js   # Web Worker wrapper (engine sources inlined into a Blob)
js/render.js      # canvas board rendering + short motion tracks
js/input.js       # pointer and keyboard input
js/ui.js          # theme cycling, player cards, animated win-rate bars, history, modals
js/app.js         # controller (game lifecycle, AI scheduling, undo)
js/site.js        # page motion: hero art, scroll reveals, tagline reveal, nav
bench/match.js    # head-to-head engine matches
tests/rules.test.mjs          # rules + AI regression tests (98 assertions)
tests/search.test.mjs         # transposition-table move packing (419 checks)
tests/cursor.test.mjs         # keyboard cursor behaviour (26 assertions)
tests/worker-inline.check.js  # worker command-loop verification
tests/e2e-browser.js          # browser check for the win-rate bars
tools/qa.js                   # layout + behaviour QA (needs playwright-core)
tools/qa-rotate.js            # keyboard wall rotation QA (needs playwright-core)
```

### Design system

The page follows one small set of rules, and the CSS variables at the top of
`assets/css/app.css` are the only place values are allowed to live.

- **Type**: Manrope only, self-hosted, no italics, no ultra-bold. Every size
  snaps to a Tailwind step (`--text-xs` … `--text-6xl`), and line heights come
  with the step
- **Spacing**: the 13-step scale only (`--s-0` … `--s-900`); nothing in
  between
- **Radius**: Tailwind values, plus the nested rule — an inner radius is the
  outer radius minus the gap when the gap is under 32px
- **Colour**: flat backgrounds only. The single gradient in the design is the
  hero heading's text fill
- **Motion**: one curve, `cubic-bezier(0.22, 1, 0.36, 1)`. Only `transform`
  and `opacity` animate. Scroll reveals use `IntersectionObserver`, never a
  scroll listener; the tagline's word-by-word light-up is the one throttled
  `rAF` scroll handler, because it needs per-word geometry
- **Reduced motion**: everything lands in its final state, no reveals, no
  canvas tracks

### Board motion

The canvas has no CSS transitions, so `js/render.js` runs its own short
animation pass and asks for a redraw through the same `quoridor:redraw`
event the theme system uses. A pass starts on a pawn move, a wall landing, or
a new shortest path, and stops when every track has landed — nothing loops.
A pawn slides between cells, a new wall drops into its groove with a small
overshoot, and a shortest path draws itself on from the pawn outward.

### Engine notes

- Classic script tags, no bundler — works from `file://`
- The rules engine and AI are DOM-free: tests load them in a Node `vm` and
  assert jumps (straight / diagonal / no jumping over two pawns), wall
  conflicts (overlap / crossing / T-touch), reachability (no sealing), undo
  consistency, and that the AI places both wall orientations
- Search pruning is sound, not heuristic: a wall is only tried when it blocks
  an edge of some player's canonical shortest path. The transposition table
  uses a generation stamp instead of a per-move clear, and stores mate scores
  ply-normalized so a bound hit stays valid at any ply
- Packed transposition-table moves reserve four bits per coordinate. The board
  has coordinates `0..8`, so a three-bit field silently decoded moves to row or
  column 8 as a different cell; the wider field keeps every pawn move intact
- Search is plain iterative-deepening alpha-beta over a max/min tree. A
  principal-variation rewrite with aspiration windows was measured at 34% over
  32 games against this engine (about 96% of individual moves were identical,
  so the loss came from the remaining tactical disagreements), and it was
  reverted. Deeper search is not evidence of better play
- Win rates come from one Monte-Carlo batch that credits every player from
  the same sample set, so the bars are mutually consistent and the cost is
  paid once per position rather than once per player
- Wall geometry: an h-wall at anchor (x,y) lies in the row groove between
  rows y and y+1 spanning columns x and x+1; a v-wall lies in the column
  groove between columns x and x+1 spanning rows y and y+1

## Tests

```text
node tests/rules.test.mjs     # rules + AI regressions
node tests/search.test.mjs    # transposition-table move packing
node tests/cursor.test.mjs    # keyboard cursor: rotation, clamping, NaN guards
node tests/worker-inline.check.js
node tests/e2e-browser.js     # needs Edge or Chrome; skips if neither is found
node tools/qa.js              # layout, keyboard, reveals, 404 (needs playwright-core)
node tools/qa-rotate.js       # keyboard wall rotation end to end (needs playwright-core)
```

`tools/qa.js` drives a real Chromium at three widths in both themes and checks
what a screenshot cannot: no horizontal overflow, the floating nav clearing the
board, the board being focusable with a visible focus ring, `Enter` actually
playing a keyboard move, scroll reveals firing, the tagline lighting word by
word, and the theme button repainting. Screenshots land in `tools/shots/`
(git-ignored). It reads `PW_CORE` for the `playwright-core` path.

`tests/cursor.test.mjs` loads `input.js` behind a small DOM stub and drives the
keyboard directly. It exists because `R` used to erase the wall preview:
`setCursor()` took a partial update (`{ isH }`), read `next.x` from it, clamped
`undefined` to `NaN`, and every later draw computed a position from `NaN`.
Rotation now preserves the anchor, and the test fails if it stops doing so.

Browser smoke test: open `index.html?autotest=1` — it skips the setup and
starts an AI vs AI game.

## License

The source code (HTML/CSS/JS and tests) is released under the
[MIT License](LICENSE). Quoridor's rules and name belong to their designer
and publisher; this repository is a reimplementation of the rules only.
