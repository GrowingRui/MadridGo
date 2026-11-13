from app.access import accessible


def test_gtfs_values() -> None:
    assert accessible(1) is True
    assert accessible(2) is False
    assert accessible(0) is None
    assert accessible(None) is None
