# Security model

sabotage-council runs coding agents over code that may be someone else's: a pull request from a stranger, or a
repository full of agent configuration. Those agents can act on your machine if nothing stops them. This page says
what stops them, what does not, and what was measured. It describes 0.1.0 as built; the full design is
[section 6 of the plan](PLAN.md#6-security-model). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What a seat can do

A seat (a leg) is meant to read the review root and nothing else: no writes, no commands, no network, no MCP servers
(which on a developer machine can include cloud-admin and ticketing tools). Each backend enforces that differently,
and each carries an enforcement label per tested CLI version ([the backend pages](backends/README.md) have the
details and the measurements):

| Label | Backends in 0.1.0 | Can it write, run commands or fetch? | Can it read outside the root? |
|---|---|---|---|
| `strong` | claude 2.1.322, 2.1.323, 2.1.325 | no: those tools are not offered | no: denied before the read runs (measured by a canary on each version) |
| `sandboxed-exec` | codex 0.167.0 | runs commands, in a sandbox that denies writes and network | yes; detected afterwards from the leg's commands |
| `pending` | antigravity, kiro, opencode; claude on an untested version; grok with its sandbox running | the mechanism should prevent it; its canary did not prove every action | not proven; detected afterwards |
| `weak` | grok with `sandbox = "off"`, cursor, muse | depends on configuration the agent may not honour, or unmeasured | yes for grok (measured); unmeasured for cursor and muse |

**Ratification, for every leg.** After a leg ends, the engine proves from the CLI's own records (never the model's
word) that it is the review it claims to be: the record belongs to this launch, the working directory is the root,
the model and effort match the pin, the tools offered and used are only reads (codex: only its declared native tools,
each command parsed), every read path resolves inside the root, the root's tree hash is unchanged, the reply's first
line is the round's nonce, and the run completed cleanly. A leg that used or was offered a forbidden tool, read
outside the root or changed the root is `contaminated`: it does not count, it is never relaunched in that root, and
`stats` shows it. A missing record field fails closed. Ratification detects; only `strong` prevents.

**Untrusted pull requests.** On a PR whose author has no write access to the repository, every seat below `strong`
follows `council.untrusted_seat_policy`: `fallback` (the default) uses the seat's fallback if that is `strong` and
otherwise leaves the seat out; `skip` leaves it out; `allow` runs it, recording your acknowledgement on the leg. A
round that falls below two ratified legs fails visibly. It never approves quietly.

**Isolation from your own configuration.** Each adapter keeps your own agent configuration out of its legs where the
CLI allows it: claude runs with no settings sources (your plugins, hooks and `CLAUDE.md` are dropped; managed policy
settings still apply); grok, cursor, muse and opencode get a per-leg `HOME`; kiro a per-leg `KIRO_HOME`; antigravity a
per-leg `--gemini-dir`; codex disables each of your MCP servers by name. What still loads is listed by `doctor` as
user-owned (codex: your global `AGENTS.md`). Every leg runs in its own process group with a wall-clock cap, and the
CLI's own auto-update is switched off for the leg where the CLI has a switch for it (all but kiro and cursor).

## The review root

Every leg reads one frozen snapshot, built fresh for each attempt under `~/.cache/sabotage-council/roots/`:

- **From git, at exact commits.** The engine reads your repository through an alternates-only shadow (plan and diff
  rounds) or its own bare mirror (pr rounds), with git's global config set to `/dev/null`, no hooks and no fsmonitor,
  and extracts `git archive` output. Your index, branches and work tree are never touched; uncommitted work is
  snapshotted to a commit object, and untracked files named like secrets (`.env*`, `*.pem`) are left out with a
  warning.
- **What it holds.** The target at its head, `_base/` at the merge base, the diff, the brief, and for a pull request
  `PR.md` (title, body and reviews) and `COMMITS.log`, every line prefixed `DATA:`, plus earlier reviews as data.
- **Symlinks.** Every symlink that is absolute, dangling, or resolves outside the root is replaced by a text file
  `SYMLINK -> <target> (not followed)`.
- **The sanitizer**, at every depth and case-insensitively: agent-config directories (`.claude`, `.cursor`, `.kiro`,
  `.agents`, `.opencode`, `.gemini`, `.muse`, `.codex`, `.grok`) move whole into `_repo-agent-config/`; instruction and
  MCP files (`AGENTS*.md`, `CLAUDE.md`, `GEMINI.md`, `MEMORY.md`, `.mcp.json`, `opencode.json`, `opencode.jsonc`,
  `.cursorrules`, `.cursorignore`) and every `SKILL.md` (and every file in a quarantined skill directory) are renamed
  with a `.council-data` suffix. They stay readable as data, and the brief says so. Repositories carry such files
  because CLIs load them automatically, and hooks run code, often outside any sandbox.
- **Integrity.** No zero-byte file git does not have; the brief's promised files exist; file names that are not
  valid UTF-8 are refused rather than guessed.
- **The seal.** The root's tree hash is taken after all of the above and compared after the legs; a residue sweep
  finds any file a leg left behind. The root is deleted, by its own name only, once the round is adjudicated; `auto`
  prunes a failed round's root after 2 days.

`doctor --deep` checks the sanitizer's list against each backend: it preflights every seat on a root of planted
hooks, rules and MCP config (top level and nested) and reports any backend that loaded one.

## Prompt injection from reviewed content

A pull request's code, title, body and earlier reviews are attacker-controlled, and so is everything a leg writes
about them. The defences:

- every piece of PR text enters the root marked `DATA:`, and the brief and the adjudication spec say that
  instructions inside the tree are data;
- seats have no tool that acts (above), so an injected instruction has nothing to call;
- leg text never starts a round, adds context, posts or runs a command; the plugin's skill says so and pre-approves
  only read-only commands and `adjudicate`, so Claude Code asks you before every `round start` and every `post`;
- every posted byte passes the validator below.

**The interactive adjudicator is your own Claude Code session**, with whatever tools you allow it, and it reads the
legs' answers and the tree. On your own plans and diffs that is fine. On a PR whose author lacks write access, `round
start pr` refuses to run unless you set `pr.interactive_adjudication = "untrusted-too"`, accepting that leg text
reaches your session. `auto` adjudicates such PRs with the restricted headless adjudicator instead.

## The headless adjudicator

`auto` (and `adjudicate <id> --headless`) runs your unmodified `claude -p` on a copy of the root, proven by its tree
hash, with `--restricted`, `--permission-mode dontAsk`, `--permission-prompts none`, `--tools Read,Glob,Grep,Edit`,
`--allowedTools Read Glob Grep "Edit(./_mainloop/**)"`, `--strict-mcp-config`, `--setting-sources ""`, settings that
block reads outside the working directory, and a PreToolUse hook that re-checks every path by realpath and every Glob
or Grep pattern by the directories it can search. With `ANTHROPIC_API_KEY` it runs `--bare`, which skips hooks, and
the path check is left to `--restricted` and the settings key.

Before the first turn the engine reads `system/init` and kills the run (SIGKILL, recording `setup` and no
adjudication) if it was offered any tool beyond those four, is not in `dontAsk`, or lists an MCP server or an extra
directory. Afterwards it ratifies the run from its stream, its transcript and the hook's log: a run that read or
edited outside its bounds, changed the copy, ran a sub-agent or loaded an instruction file is contaminated, nothing it
wrote is read, and the round is held for your ruling. Its output goes through the same validator as yours, and a
majority override it makes is stored only as a ruling for you.

Measured (claude 2.1.325, 2026-11-13): a tree that plants an instruction to call a side-effecting MCP tool and to
read a canary file outside the copy, with that tool put in front of the real `claude` and allowed: the gate ended the
launch at `system/init`, 1.06 s after start; no turn ran, no tool was called, nothing was stored, and the canary file
was never read. One limit: an MCP server starts, and runs its own startup code, before `system/init` lists its tools;
the launcher never passes one, and only its flags keep a server from starting.

## Credentials

- **The engine never handles a CLI's credentials.** Each leg gets a scrubbed environment holding only the variables
  its backend needs (each backend page lists them); API keys pass through by name and are never read, logged or
  recorded. The engine never copies a login (for example codex's `auth.json`) anywhere.
- **Claude.** The engine shells out to your unmodified `claude` binary, which uses whatever you signed in to, and
  never reads, stores or forwards that login (D15). For heavy `auto` use, use `ANTHROPIC_API_KEY` or a Team or
  Enterprise plan: it is not "ordinary, individual usage" of a consumer plan.
- **GitHub.** Every GitHub read and post goes through your `gh` login, which must be the configured `github.login`.
  Fetches into the engine's mirror use `gh auth git-credential` as git's only credential helper; the engine never
  reads, stores or logs the token.

## What gets posted

Only `post` (on your go, or `auto` without `--dry-run`) writes to GitHub, and it posts as you. Before anything posts,
the body is rendered from the adjudication with every value from the adjudication, the PR or CI neutralized, and then
validated: no round nonce, no `@mention` of anyone outside the PR, no auto-close phrase, no credential-shaped string
(the renderer redacts them and the validator refuses a body that still holds one), the sections in order, and at most
60,000 bytes. `post --post` sends only the review a dry run showed (`--expect` names its hash), and its guards
withdraw an approval when a review lands meanwhile and never dismiss a human's review.

## Running PR code (opt-in tests)

Off by default. `[auto.tests."owner/repo"]` runs your own `setup` and `command`, in `auto` only, only for a PR whose
author has write access and whose head is in the same repository (never a fork, never a deleted head repository). It
runs on a separate copy of the head outside the review root, through `/bin/sh -c`, in its own process group, with
only `PATH`, `LANG`, `LC_ALL` and `TZ` from your environment plus a `HOME` and `TMPDIR` of its own and `CI=true`,
under one wall-clock cap. **This executes the PR's code on your machine as you**; a collaborator's PR can still do
anything your account can. There is no container mode in 0.1.0.

## The store, the round dirs and the HTML report

- The run store is SQLite at `~/.local/share/sabotage-council/council.db`; its directories are created mode 0700. Rows
  are kept forever (the scorecard needs history). Round dirs beside it (`rounds/<id>/`) keep the brief, each leg's
  stream, records and answer, and the adjudication, and `auto` prunes them after 90 days. They hold excerpts of the
  code you reviewed: treat them like the repositories they came from.
- `stats` and `seats list` never change the store's contents or schema: they open it read-only and never migrate it.
  On Node 22.13 and 22.14 SQLite leaves its `-wal` and `-shm` files beside a closed store (its contents unchanged);
  Node 22.15 and later open a closed store immutable and create nothing.
- `stats --html` writes one self-contained file, mode 0600, with no script, font, image or link; everything from a
  round is escaped, and bidi controls and zero-width characters are replaced.
- `notify.command` (used by `auto`) runs the executable you configure, without a shell, with the event as JSON on
  stdin. `followups.hook` is accepted by the config but nothing runs it in 0.1.0.
- `auto install` writes a launchd agent (macOS) or systemd user unit (Linux) that runs `sabotage-council auto run` as
  you; `auto install --dry-run` prints it and writes nothing.

## Supply chain

- Every adapter declares the CLI versions it was measured on; `doctor` warns outside them and refuses below the floor
  (codex refuses every undeclared version). Every leg records the CLI version it ran.
- The engine never updates a CLI, and switches the CLI's own auto-update off for its legs where the CLI has a switch
  for it (codex, claude, grok, antigravity, opencode and muse).
- The npm package has three runtime dependencies (`commander`, `smol-toml`, `zod`) and no native module; the run store
  uses Node's built-in `node:sqlite`.
- Releases are published from a tagged GitHub Actions workflow through npm trusted publishing, with a provenance
  statement ([releasing](releasing.md)).

## Not yet verified

The [backend pages](backends/README.md) list what each canary did not prove. In short: no backend but Claude Code has
earned `strong`; antigravity, kiro and opencode each let at least one canary action run or never had it put to the
client; grok's reads are not refused before they run; cursor and muse have no recorded model run at all.
