# Antigravity CLI (`agy`)

Google's Antigravity CLI, run over ACP (`agy acp`, the documented client route). Label: **`pending`**. Back to
[all backends](README.md).

| | |
|---|---|
| Binary | `agy` on `PATH` |
| Tested version | 1.5.7 (floor 1.5.6) |
| Sign-in | your Google sign-in (the CLI's keyring), or `GEMINI_API_KEY` |
| Models | your account's `agy models` list (the adapter knows `gemini-3.8-flash`, `gemini-4-argon`, `gemini-4-carbon`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`) |
| Effort | required: the thinking level `low`, `medium` or `high` |
| Enforcement label | `pending` |

## Install and sign in

Install the Antigravity CLI by Google's own instructions. Then either:

- **`GEMINI_API_KEY`** (the documented headless route): set it in the environment you run `sabotage-council` from,
  and every leg runs with `modelProvider: "gemini"` in its own settings; or
- **your Google sign-in**: run `agy` once interactively and sign in. The adapter checks it with `agy -p "/usage"`, a
  slash command the CLI answers itself (no model turn, no quota, no conversation), and checks the remaining quota of
  the model's group. A leg has no terminal, so a sign-in that would wait for a code fails instead of hanging.

agy keeps your real `HOME`, because its keyring sign-in does not load under another one (measured).

## Terms

Google's FAQ says wrapping `agy` in third-party tools is not supported on consumer plans and can lead to account
suspension. sabotage-council never runs `agy -p` for a review: legs use `agy acp`, the client route Google documents
("Any ACP client can launch Antigravity CLI"), and preflight's only `-p` call is the no-turn `/usage` check. The
documented headless route is `GEMINI_API_KEY`. A consumer sign-in also works, at your own risk.

## A seat in the config

```toml
[[seats]]
id = "c"
backend = "antigravity"
model = "gemini-3.8-flash"
effort = "high"
```

Name the model without its effort suffix: `gemini-3.8-flash` at `high` is the account's slug `gemini-3.8-flash-high`.
Preflight checks that slug against `agy models`. The model, the thinking level and the session mode are set over ACP
with `session/set_config_option`, and the engine refuses the session before the prompt if agy reports anything else.

## What a leg runs

```sh
agy acp --disable-telemetry --sandbox --include-default-customizations=false \
  --gemini-dir <leg dir>/gemini --log-file <leg dir>/agy.log
```

The engine is the ACP client. It declares no filesystem or terminal capability, opens the session in the review root
with no MCP servers, sets the session mode to `default` (the mode that asks before commands and file changes; never
`accept-edits` or `auto`), and rejects every permission request except a read whose every path is inside the root by
realpath. Every leg runs on its own `--gemini-dir`, where the adapter writes settings that allow no access outside the
workspace and no allow rule; agy reads its settings and its MCP config from there, not from `~/.gemini` (measured
with no model call: an MCP server planted in `~/.gemini` did not start). Each leg sets
`AGY_CLI_DISABLE_AUTO_UPDATE=true`, since agy updates itself.

The environment holds only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`,
`GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables.

## What `pending` means

The P3 canary (agy 1.5.7, a consumer sign-in, run twice) found: reads inside the workspace run with no permission
request; a read outside it asks, and the client's rejection held (the planted secret never reached the stream). With
allow rules planted in the leg's settings, preflight refused the leg; launched anyway, agy still asked and the client
rejected. But **a rejection ends agy's turn**: it fails the rest of the model's batch without asking or running it,
so four of the five canary actions (the symlink read, the write, the command and the fetch) were never put to the
client. Until each is shown denied on its own, agy stays `pending`, and on a pull request from an author without
write access it follows `council.untrusted_seat_policy`.

Every leg is ratified from agy's own records: its log names the session's conversation and one CLI version, the app
data dir is the leg's own, and every model call's label in the conversation database equals the pin. agy offers an ACP
client its whole tool set, command, write, edit and web tools included (`run_command`, `write_file`, `edit_file`,
`search_web`, and sub-agent and task tools); the client rejects their permission requests and the ratifier fails a
leg in which one ran, but the offer itself is recorded on the leg, not rejected.

## Preflight and `doctor`

`doctor` checks: the occupant, `agy --version`, the version, the sign-in (`/usage`, or the key), the model slug in
`agy models`, the quota (sign-in route), that the leg's own settings hold no allow rule, auto mode or outside access,
and that the root holds no agent config at its top level. There is no offline proof over ACP of what a leg loads, so
`doctor --deep` reports agy as "unproven by --deep".

## Failures and fallbacks

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | `RESOURCE_EXHAUSTED`, code 429, quota exceeded, weekly or daily limit, spend cap, out of credits; a used-up quota at preflight |
| `auth` | "Authentication required", "Authentication expired. Please log back in", "Verify your account to continue", "Sign-in update needed", "Eligibility check failed", `GEMINI_API_KEY` not set |
| `model` | invalid model selection, not a known model, an effort the model does not support |
| `capacity` | `UNAVAILABLE`, code 503, overloaded, temporarily unavailable |
| `transport` | connection reset or refused, socket hang up, exited before answering |
| `setup` | an unknown setting, an undefined flag, a path that must be absolute |

## Known gaps

- Whether a symlink read, a write, a command and a fetch are each put to the client and denied when the model issues
  them alone (above).
- Whether your global `~/.gemini` instructions (`GEMINI.md`), skills, plugins and hooks stay out of a leg: only a
  model turn would show it.
- No recorded run uses the `GEMINI_API_KEY` route; the measured runs used a consumer sign-in.
