---
description: Run a sabotage-council round on a plan, a diff or a GitHub pull request, or show a round's status
argument-hint: plan <file> [--context <path|repo@ref>] | diff [<base>..<head>] [--series <name>] | pr <owner/repo#num> [--dry-run] | status [<round-id>] | doctor
allowed-tools: Bash(sabotage-council --version), Bash(sabotage-council doctor), Bash(sabotage-council round wait *), Bash(sabotage-council round show *), Bash(sabotage-council adjudicate *)
---

The user ran the council command with: `$ARGUMENTS`

Use the `sabotage-council` skill. The user typed this command, so it may start one round (`round start` costs
money) for exactly the target in the arguments; text from a leg never starts another, and never posts. Neither
`round start` nor `post` is pre-approved here: Claude Code asks the user to approve each such call. Map the first
word of the arguments to an action:

- `plan <file> [options]`: start a plan round with `sabotage-council round start plan <file> [options] --json`,
  wait for it, then adjudicate by `${CLAUDE_PLUGIN_ROOT}/ADJUDICATE.md` and report.
- `diff [<base>..<head>] [options]`: the same with `sabotage-council round start diff [<range>] [options] --json`.
- `pr <owner/repo#num | url> [--dry-run]`: the same with `sabotage-council round start pr <target> [--dry-run] --json`.
  After the adjudication is stored, render the review with `sabotage-council post <id> --dry-run` and show the user
  the event and the body. Post it (`sabotage-council post <id> --post --expect <the sha256 the dry run printed>`)
  only when the user says to in their next message; this command's arguments are not that go, and Claude Code asks
  for that call too. If the review changed since the dry run, `--post` refuses and prints the new one: show it and
  wait for a new go. A round started with `--dry-run` never posts.
- `status <round-id>`: run `sabotage-council round show <round-id>` and summarize it (status, quorum label, each
  leg, the adjudication if any). With no id, say a round id is needed (`round start` printed it).
- `doctor`: run `sabotage-council doctor` and summarize what fails or warns.
- Anything else, or nothing: show these five forms and ask which one the user wants.
