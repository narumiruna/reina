#!/bin/sh
set -eu
# Snapshot files must remain readable by the non-root job user.
umask 022

install -d -m 700 -- "$REINA_STATE_DIR" "$TMPDIR"
exec "$@"
