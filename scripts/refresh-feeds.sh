#!/usr/bin/env bash
# Refresh the Cercanias timetable (or other feeds) on the server: download, import, rebuild the
# OTP graph and restart OTP. The Linux counterpart of scripts/refresh-feeds.ps1 (which does the
# same on the development PC); run weekly by cron, see docs/DEPLOYMENT.md, "Feed refresh".
#
#   scripts/refresh-feeds.sh [--force] [-s cercanias,metro]
#
# Steps:
#   1. start db and redis if they are not running
#   2. `python -m app.ingest update` in a one-off container of the API image (nothing else
#      happens if no feed changed)
#   3. `otp-prepare`, build the OTP graph (otp-build profile, ~5 minutes), recreate otp
#   4. wait until the journey planner answers a real /journeys request
#   5. `python -m app.ingest status`
#
# If step 2 fails the old data and the running OTP stay untouched. Everything is logged to
# data/logs/refresh-feeds.log. Exit code: 0 ok (or skipped), 1 a step failed, 2 a feed is
# expired, expiring or missing after the refresh (so cron mails it or a monitor sees it).
#
# The GTFS validator is not run here (it needs Docker inside the container); the import does
# not depend on it. Run `python -m app.ingest validate` on a workstation if you want a report.
#
# Environment (all optional):
#   ENV_FILE     env file for compose (default: <repo>/.env.production)
#   COMPOSE_FILE compose file (default: <repo>/infra/docker-compose.prod.yml)
#   SKIP_DAYS    skip when a refresh finished less than this many days ago (default 3)
set -uo pipefail

SOURCES="cercanias"
FORCE=0
while [ $# -gt 0 ]; do
	case "$1" in
	--force) FORCE=1 ;;
	-s | --sources)
		shift
		SOURCES="${1:?missing value for --sources}"
		;;
	-h | --help)
		sed -n '2,25p' "$0"
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 1
		;;
	esac
	shift
done

# Git Bash on Windows would rewrite /paths in arguments given to docker; harmless on Linux.
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && (pwd -W 2>/dev/null || pwd))"
cd "$ROOT" || exit 1
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/infra/docker-compose.prod.yml}"
SKIP_DAYS="${SKIP_DAYS:-3}"
LOG_DIR="$ROOT/data/logs"
LOG="$LOG_DIR/refresh-feeds.log"
STEP="$(mktemp)"
mkdir -p "$LOG_DIR"

say() {
	local line
	line="$(date '+%F %T') $*"
	echo "$line"
	echo "$line" >>"$LOG"
}

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Runs a command, appends its output to the log, leaves it in $STEP, returns its exit code.
run() {
	local title="$1"
	shift
	say "== $title"
	"$@" >"$STEP" 2>&1
	local code=$?
	cat "$STEP" >>"$LOG"
	if [ "$code" -ne 0 ]; then
		tail -n 5 "$STEP"
		say "!! $title failed (exit $code)"
	fi
	return "$code"
}

# The ingest CLI in a one-off container: same image and network as the API, the repo's data/
# folder mounted at /data. As root, so it can write to a folder created by the host user.
ingest() {
	dc run --rm --no-deps --user root -v "$ROOT/data:/data" -e MADRIDGO_DATA_DIR=/data \
		-T api python -m app.ingest "$@"
}

say "refresh started (sources: $SOURCES)"

# One run at a time (cron might overlap a slow run with the next start).
if command -v flock >/dev/null 2>&1; then
	exec 9>"$LOG_DIR/refresh-feeds.lock"
	if ! flock -n 9; then
		say "skipped: another refresh is running"
		exit 0
	fi
fi

if [ "$FORCE" -eq 0 ] && [ -f "$LOG" ]; then
	last="$(grep -E '^[0-9-]{10} [0-9:]{8} refresh finished$' "$LOG" | tail -n 1 | cut -c1-19)"
	if [ -n "$last" ]; then
		last_s="$(date -d "$last" +%s 2>/dev/null || echo 0)"
		age_days=$((($(date +%s) - last_s) / 86400))
		if [ "$last_s" -gt 0 ] && [ "$age_days" -lt "$SKIP_DAYS" ]; then
			say "skipped: the last refresh finished $last (use --force to run anyway)"
			exit 0
		fi
	fi
fi

for f in "$ENV_FILE" "$COMPOSE_FILE"; do
	[ -f "$f" ] || {
		say "!! missing file: $f"
		exit 1
	}
done
docker info >/dev/null 2>&1 || {
	say "!! Docker is not running"
	exit 1
}

run "start database and Redis" dc up -d --wait db redis || exit 1
run "import feeds" ingest update -s "$SOURCES" --skip-validate || exit 1
if grep -q 'already active' "$STEP" && ! grep -q 'active as version' "$STEP"; then
	unchanged=1
else
	unchanged=0
fi

if [ "$unchanged" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
	say "no feed changed: OTP left as it is"
else
	run "prepare OTP inputs" ingest otp-prepare || exit 1
	run "rebuild OTP graph" dc --profile otp-build run --rm -T otp-build || exit 1
	run "restart OTP" dc up -d --force-recreate otp || exit 1

	# OTP needs a few minutes to load its graph, and /health does not cover that: ask the API
	# for a real connection (Parla -> Puerta del Sol area, tomorrow 09:00) until it answers.
	probe='
import json, sys, urllib.parse, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
at = (datetime.now(ZoneInfo("Europe/Madrid")) + timedelta(days=1)).replace(
    hour=9, minute=0, second=0, microsecond=0)
q = urllib.parse.urlencode({"from": "renfe:37012", "to_lat": 40.4153, "to_lon": -3.6919,
                            "at": at.isoformat()})
try:
    data = json.load(urllib.request.urlopen("http://127.0.0.1:8000/journeys?" + q, timeout=20))
    sys.exit(0 if data.get("journeys") is not None else 1)
except Exception:
    sys.exit(1)
'
	ok=0
	say "== waiting for the journey planner"
	for _ in $(seq 1 120); do
		sleep 5
		if dc exec -T api python -c "$probe" >/dev/null 2>&1; then
			ok=1
			break
		fi
	done
	if [ "$ok" -eq 1 ]; then
		say "journey planner answers"
	else
		say "!! the journey planner did not answer within 10 minutes"
		exit 1
	fi
fi

ingest status >"$STEP" 2>&1
code=$?
cat "$STEP"
cat "$STEP" >>"$LOG"
# After a refresh a feed should be well inside its dates; if not, the publisher has nothing newer.
if [ "$code" -eq 2 ] || grep -qE 'EXPIRING|EXPIRED|NOT IMPORTED' "$STEP"; then
	say "!! a feed is expired, about to expire or missing: check the status lines above"
	exit 2
fi
say "refresh finished"
exit 0
