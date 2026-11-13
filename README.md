# sabotage-council

A three-seat review council for code and plans.

Three coding agents from different model families review the same frozen snapshot. They run read-only, in
parallel, and none sees the others' answers. An adjudicator verifies every finding against the code, tallies per
finding rather than per reviewer, and writes one verdict: `SHIP`, `SHIP-WITH-FIXES` or `NEEDS-WORK`.

Each seat is filled by a CLI you already use. Planned backends:

- Codex CLI
- Claude Code
- Grok CLI
- Antigravity CLI (over ACP)
- Kiro CLI
- opencode
- Cursor CLI
- Muse Code

Every round records which seat raised which finding and what became of it. So you can see which seats earn their
place, and swap the ones that do not.

Planned modes:

- **`plan`**: the council pokes holes in a written plan.
- **`diff`**: the council reviews your branch's diff while you build.
- **`pr`**: the council reviews a GitHub pull request.
- **`auto`**: a local daemon reviews the PRs you are requested on, and posts one review per round.

## Status

Building (P4). Built so far: the config schema and loader, the run store, the review root and brief, the reply
parsers, the headless transport with the codex, claude, grok, cursor and muse seats, and the ACP transport with
the antigravity, kiro and opencode seats. There are no review rounds yet. The v1 build plan is
[docs/PLAN.md](docs/PLAN.md).

Each seat shows an enforcement label in `doctor` (plan 5.2). claude is `strong` (on 2.1.322 and 2.1.323, the
versions its canary ran on) and codex is `sandboxed-exec`. antigravity, kiro and opencode are `pending`: their
promotion canaries ran and did not prove every action was refused before it ran (plan 14). grok is `weak` with
`--sandbox off` (it would be `pending` with its sandbox running, a label no recorded run backs: no sandbox-on leg
has run). cursor and muse are `weak`: no live canary runs for them in v1. With the default
`untrusted_seat_policy = "fallback"`, a round on a PR from an author without write access needs `strong`
fallbacks for those seats, or it fails below quorum, visibly.

`doctor --deep` runs every seat's preflight, with no model call, against its own canary root of planted hooks,
rules and MCP config for every backend (top level and nested). Every planted hook event, MCP server and plugin
writes its own marker if anything runs it. What it proves: no planted code ran during preflight, and, for a
backend with an offline load dump (codex `debug prompt-input`, grok `inspect --json`, opencode `debug config`),
that the dump lists nothing from the root. It proves only what that dump covers (opencode's covers config
sources, not instruction files, which ratification checks per leg) and nothing about a model turn. A seat whose
backend has no load dump gets an "unproven by --deep" line (`unproven`, or `refused` when its preflight refused
the planted root by a filename scan), except claude on a version whose label is `strong` from its own recorded
promotion canary (2.1.322 and 2.1.323): its line says isolation is proven by that canary instead. Exit codes:
`0` every seat proven (by its load dump or its canary), `1` some seat loaded a planted file (or another doctor
check failed), `2` nothing loaded but some seat is unproven by `--deep`.

### Backend notes

- **Antigravity (`agy`).** Seats run `agy acp`, the documented client route, never `agy -p`. Google's FAQ says
  wrapping `agy` in third-party tools is not supported on consumer plans and can lead to account suspension.
  The documented headless route is a Gemini API key: set `GEMINI_API_KEY` and the seat runs with
  `modelProvider: "gemini"`. A consumer sign-in also works, at your own risk. Each leg runs on its own
  `--gemini-dir`. Measured on agy 1.5.7 with no model call: agy then reads its settings and its MCP config from
  that directory, not from `~/.gemini` (an MCP server planted in `~/.gemini` did not start). Not measured:
  whether your global `GEMINI.md`, skills, plugins and hooks in `~/.gemini` stay out. The root sanitizer and the
  per-call permission check apply either way. agy still runs with your real HOME, which its keyring sign-in
  needs.
- **Kiro (`kiro-cli`).** Seats run `kiro-cli acp` on the v2 engine with a council agent profile in a per-leg
  `KIRO_HOME`. A seat may set `auth_home = "/abs/dir"` to use a separate Kiro login (for example a personal one
  beside a work one): kiro-cli then runs with `HOME` there, and `doctor` shows which home each seat uses. Log that
  home in once with `HOME=/abs/dir kiro-cli login`.
- **Grok (`grok`).** Seats run headless with a read-only tool allowlist, `dontAsk`, deny rules and `HOME`
  isolated per leg. `--sandbox read-only` refuses to start on a Mac whose Docker Desktop socket is a symlink, so
  such a seat sets `sandbox = "off"` (label `weak`). No leg with the sandbox on has been recorded: the `pending`
  label for a sandbox-on seat with no MCP server is the plan's placeholder, not a measured result. An MCP server
  in your grok config would start inside the leg, so a seat with one is refused at preflight, and a leg that
  started one fails. Give the seat `auth_home = "/abs/dir"`, its own grok home with no MCP config, logged in once
  with `GROK_HOME=/abs/dir grok login` (`--oauth` for the browser flow, `--device-auth` for a device code); or use
  `XAI_API_KEY` (the leg then runs on its own empty grok home); or disable the server in your grok config
  yourself. `doctor` shows which grok home each seat uses. Reads outside the root are not refused before they
  run (measured): the ratifier catches them.
- **opencode.** Seats run `opencode acp` with a council agent, on per-leg XDG dirs and database, so saved
  opencode accounts never reach a leg: credentials come from provider environment variables, or use the free
  `opencode/*` models. opencode refused an outside read by path itself; a read through a symlink inside the root
  ran in the canary (the review root replaces such links with text files, but the label stays `pending`). On
  2.2.7 the council agent is still offered the `skill` tool: opencode appends its own `skill` rule after the
  council's, so no council rule removes it. The tool is accepted only while it is provably empty: preflight
  refuses a leg whose own skill locations (its XDG config, data and cache dirs, its `~/.agents` and `~/.claude`)
  or whose root (any `.opencode/`, `.claude/` or `.agents/`, at any depth) hold a skill, and any skill call
  (refused or not), skill message or user message naming a skill fails the leg.
- **Cursor (`cursor-agent`).** Seats call the newest release under `~/.local/share/cursor-agent/versions/` by
  path, never `agent` on PATH (the Cursor installer repoints that name). Print mode needs `--trust`; the council
  config and its deny-all-but-reads hook live in a per-leg `CURSOR_CONFIG_DIR`. With `CURSOR_API_KEY` the leg also
  gets its own `HOME`; on the keychain login Cursor may import your `~/.claude` hooks, and `doctor` lists them.
  `doctor` refuses Cursor seats in `auto`.
- **Muse Code (`muse`).** Seats always run with contributor mode off (on by default for subscriptions, it lets
  Meta train on the reviewed code), the read-only permission profile, and never `--trust-workspace`.
  `META_API_KEY`, when set, wins over your `muse login` session and bills pay-as-you-go; `doctor` says which one a
  seat uses.

## Development

Requirements:

- Node.js 22.13 or later (the run store uses the built-in `node:sqlite`, which needs no flag from 22.13);
- npm;
- macOS or Linux.

```sh
npm ci          # install the locked dependencies
npm test        # run the tests (vitest)
npm run lint
npm run typecheck
```

`npm run build` compiles to `dist/`. `node dist/cli/index.js doctor` then checks Node, the config at
`~/.config/sabotage-council/config.toml` and the run store at `~/.local/share/sabotage-council/council.db`
(`--config` and `--db` override both).

## License

MIT, copyright Sabotage Development LLC. See [LICENSE](LICENSE).
