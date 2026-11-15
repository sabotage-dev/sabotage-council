# Codex CLI (`codex`)

OpenAI's Codex CLI, run headless (`codex exec --json`). Label: **`sandboxed-exec`**. Back to [all backends](README.md).

| | |
|---|---|
| Binary | `codex` on `PATH` |
| Tested version | 0.167.0, and only that: any other version is refused at preflight until its tool list is declared |
| Sign-in | your ChatGPT login (`codex login`), or `CODEX_API_KEY` |
| Models | whatever `codex debug models` lists for your account |
| Effort | required; one of the levels the model lists (`low`, `medium`, `high`, ... ) |
| Enforcement label | `sandboxed-exec` on 0.167.0, `pending` (and refused) on any other version |

## Install and sign in

Install the Codex CLI by OpenAI's own instructions, at version 0.167.0, and sign in once with `codex login` (or set
`CODEX_API_KEY` in the environment you run `sabotage-council` from). The adapter checks the sign-in with
`codex login status`; a seat with neither a login nor the key fails preflight with `run codex login`.

Codex releases often. The adapter accepts exactly the versions whose offered tools it has declared (0.167.0 in
0.1.0), because its ratifier checks the offered tools by exact membership; a newer `codex` is refused with "has no
declared native tool list". Keep 0.167.0 installed for seats until a release declares the newer version.

## A seat in the config

```toml
[[seats]]
id = "a"
backend = "codex"
model = "gpt-6.1-sol"
effort = "high"     # always set it: some models default to low
```

The model id must appear in `codex debug models`, and the effort in that model's own list of reasoning levels. The
seat passes them as `-m <model>` and `-c model_reasoning_effort="<effort>"`.

## What a leg runs

```sh
codex exec --json --color never -C <root> --skip-git-repo-check -s read-only -m <model> \
  -c model_reasoning_effort="<effort>" --disable apps --disable plugins --disable hooks --disable multi_agent \
  -c project_doc_max_bytes=0 -c skills.include_instructions=false -c web_search="disabled" \
  -c analytics.enabled=false -c check_for_update_on_startup=false \
  -c mcp_servers.<name>.enabled=false ...   # one per MCP server in your codex config
  -o <leg dir>/last.txt -                   # the brief on stdin
```

The working directory is the review root. The leg's environment holds only `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `CODEX_HOME`, `CODEX_API_KEY`, `SSL_CERT_FILE`,
`SSL_CERT_DIR` and the proxy variables, plus `NO_COLOR=1`. The engine passes `CODEX_API_KEY` by name and never
reads it. It never copies your `auth.json` into another `CODEX_HOME`: a token refresh there can invalidate your
real login.

## What `sandboxed-exec` means

`-s read-only` is a sandbox, not a tool ban. A codex leg runs shell commands (through a login shell, so your shell
profile runs too); the sandbox denies writes and network, but **reads are not confined to the root** (measured on
0.167.0: a planted `echo` ran, a write was denied, a fetch was blocked). So:

- the brief asks the leg to read only with `rg`, `grep`, `sed`, `nl`, `cat`, `head`, `tail`, `wc`, `ls`, `pwd`,
  `find`, `diff`, `sort`, `uniq`, `cut`, `tr`, `stat` and `file`;
- ratification parses every command the leg ran from its rollout and fails the leg on a write denial, on a command
  outside that read list, and on a path that resolves outside the root. This check is lexical and runs after the
  fact: it detects an outside read, it does not prevent one;
- codex's sub-agent tools cannot be switched off, so every child agent's own rollout is ratified with the same checks;
- your global `~/.codex/AGENTS.md` (under `CODEX_HOME`) still loads into every leg. `doctor` lists it as
  user-owned. To keep it out, give the seat `CODEX_API_KEY` and a fresh `CODEX_HOME`.

On a pull request from an author without write access, a codex seat is below `strong`, so it follows
`council.untrusted_seat_policy` (by default it is replaced by a `strong` fallback, or sits the round out).

## Preflight and `doctor`

`doctor` (no model call) checks, in order: the occupant (model id and effort word), `codex --version`, the version
(0.167.0), `codex login status` (or `CODEX_API_KEY`), the model and effort against `codex debug models`, your MCP
servers (`codex mcp list --json`, each disabled by name in the leg), and the isolation proof: `codex debug
prompt-input` with the leg's exact flags, run from the root, must offer only the declared tools, no MCP tool and no
repository instructions. A line `user-owned: global AGENTS.md loads` names the file that still loads.

`doctor --deep` runs the same render on a root of planted hooks, rules and MCP config: codex passes as `isolated`
when its render lists nothing from that root.

## Failures and fallbacks

| Class | Signatures the adapter matches (stderr and error events) |
|---|---|
| `usage_limit` | "You've hit your usage limit", "You hit your spend cap", "Quota exceeded.", "out of credits", "upgrade to Plus", "send a request to your admin", 402 |
| `auth` | refresh token expired, used or revoked, "Please log out and sign in again", 401, "Not logged in" |
| `model` | "model rerouted:", model not found or not supported, 400 |
| `capacity` | "Selected model is at capacity", high demand, rate limit, 429, overloaded |
| `transport` | "Reconnecting... 5/5", "stream disconnected", connection reset, refused or closed |
| `setup` | not inside a trusted directory, bad arguments, config load errors |

A ChatGPT plan's usage limit is the most common failure. Give a codex seat a fallback on another backend for
`usage_limit` and `auth`, for example a `claude` occupant (which is also `strong`, so it serves untrusted PRs). The
ratifier records the plan's rate-window quota from the rollout (shown by `stats`); codex records no cost in USD.

## Known gaps

- Reads outside the root are not refused before they run (see above): codex is never `strong` in 0.1.0.
- Your global `AGENTS.md` loads into every subscription leg.
- Every codex version but 0.167.0 is refused until a release declares it.
- `doctor --deep` on a real codex install is not among the plan's recorded runs.
