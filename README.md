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
  the **Win Rate** button (preference is remembered)
- **Three themes**: system (Auto) / Light / Dark, cycled with one button and
  remembered across visits
- **Complete rules**: 9×9 board, two-cell walls, straight and diagonal jumps,
  no double jumps in the 4-player game, walls may not overlap or cross,
  and no wall may seal any player off from their goal (BFS reachability check)
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
- **Strong single AI**: iterative-deepening alpha-beta (up to 9 plies) with a
  Zobrist-hashed transposition table, time management (~2.4 s budget per
  move, hard-capped under 3 s), relevant-wall pruning, and paranoid
  multi-opponent search for 3+ players — it sees jump tactics and wall
  counterplay. All search runs in a **Web Worker**, so the page stays
  responsive while the AI thinks; under `file://` (no workers) it falls
  back to a shorter synchronous search automatically.
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
5. In the 4-player game, jumping over two pawns at once is forbidden
6. 2-player: 10 walls each · 4-player: 5 walls each; first to reach the
   opposite edge wins

## Implementation

```
index.html        # page skeleton + theme CSS variables (data-theme)
js/rules.js       # rules engine (pure logic, no DOM; Node-testable)
js/ai.js          # iterative-deepening alpha-beta AI + win-rate simulator
js/ai-worker.js   # Web Worker wrapper (engine sources inlined into a Blob)
js/render.js      # canvas board rendering (DPI-aware, theme-aware)
js/input.js       # pointer input (mouse + touch unified)
js/ui.js          # theme cycling, player cards, win-rate bars, history, modals
js/app.js         # controller (game lifecycle, AI scheduling, undo)
tests/rules.test.mjs          # rules + AI regression tests (82 assertions)
tests/worker-inline.check.js  # worker command-loop verification (run manually)
```

- Classic script tags, no bundler — works from `file://`
- The rules engine and AI are DOM-free: tests load them in a Node `vm` and
  assert jumps (straight / diagonal / no double jump), wall conflicts
  (overlap / crossing / T-touch), reachability (no sealing), undo
  consistency, and that the AI places both wall orientations
- Wall geometry: an h-wall at anchor (x,y) lies in the row groove between
  rows y and y+1 spanning columns x and x+1; a v-wall lies in the column
  groove between columns x and x+1 spanning rows y and y+1. Hit-testing
  picks the nearest wall center line, which is what makes both orientations
  naturally reachable with a single click.

## Tests

```text
node tests/rules.test.mjs
```

Browser smoke test: open `index.html?autotest=1` — it skips the setup modal
and starts an AI vs AI game.

## License

The source code (HTML/CSS/JS and tests) is released under the
[MIT License](LICENSE). Quoridor's rules and name belong to their designer
and publisher; this repository is a reimplementation of the rules only.
