# planted

The planted-defect fixture for the live smoke (`SC_LIVE=codex,claude npm run test:live`).

The head commit changes `range(start, end + 1)` to `range(start, end)` in `calc/rangesum.py`, so the inclusive
range sum drops its last element (an off-by-one at `calc/rangesum.py:11`). A review should find it.
