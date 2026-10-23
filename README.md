# Quoridor

An open-source web version of Quoridor, the wall-placement race game: be the
first to bring your pawn to the opposite edge of the board. Pure front end —
zero dependencies, no build step; open `index.html` and play.

## Features

- **2-player matches**: PVP (human vs human) and PVE (human vs AI)
- **4-player matches**: any mix of **Human / AI / Off** per seat
  (off seats are dropped, so 2–4 players in any combination work, e.g. one
  human against three AIs)
- **Live win probability**: every player card carries a win-rate bar,
  estimated by Monte-Carlo simulation after each move and toggleable with
  the **Win Rate** button (preference is remembered). While the AI is
  thinking the previous bars stay on screen; a fresh estimate then eases the
  number and the bar together over ~0.45 s (slow at both ends, fast in the
  middle) instead of snapping or blanking out
- **Three themes**: system (Auto) / Light / Dark, cycled with one button and
  remembered across visits
- **Complete rules**: 9×9 board, two-cell walls, straight and diagonal jumps,
  no jumping over two pawns (any player count), walls may not overlap or
  cross, and no wall may seal any player off from their goal (BFS
  reachability check)
- **Unified input**: no mode toggle — click a cell to move, click a groove to
  place a wall. The wall orientation follows the groove: hover along a row
  groove for a horizontal wall, along a column groove for a vertical wall.
  Legal move targets always glow; an illegal wall preview turns red.
- **Color-coded walls**: every wall is painted in the color of the player
  who placed it, so you can read each side's blocking strategy at a glance
  (and study how the AI defends).
- **Game aids**: live shortest-distance counters, last-move trail,
  undo (rolls back through AI replies to your previous action), full
  move history
- **Strong single AI**: iterative-deepening alpha-beta with a Zobrist-hashed
  transposition table, time management (~2.4 s budget per move, hard-capped
  under 3 s), relevant-wall pruning, and paranoid multi-opponent search for 3+
  players — it sees jump tactics and wall counterplay. Two
  **Web Workers** share one inlined engine source: a "thinker" runs the search
  and a separate "sampler" estimates win rates, so a long search can never
  delay the bars. Under `file://` (no workers) both fall back to synchronous
  computation automatically.
- Touch-friendly (Pointer Events: press to preview, release to act)

## About the game

Quoridor was designed by Mirko Marchesi and is published by Gigamic (1997).
This repository is a third-party reimplementation for personal study and
play; it is not affiliated with, endorsed by, or sponsored by the publisher.
Game names and trademarks belong to their respective owners.

## Play

Open the live site: <https://22able22.github.io/quoridor/>
(or open `index.html` directly from `file://`).

- Use the header button to cycle Auto / Light / Dark themes
- **New Game** sets the player count and seats
- Click a cell to move; hover a groove to preview a wall and click to place it
- **Undo** rewinds AI replies together with your own last action

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
5. Jumping over two pawns at once is never allowed (any player count): a
   straight jump needs a free landing square behind the single jumped pawn
6. 2-player: 10 walls each · 4-player: 5 walls each; first to reach the
   opposite edge wins

## Implementation

```
index.html        # page skeleton + theme CSS variables (data-theme)
js/rules.js       # rules engine (pure logic, no DOM; Node-testable)
js/ai.js          # iterative-deepening PVS AI + win-rate simulator
js/ai-worker.js   # Web Worker wrapper (engine sources inlined into a Blob)
js/render.js      # canvas board rendering (DPI-aware, theme-aware)
js/input.js       # pointer input (mouse + touch unified)
js/ui.js          # theme cycling, player cards, animated win-rate bars, history, modals
js/app.js         # controller (game lifecycle, AI scheduling, undo)
bench/match.js    # head-to-head engine matches (how the AI changes were judged)
tests/rules.test.mjs          # rules + AI regression tests (98 assertions)
tests/worker-inline.check.js  # worker command-loop verification (run manually)
tests/e2e-browser.js          # browser check for the win-rate bars (run manually)
```

- Classic script tags, no bundler — works from `file://`
- The rules engine and AI are DOM-free: tests load them in a Node `vm` and
  assert jumps (straight / diagonal / no jumping over two pawns), wall
  conflicts (overlap / crossing / T-touch), reachability (no sealing), undo
  consistency, and that the AI places both wall orientations
- Search pruning is sound, not heuristic: a wall is only tried when it blocks
  an edge of some player's canonical shortest path, because a wall that
  raises nobody's distance — or that seals somebody off — must block that
  player's shortest path. The transposition table uses a generation stamp
  instead of a per-move clear, and stores mate scores ply-normalized so a
  bound hit stays valid at any ply
- Packed transposition-table moves reserve four bits per coordinate. The board
  has coordinates `0..8`, so a three-bit field silently decoded moves to row or
  column 8 as a different cell; the wider field keeps every pawn move intact
- Search is plain iterative-deepening alpha-beta over a max/min tree. A
  principal-variation rewrite with aspiration windows was measured at 34% over
  32 games against this engine (about 96% of individual moves were identical,
  so the loss came from the remaining tactical disagreements), and it was
  reverted. Deeper search is not evidence of better play: the reverted version
  reached the same depth in the same time and still played worse
- Win rates come from one Monte-Carlo batch that credits every player from
  the same sample set, so the bars are mutually consistent and the cost is
  paid once per position rather than once per player
- Wall geometry: an h-wall at anchor (x,y) lies in the row groove between
  rows y and y+1 spanning columns x and x+1; a v-wall lies in the column
  groove between columns x and x+1 spanning rows y and y+1. Hit-testing
  picks the nearest wall center line, which is what makes both orientations
  naturally reachable with a single click.

## Tests

```text
node tests/rules.test.mjs
node tests/search.test.mjs    # transposition-table move packing
node bench/match.js --a js/ai.js --b <other-engine.js> --games 48 --budget 200
node tests/e2e-browser.js      # needs Edge or Chrome; skips if neither is found
```

`tests/search.test.mjs` checks that every pawn destination and every wall anchor
survives the transposition table's move packing without collision, and that the
engine still returns a legal action without mutating the caller's position. It
was written after a three-bit coordinate field silently mangled moves to row and
column 8; reintroducing that field makes the test fail.

`bench/match.js` plays two engine builds with colours alternated. Repeated
openings and timing-dependent searches are correlated, so its nominal binomial
interval is only descriptive. Use it to compare builds, not to certify one: a
principal-variation rewrite here scored 34% over 32 games against the engine it
replaced while searching to the same depth in the same time, and it was
reverted. Depth reached and walls spent are efficiency observations, not
strength evidence.

Browser smoke test: open `index.html?autotest=1` — it skips the setup modal
and starts an AI vs AI game.

## License

The source code (HTML/CSS/JS and tests) is released under the
[MIT License](LICENSE). Quoridor's rules and name belong to their designer
and publisher; this repository is a reimplementation of the rules only.
