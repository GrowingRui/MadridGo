from pathlib import Path

from app.ingest.__main__ import feed_file


def test_existing_path_is_used_as_it_is(tmp_path: Path) -> None:
    f = tmp_path / "a.zip"
    f.write_bytes(b"x")
    assert feed_file(tmp_path, str(f)) == f


def test_windows_path_from_another_machine_is_found_by_name(tmp_path: Path) -> None:
    flat = tmp_path / "gtfs" / "flat"
    flat.mkdir(parents=True)
    (flat / "cercanias-4ebb8de0b8fc.zip").write_bytes(b"x")
    stored = r"D:\old-pc\madridgo\data\gtfs\flat\cercanias-4ebb8de0b8fc.zip"
    assert feed_file(tmp_path, stored) == flat / "cercanias-4ebb8de0b8fc.zip"


def test_posix_path_from_another_machine_is_found_by_name(tmp_path: Path) -> None:
    raw = tmp_path / "gtfs" / "raw"
    raw.mkdir(parents=True)
    (raw / "emt.zip").write_bytes(b"x")
    assert feed_file(tmp_path, "/srv/old/data/gtfs/raw/emt.zip") == raw / "emt.zip"


def test_missing_file_gives_the_stored_path_back(tmp_path: Path) -> None:
    assert feed_file(tmp_path, "/nowhere/x.zip") == Path("/nowhere/x.zip")
