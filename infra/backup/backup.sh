#!/bin/sh
# Nightly PostgreSQL dump for the production stack (the `backup` service in
# docker-compose.prod.yml). Every night at 03:30 (TZ) it writes
# /backups/madridgo-YYYY-MM-DD.dump (pg_dump custom format, compressed) and keeps the newest
# $BACKUP_KEEP. A dump is written to a .partial file first, so a failed run never replaces a
# good one. Restore: docs/DEPLOYMENT.md, "Backups".
# Run once now:  docker compose ... exec backup /bin/sh /backup.sh --once
set -eu

KEEP="${BACKUP_KEEP:-7}"

dump() {
	day=$(date +%F)
	out="/backups/madridgo-$day.dump"
	echo "$(date '+%F %T') backup: dumping $PGDATABASE"
	if pg_dump --format=custom --compress=6 --file="$out.partial"; then
		mv "$out.partial" "$out"
		echo "$(date '+%F %T') backup: wrote $out ($(du -h "$out" | cut -f1))"
	else
		rm -f "$out.partial"
		echo "$(date '+%F %T') backup: FAILED" >&2
		return 1
	fi
	# Keep the newest $KEEP dumps.
	ls -1t /backups/madridgo-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
		rm -f "$old"
		echo "$(date '+%F %T') backup: removed $old"
	done
}

if [ "${1:-}" = "--once" ]; then
	dump
	exit $?
fi

echo "$(date '+%F %T') backup: running daily at 03:30 ($TZ), keeping $KEEP"
while true; do
	now=$(date +%s)
	next=$(date -d "today 03:30" +%s)
	[ "$next" -le "$now" ] && next=$(date -d "tomorrow 03:30" +%s)
	sleep $((next - now))
	dump || true
done
