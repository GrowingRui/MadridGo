"""Run the MobilityData GTFS validator (Docker image) and summarise its report."""

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

VALIDATOR_IMAGE = "ghcr.io/mobilitydata/gtfs-validator:8.0.1"


@dataclass(frozen=True)
class ValidationSummary:
    status: str  # valid | warnings | errors | failed
    errors: int
    warnings: int
    report_dir: Path
    top_errors: list[str]


def summarise_report(report: dict[str, object], report_dir: Path) -> ValidationSummary:
    notices = report.get("notices", [])
    errors = warnings = 0
    top: list[tuple[int, str]] = []
    for n in notices if isinstance(notices, list) else []:
        total = int(n.get("totalNotices", 0))
        if n.get("severity") == "ERROR":
            errors += total
            top.append((total, str(n.get("code"))))
        elif n.get("severity") == "WARNING":
            warnings += total
    status = "errors" if errors else "warnings" if warnings else "valid"
    top_errors = [f"{code} x{count}" for count, code in sorted(top, reverse=True)[:5]]
    return ValidationSummary(status, errors, warnings, report_dir, top_errors)


def validate(zip_path: Path, report_dir: Path, timeout_s: int = 1800) -> ValidationSummary:
    """Validate zip_path. The HTML and JSON reports are archived in report_dir."""
    if shutil.which("docker") is None:
        return ValidationSummary("failed", 0, 0, report_dir, ["docker not found"])
    report_dir.mkdir(parents=True, exist_ok=True)
    work = zip_path.parent.resolve()
    out = report_dir.resolve()
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{work}:/in:ro",
        "-v", f"{out}:/out",
        VALIDATOR_IMAGE,
        "-i", f"/in/{zip_path.name}", "-o", "/out", "-c", "es", "-svu",
    ]  # fmt: skip
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, check=False)  # noqa: S603
    report_file = out / "report.json"
    if proc.returncode != 0 or not report_file.exists():
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["no output"]
        return ValidationSummary("failed", 0, 0, report_dir, tail)
    return summarise_report(json.loads(report_file.read_text("utf-8")), report_dir)
