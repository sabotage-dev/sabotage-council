# Muse Code (`muse`)

Meta's Muse Code, run headless (`muse exec --json`). Label: **`weak`**: no logged-in model run has been recorded
(owner ruling for P4), so everything about a real leg is unmeasured. Back to [all backends](README.md).

| | |
|---|---|
| Binary | the native binary the `muse` launcher records (in `~/.sabotage-council/tools/muse/bin` or `~/.local/bin`, by its `.muse-version`), else that launcher, else `muse` on `PATH` |
| Tested version | 1.4.15 (floor 1.4.15) |
| Sign-in | your `muse login` session, or `META_API_KEY` (pay-as-you-go) |
| Models | the adapter's list: `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`, `muse-wonder-1.0`, `muse-ember-1.0`; contributor-mode variants are refused |
| Effort | required: `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra` (`none` is refused by the provider) |
| Enforcement label | `weak` |

## Install and sign in

Install Muse Code by Meta's own instructions, at version 1.4.15, and sign in with `muse login`, or set
`META_API_KEY`. When `META_API_KEY` is set it wins over your stored login and bills pay-as-you-go, not your
subscription; `doctor` says which one each seat uses (a warning when it is the key). The adapter checks a login with
`muse usage`; without one, preflight says `run muse login, or set META_API_KEY`.

The adapter calls the native binary by path when the launcher has recorded one, which skips the launcher's update
check and its use of `HOME`.

## Terms: contributor mode is always off

Muse's contributor mode is on by default for subscriptions and lets Meta train on the code a session reads. Every
council leg runs with `--contributor-mode off` and `MUSE_CONTRIBUTOR_MODE=0`, and a contributor-mode model variant is
refused as a seat ("council seats run with contributor mode off").

## A seat in the config

```toml
[[seats]]
id = "c"
backend = "muse"
model = "muse-spark-1.3"
effort = "high"
```

Muse has no offline model list, so the adapter keeps one; the leg's record is the proof of the model that ran.

## What a leg runs

```sh
muse exec --json --session-id <uuid> --workspace <root> --permission-profile :read-only --disable-write \
  --disable-shell --disable-web-tools --disable-request-user-input --disable-reminders \
  --no-foreign-personal-context --contributor-mode off --max-model-steps 80 -c agents.execution_capacity=1 \
  --model <model> --reasoning-effort <effort> --prompt-file <brief>
```

Never `--trust-workspace` (it would load project rules, skills and hooks, and hooks run outside the sandbox; an
untrusted workspace still runs headless, measured), `--yolo`, `--disable-sandbox`, `--disable-approval`,
`--no-session-log` or `--allow-workspace-switch`. `--permission-profile` cannot be combined with `--sandbox-network`
or `--approval-judge`, so neither is passed. Each leg runs with its own `HOME`, `XDG_CONFIG_HOME` (holding only
`{"schema_version": 1}` as its settings) and `XDG_DATA_HOME`, reads your login through `MUSE_AUTH_PATH`, and sets
`MUSE_NO_AUTO_UPDATE=1` and `MUSE_LOGIN=0`. The environment holds only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`LANG`, `LC_ALL`, `LC_CTYPE`, `META_API_KEY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables, plus
those above. After the leg, `muse export --session <id>` (offline) writes the session export the ratifier reads.

## What `weak` means

Muse's flags were checked against `muse exec --help` and offline runs with its echo provider; no logged-in run shows
what a real leg's records hold (its model, effort and tool fields, and which side-effect intents a read records).
The read-tool list the ratifier accepts (`read_file`, `list_dir`, `grep`, `glob`) is unmeasured. There is no offline
dump of what a leg loads. On a pull request from an author without write access a muse seat follows
`council.untrusted_seat_policy`.

## Preflight and `doctor`

`doctor` checks: the occupant (no contributor variant, a declared model, a valid effort), `muse --version`, the
version, the credential (`muse usage`, or the key), and that the root holds no `.muse/`, `.agents/`, `.claude/`,
`.codex/`, `.mcp.json`, `AGENTS*.md`, `CLAUDE.md` or `MEMORY.md` at any depth. `doctor --deep` reports muse as
"unproven by --deep".

## Failures and fallbacks

None of these texts comes from a logged-in run:

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | `tierLimit`, usage limit, limit refreshes, billing not configured, billing error, status 402 |
| `auth` | not logged in, `authRequired`, `invalid_api_key`, `authentication_error`, a download rejected with 401 |
| `model` | `model_not_found`, unknown model, a model it rejects |
| `capacity` | rate limit, 429, `service_overloaded`, `backend_unavailable`, `gateway_timeout` |
| `transport` | could not reach, connection reset or refused, socket hang up |
| `setup` | flags that cannot be combined, a malformed or unsupported settings file, exit code 2, a usage message, "muse is available to Meta employees" |

## Known gaps

- Everything about a logged-in leg (above); muse stays below `strong` in v1 whatever a canary would show.
- Muse 1.4.15 does not record the effort, the contributor mode or the permission profile in the session, so none of
  them is ratified from the record (the ratifier accepts their absence for that version); it checks the launch flags
  instead. Muse records no offered tools either.
