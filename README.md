# Agent Browser Benchmark

How well does a coding agent drive a web browser, and does it matter which browser tool it
uses? This repository runs the same [Claude Code](https://claude.com/claude-code) agent, with
the same model and the same prompts, through five browser automation surfaces and measures what
each one could do, how often it finished the job, and what it cost in time and tokens.

Everything is here: the harness, the fixture site, all 670 run records and every raw agent
transcript. The write-up is at
[umutcelik.com.tr/blog/five-ways-to-drive-a-browser](https://umutcelik.com.tr/blog/five-ways-to-drive-a-browser/).
The full report, with per-task tables and charts, is [`results/main/report.html`](results/main/report.html).

## Results

Opus 5.5 (`claude-opus-5-5`), effort `medium`, Claude Code 2.1.285, macOS, September 2026.

| Variant | Probes solid | Passed (all runs) | Median time | Median input tokens | Fixed context | Cost, 134 runs |
| --- | --- | --- | --- | --- | --- | --- |
| Claude in Chrome | 20/22 | 126/131 | 26 s | 122k | 15.7k | $22.5 |
| Playwright MCP · Chrome | 22/22 | 131/131 | 13 s | 57k | 10.6k | $10.9 |
| Orca browser | 20/22 | 126/131 | 13 s | 33k | 6.4k | $14.9 |
| Safari MCP | 21/22 | 127/131 | 13 s | 38k | 8.5k | $10.7 |
| Playwright MCP · WebKit | 22/22 | 131/131 | 13 s | 57k | 10.6k | $11.6 |

- *Probes solid*: single-skill probes passed in at least two of three runs.
- *Passed*: probes, realistic tasks and bug hunts together (the baseline tier is excluded).
- *Median time and tokens*: from the 486 non-baseline runs of the parallel phase (see Method).
- *Fixed context*: input tokens of a reply that uses no tools, which is roughly the cost of the
  tool definitions and any system prompt the surface adds.
- *Cost*: list-price equivalent reported by Claude Code (`total_cost_usd`); the runs themselves
  used a Max subscription.

What stood out:

- **Every surface can do the job; the difference is cost.** No variant fell below 96%, and
  Playwright passed all 131 runs on both engines. Claude in Chrome needed about twice the time
  and two to four times the input tokens of the others.
- **Claude in Chrome** reads pages through screenshots more often, carries the largest fixed
  context, and could not read an HttpOnly cookie in any run. Its real advantage, driving your own
  signed-in browser, is outside what clean fixtures measure.
- **Safari MCP** was the cheapest and had the most compact page reads, but a native `confirm()`
  left its click call hanging (0/3), and it has no drag gesture, so pointer drags fell back to
  events synthesized in page JavaScript.
- **Orca's browser** lost its runtime connection on a native `confirm()`, and
  `set media print` reported success without switching the media type.
- **The interface matters more than the engine.** Playwright on Chrome and on WebKit finished
  within a second of each other on every tier.

## What was compared

| Variant | Surface | Engine | How the agent reaches it |
| --- | --- | --- | --- |
| `claude-in-chrome` | Claude in Chrome extension | Google Chrome 154 (the author's own profile) | built-in MCP, `claude --chrome` |
| `pw-chrome` | `@playwright/mcp` 0.0.83 | Google Chrome 154, isolated profile, maximized | MCP over stdio |
| `pw-webkit` | `@playwright/mcp` 0.0.83 | Playwright WebKit 26.6 (build 2368) | MCP over stdio |
| `safari-mcp` | `safaridriver --mcp` ([announcement](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)) | Safari 27.0.1 | MCP over stdio, through [`src/safari-proxy.mjs`](src/safari-proxy.mjs) |
| `orca-browser` | Orca's built-in browser, Orca 1.4.217 | Chromium 150 (Electron) | `orca` CLI through the Bash tool |

Two pairs separate engine from interface: `claude-in-chrome` and `pw-chrome` drive the same
installed Chrome; `safari-mcp` and `pw-webkit` share an engine family.

## Tasks

36 tasks in four tiers, all served by a local fixture server ([`src/tasks/`](src/tasks)).

| Tier | Runs per variant | Tasks |
| --- | --- | --- |
| K0 baseline | 3 | Reply without tools (fixed context cost) |
| K1 capability probes | 3 each | read text, click, type and submit, form controls, hover menu, keyboard shortcut, HTML5 drag and drop, same-origin iframe, cross-origin iframe, nested shadow DOM, popup window, infinite scroll, `confirm()` + `prompt()` dialogs, file upload, file download, HttpOnly cookie, console error, request body, run page JavaScript, canvas below the fold (screenshot + vision), resize to phone width, print media |
| K2 realistic tasks | 5 each | checkout with validation, filtered SPA catalog, paginated table sum, multi-step wizard with a custom date picker, login with a code from a second tab, detail-page extraction, shop behind cookie banner and pop-ups, pointer-driven kanban board |
| K3 bug hunts | 5 each | failing API calls behind normal-looking widgets, silent console exceptions, accessibility faults, phone-width layout bugs, Chromium-only APIs |

K3 pages place their bugs in lettered sections, and the placement changes every run. The
engine task takes its ground truth from what each widget actually did in the run's own
browser, so WebKit and Chromium have different correct answers.

## Method

**Isolation.** Every run is a fresh non-interactive Claude Code process:

```bash
claude -p "<prompt>" --model claude-opus-5-5 --effort medium \
  --setting-sources project --strict-mcp-config --mcp-config <one server> \
  --tools Read --allowedTools "mcp__<server>__*" Read \
  --json-schema '<answer schema>' --output-format stream-json --verbose \
  --no-session-persistence --permission-mode bypassPermissions
```

- `--setting-sources project` keeps personal `CLAUDE.md` files and user settings out of the run.
- The only built-in tool is `Read`, so saved screenshots and downloaded files can be opened.
  Without Bash or WebFetch the agent cannot bypass the browser with `curl`.
- The Orca lane gets `Bash` restricted to `orca` browser commands in `dontAsk` mode, and the
  Orca browser guide appended to the system prompt in place of MCP tool descriptions.
- The answer comes back through `--json-schema`.

**Ground truth.** Each run gets its own origin (`run-<id>.localhost`), so cookies and storage
start empty in every browser, including a personal Chrome profile. Expected answers are
derived with an HMAC over a secret that exists only in the runner's memory, so an agent that
reads this repository still cannot compute them. The checker compares the answer with what the
server actually received: an agent that says it submitted a form but never did fails.

**Same window, every browser.** A beacon on every page reports the real viewport. Browsers ran
visible and maximized on a 1728×1117 display: Chrome 1728×873, Playwright Chrome 1728×907,
Safari, Playwright WebKit and Orca 1728×890 (Safari and Orca are sized by the harness before
the agent's first call). A run that started narrower than 1700 px was discarded and repeated.

**Reference solutions.** Before the full run, a scripted Playwright solution solved every K1,
K2 and K3 fixture in both Chrome and WebKit ([`src/selfcheck.mjs`](src/selfcheck.mjs)). It
caught two fixture bugs that would have failed every agent.

**Schedule.** The first 174 runs ran one at a time in shuffled blocks. The remaining 496 ran
five at a time: all five variants of a task start together, and the next task starts when all
five finish. For four variants the parallel-to-sequential time ratio on matching tasks was
0.94 to 1.03. Orca's setup changed mid-run (a pre-opened, pinned tab), so its sequential-phase
times are left out. Reported times and tokens come from the parallel phase; pass rates use
every run.

**Cleanup.** After each run the harness closes the run's tabs and windows, restores any Chrome
window the agent resized, and kills only browser processes that descended from that run's
`claude` process.

## Limitations

- One model and one effort setting. The tasks turned out easy for this model, so the benchmark
  separates cost and edge capabilities better than general competence.
- Claude Code adds its own system-prompt guidance for Claude in Chrome; the other surfaces rely
  on tool descriptions.
- Engine builds differ: Chrome 154, Orca's Chromium 150, and Playwright's WebKit 26.6 build,
  which is not the engine inside Safari 27.
- The HttpOnly-cookie probe tripped the API's cyber safeguard in 12 of its 15 runs (every
  variant except Orca). The refused turn was retracted and re-run on `claude-opus-5`, twice more
  on `claude-opus-4-8`. The other 654 runs used `claude-opus-5-5` only.
- Claude in Chrome ran in the author's everyday Chrome profile with its extensions.
- Answers were checked at run time; the secret is gone, so stored verdicts can be audited but
  the expected values cannot be re-derived.
- Local fixture pages only: no sign-in walls, bot detection or very heavy real-world pages.

## Data

```
results/
  main/
    runs.jsonl        one JSON record per run: 678 lines, 670 of them counted (see status below)
    summary.json      per task and per variant aggregates
    report.html       the rendered report
    meta.json         findings and limitations text used by the report
    raw/<runId>/
      prompt.txt        the exact prompt
      mcp.json          the MCP config the run used (plus playwright.json for pw-chrome)
      stream.jsonl      the full Claude Code transcript (stream-json)
      arrivals.json     receive time of every transcript line, ms from start
      server-events.json  everything the fixture server saw during the run
      stderr.txt
      playwright/       screenshots and snapshots saved by Playwright MCP
  pilot/              20 runs used to validate the harness; not part of the report
  main-run.log, pilot-run.log   runner console output
```

Key fields in `runs.jsonl`:

| Field | Meaning |
| --- | --- |
| `key`, `task`, `tier`, `variant`, `rep` | what ran; `key` is `task\|variant\|rep` |
| `status` | `ok`, `timeout`, `error` count; `api-error`, `infra-error`, `invalid-viewport` were retried and are excluded from every figure |
| `pass`, `check` | checker verdict and its details (K3 adds `recall`, `precision`, `truth`) |
| `claimedComplete`, `notes`, `structured` | the agent's own answer |
| `trusted` | whether the page saw real browser input (`event.isTrusted`) for the tested interaction |
| `durationMs`, `durationApiMs`, `toolTimeMs` | wall time, model time, time between tool call and tool result |
| `totalInputTokens`, `usage`, `costUsd` | tokens (input + cache) and list-price cost |
| `toolCalls`, `toolNames`, `toolResultBytes`, `toolResultImages` | tool usage; `StructuredOutput` is not counted as a call |
| `viewport` | first and last viewport the page reported |
| `concurrency` | runs in flight when this run started; missing means 1 |
| `rateLimit` | the last `rate_limit_event` of the run |
| `cleanup` | what the harness had to close or restore afterwards |

## Reproduce

Requirements: macOS, Node 24, Claude Code (runs used 2.1.285), Google Chrome with the Claude
extension signed in to the same account, Safari 27 with *Settings → Advanced → Show features
for web developers* and *Settings → Developer → Allow remote automation and external agents*
turned on, and the Orca desktop app for the Orca lane.

```bash
npm install
npx @playwright/mcp install-browser webkit
npm run smoke          # every fixture route renders
npm run selfcheck      # reference solutions pass in Chrome and WebKit (opens visible browsers)
npm run bench          # the full run, resumable; re-run the same command to continue
npm run watch          # health check while it runs
npm run report
```

The runner pauses itself before a Claude usage window fills (`--max-five-hour`,
`--max-weekly`), retries transient API errors, and stops if one variant keeps failing for an
environment reason. Use `--tasks k1-read,k2-table --variants safari-mcp` to run a subset.

## Repository layout

```
src/
  runner.mjs        plans, runs and records runs (sequential or --parallel task blocks)
  server.mjs        fixture server and run-scoped event log
  tasks/            task definitions: pages, prompts, answer schemas, checkers
  variants.mjs      the five surfaces and their Claude Code arguments
  safari-proxy.mjs  stdio MCP proxy that sizes the Safari window before the agent starts
  metrics.mjs       transcript parsing
  cleanup.mjs       tab, window and process cleanup
  selfcheck.mjs     scripted reference solutions
  smoke.mjs, watch.mjs, summarize.mjs, report.mjs
```

## How this was made

I designed and ran this benchmark with Claude Code as a pair: it wrote most of the harness and
the first draft of the report, and I reviewed the design, the anomalies and the conclusions.

## License

MIT, for the code and the data. See [LICENSE](LICENSE).
