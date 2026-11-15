from calc.rangesum import mean, range_sum


def test_single_element():
    assert range_sum([5, 6, 7], 1, 1) == 6


def test_mean():
    assert mean([1, 2, 3]) == 2
