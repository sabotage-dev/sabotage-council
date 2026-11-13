---
description: Run a sabotage-council round on a plan or a diff, or show a round's status
argument-hint: plan <file> [--context <path|repo@ref>] | diff [<base>..<head>] | status [<round-id>] | doctor
allowed-tools: Bash(sabotage-council *)
---

The user ran the council command with: `$ARGUMENTS`

Use the `sabotage-council` skill. Map the first word of the arguments to an action:

- `plan <file> [options]`: start a plan round with `sabotage-council round start plan <file> [options] --json`,
  wait for it, then adjudicate by `${CLAUDE_PLUGIN_ROOT}/ADJUDICATE.md` and report.
- `diff [<base>..<head>] [options]`: the same with `sabotage-council round start diff [<range>] [options] --json`.
- `status <round-id>`: run `sabotage-council round show <round-id>` and summarize it (status, quorum label, each
  leg, the adjudication if any). With no id, say a round id is needed (`round start` printed it).
- `doctor`: run `sabotage-council doctor` and summarize what fails or warns.
- Anything else, or nothing: show these four forms and ask which one the user wants.
