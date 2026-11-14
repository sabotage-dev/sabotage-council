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

Building (P7). Built so far: the config schema and loader, the run store, the review root and brief, the reply
parsers, the headless transport with the codex, claude, grok, cursor and muse seats, the ACP transport with the
antigravity, kiro and opencode seats, the round runner with the `plan`, `diff` and `pr` modes, the `adjudicate`
validator, the restricted headless adjudicator, the GitHub post step, and the Claude Code plugin. `auto` comes
later. The v1 build plan is [docs/PLAN.md](docs/PLAN.md).

Each seat shows an enforcement label in `doctor` (plan 5.2). claude is `strong` (on 2.1.322, 2.1.323 and 2.1.325, the
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
promotion canary (2.1.322, 2.1.323 and 2.1.325): its line says isolation is proven by that canary instead. Exit codes:
`0` every seat proven (by its load dump or its canary), `1` some seat loaded a planted file (or another doctor
check failed), `2` nothing loaded but some seat is unproven by `--deep`.

### Running a round

From a git repository:

```sh
sabotage-council round start plan docs/PLAN.md --json   # or: round start diff [<base>..<head>] --json
                                                         # or: round start pr owner/repo#12 [--dry-run] --json
sabotage-council round wait <id>                         # blocks until the legs settle; prints JSON
sabotage-council round show <id>                         # a readable summary, any time
sabotage-council adjudicate <id> ADJUDICATION.json       # validate, store, print the effective verdict
sabotage-council adjudicate <id> --headless              # or: the engine runs a restricted Claude Code to adjudicate
sabotage-council post <id> --dry-run                     # pr: the exact review that would post, and its review sha256
sabotage-council post <id> --post --expect <sha256>      # pr: post that review, one review on the reviewed head
```

- `round start plan <file>` reviews a written plan. `--context <path|repo@ref>` adds other paths or repositories
  to the root, `--fact <text>` gives the seats an established fact they must not refile, and `--question <text>`
  (at most 3) replaces the default questions. An uncommitted plan, and uncommitted changes to a `--context` path
  inside the repository, are snapshotted together, and the round reviews that snapshot: its revision, `FOLD.diff`
  and the root's copy of the context agree.
- `round start diff [<base>..<head>]` reviews a branch diff; the default is the merge-base with the default branch
  to HEAD, with uncommitted work snapshotted to a commit object (your index and branches are never touched; the
  ignore rules `git status` uses apply, including the excludes file the repository's own config names, and
  untracked files named like secrets, such as `.env*` or `*.pem`, are left out with a warning). An explicit range
  reviews committed history; `--uncommitted` adds the work tree. Rounds on one branch form one series: they number
  together and carry earlier items. A sha, a tag or a detached HEAD has no branch, so its series is keyed by the
  head commit, and a later commit starts a new series (`round start` warns). `--series <name>` names the series
  instead, for any head: rounds with that name in the repository form one series, whatever the head or the base.
- `round start` numbers the round from the store (a head counts once a council round on it, with two or more
  counted legs, is adjudicated; a plan round counts revisions of the plan, so an unrelated commit is not a new
  round), builds and seals the root, writes the brief, and starts a detached worker that runs the legs; it prints
  the round id (or JSON with `--json`) and returns. The worker preflights every seat and fallback serially,
  launches the legs in parallel, moves a seat to its fallback within the round on `usage_limit` or `auth` (or when
  its primary fails preflight), relaunches a leg once on `capacity`, `transport`, `empty` or `timeout` while the
  round has time, rebuilds the root first if it changed, ratifies every leg, sweeps the root for residue, and
  settles quorum over distinct occupants: 2 or more ratified legs is a council round, 1 is a labelled solo review
  that never approves, 0 fails the round.
- `round start pr <owner/repo#num | url> [--dry-run] [--no-identity]` reviews a GitHub pull request. It reads the
  PR through your `gh` login, which must be the `github.login` account (it refuses otherwise), fetches its head and
  base into the engine's own bare mirror beside the store (with `gh auth git-credential` as git's credential helper,
  in the same environment, so a `GH_TOKEN`-only setup can fetch a private repository; the engine never reads, stores
  or logs the token), and numbers the round from the PR's review history: every review by `github.login`
  or a `council_logins` login whose first line is a council marker counts its `commit_id` as a reviewed head, so a
  PR another council already reviewed continues at its round (plan 3.6). GitHub's changed-file list must match what
  the fetched base and head change, or the round stops. The root holds the PR head, the merge base,
  `PR.md` and the earlier reviews as data; your own change request on an earlier head becomes asks the seats must
  answer, and one on this head holds the round for your ruling (a later council review of yours replaces it, as it
  does on GitHub). Other reviewers' standing change requests, `council_logins` reviewers' unmarked ones included,
  are earlier items. Repository names are matched case-insensitively. Any GitHub read that fails stops the round. A PR
  from an author without write access is refused unless `pr.interactive_adjudication = "untrusted-too"` (then
  `council.untrusted_seat_policy` applies to every seat below `strong`). A head whose tree you already approved on
  another PR takes the identity path: no seats (`--no-identity` runs a council round instead). It needs a
  `[github]` table with your `login`.
- `post <id> --dry-run | --post [--expect <review sha256>]` (pr rounds, after `adjudicate`): maps the round to
  APPROVE, REQUEST_CHANGES or COMMENT by plan 3.7's table (your own PR always gets a COMMENT; CI, with each required
  check bound to its app, the hold list, `auto.approve` and any human change request the round never adjudicated gate
  an approval), renders the body (the marker line first; every value from the adjudication, the PR or CI neutralized,
  paths and names as one escaped line), and validates it: no nonce, no mention of anyone outside the PR, no
  auto-close phrase, no credential shape, the body's own sections in order, at most 60,000 bytes. `--dry-run`
  prints the event, the body, the body's sha256 and the review sha256 (one hash of the event and the body), and
  posts nothing. `--post` sends only the review a dry run showed: the one whose review sha256 `--expect` names (so
  a go for one event never sends another with the same body), or else the latest; if anything changed since (CI
  turned green, a review landed), it refuses and prints the new one. It claims the round so two posts never both
  send (a post whose claim was taken over after an hour posts nothing), re-checks the pull request right before
  posting (head moved: the round is superseded; closed, or an identity round's base moved off the default branch:
  nothing posts, and a new dry run shows what applies now), posts one review bound to the reviewed head, and then
  runs its guards: it withdraws an approval if a review other than a council's landed meanwhile, withdraws any
  review GitHub bound to another commit, and after a comment that owes nothing dismisses the council's own earlier
  change request (never a human's). A guard that fails stays pending and `post` exits 1; run the same `--post` again
  to resume it. After a crash, the next `--post` first adopts the review that landed (even when the head moved or
  the PR closed since) and runs its guards. A round started with `--dry-run` never posts.
- `credit <owner/repo#num> <review-id> [--note <text>]` counts an unmarked review you vouch for as a council round
  at its own head and time (plan 3.6 step 4). A review that starts with a council or identity marker is refused:
  the marker rules decide those.
- `round wait <id> [--timeout <minutes>]` exits 0 when the legs settle, 1 when the round failed (or its worker
  died), and 3 when the timeout ran out first.
- `adjudicate <id> <file> [--check]` checks `ADJUDICATION.json` (plan 7.3) against the round as the store
  recorded it and stores it, once, only if every check passes; each rejection names its class (`[attribution]`,
  `[round-rule]`, ...). `--check` validates only and lists every majority override with its proof, to show before
  storing.
- `adjudicate <id> --headless [--json]` (plan 6.4, 7.2) has the engine adjudicate the round itself, with no user in
  the loop: it is what `auto` will use. It needs `[adjudicator] model` in the config (`effort` defaults to `high`,
  `max_turns` to 40, `timeout_minutes` to 15). The engine copies the round's frozen root into a working directory,
  proves the copy by its tree hash, adds the inputs (`_council/`: `ADJUDICATE.md`, the round as `round wait` prints
  it, the counted legs' answers, the ratification table, the test result) and an empty `_mainloop/ADJUDICATION.json`,
  and runs your unmodified `claude -p` there with `--restricted`, `--permission-mode dontAsk`, `--permission-prompts
  none`, `--tools Read,Glob,Grep,Edit`, `--allowedTools Read Glob Grep "Edit(./_mainloop/**)"`,
  `--strict-mcp-config`, `--setting-sources ""`, and settings that block reads outside the working directory and run
  a PreToolUse hook that re-checks every path by realpath (with `ANTHROPIC_API_KEY` it runs `--bare`, which skips
  hooks). It reads `system/init` before the first turn and kills the run there, recording `setup` and no
  adjudication, when it was offered any tool beyond those four or is not in `dontAsk`. It ratifies the run from its
  stream, its transcript and the hook's log: a run that read or edited outside its bounds, or changed the copy, is
  contaminated, nothing it wrote is read, and the round is held for your ruling. Otherwise the engine replaces the
  placeholder finding ids with stable ones and stores the document through the same validator (a majority override
  is a ruling here, as no one saw its proof); a rejection re-prompts once with the errors, and a second one holds
  the round (`round show` says HELD; adjudicate it yourself). The adjudicator's observed model, effort, tools,
  permission denials, cost, duration and transcript are recorded on the round. Exit 0 adjudicated, 1 failed, 4 held.
- Every command takes `--config`, `--db` and `--roots`. The store defaults to
  `~/.local/share/sabotage-council/council.db`, with round dirs in `rounds/<id>/` beside it; roots are built under
  `~/.cache/sabotage-council/roots/` as `<store tag>-<round id>-a<attempt>` and deleted, by that name only, once the
  round is adjudicated. A round dir's `round.json` is a display copy: the store decides.

The Claude Code plugin in [plugin/](plugin/) runs this loop from a session: `/sabotage-council:council plan
<file>`, `diff` or `pr <owner/repo#num>`, then the session adjudicates by
[plugin/ADJUDICATE.md](plugin/ADJUDICATE.md). For a PR it then shows you the review `post --dry-run` renders, and
posts only when you say so in your next message, with `--expect` set to that review's hash (its event and its
body): a review that changed since waits for a new go. The plugin pre-approves only the read-only commands and
`adjudicate`: Claude Code asks you to approve every `round start` and every `post`, since a round costs money, a
review is public, and the session reads the legs' untrusted answers.

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
  hold any file, or whose root holds a live skill file anywhere, the quarantine included (the sanitizer renames
  every `SKILL.md`, and every file in a quarantined skill dir, with `.council-data`); any skill call (refused or
  not), skill message or user message naming a skill fails the leg.
- **Cursor (`cursor-agent`).** Seats call the newest release under `~/.local/share/cursor-agent/versions/` by
  path, never `agent` on PATH (the Cursor installer repoints that name). Print mode needs `--trust`; the council
  config and its deny-all-but-reads hook live in a per-leg `CURSOR_CONFIG_DIR` and in the leg's own `HOME`.
  Cursor seats need `CURSOR_API_KEY`: the keychain login keeps your `HOME`, where the council hooks are never
  read (and Cursor would import your `~/.claude` hooks), so preflight refuses it until a live run shows the hooks
  loading there. `doctor` refuses Cursor seats in `auto`.
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
