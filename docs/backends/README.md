# Seat backends

A seat is filled by a coding-agent CLI you install and sign in to yourself. The engine never installs, updates or
logs in to a CLI, and never reads your credentials: each leg gets a scrubbed environment holding only the variables
its backend needs, passed through by name.

| Backend | Binary | Transport | Tested version | Enforcement label | Page |
|---|---|---|---|---|---|
| Codex CLI | `codex` | headless | 0.167.0 (only) | `sandboxed-exec` | [codex](codex.md) |
| Claude Code | `claude` | headless | 2.1.322, 2.1.323, 2.1.325 | `strong` on those, `pending` on others | [claude](claude.md) |
| Grok CLI | `grok` | headless | 1.0.70 | `weak` with `sandbox = "off"`, `pending` with the sandbox on | [grok](grok.md) |
| Antigravity CLI | `agy` | ACP | 1.5.7 | `pending` | [antigravity](antigravity.md) |
| Kiro CLI | `kiro-cli` | ACP | v3 engine (the default): 3.5.0; v2: 3.2.1, 3.3.0, 3.5.0 | `pending` | [kiro](kiro.md) |
| opencode | `opencode` | ACP | 2.2.7 | `pending` | [opencode](opencode.md) |
| Cursor CLI | `cursor-agent` | headless | none | `weak` | [cursor](cursor.md) |
| Muse Code | `muse` | headless | 1.4.15 | `weak` | [muse](muse.md) |

`sabotage-council doctor` runs every seat's preflight (no model call) and prints the label it got. Each page says how
the label was measured and what it does not cover.

## Enforcement labels

A seat must not act on your machine: no writes, no commands, no network, no MCP servers, and reads only inside the
review root. How well a backend enforces that differs, and each adapter declares a label per tested CLI version:

| Label | Meaning |
|---|---|
| `strong` | No tool beyond file reads is offered, and reads are confined to the root, both proven before execution by the backend's own promotion canary (a leg asked to read outside the root by path, through a symlink, by Glob and Grep, to write, run a command and fetch, with a planted allow rule in your own settings: every action refused or denied before it ran). |
| `sandboxed-exec` | Commands run inside a sandbox that denies writes and network, but reads are not confined to the root. |
| `pending` | The mechanism exists, but its canary did not prove every action is refused before it runs. |
| `weak` | Enforcement depends on configuration the agent may not honour, or is unmeasured. |

Whatever the label, every leg is ratified after it ends from the CLI's own records (the model that ran, the tools
used, the paths read, the nonce line) and the root's hash, and a leg that used a forbidden tool, read outside the root
or changed the root is `contaminated` and does not count. The offer is checked only where the CLI records it or the
adapter can compute it: claude, codex and grok legs fail on a forbidden offer and opencode's is computed at preflight;
antigravity is offered command and write tools and its ratifier records that offer without failing on it; kiro on
its v3 engine reports the offered tool tags before the prompt, and the leg is refused unless they are exactly the read
tag; kiro on v2, cursor and muse record no offer. [The security page](../security.md#what-a-seat-can-do) has the table per backend.
Ratification catches a violation; only `strong` prevents it.

**Pull requests from authors without write access.** In `pr` and `auto` rounds, a seat below `strong` follows
`council.untrusted_seat_policy`:

- `fallback` (the default): the seat uses its fallback if that is `strong`, else it sits the round out;
- `skip`: the seat sits the round out;
- `allow`: the seat runs anyway, and every such leg records your acknowledgement.

In 0.1.0 only a `claude` seat on a tested version is `strong`, so with the default policy a round on such a PR
needs `claude` fallbacks for its other seats, or it falls below quorum and fails, visibly. It never approves
quietly. See [the security model](../security.md).

## Failure classes

Every adapter maps its CLI's errors (read from stderr and error records, never from the answer text) to one class,
and the round runner acts on the class:

| Class | Examples | What the round does |
|---|---|---|
| `usage_limit` | quota or spend cap, monthly limit, HTTP 402 | moves the seat to its fallback, if `fallback.on` lists `usage_limit` |
| `auth` | not logged in, expired login, a browser sign-in prompt | moves the seat to its fallback, if `fallback.on` lists `auth` |
| `capacity` | 429, overloaded, rate limit | relaunches the leg once |
| `transport` | connection reset or refused, a stream that ended early | relaunches the leg once |
| `timeout` | the leg's wall clock (`council.leg_timeout_minutes`, 25 by default) ran out | kills the process group and relaunches once |
| `empty` | the leg ratified but gave no verdict and no findings | relaunches once |
| `model` | unknown model id, another model or effort in the record | not a review; no relaunch |
| `contaminated` | a forbidden tool offered or used, a read outside the root, the root changed | not a review; never relaunched in that root |
| `setup` | a bad flag, a settings error, a preflight refusal | not a review; no relaunch |

A relaunch happens only while the round has time left (the round's budget is twice the leg cap), and a relaunch or a
fallback runs on a re-verified or rebuilt root. A primary that fails its preflight moves to the fallback whatever
the class; a fallback that fails its preflight leaves the seat out. Preflights run one at a time before any launch,
so legs never race a token refresh.

A fallback is configured per seat, and only `usage_limit` and `auth` can trigger it:

```toml
[[seats]]
id = "a"
backend = "codex"
model = "gpt-6.1-sol"
effort = "high"
fallback = { backend = "claude", model = "claude-opus-5-5", effort = "high", on = ["usage_limit", "auth"] }
```

No model may vote twice: a fallback must be a different occupant (backend, model or effort) from its own primary,
from every other seat's primary and from every other seat's fallback. So covering two seats with `claude` fallbacks
for untrusted pull requests takes two different Claude models (or efforts), neither one a primary. A fallback table
takes `backend`, `model`, `effort`, `on`, (kiro and grok) `auth_home` and (kiro) `engine`; it has no `sandbox` key,
so a grok fallback always runs with the read-only sandbox.
