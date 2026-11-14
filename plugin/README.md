# sabotage-council Claude Code plugin

Runs a sabotage-council review round from Claude Code and adjudicates it in your session.

- `/sabotage-council:council plan <file>`: the council reviews a written plan.
- `/sabotage-council:council diff [<base>..<head>]`: the council reviews a branch diff (uncommitted work included).
- `/sabotage-council:council pr <owner/repo#num> [--dry-run]`: the council reviews a GitHub pull request; the
  session shows the review it would post, and posts it only on your go.
- `/sabotage-council:council status <round-id>`: a round's summary.
- The `sabotage-council` skill holds the procedure; `ADJUDICATE.md` holds the adjudication rules, shared with the
  headless adjudicator.

The plugin calls the `sabotage-council` engine on your PATH (the npm package in this repository) and holds no
engine logic. Install the plugin with `/plugin marketplace add sabotage-dev/sabotage-council`, then
`/plugin install sabotage-council@sabotage-council`. MIT, copyright Sabotage Development LLC.
