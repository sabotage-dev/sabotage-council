# Changelog

## 0.1.0

The first release.

### What ships

- **The engine**, the npm package `sabotage-council` (Node 22.15 or later, macOS and Linux): three seats from
  different model families review one frozen, sanitized snapshot read-only and in parallel, each leg ratified from
  its CLI's own records, with quorum 2 of 3, a fallback per seat on `usage_limit` and `auth`, and one relaunch on
  `capacity`, `transport`, `empty` and `timeout`.
- **Four modes**: `plan` (a written plan), `diff` (a branch diff, uncommitted work included), `pr` (a GitHub pull
  request, with the round numbered from its review history and one review posted on your go) and `auto` (a local
  daemon that reviews the PRs you are requested on, adjudicates headless and posts one review per round; a shadow
  mode posts nothing).
- **Eight seat backends**: codex and claude (headless), grok, cursor and muse (headless), antigravity, kiro and
  opencode (ACP). See [docs/backends/](docs/backends/README.md).
- **kiro seats run kiro-cli's v3 engine by default** (Kiro's own default for new installs; kiro-cli 3.5.0 or later),
  with `engine = "v2"` keeping the v2 engine on 3.2.1, 3.3.0 and 3.5.0. **An existing kiro seat or fallback with no
  `engine` moves to v3**: set `engine = "v2"` to keep it on v2, or update kiro-cli to 3.5.0 (a v3 seat on an older
  kiro-cli is refused at preflight: "update kiro-cli, or set engine = v2"). `doctor` prints each kiro seat's engine,
  `seats swap/add/test` take `--engine`, and every leg records the engine it ran. On v3 the client pins the agent,
  model, effort, autopilot, content collection, memory reflection and session tools messaging over ACP and gates the
  session before the prompt (exactly kiro's read tool tag, empty permission presets, no MCP server, bundled steering
  only); legs on 3.5.0 get a settings file that turns off kiro-cli's self-update, telemetry and content sharing. See
  [the kiro page](docs/backends/kiro.md).
- **Findings blocks** in the three shapes seats write (the `F1 | HIGH | path:line | title` lines, JSON, YAML), tagged
  `findings` on the opening fence or, as a live seat wrote it, on the first non-blank line inside an untagged fence
  that only blank lines and the verdict line follow; anything looser, such a block midway through the answer (it may
  be quoted), or two blocks that differ, goes to the adjudicator.
- **Adjudication**: `adjudicate` validates and stores your session's `ADJUDICATION.json`; `adjudicate --headless`
  runs a restricted Claude Code to adjudicate with no user in the loop (what `auto` uses). `adjudicate --check`
  names the stable id each finding must have, even when its `id` is a placeholder the schema rejects, so any `f_` id
  can be a placeholder.
- **The scorecard**: `stats` (per seat and per occupant, with swap candidates, as text, JSON or one HTML file) and the
  `seats` commands (`list`, `test` on a built-in planted-defect fixture, `swap`, `add`, `remove`). A seat is a swap
  candidate on a low ratified rate, a low precision, or silence: nothing it raised adopted or refuted over N
  adjudicated rounds, with no blocking finding lost without it (a seat that alone raised a ruling still pending is
  not silent). `stats` and `seats list` read the store read-only and create nothing beside a closed store: the Node
  floor is 22.15 (raised from 22.13 before this release), whose SQLite opens a closed store immutable, and a closed
  store it cannot open that way is refused with the reason, as is a store with only one of its `-wal` and `-shm`
  files (`doctor --db` clears it).
- **The Claude Code plugin** in `plugin/`: `/sabotage-council:council plan | diff | pr | status | doctor | stats |
  seats`, the skill, and the adjudication spec `ADJUDICATE.md` the headless adjudicator shares.
- `doctor` and `doctor --deep`: every seat's preflight with no model call, and a canary root of planted agent
  configuration.

### What is measured, and what is not

- **Enforcement labels.** Only `claude` on 2.1.322, 2.1.323 and 2.1.325 is `strong` (a promotion canary on each).
  `codex` 0.167.0 is `sandboxed-exec` (commands run in a write- and network-denied sandbox; reads are not confined).
  `antigravity` 1.5.7, `kiro` (3.5.0 on both engines; 3.2.1 and 3.3.0 on v2) and `opencode` 2.2.7 are `pending`:
  their canaries ran and did not prove every action refused before it ran (kiro's v3 canary has not run yet). `grok`
  1.0.70 is `weak` with `sandbox = "off"` (reads outside the root ran and were caught only by ratification); with its
  sandbox on it is `pending`, a label no recorded run backs. `cursor` and `muse` are `weak`: no live Cursor run and no
  logged-in Muse run exists.
- With the default `untrusted_seat_policy = "fallback"`, a round on a PR from an author without write access needs
  `strong` (claude) fallbacks for the other seats, or it fails below quorum, visibly.
- Not measured: an antigravity leg's symlink read, write, command and fetch, each put to the client on its own;
  whether `~/.gemini` instructions, skills, plugins and hooks stay out of an agy leg; kiro's offered tool set on its v2
  engine, the effort field on a model with effort levels (either engine), whether the v3 settings file stops a pending
  self-update, and a model reroute v3 does not report; a grok configuration that stops reads before they run, and a grok leg
  with its sandbox on; every Cursor behaviour; a logged-in Muse leg's records; the Bedrock and Vertex routes for
  claude; the `GEMINI_API_KEY`, `KIRO_API_KEY` and paid-provider opencode routes.

### Known limits

- `codex` seats accept only 0.167.0; a newer codex is refused until a release declares its tool list.
- A grok fallback cannot set `sandbox = "off"`, so on a Mac whose Docker Desktop socket is a symlink it fails
  preflight.
- A grok seat fails if its grok home's config starts any MCP server (preflight refuses it). If your own grok config
  starts one, give the seat an `auth_home` (its own grok home, logged in once with `GROK_HOME=<dir> grok login`,
  holding no MCP config) or choose another seat; the README quickstart says so at step 1.
- Not built: the plan's `doctor --seat`, the `auto` warning for seats below `strong`, the once-a-day usage-limit
  notification per occupant, the opt-in tests' container mode, and the follow-ups hook (`[followups] hook` is
  accepted by the config, and nothing runs it).
