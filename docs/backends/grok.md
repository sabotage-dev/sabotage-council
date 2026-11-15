# Grok CLI (`grok`)

xAI's Grok Build CLI, run headless. Label: **`weak`** with `sandbox = "off"` (the only measured configuration),
`pending` with the read-only sandbox running. Back to [all backends](README.md).

**A grok seat fails if its grok home's config starts any MCP server:** preflight refuses the seat, so `doctor` and
every round do. If your own grok config starts one, either give the seat an `auth_home` (its own grok home, a
directory logged in once with `GROK_HOME=<dir> grok login`, holding no MCP config) or choose another seat.

| | |
|---|---|
| Binary | `$GROK_HOME/bin/grok` (default `~/.grok/bin/grok`) when it exists, else `grok` on `PATH` |
| Tested version | 1.0.70 (floor 1.0.70) |
| Sign-in | your grok login, a separate login in the seat's `auth_home`, or `XAI_API_KEY` |
| Models | `grok models` for your account (the adapter knows `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`) |
| Effort | required: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| Enforcement label | `weak` with `sandbox = "off"`, with an MCP server, or on an untested version; `pending` with `sandbox = "read-only"` on 1.0.70 (no such leg has been recorded) |

## Install and sign in

Install the Grok CLI by xAI's own instructions, at version 1.0.70. A seat signs in one of three ways, picked in this
order:

1. **`auth_home`** (recommended): the seat's own grok home, a directory you log in to once with
   `GROK_HOME=/abs/dir grok login`. The leg runs with `GROK_HOME` there, so your own `~/.grok` is never touched, and
   its config holds no MCP server unless you add one. `XAI_API_KEY` is not passed to such a leg.
2. **`XAI_API_KEY`**: the leg runs on its own empty grok home.
3. **Your own login**: the leg runs with your grok home (`GROK_HOME`, else `~/.grok`).

The adapter checks the sign-in with `grok models` under the leg's environment; without one, preflight says
`run GROK_HOME=<home> grok login` (or `grok login`, or set `XAI_API_KEY`). A leg that waits 90 seconds without
starting (a sign-in prompt) is killed and classified `auth`.

**MCP servers.** Servers in a grok config start inside the leg even when no tool can reach them (measured: a
`context7` server started through `npx`, a process with network). So a leg that starts an MCP server fails, and
preflight refuses a seat whose grok home lists one (`grok inspect` names them). If your own grok config has MCP
servers, give the seat an `auth_home` or choose another seat. (`XAI_API_KEY`, whose leg runs on an empty grok home,
and disabling the servers in your own grok config also work.) The engine never edits your grok config.

## A seat in the config

```toml
[[seats]]
id = "c"
backend = "grok"
model = "grok-4.7"
effort = "high"
sandbox = "off"                     # "read-only" where grok's sandbox starts (see below)
auth_home = "/abs/path/grok-home"   # optional: a separate grok login, logged in once
```

`auth_home` must be an existing absolute directory, and must not be your own grok home. `grok-4.7` is served as
`grok-4.7-build`, which ratifies as the same model; `grok-4.7-build-fast` must be pinned by its own name.

**The sandbox.** `sandbox = "read-only"` (the default) runs grok's `--sandbox read-only`, which refuses to start on a
Mac whose Docker Desktop socket (`/var/run/docker.sock`) is a symlink. Preflight detects that and says to set
`sandbox = "off"`. With `off`, the read-only tool allowlist is the only enforcement and the label is `weak`. A
fallback table has no `sandbox` key, so a grok fallback always runs read-only and fails preflight on such a Mac.

## What a leg runs

```sh
grok --prompt-file <brief> --cwd <root> -s <uuid> -m <model> --effort <effort> \
  --output-format streaming-messages-json --permission-mode dontAsk --tools read_file,grep,list_dir \
  --disallowed-tools <every other tool name> --deny Bash --deny Edit --deny Write --deny MCPTool --deny WebFetch \
  --disable-web-search --no-subagents --no-plan --no-memory --no-auto-update --no-wait-for-background \
  --sandbox <read-only|off>
```

Each leg gets its own empty `HOME`, so Claude Code compatibility (your `~/.claude` instructions, plugins, hooks, MCP
servers and permission rules) never loads; `GROK_HOME` is chosen as above. The environment holds only `PATH`,
`USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `XAI_API_KEY` (not on the `auth_home` route),
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables, plus `GROK_DISABLE_AUTOUPDATER=1`, `GROK_MEMORY=0`,
`GROK_SUBAGENTS=0`, `GROK_WEB_FETCH=0` and `NO_COLOR=1`.

## What `weak` means

The tool allowlist works: measured on 1.0.70, a leg is offered exactly `read_file`, `grep` and `list_dir` (a deny
list alone would be a silent no-op, since tool names differ between grok's internal backends). But reads are not
confined to the root: in the 1.0.70 canary, a read outside the root by path, a read through a symlink and a grep
outside the root all ran under `dontAsk` with no denial. Ratification caught each one (every read path is audited from
the session record and the leg is `contaminated`), but only after it ran. So grok is never `strong` in this
configuration, and on a pull request from an author without write access a grok seat follows
`council.untrusted_seat_policy`.

## Preflight and `doctor`

`doctor` shows which grok home each seat uses (`auth_home`, `login` or `api-key`), then checks: the occupant, the
home, `grok --version`, the version, the sandbox (the Docker socket), the sign-in, the model and its effort menu
(from `models_cache.json`; a warning when the menu is missing), and `grok inspect --json` under the leg's
environment: no project instructions, hooks, plugins, permission rules or MCP servers.

`doctor --deep` reads the same `grok inspect` dump on a root of planted files. Measured on the owner's machine with
1.0.70, grok failed it: its `inspect` listed the planted project `.grok/config.toml`. The review root moves every
`.grok/` directory into a quarantine before a leg starts, so a real leg never sees one, but `--deep` reports the CLI
as it is.

## Failures and fallbacks

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | status 402, "Payment Required", "usage balance exhausted" |
| `auth` | "Not signed in", status 401 or 403, an external auth provider failure, reauthenticate; a start that stalls 90 s |
| `model` | "Couldn't set model", unknown model id, model not found or unavailable |
| `capacity` | at capacity due to high demand, status 5xx or 429, rate limit |
| `timeout` | `error_max_turns`, the wait for background work ran out |
| `transport` | connection reset or refused, socket hang up, the output limit |
| `setup` | a sandbox profile it could not apply, refusing to start with its protections missing, bad arguments; an MCP server that started |

Cost is recorded in USD from the session's usage record.

## Known gaps

- No leg with the sandbox on has been recorded (on the measuring Mac it refuses to start), so the `pending` label for
  `sandbox = "read-only"` is a placeholder, not a measured result.
- No configuration that stops reads outside the root before they run has been measured.
- A grok fallback cannot set `sandbox = "off"`.
