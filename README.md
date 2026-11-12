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

Building (P0). This phase is the scaffold: the config schema and loader, the run store and its migrations, and a
`doctor` skeleton. There are no seat adapters and no review rounds yet. The v1 build plan is
[docs/PLAN.md](docs/PLAN.md).

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
