# sabotage-council

A three-seat review council for code and plans.

Three coding agents from different model families review the same frozen snapshot. They run read-only, in
parallel, and none sees the others' answers. An adjudicator verifies every finding against the code, tallies per
finding rather than per reviewer, and writes one verdict: `SHIP`, `SHIP-WITH-FIXES` or `NEEDS-WORK`.

Each seat is filled by a CLI you already use. Planned backends:

- Codex CLI
- Claude Code
- Grok CLI
- Antigravity CLI (over ACP)
- Kiro CLI
- opencode
- Cursor CLI
- Muse Code

Every round records which seat raised which finding and what became of it. So you can see which seats earn their
place, and swap the ones that do not.

Planned modes:

- **`plan`**: the council pokes holes in a written plan.
- **`diff`**: the council reviews your branch's diff while you build.
- **`pr`**: the council reviews a GitHub pull request.
- **`auto`**: a local daemon reviews the PRs you are requested on, and posts one review per round.

## Status

Building (P3). Built so far: the config schema and loader, the run store, the review root and brief, the reply
parsers, the headless transport with the codex and claude seats, and the ACP transport with the antigravity and
kiro seats. There are no review rounds yet. The v1 build plan is [docs/PLAN.md](docs/PLAN.md).

Each seat shows an enforcement label in `doctor` (plan 5.2). claude is `strong`, codex is `sandboxed-exec`, and
antigravity and kiro are `pending`: their promotion canaries ran and did not prove every action (plan 14).

### Backend notes

- **Antigravity (`agy`).** Seats run `agy acp`, the documented client route, never `agy -p`. Google's FAQ says
  wrapping `agy` in third-party tools is not supported on consumer plans and can lead to account suspension.
  The documented headless route is a Gemini API key: set `GEMINI_API_KEY` and the seat runs with
  `modelProvider: "gemini"`. A consumer sign-in also works, at your own risk. Each leg runs on its own
  `--gemini-dir`. Measured on agy 1.5.7 with no model call: agy then reads its settings and its MCP config from
  that directory, not from `~/.gemini` (an MCP server planted in `~/.gemini` did not start). Not measured:
  whether your global `GEMINI.md`, skills, plugins and hooks in `~/.gemini` stay out. The root sanitizer and the
  per-call permission check apply either way. agy still runs with your real HOME, which its keyring sign-in
  needs.
- **Kiro (`kiro-cli`).** Seats run `kiro-cli acp` on the v2 engine with a council agent profile in a per-leg
  `KIRO_HOME`. A seat may set `auth_home = "/abs/dir"` to use a separate Kiro login (for example a personal one
  beside a work one): kiro-cli then runs with `HOME` there, and `doctor` shows which home each seat uses. Log that
  home in once with `HOME=/abs/dir kiro-cli login`.

## Development

Requirements:

- Node.js 22.13 or later (the run store uses the built-in `node:sqlite`, which needs no flag from 22.13);
- npm;
- macOS or Linux.

```sh
npm ci          # install the locked dependencies
npm test        # run the tests (vitest)
npm run lint
npm run typecheck
```

`npm run build` compiles to `dist/`. `node dist/cli/index.js doctor` then checks Node, the config at
`~/.config/sabotage-council/config.toml` and the run store at `~/.local/share/sabotage-council/council.db`
(`--config` and `--db` override both).

## License

MIT, copyright Sabotage Development LLC. See [LICENSE](LICENSE).
