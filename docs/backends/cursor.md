# Cursor CLI (`cursor-agent`)

Anysphere's Cursor CLI, run headless in print mode. Label: **`weak`**, the weakest of the eight: the adapter was
built from Cursor's documentation and changelog, and **no Cursor leg has run live** (owner ruling D14). Back to
[all backends](README.md).

| | |
|---|---|
| Binary | the newest `~/.local/share/cursor-agent/versions/<YYYY.MM.DD-sha>/cursor-agent`, by absolute path; never `agent` or `cursor-agent` on `PATH` |
| Tested version | none (floor 2026.10.15) |
| Sign-in | `CURSOR_API_KEY` only; the keychain login is refused |
| Models | a declared slug that `cursor-agent models` lists: `gpt-5.5-low`, `gpt-5.5-medium`, `gpt-5.5-high`, `gpt-5.3-codex-high`, `claude-opus-5-high`, `claude-opus-4-7-thinking-max` |
| Effort | part of the slug; leave `effort` unset, or set it to the slug's own |
| Enforcement label | `weak` |
| `auto` | refused: `doctor` fails Cursor seats in a config with an `[auto]` table |

## Install and sign in

Install the Cursor CLI by Anysphere's own instructions, at 2026.10.15 or later (from that release Grep and Glob honour
the read boundary). The installer repoints `~/.local/bin/agent`, a name other CLIs use, so the adapter calls the
versioned binary under `~/.local/share/cursor-agent/versions/` by its path.

Set `CURSOR_API_KEY`. The keychain login keeps your own `HOME`, where the council's hooks are never read (and Cursor
imports your Claude Code hooks from `~/.claude/settings.json` by default), so preflight refuses it until a live run
shows the hooks loading there.

## A seat in the config

```toml
[[seats]]
id = "c"
backend = "cursor"
model = "gpt-5.5-high"
```

`auto` (the model that routes per request) is refused. A slug outside the adapter's declared list is refused, since
the ratifier needs the model id and effort it must find in the hook payloads.

## What a leg runs

```sh
cursor-agent -p --output-format stream-json --trust --mode ask --sandbox enabled --workspace <root> \
  --model <slug> <the brief>
```

Never `-f`, `--force`, `--yolo` or `--approve-mcps`. `--trust` is required in print mode and enables project hooks,
so the root sanitizer must have run (preflight refuses a root that still holds `.cursor/`, `.claude/`, `AGENTS*.md`,
`CLAUDE.md`, `.cursorrules`, `.cursorignore` or `.mcp.json` at any depth). The leg's `CURSOR_CONFIG_DIR`, outside the
root, holds deny rules (`Write`, `Shell`, `WebFetch` and every MCP tool), a read boundary of the workspace, and a
deny-all-but-reads hook that allows only read tools on paths inside the root by realpath and logs every event; the
same config and hook are written to the leg's own `HOME`. Print mode can hang after its result, so the leg is done
at the result line, and the process gets 10 seconds to exit before the engine kills its group.

The environment holds only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`,
`CURSOR_API_KEY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the proxy variables, plus `NO_OPEN_BROWSER=1`,
`NO_COLOR=1`, the leg's `HOME` and `CURSOR_CONFIG_DIR`.

## What `weak` means

Nothing about Cursor's enforcement has been measured. Untested: the prompt route, whether `CURSOR_CONFIG_DIR`
relocates hooks, the hook output contract, the legacy `model` slug in hook payloads, and every error text. No
documented key turns off Cursor's import of third-party (Claude Code) configuration, so the leg's own `HOME` is the
isolation. A Cursor leg is ratified from its stream and the council hook's log (a leg with no hook event fails, since
the stream's model is only a display name), but treat a Cursor seat as review-only on your own code. On a pull
request from an author without write access it follows `council.untrusted_seat_policy`, and `doctor` fails it for
`auto`.

## Preflight and `doctor`

`doctor` checks: the slug and its declared model, the effort against the slug, the binary under the versions
directory, the version (always a warning: no Cursor version is tested), `CURSOR_API_KEY`, the slug in
`cursor-agent models`, and that the root holds no file a trusted workspace loads. There is no offline load dump, so
`doctor --deep` reports cursor as "unproven by --deep".

## Failures and fallbacks

All of these are from the documentation, not from a recorded run:

| Class | Signatures the adapter matches |
|---|---|
| `usage_limit` | "hit your usage limit", "total usage limit reached", `ActionRequiredError`, `usage_limit_exceeded`, spend limit |
| `auth` | not authenticated, stored authentication is invalid, "run agent login", `NOT_LOGGED_IN`, unlock your keychain, invalid API key |
| `model` | "AI Model Not Found", "Model name is not valid", a model not available, blocked or restricted |
| `capacity` | rate limit, too many requests, `RESOURCE_EXHAUSTED`, 429 |
| `transport` | connection reset or refused, socket hang up, fetch failed |
| `setup` | workspace trust, untrusted workspace, headless disabled, an unknown option |

## Known gaps

- Everything above is unmeasured; Cursor stays below `strong` in v1 whatever a canary would show.
- The adapter is headless only; whether the installed CLI has an ACP mode is not probed.
