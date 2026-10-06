#!/usr/bin/env bash
# Host side of the in-app "Update" button (see backend/src/routes/update.js).
#
# The app cannot replace its own container, so its Update button only writes
# <data dir>/update-request.json. This script, run every minute from the
# crontab of a user who may use Docker, picks the request up, pulls the
# released image and swaps the container, keeping its settings. It also
# touches <data dir>/updater-heartbeat on every run - without a fresh
# heartbeat the app does not offer the button.
#
# Install (as that user):
#   scripts/p5-update.sh --install [container name]
# Remove:
#   scripts/p5-update.sh --uninstall
#
# The previous container is kept, stopped, as <name>-previous. If the new one
# does not answer within a minute, it is removed and the previous one started
# again. The outcome lands in <data dir>/update-result.json for the app.
set -u

IMAGE_REPO="${P5_IMAGE:-ghcr.io/quatrixone/p5-manager}"
NAME="${P5_CONTAINER:-}"
SELF="$(readlink -f "$0")"
CRON_TAG="# p5-manager updater"

case "${1:-}" in
  --install)
    NAME="${2:-${NAME:-ps5webpayload-manager-app-1}}"
    docker inspect "$NAME" >/dev/null 2>&1 || { echo "No container named $NAME" >&2; exit 1; }
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; echo "* * * * * P5_CONTAINER=$NAME $SELF >/dev/null 2>&1 $CRON_TAG"; } | crontab -
    echo "Installed: checks $NAME every minute."
    exit 0 ;;
  --uninstall)
    crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
    echo "Removed."
    exit 0 ;;
esac

[ -n "$NAME" ] || { echo "P5_CONTAINER is not set (use --install)" >&2; exit 1; }
inspect() { docker inspect --format "$1" "$NAME" 2>/dev/null; }

# The host directory mounted as the app's data dir.
DATA_DST="$(inspect '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATA_DIR=//p')"
DATA_DST="${DATA_DST:-/app/data}"
DATA="$(inspect '{{range .Mounts}}{{.Destination}}={{.Source}}{{println}}{{end}}' | sed -n "s|^$DATA_DST=||p")"
[ -n "$DATA" ] && [ -d "$DATA" ] || exit 0

touch "$DATA/updater-heartbeat"
REQ="$DATA/update-request.json"
[ -f "$REQ" ] || exit 0

exec 9>"$DATA/.updater.lock"
flock -n 9 || exit 0

VERSION="$(sed -n 's/.*"version" *: *"\([0-9][0-9A-Za-z.-]*\)".*/\1/p' "$REQ")"
result() { printf '{"ok":%s,"version":"%s","message":"%s","finished_at":"%s"}\n' "$1" "$VERSION" "$2" "$(date -u +%FT%TZ)" > "$DATA/update-result.json"; }
finish() { rm -f "$REQ"; result "$1" "$2"; exit 0; }
[ -n "$VERSION" ] || finish false "The request names no version"

NEW_IMAGE="$IMAGE_REPO:$VERSION"
# A pull that fails is fine when the image is already here (preloaded, offline).
docker pull -q "$NEW_IMAGE" >/dev/null 2>&1 || docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 \
  || finish false "Could not pull $NEW_IMAGE"

# Rebuild the container's own settings from what is running now.
OLD_IMAGE="$(inspect '{{.Image}}')"
ARGS=(--name "$NAME" -d)
add() { while IFS= read -r line; do [ -n "$line" ] && ARGS+=("$1" "$line"); done; }
add -v         < <(inspect '{{range .HostConfig.Binds}}{{println .}}{{end}}')
add --device   < <(inspect '{{range .HostConfig.Devices}}{{.PathOnHost}}:{{.PathInContainer}}:{{.CgroupPermissions}}{{println}}{{end}}')
add --cap-add  < <(inspect '{{range .HostConfig.CapAdd}}{{println .}}{{end}}')
add --group-add < <(inspect '{{range .HostConfig.GroupAdd}}{{println .}}{{end}}')
add --security-opt < <(inspect '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}')
add -p         < <(inspect '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$p}}{{println}}{{end}}{{end}}')
# Labels too, minus the image's own: Docker Compose finds its containers by
# them, so a later `docker compose up` still treats this one as its own.
add --label    < <(grep -vxFf <(docker inspect --format '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$OLD_IMAGE") \
                              <(inspect '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}'))
# Only the variables set on the container, not the ones its image brought.
add -e         < <(grep -vxFf <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$OLD_IMAGE") \
                              <(inspect '{{range .Config.Env}}{{println .}}{{end}}'))
ARGS+=(--network "$(inspect '{{.HostConfig.NetworkMode}}')")
RESTART="$(inspect '{{.HostConfig.RestartPolicy.Name}}')"
[ -n "$RESTART" ] && [ "$RESTART" != "no" ] && ARGS+=(--restart "$RESTART")
USER_SET="$(inspect '{{.Config.User}}')"
[ -n "$USER_SET" ] && [ "$USER_SET" != "$(docker inspect --format '{{.Config.User}}' "$OLD_IMAGE")" ] && ARGS+=(--user "$USER_SET")
[ "$(inspect '{{.HostConfig.Privileged}}')" = "true" ] && ARGS+=(--privileged)

# Where the app answers on the host: its own port on the host network, else
# the published one. Worked out now, while the settings can still be read.
PORT="$(inspect '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PORT=//p')"
PORT="${PORT:-3001}"
if [ "$(inspect '{{.HostConfig.NetworkMode}}')" = "host" ]; then
  HOSTPORT="$PORT"
else
  HOSTPORT="$(inspect "{{with index .HostConfig.PortBindings \"$PORT/tcp\"}}{{(index . 0).HostPort}}{{end}}")"
fi

docker rm -f "$NAME-previous" >/dev/null 2>&1
docker stop "$NAME" >/dev/null 2>&1
docker rename "$NAME" "$NAME-previous" || finish false "Could not set the running container aside"

rollback() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker rename "$NAME-previous" "$NAME" && docker start "$NAME" >/dev/null 2>&1
  finish false "$1 - the previous version is running again"
}

docker run "${ARGS[@]}" "$NEW_IMAGE" >/dev/null 2>&1 || rollback "The new container did not start"

# Give it a minute: it has to stay up and, where its port is reachable from
# here, answer on it.
for i in $(seq 1 30); do
  sleep 2
  [ "$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$NAME" 2>/dev/null)" = "running 0" ] || continue
  if [ -n "$HOSTPORT" ]; then
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$HOSTPORT/api/update/status" && finish true "Updated to $VERSION"
  elif [ "$i" -ge 10 ]; then
    finish true "Updated to $VERSION"
  fi
done
rollback "The new version did not come up"
