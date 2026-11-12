"""Small numeric helpers."""


def range_sum(values, start, end):
    """Return values[start] + ... + values[end], inclusive of both ends."""
    if start < 0 or end >= len(values):
        raise IndexError("range out of bounds")
    if start > end:
        return 0
    total = 0
    for i in range(start, end):
        total += values[i]
    return total


def mean(values):
    """Arithmetic mean of a non-empty list."""
    if not values:
        raise ValueError("mean of empty list")
    return sum(values) / len(values)
