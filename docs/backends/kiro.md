# Kiro CLI (`kiro-cli`)

AWS's Kiro CLI, run over ACP on its v2 engine (`kiro-cli acp --agent-engine v2`). Label: **`pending`**. Back to
[all backends](README.md).

| | |
|---|---|
| Binary | `kiro-cli` on `PATH` |
| Tested version | 3.2.1 (floor 3.2.1) |
| Sign-in | your Kiro login (Builder ID or IAM Identity Center), a separate login in the seat's `auth_home`, or `KIRO_API_KEY` |
| Models | your account's `kiro-cli chat --list-models` (the adapter knows `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.7`, `deepseek-3.2`, `glm-5`, `qwen3-coder-next` and more) |
| Effort | `low`, `medium`, `high`, `xhigh` or `max`; leave it unset for models with no effort levels (`glm-5`, `deepseek-3.2`, `qwen3-coder-next`, `claude-haiku-4.5`) |
| Enforcement label | `pending` |

## Install and sign in

Install the Kiro CLI by AWS's own instructions, at version 3.2.1 (releases are weekly and sometimes breaking). Then
sign in one of three ways:

- **Your own login**: `kiro-cli login`. kiro-cli runs with your `HOME` and reads its token store there.
- **`auth_home`**: a separate login of the seat's own (for example a personal account beside a work one). kiro-cli
  then runs with `HOME` set to that directory. Log it in once with `HOME=/abs/dir kiro-cli login`. `doctor` shows which
  home and which credential each seat uses. With `auth_home` set, `KIRO_API_KEY` is not passed to the leg.
- **`KIRO_API_KEY`**, used when the seat has no `auth_home`.

Preflight reads the token store's expiry and whether a refresh token exists (never a token's value), then proves the
sign-in with `kiro-cli chat --list-models` under a 30 second cap. An expired login opens a browser and waits about 10
minutes; the engine kills the process the moment kiro-cli prints "Opening browser" (or asks to continue to the
browser) and classifies it `auth`. The fix it prints is `run kiro-cli login with HOME=<home>`.

## A seat in the config

```toml
[[seats]]
id = "a"
backend = "kiro"
model = "gpt-5.6-sol"
effort = "high"
auth_home = "/abs/path/kiro-home"   # optional: a separate Kiro login
```

`auto` routes per request and is refused as a council pin. Two kiro seats on the same model with two different
`auth_home` logins are two occupants; two declared logins that resolve to one token store are refused.

## What a leg runs

```sh
kiro-cli acp --agent-engine v2 --agent sabotage-council --model <model> [--effort <effort>]
```

Never `--trust-tools` or `--trust-all-tools`. Each leg gets its own `KIRO_HOME` holding only the council agent
profile: read tools `fs_read`, `grep` and `glob`; no allowed tools; shell, writes, web fetch and web search denied; no
resources, hooks or MCP servers, and `includeMcpJson: false`. So your own steering, hooks, MCP config and other
agents never reach a leg. The engine pins the v2 engine because kiro falls back to v3 when no v2-only flag is given,
and v3 reports no model before a turn.

The engine is the ACP client: it declares no filesystem or terminal capability, opens the session in the review root
with no MCP servers, checks that kiro reports the council agent and the pinned model before sending the prompt, and
rejects every permission request except a read whose every path is inside the root by realpath. The environment
holds only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `KIRO_API_KEY` (not with
`auth_home`), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables, plus `HOME`, `KIRO_HOME`, `NO_COLOR=1`
and `TERM=dumb`.

## What `pending` means

The P3 canary (kiro-cli 3.2.1, a separate personal login, run twice) found: reads inside the working directory run
with no permission request; a read outside the root by path, a read through a symlink and a search outside it each
asked, and the client rejected them before they ran. But with an allow rule planted in the leg's profile (allowed
tools and an `fs_read` path of `/**`), preflight refused the leg; launched anyway, kiro read the outside file and the
symlink with no request and the secret reached the stream, caught only at ratification. So the profile check at
preflight is the guard, not the client. Write, command and fetch were not attempted, and kiro records no offered tool
set. Until those are measured, kiro stays `pending`, and on a pull request from an author without write access it
follows `council.untrusted_seat_policy`.

Every leg is ratified from `$KIRO_HOME/sessions/cli/<session>.json`: one record, the root as its directory, the
council agent, the pinned model on every turn, the pinned effort (or none), and no trusted tools, write paths or
allowed commands. Credits come from its `metering_usage`.

## Preflight and `doctor`

`doctor` prints each kiro seat's home (`auth_home` or your `HOME`) and credential (`auth_home store`, `user HOME
store` or `KIRO_API_KEY`), then checks: the occupant, the home, the token store, `kiro-cli --version`, the version,
the sign-in (`chat --list-models`), the account's usage limit, the model in the account's list, and isolation (no
rule is laid over the council profile, whose sha256 is printed, and the root holds no `.kiro/` or `AGENTS*.md` at
its top level). There is no offline proof over ACP of what a leg loads, so `doctor --deep` reports kiro as
"unproven by --deep".

## Failures and fallbacks

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | "Monthly request limit reached", "enable overages to continue", "The limits reset on", insufficient credits |
| `auth` | "Opening browser", "Auth portal timed out", "OAuth error", "Not logged in.", "You are not logged in", an expired token or session |
| `model` | failed to set model, model not found or not available, invalid model |
| `capacity` | "Kiro is having trouble responding", dispatch failure, retries, throttling, too many requests, ServiceUnavailable |
| `transport` | connection reset or refused, socket hang up, exited before answering |
| `setup` | exit codes 3 (a required MCP server did not start) and 4 (the agent is unavailable on the engine), no agent with that name, falling back, tool approval required, bad arguments |

A monthly request limit ends a Kiro seat until the month resets: give it a fallback on another backend for
`usage_limit` and `auth`.

## Known gaps

- The offered tool set: kiro records none, and the canary saw no write, command or fetch attempt.
- The effort field on a model that has effort levels: the measured runs used a model with none.
- No recorded run uses `KIRO_API_KEY`; the measured runs used a separate personal login (`auth_home`).
