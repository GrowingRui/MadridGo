"""Download feeds into the local data directory, keeping one file per content hash."""

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

import httpx

USER_AGENT = "MadridGo-ingest/0.1 (+https://github.com/GrowingRui/MadridGo)"


@dataclass(frozen=True)
class Downloaded:
    path: Path
    sha256: str
    size: int
    changed: bool  # False when the content matches the previous download


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest_dir: Path, name: str, timeout_s: float = 300.0) -> Downloaded:
    """Download url to dest_dir/<name>-<sha12>.<ext> and point dest_dir/<name>-latest at it.

    The file is streamed to a temporary path first, so an interrupted download never
    replaces a good file.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = ".osm.pbf" if url.endswith(".osm.pbf") else ".zip"
    tmp = dest_dir / f".{name}.part"
    h = hashlib.sha256()
    size = 0
    with httpx.stream(
        "GET", url, follow_redirects=True, timeout=timeout_s, headers={"User-Agent": USER_AGENT}
    ) as resp:
        resp.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in resp.iter_bytes(1 << 20):
                f.write(chunk)
                h.update(chunk)
                size += len(chunk)
    digest = h.hexdigest()
    final = dest_dir / f"{name}-{digest[:12]}{ext}"
    latest = dest_dir / f"{name}-latest{ext}"
    changed = not (latest.exists() and sha256_file(latest) == digest)
    tmp.replace(final)
    shutil.copyfile(final, latest)
    return Downloaded(path=final, sha256=digest, size=size, changed=changed)
