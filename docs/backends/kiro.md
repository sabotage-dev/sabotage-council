# Kiro CLI (`kiro-cli`)

AWS's Kiro CLI, run over ACP. Seats run its **v3 engine** by default (`kiro-cli acp --agent-engine v3`, Kiro's own
default for new installs); the v2 engine stays supported with `engine = "v2"`. Label: **`pending`** on both. Back to
[all backends](README.md).

| | |
|---|---|
| Binary | `kiro-cli` on `PATH` |
| Engine | `v3` (the default) or `v2`, set per seat and per fallback with `engine` |
| Tested versions | v3: 3.5.0 (the v3 floor). v2: 3.2.1, 3.3.0 and 3.5.0 (the v2 floor is 3.2.1) |
| Sign-in | your Kiro login (Builder ID or IAM Identity Center), a separate login in the seat's `auth_home`, or `KIRO_API_KEY` |
| Models | your account's `kiro-cli chat --list-models` (the adapter knows `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.7`, `deepseek-3.2`, `glm-5`, `qwen3-coder-next` and more) |
| Effort | `low`, `medium`, `high`, `xhigh` or `max`; leave it unset for models with no effort levels (`glm-5`, `deepseek-3.2`, `qwen3-coder-next`, `claude-haiku-4.5`) |
| Enforcement label | `pending` |

## Choosing the engine

- A kiro seat or fallback with no `engine` runs v3. **An existing kiro seat with no `engine` moves to v3 with this
  release.** `doctor` prints each kiro seat's engine (`v3 (the default ...)` or `v2 (engine = "v2")`).
- `engine = "v2"` keeps the v2 path exactly as before: the same launch flags, the same agent profile and the same
  session-record checks. What a v2 leg launches and checks changes only by the leg settings file, on the versions that
  declare it (below); preflight's own kiro-cli commands now run on a scratch `KIRO_HOME` for both engines.
- v3 needs kiro-cli 3.5.0 or later. A v3 seat on an older kiro-cli is refused at preflight with "update kiro-cli, or
  set engine = v2". On a version newer than the tested ones `doctor` warns and the same checks apply.
- `engine` is set only on kiro seats and fallbacks; on any other backend it is a config error. It is not part of the
  occupant's identity: a seat that changes engine keeps its scorecard history, and every leg records the engine it
  ran (its ratification, the `stats` evidence rows, `seats test --json`).
- `seats swap`, `seats add` and `seats test` take `--engine v3|v2`. `seats test <seat> --engine v2` runs a kiro seat
  on the other engine without editing the config.

## Install and sign in

Install the Kiro CLI by AWS's own instructions, at version 3.5.0 (releases are weekly and sometimes breaking). Then
sign in one of three ways:

- **Your own login**: `kiro-cli login`. kiro-cli runs with your `HOME` and reads its token store there.
- **`auth_home`**: a separate login of the seat's own (for example a personal account beside a work one). kiro-cli
  then runs with `HOME` set to that directory. Log it in once with `HOME=/abs/dir kiro-cli login`. `doctor` shows which
  home and which credential each seat uses. With `auth_home` set, `KIRO_API_KEY` is not passed to the leg.
- **`KIRO_API_KEY`**, used when the seat has no `auth_home`.

Preflight reads the token store's expiry and whether a refresh token exists (never a token's value), then proves the
sign-in with `kiro-cli chat --list-models` under a 30 second cap. An expired login opens a browser and waits about 10
minutes; the engine kills the process the moment kiro-cli prints "Opening browser" (or asks to continue to the
browser) and classifies it `auth`. Signed out, the v3 engine opens no browser: its `session/new` fails with
"Authentication required. Not logged in.", which is `auth` too. The fix it prints is `run kiro-cli login with
HOME=<home>`.

## A seat in the config

```toml
[[seats]]
id = "a"
backend = "kiro"
model = "gpt-5.6-sol"
effort = "high"
engine = "v3"                       # optional: "v3" (the default) or "v2"
auth_home = "/abs/path/kiro-home"   # optional: a separate Kiro login
```

`auto` routes per request and is refused as a council pin. Two kiro seats on the same model with two different
`auth_home` logins are two occupants; two declared logins that resolve to one token store are refused.

## What a leg runs

```sh
kiro-cli acp --agent-engine v3                                                          # v3 (the default)
kiro-cli acp --agent-engine v2 --agent sabotage-council --model <model> [--effort <e>]  # engine = "v2"
```

Never `--trust-tools` or `--trust-all-tools`. Each leg gets its own `KIRO_HOME`, so your own steering, hooks, MCP
config, permission presets and other agents never reach it. The engine writes into it:

- **The council agent** `agents/sabotage-council.json`. On v3 it is one constant file, written as its exact bytes and
  hashed back from disk (sha256 `a97e6cc036f21ce5...`): the output of kiro's own `kiro-cli agent upgrade` for the v2
  profile without its model, with tools `read`, `grep` and `glob`, no hooks, resources or MCP servers,
  `includeMcpJson: false`, and permission rules denying shell, writes, web fetch and web search, plus an `fs_read`
  allow of `./**`. The model is never in it: it is pinned over ACP. On v2 it is the v2 profile with the model. After
  a v3 leg, a changed hash or any `.json.bak` beside it fails the leg (`contaminated`).
- **The leg settings file** `settings/cli.json`, on kiro-cli 3.5.0 (both engines): `app.disableAutoupdates: true`,
  `telemetry.enabled: false` and `codeWhisperer.shareCodeWhispererContentWithAWS: false`. kiro-cli 3.5.0 reads this
  file from the leg's `KIRO_HOME` (measured: `kiro-cli settings app.disableAutoupdates` answers `true (global)`).
  Without it, kiro-cli's default updates itself on startup (it replaced itself from 3.3.0 to 3.5.0 between two
  measured runs). Whether the setting stops an update is not measured: no update was pending. 3.2.1 and 3.3.0 legs
  run with no settings file, as before.

The engine is the ACP client: it declares no filesystem or terminal capability, opens the session in the review root
with no MCP servers, and rejects every permission request except a read whose every path is inside the root by
realpath. The environment holds only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`,
`KIRO_API_KEY` (not with `auth_home`), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables, plus `HOME`,
`KIRO_HOME`, `NO_COLOR=1` and `TERM=dumb`.

## Before the prompt (v3)

The v3 session opens on kiro's default agent. Before any credit is spent, the client:

1. **Pins, in order**, each with `session/set_config_option` and checked in the options kiro reports: `mode` =
   `sabotage-council`, `model` = the pin (waited for until kiro lists it), `effortLevel` = the pin (only when the
   seat sets an effort), `autopilot` = `off`, `contentCollection` = `disabled`, `memoryReflection` = `off` and
   `sessionToolsMessaging` = `off`. A value kiro does not confirm refuses the leg (`setup`; `model` for the model and
   the effort). An effort on a model with no `effortLevel` option is refused (`model`): no model on the measured
   account had effort levels, so this is checked at the protocol level only.
2. **Gates the session.** It refuses the leg (`setup`) unless every permission preset store kiro reads is the leg's
   own and empty, no MCP server, power or progressive-context item is listed, and, after the mode pin, kiro offers
   exactly the tool tag `{builtin, read}`, the preset stores are still empty, the steering is only kiro's bundled
   manual documents, and the only command is `sabotage-council`. Each notification is waited for up to 5 seconds;
   one that never arrives refuses the leg.

The gate is what proves the agent file worked: kiro's own `agent validate` accepts files that give v3 no tools at
all.

## During the turn (v3)

- Reads inside the root run with no permission request. A read outside the root asks, naming the path in
  `_meta.kiro.consent.resource`, and the client rejects it; kiro then reports the call `failed` with the notice "The
  user rejected this tool call.". Only that exact notice, after the client's rejection, counts as not run; any other
  text in the snapshot is output and fails the leg.
- The read set is `Read File`, `Grep Search`, `List Directory` and `File Search`, judged by title. Every path is
  judged, and every pattern (`includePattern`, File Search's query) as a glob: one that names a parent (`..`), an
  absolute path or `~` is outside, and a search that names an outside path or pattern fails the leg whatever it
  returned (kiro ran a `../**/*` grep with no request). Any other title, or a tool origin other than `default` or
  `acp`, fails the leg.
- `Load Resource` is always offered. A load that never completes (kiro's catalogue error) did not run; a completed
  load fails the leg, a bundled steering document included.
- After 7 failed calls in a row kiro's loop guard asks what to do; the client answers `cancel`, which ends the turn
  with no verdict, so the leg is not a review (`empty`). An answer of `keep-iterating` recorded anywhere fails the
  leg.

## Ratification

**v3.** From the stream: every pin held and none changed after the prompt; no later tool tags, presets or steering
that would fail the gate; no notification after the prompt naming another model or a fallback (`model`); a
successful turn completion and an `end_turn`; the tools kiro says it used, matched one for one to the calls the client
saw; credits summed from the turn summaries, with kiro's `creditSplit` beside them (a `delegated` share above zero
means work the stream does not show, so the leg fails). After kiro exits, from the leg's `KIRO_HOME`: exactly one
`sessions/*/<session>/session.json` with the council agent, the pinned model named by the client, the root as its
only root and workspace, and autopilot off; `messages.jsonl` beside it naming the pinned model in every model note and
agreeing with the stream on every call; both preset stores still empty; the agent file unchanged; and the version
the leg ran (`KiroCLI/<version>` in its `logs/*/kiro.log`) equal to the one preflight saw. Kiro calls this file
layout unstable: a missing or unreadable file fails the leg as `setup`, visibly, until the adapter catches up.

**v2.** As before: `$KIRO_HOME/sessions/cli/<session>.json`, one record, the root as its directory, the council
agent, the pinned model on every turn, the pinned effort (or none), and no trusted tools, write paths or allowed
commands. Credits come from its `metering_usage`.

**What v3 cannot prove.** No v3 record carries the model of each request, as v2's per-turn `model` does:
`messages.jsonl` names the model per turn and `session.json` the session's last value, and a reported change is
caught, but an unreported reroute inside a turn would go unseen on v3.

## What `pending` means

The P3 canary (kiro-cli 3.2.1, v2, a separate personal login, run twice) found: reads inside the working directory
run with no permission request; a read outside the root by path, a read through a symlink and a search outside it
each asked, and the client rejected them before they ran. But with an allow rule planted in the leg's profile,
preflight refused the leg; launched anyway, kiro read the outside file and the symlink with no request and the secret
reached the stream, caught only at ratification. So the profile check at preflight is the guard, not the client.
Write, command and fetch were not attempted.

On v3 (3.5.0, measured for this release) the offered tools are checked before the prompt and are exactly the read
tag; the outside read asked and was rejected; an outside search ran with no request and matched nothing. **Isolation
from your own `HOME`** held in one decoy run: steering (always included, and an `AGENTS.md`), a same-name
`sabotage-council` agent with every tool and a shell allow, a second agent, a skill, an MCP server that leaves a
marker when it starts, a permission preset and a hook were placed under the leg's `HOME`, and none reached the
session: no decoy word in the stream or the answer, the offered tools exactly `{builtin, read}`, no decoy agent or
command, steering only the three bundled documents, both preset stores the leg's own and empty, no MCP server and no
marker. The hook and preset files were in guessed formats, so those two show only that a file at that path does not
load. **The v3 canary** ran on 3.5.0 through this release's adapter. The outside read by path asked and was
rejected. kiro itself blocked the read through an outward symlink, with no request. A search with an outside pattern
ran with no request and returned nothing, and ratification marked the leg `contaminated`. Write, command and fetch
were never attempted: no such tool is offered. A planted allow-all agent file and a planted permission preset were
each refused at preflight and, launched anyway, by the gate before the prompt. Because an outside search ran before
anything refused it, kiro stays `pending` on both engines (the v2 canary ran on 3.2.1 only), and on a pull request
from an author without write access it follows `council.untrusted_seat_policy`.

## Preflight and `doctor`

`doctor` prints each kiro seat's engine, home (`auth_home` or your `HOME`) and credential (`auth_home store`, `user
HOME store` or `KIRO_API_KEY`), then checks: the occupant, the home, the token store, `kiro-cli --version`, the
version (and, on v3, the v3 floor), the sign-in (`chat --list-models`), the account's usage limit, the model in the
account's list, and isolation (no rule is laid over the agent file, whose sha256 is printed; on v3 the file is
written and hashed on disk; the root holds no `.kiro/` or `AGENTS*.md` at its top level). Preflight's own kiro-cli
commands run on a scratch `KIRO_HOME`, never your settings: `--version` with only `app.disableAutoupdates: true`, the
model listing with the settings file declared for that version; the scratch directory is removed after. There is no
offline proof over ACP of what a leg loads, so `doctor --deep` reports kiro as "unproven by --deep".

## Failures and fallbacks

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | "Monthly request limit reached", "enable overages to continue", "The limits reset on", insufficient credits |
| `auth` | "Opening browser", "Auth portal timed out", "OAuth error", "Not logged in." (the v3 `session/new` error too), "You are not logged in", an expired token or session |
| `model` | failed to set model, model not found or not available, invalid model; on v3 a model or effort pin kiro does not confirm |
| `capacity` | "Kiro is having trouble responding", dispatch failure, retries, throttling, too many requests, ServiceUnavailable |
| `transport` | connection reset or refused, socket hang up, exited before answering |
| `setup` | exit codes 3 (a required MCP server did not start) and 4 (the agent is unavailable on the engine), no agent with that name, falling back, tool approval required, bad arguments; on v3 a gate refusal, an unconfirmed pin, a missing record file or a version mismatch |

A monthly request limit ends a Kiro seat until the month resets: give it a fallback on another backend for
`usage_limit` and `auth`.

## Known gaps

- The effort field on a model that has effort levels: the measured account offers none, on either engine.
- On v2, the offered tool set: kiro records none, and the P3 canary saw no write, command or fetch attempt.
- On v3: whether the settings file stops a pending self-update (none was pending when it was measured); what a model
  fallback looks like in the stream; the read tag's "diagnostics" tools (none was called); whether a hook or a
  permission preset under your `HOME` in a format kiro reads would load.
- Whether 3.2.1 and 3.3.0 read `app.disableAutoupdates` from `KIRO_HOME`.
- No recorded run uses `KIRO_API_KEY`; the measured runs used a separate personal login (`auth_home`).
