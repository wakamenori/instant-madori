#!/bin/sh
# Wrangler runs this as its docker binary. PPID identifies the process that started it.
exec "$MADORI_DOCKER_TETHER_NODE" "${0%/*}/docker-tether.ts" "$PPID" "$@"
