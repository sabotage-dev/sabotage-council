# sabotage-council

A three-seat review council for code and plans.

Three coding agents from different model families review the same frozen snapshot. They run read-only, in
parallel, and none sees the others' answers. An adjudicator (your Claude Code session, or a restricted headless
Claude Code) verifies every finding against the code, tallies per finding rather than per reviewer, and writes one
verdict: `SHIP`, `SHIP-WITH-FIXES` or `NEEDS-WORK`.

Each seat is filled by a CLI you already use: Codex CLI, Claude Code, Grok CLI, Antigravity CLI, Kiro CLI, opencode,
Cursor CLI or Muse Code. Every leg is ratified from the CLI's own records (the model that actually ran, the tools it
used and, where the CLI records it, what it was offered, the files it read), so a leg that is not the review it claims
to be does not count. Every round records which seat raised which finding and what became of it, so you can see which
seats earn their place and swap the ones that do not.

Four modes:

- **`plan`**: the council pokes holes in a written plan;
- **`diff`**: the council reviews your branch's diff while you build;
- **`pr`**: the council reviews a GitHub pull request, and posts one review on your go;
- **`auto`**: a local daemon reviews the pull requests you are requested on, and posts one review per round.

## Install

Requirements: Node.js 22.13 or later, git, macOS or Linux, and the CLIs for your seats (each signed in). `pr` and
`auto` also need the GitHub CLI `gh`, signed in. The adjudicator is Claude Code.

```sh
npm install -g sabotage-council
sabotage-council --version
```

The Claude Code plugin runs a round from a session and adjudicates it there. In Claude Code:

```text
/plugin marketplace add sabotage-dev/sabotage-council
/plugin install sabotage-council@sabotage-council
```

The plugin holds no engine logic: it calls the `sabotage-council` command you installed above.

## Quickstart: a first plan round

**1. Install and sign in to three seat CLIs.** This example seats Codex CLI 0.167.0 (`codex login`), Claude Code
2.1.325 (`claude auth login`) and Grok CLI 1.0.70 (`grok login`): three model families. Any three of the eight work;
each [backend page](docs/backends/README.md) says how to install, sign in and choose a model, and what it can and
cannot enforce.

**2. Write the config** at `~/.config/sabotage-council/config.toml`. This never overwrites a config you already
have: if the file exists, the shell refuses (`noclobber`) and nothing is written, so back up or move your config
first, or add these seats to it by hand.

```sh
mkdir -p ~/.config/sabotage-council
(set -o noclobber; cat > ~/.config/sabotage-council/config.toml) <<'EOF'
[[seats]]
id = "a"
backend = "codex"
model = "gpt-6.1-sol"
effort = "high"

[[seats]]
id = "b"
backend = "claude"
model = "claude-sonnet-5-5"
effort = "high"

[[seats]]
id = "c"
backend = "grok"
model = "grok-4.7"
effort = "high"
sandbox = "off"   # grok's read-only sandbox does not start on a Mac with Docker Desktop
EOF
```

Seats are exactly three, and a round needs two ratified legs. The config is read only from your machine, never from
the repository under review. [The configuration](#configuration) lists every setting.

**3. Check the setup**, with no model call:

```sh
sabotage-council doctor
```

It loads the config, creates the run store, and preflights every seat: binary, version, sign-in, model, and the
isolation each backend can prove. Each seat line ends with its enforcement label. A `fail` line names what to fix; a
`warn` line (for example grok's sandbox being off) is information. `round start` also runs the config-wide checks
`doctor` skips: every model id against its adapter's list (an error), and two seats in one model family or a seat in
the adjudicator's family (a `warn` line).

**4. Start a round** from a git repository that holds your plan (a Markdown file; it may be uncommitted):

```sh
sabotage-council round start plan docs/PLAN.md --json
```

It snapshots the plan into a sealed review root, writes the brief, starts the three legs in a background worker, and
prints the round as JSON on its last line (`round_id`, `round_no`, `rule`, `scope`, the brief's path, and the `next`
command), after any `warn` lines. Rounds cost money: each leg is one paid run of its CLI.

**5. Wait for the legs** (each is capped at 25 minutes by default):

```sh
sabotage-council round wait <round_id>
```

It prints the settled round as JSON: each leg's status, verdict and findings, and the quorum label (`council` with two
or three ratified legs, `solo` with one, which never approves). `sabotage-council round show <round_id>` prints a
readable summary at any time.

**6. Adjudicate.** In Claude Code with the plugin, `/sabotage-council:council plan docs/PLAN.md` runs steps 4 to 6
for you: the session waits for the legs, verifies each finding against the code, writes the adjudication and stores
it. By hand, write `ADJUDICATION.json` by the procedure in [plugin/ADJUDICATE.md](plugin/ADJUDICATE.md) (map every
finding of every ratified leg, verify each against the root that `round wait` printed), check it, then store it:

```sh
sabotage-council adjudicate <round_id> ADJUDICATION.json --check
sabotage-council adjudicate <round_id> ADJUDICATION.json
```

`--check` validates and stores nothing; a rejection names the rule it broke (`[attribution]`, `[round-rule]`, ...).
Finding ids are computed from the finding's path and title, so the first `--check` names the id each finding must
have: copy it in and check again. The stored verdict is the round's.

**7. Fold and go again.** After you fix the owed findings, the same `round start` becomes round 2: the seats review
only the change since the last adjudicated round, and the earlier owed findings come back as items each needing a
row. From round 4 only HIGH findings block (and an open change-request ask from you stays owed).

## More modes

**A branch diff.** From the branch: `sabotage-council round start diff --json` reviews the merge-base with the default
branch to HEAD, uncommitted work included (snapshotted to a commit object; your index and branches are never
touched). `round start diff main..feature --json` reviews an explicit range. Then wait and adjudicate as above, or
`/sabotage-council:council diff` in Claude Code.

**A pull request.** Add your GitHub login to the config (`[github] login = "you"`; your `gh` login must be that
account). Then `/sabotage-council:council pr owner/repo#12`, or by hand:

```sh
sabotage-council round start pr owner/repo#12 --json   # add --dry-run to make a round that can never post
sabotage-council round wait <round_id>
sabotage-council adjudicate <round_id> ADJUDICATION.json
sabotage-council post <round_id> --dry-run             # the exact review: its event, its body and its sha256
sabotage-council post <round_id> --post --expect <the review sha256 the dry run printed>
```

Nothing posts without `--post`, and `--post` sends only the review a dry run showed. A PR from an author without
write access is refused in your session unless you set `pr.interactive_adjudication = "untrusted-too"` (its text is
attacker-controlled and your session would read it), and its seats below `strong` follow
`council.untrusted_seat_policy` ([security](docs/security.md)).

**The auto-reviewer.** `auto` reviews every PR where you are requested as a reviewer, one round per new head,
adjudicated by the restricted headless adjudicator, and posts one review per round as you. It needs `[github] login`,
`[adjudicator] model` and an `[auto]` table whose `repos_allow` names the repositories it may touch. Start in the
shadow mode, and look before anything posts:

```sh
sabotage-council auto run-once --dry-run   # one pass: renders its reviews, posts nothing
sabotage-council auto status               # paused or not, the service, open rows, the last pass
sabotage-council auto install --dry-run    # prints the service file and its commands; writes and loads nothing
sabotage-council auto install --shadow     # a launchd agent (macOS) or systemd user unit (Linux) that posts nothing
sabotage-council auto install              # the same, posting; auto uninstall removes it; auto pause / resume
```

Run the shadow mode for a while, read what it would have posted (`auto status`, the round dirs, `stats`), and only
then install the posting service. Heavy `auto` use on a consumer Claude plan is not "ordinary, individual usage": use
`ANTHROPIC_API_KEY` or a Team or Enterprise plan for the seats and the adjudicator.

**The scorecard and the seats.**

```sh
sabotage-council stats [--since 30d] [--json] [--html report.html]   # per seat and per occupant, with swap candidates
sabotage-council seats list                                            # each seat, its fallback, its label, its score
sabotage-council seats test codex:gpt-6.1-sol:high                     # ONE paid leg on a built-in planted-defect fixture
sabotage-council seats swap c --backend antigravity --model gemini-3.8-flash --effort high --dry-run
```

`stats` and `seats list` never change the run store's contents or schema (on Node 22.13 and 22.14 SQLite leaves its
`-wal` and `-shm` files beside a closed store), and nothing ever swaps a seat by itself. [Migration](docs/migration.md)
explains why a swap starts the seat's evidence over.

## Status: 0.1.0, what is measured and what is not

Every mode, all eight backends, the headless adjudicator, the auto-reviewer and the scorecard are built and tested
against recorded and fake CLI runs. What each backend can enforce was measured on its own canary, and most did not
earn the top label:

| Label | Backends | Why |
|---|---|---|
| `strong` | claude 2.1.322, 2.1.323, 2.1.325 | its promotion canary on each version denied every outside read (path, symlink, Glob, Grep) before it ran; no write, command or fetch tool is offered |
| `sandboxed-exec` | codex 0.167.0 | commands run in a write- and network-denied sandbox; reads are not confined to the root (checked afterwards) |
| `pending` | antigravity 1.5.7, kiro 3.2.1, opencode 2.2.7; claude on an untested version | their canaries ran and did not prove every action refused before it ran |
| `weak` | grok 1.0.70 with `sandbox = "off"`; cursor; muse | grok's reads outside the root ran and were caught only afterwards; no live Cursor run and no logged-in Muse run exists |

A grok seat with its sandbox running would be `pending`, a label no recorded run backs. With the default
`untrusted_seat_policy = "fallback"`, a round on a PR from an author without write access needs `strong` (claude)
fallbacks for the other seats, or it fails below quorum, visibly. Each [backend page](docs/backends/README.md) lists
what its canary did not prove, and the [changelog](CHANGELOG.md) lists what 0.1.0 does not do.

## Documentation

- [Seat backends](docs/backends/README.md): one page per CLI (install, sign-in, models, label, failures, terms).
- [Security model](docs/security.md): what a seat can do, the review root, prompt injection, credentials.
- [Migration](docs/migration.md): upgrading the run store, moving from another council, moving a seat.
- [Releasing](docs/releasing.md): how a release is published (for maintainers).
- [plugin/ADJUDICATE.md](plugin/ADJUDICATE.md): the adjudication procedure and the `ADJUDICATION.json` schema.
- [The v1 plan](docs/PLAN.md): the full design, decisions and measured records.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## Configuration

The config is TOML at `~/.config/sabotage-council/config.toml` (or `--config`, or `SABOTAGE_COUNCIL_CONFIG`). Every
table is strict: an unknown key is an error. The engine never reads seat, posting or test settings from the
repository under review. Defaults are shown.

```toml
[council]                          # quorum is fixed at 2 and seats at 3 (D10)
leg_timeout_minutes = 25
untrusted_seat_policy = "fallback" # PRs from authors without write access: "fallback" | "skip" | "allow"
high_only_from_round = 4           # from this round only HIGH findings (and your open asks) block

[[seats]]                          # exactly three
id = "a"
backend = "codex"                  # codex, claude, grok, antigravity, kiro, opencode, cursor, muse
model = "gpt-6.1-sol"              # an id the backend's adapter lists
effort = "high"                    # required by most backends (see each backend page)
fallback = { backend = "claude", model = "claude-opus-5-5", effort = "high", on = ["usage_limit", "auth"] }
# grok seats take sandbox = "read-only" | "off"; kiro and grok seats (and fallbacks) take auth_home = "/abs/dir",
# a separate login of the seat's own.

[adjudicator]                      # the headless adjudicator (auto, adjudicate --headless)
model = "claude-opus-5-5"          # no default: adjudicate --headless refuses until it is set
effort = "high"
max_turns = 40
timeout_minutes = 15

[github]                           # pr and auto
login = "your-login"               # must be your gh login
council_logins = []                # other logins whose council reviews count toward the round number
markers_also_count = []            # first-line prefixes of another council's reviews, e.g. ["Council round"]

[auto]
interval_minutes = 5
repos_allow = ["your-org/*"]       # an empty list allows nothing
repos_skip = []
repos_hold = []                    # rounds run and post, but never approve
include_assigned = false           # also review PRs assigned to you
include_team_requests = true       # team review requests count
approve = true
ci_gate = "required-checks"        # or "all" | "off"
ci_red_event = "REQUEST_CHANGES"   # or "COMMENT": what red CI posts when nothing is owed
max_rounds_per_day = 30
identity_approval = true           # a head whose tree you already approved on another PR takes the identity path

[auto.tests."your-org/api"]        # opt-in, collaborators' same-repository PRs only, never forks
setup = "npm ci"
command = "npm test"
timeout_minutes = 15

[pr]
interactive_adjudication = "trusted-only"  # or "untrusted-too"

[notify]
command = "/abs/path/notify"       # gets each auto event as JSON on stdin; the desktop notifier if unset

[stats]                            # the swap-candidate flag
swap_min_ratified_rounds = 20
swap_precision_below = 0.5
swap_ratified_rate_below = 0.8
```

Config load checks exactly three seats, unique ids, every model id against its adapter's list, and that no model
votes twice: a fallback differs from its own primary, from every other seat's primary and from every other seat's
fallback. It warns when two seats share a model family, or a seat shares the adjudicator's.

## Reference

`doctor` takes `--config`, `--db` and `--deep`, and `stats` takes `--config`, `--db`, `--since`, `--seat`,
`--occupant`, `--json` and `--html`. Every other command (`round`, `adjudicate`, `post`, `credit`, `auto`, `ruling`
and `seats`) takes `--config`, `--db` and `--roots`, beside its own options. The store defaults to
`~/.local/share/sabotage-council/council.db` (or `SABOTAGE_COUNCIL_DB`), with round dirs in `rounds/<id>/` beside
it; roots are built under `~/.cache/sabotage-council/roots/` (or `SABOTAGE_COUNCIL_ROOTS`) as
`<store tag>-<round id>-a<attempt>` and deleted, by that name only, once the round is adjudicated. A round dir's
`round.json` is a display copy: the store decides. `sabotage-council <command> --help` prints every option.

### `doctor`

`doctor` checks Node, the config, the run store (applying pending migrations) and every seat's preflight, with no
model call. Exit 0 when nothing failed, 1 otherwise. A config with an `[auto]` table fails any Cursor seat (no Cursor
canary has run).

`doctor --deep` also runs every seat's preflight, still with no model call, against its own canary root of planted
hooks, rules and MCP config for every backend (top level and nested). Every planted hook event, MCP server and plugin
writes its own marker if anything runs it. What it proves: no planted code ran during preflight, and, for a backend
with an offline load dump (codex `debug prompt-input`, grok `inspect --json`, opencode `debug config`), that the dump
lists nothing from the root. It proves only what that dump covers (opencode's covers config sources, not instruction
files, which ratification checks per leg) and nothing about a model turn. A seat whose backend has no load dump gets
an "unproven by --deep" line (`unproven`, or `refused` when its preflight refused the planted root by a filename
scan), except claude on a version whose label is `strong` from its own recorded promotion canary: its line says
isolation is proven by that canary instead. Exit codes: `0` every seat proven (by its load dump or its canary), `1`
some seat loaded a planted file (or another doctor check failed), `2` nothing loaded but some seat is unproven by
`--deep`.

### Rounds

```sh
sabotage-council round start plan docs/PLAN.md --json   # or: round start diff [<base>..<head>] --json
                                                         # or: round start pr owner/repo#12 [--dry-run] --json
sabotage-council round wait <id>                         # blocks until the legs settle; prints JSON
sabotage-council round show <id>                         # a readable summary, any time
sabotage-council adjudicate <id> ADJUDICATION.json       # validate, store, print the effective verdict
sabotage-council adjudicate <id> --headless              # or: the engine runs a restricted Claude Code to adjudicate
sabotage-council post <id> --dry-run                     # pr: the exact review that would post, and its review sha256
sabotage-council post <id> --post --expect <sha256>      # pr: post that review, one review on the reviewed head
sabotage-council post <id> --reconcile                   # pr: settle an interrupted post: adopt what landed, or record none did
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
- `round wait <id> [--timeout <minutes>]` exits 0 when the legs settle, 1 when the round failed (or its worker
  died), and 3 when the timeout ran out first.
- `adjudicate <id> <file> [--check]` checks `ADJUDICATION.json` (plan 7.3) against the round as the store
  recorded it and stores it, once, only if every check passes; each rejection names its class (`[attribution]`,
  `[round-rule]`, ...). `--check` validates only and lists every majority override with its proof, to show before
  storing.
- `adjudicate <id> --headless [--json]` (plan 6.4, 7.2) has the engine adjudicate the round itself, with no user in
  the loop: it is what `auto` uses. It needs `[adjudicator] model` in the config. The engine copies the round's
  frozen root into a working directory, proves the copy by its tree hash, adds the inputs (`ADJUDICATE.md`, the round,
  the counted legs' answers, the ratification table, the test result) and an empty `_mainloop/ADJUDICATION.json`, and
  runs your unmodified `claude -p` there, restricted to Read, Glob, Grep and one Edit of its output file
  ([security](docs/security.md#the-headless-adjudicator) has the flags and the checks). A run that went out of bounds
  is contaminated, nothing it wrote is read, and the round is held for your ruling. Otherwise its document is stored
  through the same validator (a majority override is stored only as a `ruling`, as no one saw its proof); a rejection
  re-prompts once with the errors, and a second one holds the round (`round show` says HELD; adjudicate it
  yourself). The adjudicator's observed model, effort, tools, permission denials, cost and transcript are recorded on
  the round. Exit 0 adjudicated, 1 failed, 4 held.
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
- `post <id> --reconcile` settles a post that recorded its intent and was interrupted, and posts nothing new: a
  review of the round that landed is adopted as its post (its guards run), and when none landed that is recorded.
  Until then `ruling` will not release the round, since its review may be on GitHub; this is the way out for a held
  round whose post never landed, a closed PR's included.
- `ruling <id> <finding-id> uphold|overturn [--note]` records your ruling on a `ruling` finding (plan 3.8), and
  `ruling <id> approve|post|skip [--note]` releases a round held for your ruling: `approve` maps its review again with
  your rulings applied (upheld is owed, overturned is refuted) and lets it approve if every other gate allows;
  `post` posts that review with the approval held; `skip` posts nothing more. Every ruling finding must be ruled
  first, and `approve` is refused while one is upheld. A round that already posted its "Ruling needed" comment posts
  the release as one more review on the same head. Nothing else releases a held round, so it never turns into an
  approval on its own.
- `credit <owner/repo#num> <review-id> [--note <text>]` counts an unmarked review you vouch for as a council round
  at its own head and time (plan 3.6 step 4). A review that starts with a council or identity marker is refused:
  the marker rules decide those.

The Claude Code plugin runs this loop from a session: `/sabotage-council:council plan <file>`, `diff` or `pr
<owner/repo#num>`, then the session adjudicates by [plugin/ADJUDICATE.md](plugin/ADJUDICATE.md). For a PR it then
shows you the review `post --dry-run` renders, and posts only when you say so in your next message, with `--expect`
set to that review's hash (its event and its body): a review that changed since waits for a new go. The plugin
pre-approves only the read-only commands and `adjudicate`: Claude Code asks you to approve every `round start` and
every `post`, since a round costs money, a review is public, and the session reads the legs' untrusted answers.

### The auto-reviewer

`auto` reviews every pull request where you are requested as a reviewer, one council round per new head, adjudicated
by the restricted headless adjudicator, and posts one review per round as you (plan 9.4). It needs `[github] login`,
`[adjudicator] model` and an `[auto]` table whose `repos_allow` names the repositories it may touch: an empty list
allows nothing, and a search result outside it is dropped before anything about that PR is read.

The shadow mode is `auto run --dry-run`: every pass renders its reviews and posts nothing. `auto install` creates the
daemon's log dir (`auto/` beside the store, mode 0700) before it writes and loads the service.

- **Queue.** GitHub's search for open, non-draft PRs with a review requested from you (`review-requested:@me`, which
  includes your teams; `auto.include_team_requests = false` keeps direct requests only; `include_assigned = true`
  adds `assignee:@me`), narrowed to the owners `repos_allow` names. Your own PRs, drafts and `repos_skip` are
  skipped. After your review clears the request, a PR stays in scope while your latest review of it is a change
  request, a comment, or a dismissed approval, so later pushes get delta rounds (at most 20 such PRs read per pass,
  in turn). A head you already reviewed (by any store, or by hand with a marker) is not reviewed again, and the last
  read before each POST checks once more: a review of yours with the round's marker already on the head is adopted
  when it is the very review the post would send, else nothing posts. Two stores on one account are serialized only
  by that read. A PR made a draft while its round ran gets no review until it is ready again.
- **One row per head.** Each head is claimed (owner, heartbeat; a dead daemon's claim is taken over), numbered once
  by its first claim from the reviews read before it, and gets two attempts: a failed round is retried with a new
  round, a failed adjudication by re-running only the adjudicator. A round is linked to its row as it is created, so
  a crash never leaves a second round for the head. Before a review posts, the row records a hash of the round's
  records and the review it means to post; after a crash, the next pass adopts the review that landed, or posts that
  same review only while the records still hash the same, or fails visibly; it holds the round's post claim from that
  reconciliation to the re-post, so a post of yours by hand cannot slip in between. A post refused because another
  post of the round holds its claim keeps the row waiting for the next pass, which adopts that post if it landed. A
  row whose repository left `repos_allow` is still reconciled that way, and nothing new posts there.
- **Holds and rulings.** `repos_hold` posts but never approves; your own change request on the head, a ruling the
  adjudicator asks for, or an adjudicator run that went out of bounds holds the row for `ruling`. A release waits
  while a post of the round may be on GitHub (the next pass reconciles it first; for a round you posted by hand,
  `post <id> --reconcile`), and a dry run's round is never released. The CI gate and the post's guards are `post`'s
  (above). On a private repository of a free GitHub plan, which has no branch protection or rulesets (GitHub answers
  403 "Upgrade to GitHub Pro ..."), no check can be required, so every reported check is judged and the review says
  so; any other refusal leaves CI unknown and holds the approval.
- **Opt-in tests.** `[auto.tests."owner/repo"]` (`setup`, `command`, `timeout_minutes`) runs only for PRs whose
  author has write access and whose head is in the same repository, never a fork, on a copy of the head outside the
  review root, with only PATH, LANG, LC_ALL and TZ from your environment. The result, with the tails of its output
  and its errors, goes to the adjudicator; only a PASS lets the round approve. It runs the PR's code on your machine
  ([security](docs/security.md#running-pr-code-opt-in-tests)).
- **Notifications** on a needed ruling, a final failure, an approval held, an approval withdrawn, and a pass lock
  another pass keeps holding: to `notify.command` (an executable that gets the event as JSON on stdin) or the
  desktop, once per PR head and kind per 24 hours, a dry run's apart from the real ones.
- **One pass at a time.** A pass holds a lease in the store with a heartbeat, refreshed around every git and `gh`
  process even while synchronous work holds the event loop; a lease whose heartbeat is 10 minutes old is taken over,
  whatever its pid or host, and a takeover never removes a fresh owner's lease. A round whose preparing pass still runs
  on this machine is never failed for it. `auto pause` stops a running pass at its next round.
- **Limits.** `max_rounds_per_day` (30) council rounds in any 24 hours, resumed rows included; on macOS each round
  runs under `caffeinate -i`. Round dirs older than 90 days and failed rounds' roots older than 2 days are pruned;
  rows of closed PRs retire.

### The scorecard and the seats

```sh
sabotage-council stats [--since 30d] [--seat a] [--occupant codex:gpt-6.1-sol[:high]] [--json] [--html report.html]
sabotage-council seats list [--no-preflight] [--json]
sabotage-council seats test <seat-id | backend:model[:effort]> [--fallback] [--timeout <min>] [--json]
sabotage-council seats swap <seat> --backend X --model Y [--effort E] [--dry-run]
sabotage-council seats add <seat> --backend X --model Y [--effort E] [--dry-run]
sabotage-council seats remove <seat> [--dry-run]
```

`stats` reads the run store and never changes its contents or schema: it opens the store read-only and never migrates
it (on Node 22.13 and 22.14 SQLite leaves its `-wal` and `-shm` files beside a closed store; see `seats list` below).
A store whose schema is behind this build is refused with the command that upgrades it
(`sabotage-council doctor --db <path>`), and one written by a newer build is refused too. It scores every seat and
every occupant (a backend, model and effort) over a window: all history by default; `--since` takes `30d`, `12h`,
`2w`, `90m`, a UTC date or an ISO timestamp. `--seat` and `--occupant` choose which rows are shown; every metric still
reads every seat's legs. With no store or an empty window it says so and exits 0.

Which rounds count:

- council rounds whose legs settled, dry runs included (the shadow mode is all dry runs), and failed, solo, awaiting
  and superseded rounds for the leg metrics; finding metrics read only adjudicated rounds (a stored verdict);
- identity rounds have no legs and are left out, and so are rounds still running and any leg still `RUNNING`;
- a fallback leg counts for its seat and for its own occupant, never for the seat's primary occupant;
- an occupant that holds two seats in a round (two kiro seats on one model with two logins) has every ratified leg
  counted on its card; a finding both legs raised is one finding, unique to it when no other occupant raised it; its
  position for dissent and agreement is the one its legs share, and none in a round where they differ;
- `seats test` runs are never rounds (see below).

The metrics (plan 8.2), as built:

| Metric | Definition |
|---|---|
| Rounds seated, ratified rate | Rounds with at least one leg of the seat (a launch, or a primary that failed preflight); ratified rate = rounds with a ratified (`PASS`) leg / rounds seated. A seat skipped by the untrusted-PR policy has no leg and is not seated. |
| Failure mix | Failed legs per failure class, over every attempt. Fallback used: seated rounds with a `fallback` leg (for an occupant: rounds it sat as a primary and its seat moved to the fallback, over the rounds it sat as a primary). Relaunch: rounds with a leg at attempt 2 or later (the same seat and role launched again); a fallback is the `fallback` role at attempt 1, so the two are told apart by role and attempt. |
| Verdict mix | The raw verdict of each ratified leg: SHIP, SHIP-WITH-FIXES, NEEDS-WORK, none. |
| Raised, adopted, refuted, precision | Raised: canonical findings the seat was a source of (counted once). Adopted = owed + follow-up + ruling upheld; refuted = refuted + ruling overturned; a ruling not yet ruled on is pending; nits and noted findings are neither. Precision = adopted / (adopted + refuted), n/a when both are 0. |
| Unique adopted, owed, HIGH | Raised by this seat alone (every source leg is its own). Uniqueness counts raisers, not severities: a finding two seats raised at different severities is unique to neither. Owed includes an upheld ruling. Unique HIGH: unique, adopted, and HIGH by the adjudicator's final severity (a seat's own HIGH label earns nothing). |
| Drop-one | Blocking findings lost: owed rows and holding rulings (unruled or upheld) the seat raised alone. Flipped to SHIP: rounds whose stored verdict was not SHIP, whose every blocking finding it raised alone, and that kept quorum (2 ratified legs) without it; a stored SHIP with a held ruling is never a flip. A round whose other legs had fewer than 2 ratified is counted as quorum lost, never as a flip. |
| Dissent | NEEDS-WORK vs not, on the raw verdict: SHIP and SHIP-WITH-FIXES are one position (only NEEDS-WORK blocks a round). A lone dissent: its position differed from the two other ratified legs, which agreed. Right: a lone NEEDS-WORK in a round that ended blocked or with one of its own findings owed, or a lone SHIP or SHIP-WITH-FIXES in a round that ended with nothing blocking. (The plan first said SHIP vs not; the council chose this axis in round 1 of P9, so a SHIP-WITH-FIXES whose findings became follow-ups is no dissent from two SHIPs.) |
| Cost, duration | USD and credits summed over every leg (failed attempts cost too); units are never converted. Quota is the CLI's own rate-window snapshot, shown as the highest and the latest. p50 and p90 are nearest-rank percentiles of ratified legs' durations. Cost per adopted finding: the seat's USD (or credits) in adjudicated rounds / adopted findings in them; n/a unless one of its legs in an adjudicated round recorded that unit. |
| Agreement | Per pair of seats (and of occupants): settled rounds where both ratified with a verdict, and how many of them one said NEEDS-WORK and the other did not. |

A seat is a **swap candidate** (plan 8.3) when its unique owed count is 0 and either its ratified rate is below
`swap_ratified_rate_below` over at least `swap_min_ratified_rounds` rounds seated (a seat that fails every attempt is
flagged, its failures the evidence), or its precision is below `swap_precision_below` over at least that many
adjudicated rounds it ratified in. The flag judges the seat's **current occupant**: the config's, else the one the
latest round seated, over the rounds since it took the seat (from the first round whose roster snapshot seats it
there after a different one). So a swap starts the evidence over, and the reasons name the occupant. The seat's
fallback legs in those rounds count; changing only the fallback starts nothing over. A precision of n/a (nothing
adopted or refuted) is reported as inconclusive, with the rounds, the findings raised and the blocking findings lost,
and is not flagged (that is the owner's call). Every flag lists the rounds and findings behind it. Nothing ever swaps
a seat by itself.

`--json` prints the report with `"schema": "sabotage-council.stats"` and `"version": 1`. Top-level keys: `schema`,
`version`, `generated_at`, `window` (`since`, `first_round_at`, `last_round_at`, `rounds` counts, `adjudicator_usd`),
`filters`, `thresholds`, `message` (set when there is nothing to score), `notes`, `seats` and `occupants` (one card
each: `rounds_seated`, `rounds_ratified`, `ratified_rate`, `adjudicated_ratified`, `failures`, `verdicts`,
`findings`, `unique`, `drop_one`, `dissent` (each lone round's `said` is `blocks` for NEEDS-WORK or `clears`),
`cost`), `agreement` (`seats`, `occupants`), `recommendations` (per seat: `swap_candidate`, `eligible`, `occupant`
(the occupant judged, where it came from, and the round it took the seat), `reasons`, `evidence`) and `seat_tests`. A
field may be added within a version; a renamed, removed or redefined field bumps it. Ratios are 0 to 1, or null when
their denominator is 0. DEL, C1, U+2028, U+2029, bidi controls and zero-width characters inside strings are written
as `\uXXXX` escapes; the text and HTML forms replace them (and control characters) with U+FFFD.

`--html <file>` writes the same report as one self-contained file (no script, font, image or link; light and dark;
readable at phone width), with mode 0600. Everything in it that came from a round is escaped. A path that exists and
is not a regular file is refused. Its agreement matrix shows every pair a filtered report keeps.

`seats list` shows each seat and its fallback with the enforcement label its preflight gives (as `doctor` shows it;
no model call) and a one-line scorecard, whose flag judges the config's occupant. It reads the store as `stats` does.
On Node 22.13 and 22.14 both read a closed store through a plain read-only connection, which leaves SQLite's `-wal`
and `-shm` files beside it (its contents unchanged); from Node 22.15 a closed store is opened immutable.

`seats test` qualifies an occupant before it is seated: it runs **one paid leg** on the planted-defect fixture that
ships in the package (three defects planted in a small Python module), on a root built the normal way, and reports
which defects it found, ratification, verdict, cost and duration. A finding names a defect when its path is
`calc/rangesum.py` at the head (with or without the root's `planted/` prefix, never the `_base/` copy) and its line is
the defect's changed line, or its title holds more of that defect's keywords than of any other's. It prints what it
is about to run first (on stderr with `--json`, whose stdout is only the JSON). Ctrl-C before the launch starts
nothing; a setup failure prints an error and exits 1, recording nothing. Exit 0: ratified and found every defect; 2:
ratified but missed one; 1: did not ratify or did not run. It works for an occupant that is not in the config; a model
id holding a `:` (`opencode:ollama/llama3:8b`) is read whole when the adapter lists it, and a spec that reads two
listed ways is refused. Its result is stored as a `seat-test` event with no round, so no scorecard metric counts it;
`stats` lists seat tests on their own.

`seats swap | add | remove` edit the config file. They change only the target seat's own `[[seats]]` block and keep
every other byte (comments, order, other sections), except that `remove` also takes the blank line that separated the
removed block from its neighbour (the one after it, or the one before it when the block ends the file), so a remove
and an add do not grow the file. The edited text must pass the config loader first: seats are fixed at three (D10),
so `swap` replaces an occupant, `add` works only on a file with two seats and `remove` only on one with four. A swap
keeps the seat id (and its fallback), so the history stays under that seat, and the new occupant gets its own row at
its first leg. A timestamped backup (mode 0600) is written beside the file before it is replaced atomically, keeping
its exact mode; `--dry-run` prints the diff and writes nothing. A file whose seats are written as an inline array, or
a `[seats.x]` sub-table, is refused, never rewritten.

## Development

Requirements: Node.js 22.13 or later (the run store uses the built-in `node:sqlite`, which needs no flag from 22.13),
npm, macOS or Linux.

```sh
npm ci            # install the locked dependencies
npm test          # run the tests (vitest)
npm run lint
npm run typecheck
npm run build     # compile to dist/
```

Then `node dist/cli/index.js doctor` runs the build you just made: it checks Node, the config, the run store (applying
pending migrations) and every seat's preflight, with no model call. CI runs lint, typecheck, test and build on Ubuntu
and macOS, on Node 22.13.0, the newest 22 and 24.

## License

MIT, copyright Sabotage Development LLC. See [LICENSE](LICENSE).
