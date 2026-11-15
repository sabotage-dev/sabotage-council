# Claude Code (`claude`)

Anthropic's Claude Code, run headless (`claude -p`). Label: **`strong`** on the tested versions. Claude Code is also
the adjudicator (your session interactively, `claude -p` headless in `auto`). Back to [all backends](README.md).

| | |
|---|---|
| Binary | `claude` on `PATH`, your own unmodified install |
| Tested versions | 2.1.322, 2.1.323, 2.1.325 (floor 2.1.322: older versions are refused) |
| Sign-in | your Claude Code login, `ANTHROPIC_API_KEY`, or the Bedrock or Vertex route |
| Models | the adapter's table: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-2`, ... |
| Effort | required: `low`, `medium`, `high`, `xhigh` or `max` |
| Enforcement label | `strong` on 2.1.322, 2.1.323 and 2.1.325; `pending` on any other version |

## Install and sign in

Install Claude Code by Anthropic's own instructions and sign in (`claude auth login`), or set `ANTHROPIC_API_KEY`.
The adapter checks with `claude auth status --json` and reads only whether you are logged in, the method and the
login's expiry (never an email or organisation). With `ANTHROPIC_API_KEY` set, every Claude leg runs `--bare`.

Claude Code updates itself. A version outside the tested list gets the label `pending` and a warning, and on a
subscription login with any plugin enabled, preflight refuses the seat (plugins could add tools to the leg) and
names the way out: set `ANTHROPIC_API_KEY` so the leg runs `--bare`, or use a tested version. Each leg sets
`DISABLE_AUTOUPDATER=1`; an update made outside a leg (by your own sessions) still moves the version.

## A seat in the config

```toml
[[seats]]
id = "b"
backend = "claude"
model = "claude-sonnet-5-5"
effort = "high"
```

Claude Code has no offline model list, so the adapter keeps a table of the ids it accepts (`claude-fable-5-2`,
`claude-fable-5-1`, `claude-fable-5`, `claude-mythos-5-2`, `claude-mythos-5-1`, `claude-opus-5-5`, `claude-opus-5`,
`claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`,
`claude-haiku-5-5`, `claude-haiku-4-5`); the leg's own record is the proof of the model that ran. A recorded id with
a date suffix or a context tag (`[1m]`) still matches its pin.

The config warns when a Claude seat shares the adjudicator's model family: the adjudicator is always Claude Code,
and two judgements from one family are less independent.

## What a leg runs

```sh
claude -p --output-format stream-json --verbose --model <model> --effort <effort> --restricted \
  --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep --strict-mcp-config \
  --setting-sources "" --settings <leg dir>/settings.json --session-id <uuid> [--bare] \
  --allowedTools Read Glob Grep --disallowedTools <every non-read built-in tool>
```

The brief goes on stdin, the working directory is the review root, and the leg's settings file (outside the root)
sets `permissions.blockReadsOutsideWorkingDirectories`. The environment holds only `PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`,
`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE` and the proxy variables, plus `DISABLE_AUTOUPDATER=1` and `NO_COLOR=1`; values are passed by name and
never read, logged or recorded.

Why these flags (each measured on 2.1.322):

- without `--tools`, a headless run is offered scheduling, messaging, worktree and workflow tools and inherits your
  default permission mode (such as `auto`);
- `--setting-sources ""` (any set without `user`) drops every installed plugin, its tools and your hooks, while
  your login still works; only managed (policy) settings still apply, and `doctor` lists them as user-owned;
- `--bare` (with an API key) also drops plugins, hooks and `CLAUDE.md` discovery, but it accepts only an API key,
  never an OAuth login.

As soon as the stream's `system/init` appears, the engine checks it: a leg offered anything beyond Read, Glob and
Grep, or not in `dontAsk`, is killed (SIGKILL) before its first turn can run a tool.

## What `strong` means

On 2.1.322, 2.1.323 and 2.1.325 the promotion canary ran once each (with claude-haiku-5-5 at low effort, under a
cent each): with an allow rule for reads anywhere, Bash, Write and WebFetch planted in a settings file, the leg was
asked to read a file outside the root by path and through a symlink, to Grep and Glob outside it, to write, run a
command and fetch. Write, Bash and WebFetch were not offered; every outside Read, Grep and Glob was denied before it
ran (`--restricted` confines all three to the working directory) and is in `permission_denials`; the secret never
reached the stream or the transcript, no file was created, and the root's hash was unchanged.

So a Claude seat on a tested version can sit a round on a pull request from an author without write access, and is
the natural fallback for the other seats under the default `untrusted_seat_policy = "fallback"`.

## Preflight and `doctor`

`doctor` checks: the occupant (model id and effort), `claude --version`, the version (tested, untested with a
warning, or below the floor), the sign-in, the model against the table, and isolation (`--bare` with a key; the
measured settings-source isolation on a tested version; on an untested version, `claude plugin list --json` must show
no enabled plugin). A note lists what stays user-owned: managed (policy) settings.

`doctor --deep` has no offline load dump to run for claude: on a tested version its line says isolation is proven by
the recorded promotion canary instead.

## Failures and fallbacks

| Class | Signatures the adapter matches (stderr, the result's error status and subtype) |
|---|---|
| `usage_limit` | usage limit, limit reached, spend cap, "credit balance is too low", status 402, `error_max_budget_usd` |
| `auth` | status 401 or 403, `authentication_error`, invalid API key, OAuth token expired, "please run /login", not logged in |
| `model` | `unrecognized_model`, "issue with the selected model", `not_found_error`, status 404 |
| `capacity` | overloaded, status 529 or 429, rate limit |
| `timeout` | `error_max_turns`, maximum number of turns |
| `transport` | connection reset, refused or timed out, socket hang up, fetch failed |
| `setup` | "Input must be provided", an unknown option, invalid settings, the init gate firing |

A Claude subscription has usage windows: give a Claude seat a fallback on another login or an API key for
`usage_limit` and `auth`. The leg's cost in USD is recorded from the result line and shown by `stats`.

## Terms

The engine shells out to your unmodified `claude` binary, which uses whatever you signed in to; it never reads,
stores or forwards that login (D15), and it does not embed the Agent SDK on a subscription login. Anthropic's terms
allow you to sign in to the unmodified Claude Code binary with your own subscription; they do not permit a
third-party product to route requests through a consumer plan on your behalf. Heavy `auto` use is not "ordinary,
individual usage" for consumer plan limits: for `auto`, use `ANTHROPIC_API_KEY` or a Team or Enterprise plan, for the
seats and for the headless adjudicator.

## Known gaps

- A version outside 2.1.322, 2.1.323 and 2.1.325 is `pending` until its own canary runs; Claude Code updates often.
- No recorded run uses the Bedrock or Vertex route; the adapter passes their variables through, but its model table
  holds first-party ids only.
