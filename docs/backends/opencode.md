# opencode (`opencode`)

The open-source, multi-provider opencode CLI, run over ACP (`opencode acp`). Label: **`pending`**. Back to
[all backends](README.md).

| | |
|---|---|
| Binary | `~/.sabotage-council/tools/opencode/node_modules/.bin/opencode` (an `npm --prefix` install there) when it exists, else `opencode` on `PATH` |
| Tested version | 2.2.7 (floor 2.2.7) |
| Sign-in | provider API keys in the environment, or none for the free `opencode/*` models |
| Models | `provider/model`, as `opencode models` lists it for the keys you set |
| Effort | optional: a variant name the model offers (opencode refuses one it does not have) |
| Enforcement label | `pending` |

## Install and sign in

Install opencode by its project's own instructions, at version 2.2.7. Every leg runs on its own config, data, state
and cache directories and its own database, so **saved opencode accounts and your global opencode config never reach
a leg**. Credentials come only from provider environment variables, passed by name: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`,
`GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_AI_API_KEY`, `FIREWORKS_API_KEY`,
`CEREBRAS_API_KEY`, `META_API_KEY`, the AWS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
`AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`), Google Cloud (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`) and
Azure (`AZURE_API_KEY`, `AZURE_RESOURCE_NAME`) variables.

The free `opencode/*` models need no key (measured on 2.2.7: `opencode/big-pickle`, `opencode/beam-free`,
`opencode/glm-5.3-flash-free` and others). Their free tier has a usage limit.

A seat whose provider has no key set fails preflight with "no `<provider>` model is offered: set that provider's API
key in the environment (legs never read saved opencode accounts)".

## A seat in the config

```toml
[[seats]]
id = "c"
backend = "opencode"
model = "opencode/big-pickle"
# effort = "high"   # only for a model that offers that variant
```

The model must be listed by `opencode models` under the leg's own environment. Over ACP the engine sets the model,
then the effort (if any), then the council agent as the session mode, and refuses the session if opencode reports
anything else.

## What a leg runs

`opencode acp`, from the review root, with `PWD` set to the root (opencode takes its directory from `PWD`, not the
spawn directory), its own empty `HOME`, per-leg `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
`XDG_CACHE_HOME` and `OPENCODE_DB`, and `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1` and
`OPENCODE_DISABLE_PROJECT_CONFIG=1`. The council config arrives in `OPENCODE_CONFIG_CONTENT`: an agent `council`
that denies everything, then allows `read`, `glob` and `grep`, and denies `skill` and `external_directory`, with
policies that deny shell, edits, web fetch and search, sub-agents, skills, MCP and plugins.

The engine is the ACP client: it declares no filesystem or terminal capability, opens the session in the root with
no MCP servers, and rejects every permission request except a read whose every path is inside the root by realpath.

**The `skill` tool.** On 2.2.7 opencode appends its own `skill` rule after the council's, so no council rule removes
the tool from the offer. It is accepted only while it is provably empty: preflight refuses a leg whose own skill
locations (its XDG config, data and cache directories, its `~/.agents` and `~/.claude`) hold any file, or whose root
holds a live skill file anywhere, the quarantine included (the root sanitizer renames every `SKILL.md`, and every
file in a quarantined skill directory, with a `.council-data` suffix). Any skill call, skill message or user message
naming a skill fails the leg.

## What `pending` means

The P4 canary (opencode 2.2.7, a free model, run twice) found: a read outside the root by path and searches outside
it were refused by opencode itself before they ran (`Permission denied: external_directory`, with no permission
request to the client). But a read **through a symlink inside the root** ran and the secret reached the log, caught
only at ratification (opencode's `external_directory` check is lexical). With allow rules planted in a config passed
in `OPENCODE_CONFIG`, preflight refused the leg; launched anyway, the same pattern held. Write, command and fetch were
not attempted. The review root replaces any symlink that leaves the root with a text file, but the canary is the
bar, so opencode stays `pending`, and on a pull request from an author without write access it follows
`council.untrusted_seat_policy`.

Every leg is ratified from opencode's own database: the session's directory is the root, every step ran the council
agent and the pinned model and variant, only reads ran (or were denied before running), every read path is inside
the root, every recorded tool call is in the ACP log, no shell message, no skill use, no sub-agent session, no
instruction file loaded, and the session ended `succeeded`.

## Preflight and `doctor`

Every check runs opencode with `--standalone` on the leg's own environment. `doctor` checks: the occupant,
`opencode --version`, the version, isolation (`debug config` lists only the leg's config dir and the council
document; `debug agents` shows the council agent denying every non-read action; the root holds no `.opencode/`,
`opencode.json`, `AGENTS*.md`, `CONTEXT.md`, `.claude/` or `.agents/` outside the quarantine), the offered tools (the
read set, plus `skill` only while it is provably empty), `mcp list` and `plugin list` (both empty), and the model.

`doctor --deep` runs `debug config` on a root of planted files before the root scan, so opencode passes as
`isolated` when that dump lists nothing from the root. The dump covers config sources, not instruction files, which
ratification checks per leg from the database.

## Failures and fallbacks

| Class | Signatures the adapter matches (opencode's own error types) |
|---|---|
| `usage_limit` | `provider.quota`, `provider.free-limit` and the other limit types, "Free usage limit reached", "usage limit reached", "Workspace usage limit" |
| `auth` | `provider.auth`, not logged in, invalid API key, unauthorized |
| `model` | `provider.no-route`, "Model unavailable", "Invalid model reference", "effort not found", "model not found" |
| `capacity` | `provider.rate-limit`, rate limit, too many requests, overloaded |
| `timeout` | `provider.timeout` |
| `transport` | `provider.transport`, "Can't reach", "database is locked", `SQLITE_BUSY`, connection reset or refused |
| `setup` | bad arguments, `InvalidConfigOptionError`, "mode not found" |

The free models' usage limit is a `usage_limit`: give a free-model seat a fallback.

## Known gaps

- The symlink read inside the root (above), and write, command and fetch, which the canary did not attempt.
- No recorded run uses a paid provider key; the measured runs used the free models.
- `OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_DISABLE_CLAUDE_CODE` come from opencode's source; no run measured
  either switch on its own.
