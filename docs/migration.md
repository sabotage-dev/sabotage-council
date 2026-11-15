# Migration

## Upgrading the run store

The run store (`~/.local/share/sabotage-council/council.db` by default, or `--db` / `SABOTAGE_COUNCIL_DB`) carries
its schema version. A new release may add migrations (the numbered SQL files in the package's `migrations/`).

- **Applying them.** Run `sabotage-council doctor --db <path>` once after an upgrade. The other commands that open
  the store for writing (`round`, `adjudicate`, `post`, `ruling`, `credit`, `auto` and `seats test`) also apply
  pending migrations when they open it, in one transaction, so a failed migration leaves the store unchanged;
  `doctor` prints `applied migration(s) N, ...` when it applied any. `seats swap`, `add` and `remove` edit only the
  config file.
- **Read-only commands refuse a store behind their build.** `stats` and the scorecard line of `seats list` open the
  store read-only and never migrate it. A store at an older schema is refused with the command that upgrades it:

  ```text
  error: the run store at <path> is at schema version 3; this build reads version 5, and this command never migrates the store: run `sabotage-council doctor --db <path>` once to upgrade it (doctor applies the pending migrations), then run this again
  ```

- **No downgrade.** Migrations only go forward. An older build refuses a store that a newer build migrated ("the
  store has schema version N, which this build does not know"), and a store whose applied migration text differs
  from the one the build ships is refused too.
- **Back up first** if you want a way back: stop anything using the store (`sabotage-council auto pause`, or `auto
  uninstall`), then copy `council.db` together with its `council.db-wal` and `council.db-shm` files if they exist.

On Node 22.13 and 22.14, whose SQLite cannot open a URI filename, `stats` and `seats list` read a closed store through
a plain read-only connection, which leaves SQLite's `-wal` and `-shm` files beside it; the store's contents are
unchanged. From Node 22.15 a closed store is opened immutable and nothing is created.

## Moving from another council

A PR's round number comes from its review history on GitHub, so a PR another council already reviewed continues at
its round. Three settings decide which earlier reviews count (plan 3.6):

```toml
[github]
login = "your-login"
council_logins = ["another-council-bot"]    # other logins whose council reviews count
markers_also_count = ["Council round"]      # first-line prefixes of another council's reviews
```

- A review counts as a council round when it is by `login` or a `council_logins` login and its first line (one
  heading or emphasis wrapper stripped) is a sabotage-council marker for this PR, or starts with one of the
  `markers_also_count` prefixes (case-insensitive). From such a line, `round <N>` gives its round number and
  `at <sha>` its stated head. The head that counts is the review's `commit_id`.
- A marker review by any other login is ignored, so a stranger cannot move your round count.
- `council_logins` reviewers' unmarked change requests that still stand are carried into the next round as earlier
  items.
- **Hand credits.** For an earlier review with no marker that you vouch for as a council round, run
  `sabotage-council credit <owner/repo#num> <review-id> [--note <why>]`: it counts as a round at its own head and time.
  A review that starts with a council or identity marker is refused there, since the marker rules already decide it.

The engine never imports another council's history into the store; only GitHub's review history carries over, and
the scorecard starts from your first round here.

## Moving a seat

Seats are fixed at three (D10). To change who fills a seat:

1. `sabotage-council seats test <backend:model[:effort]>` qualifies a candidate: one paid leg on the built-in
   planted-defect fixture, reporting the defects it found, ratification, cost and duration. It is stored as a seat
   test, never as a round.
2. `sabotage-council seats swap <seat> --backend X --model Y [--effort E] --dry-run` prints the change to your config;
   run it without `--dry-run` to apply it. Only that seat's `[[seats]]` block changes, it keeps its id and its
   fallback, and a timestamped backup (mode 0600) is written beside the file first.

**Why the scorecard starts the seat's evidence over.** `stats` keeps every round under the seat id and under each
occupant (a backend, model and effort), so nothing is lost. But the swap-candidate flag judges the seat's **current
occupant**, over the rounds since it took the seat: a new occupant has not yet earned or lost anything, and judging it
by its predecessor's record would flag (or clear) the wrong one. The flag's reasons name the occupant they judge.
Changing only the fallback starts nothing over. `add` and `remove` exist only to repair a file that does not have
three seats.
