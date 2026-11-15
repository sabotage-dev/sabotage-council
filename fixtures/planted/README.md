# planted

The planted-defect fixture `sabotage-council seats test` runs one leg on (plan 8.4). It ships in the package, so a
candidate can be qualified without the repository's tests.

`base/` is the repository at the base commit; `head/` is the same repository at the head commit, which plants three
defects in `calc/rangesum.py`, one on each changed line (6, 11 and 20). `defects.json` names each one with its line and
a few keywords. A finding counts for a defect when its path is that file at the head (`calc/rangesum.py`, with or
without the root's `planted/` prefix; never the `_base/` copy or any other prefix) and either its line is the defect's
line, or, with no line on a defect, its title holds more of that defect's keywords than of any other's (a tie is no
match).

- D1 (HIGH): the loop runs `range(start, end)`, so the inclusive range sum drops its last element. The existing test
  fails on it.
- D2 (MEDIUM): the bounds check is `end > len(values)`, so `end == len(values)` is summed instead of raising.
- D3 (MEDIUM): `mean` uses floor division, so the mean of `[1, 2]` is `1`. No test catches it.
