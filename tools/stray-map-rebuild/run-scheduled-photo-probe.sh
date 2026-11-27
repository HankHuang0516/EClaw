#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/../.." && pwd)"
node_image=stray-map-release-preflight:3ec76d896
postgres_image=postgis/postgis:17-3.5
case "${1:-scheduled}" in
    scheduled) fixture_db=stray_photo_schedule_fixture; probe=tools/stray-map-rebuild/scheduled-photo-probe.cjs ;;
    publish) fixture_db=stray_photo_publish_fixture; probe=tools/stray-map-pilot/photo-publish-probe.cjs ;;
    *) echo 'Expected scheduled or publish' >&2; exit 2 ;;
esac
fixture_host=fixture.railway.internal
fixture_password=fixture-local-only

docker_uri="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
[[ "$docker_uri" == unix://* && "$(docker info --format '{{.OperatingSystem}}')" == *"Docker Desktop"* ]]
docker image inspect "$node_image" "$postgres_image" >/dev/null
fixture_lease="$(mktemp -d /tmp/stray-scheduled-photo.XXXXXX)"
private_network="$(basename "$fixture_lease" | tr '[:upper:].' '[:lower:]-')"
fixture_container="$private_network-pg"
owns_network=0
owns_container=0
cleanup() {
    if [[ "$owns_container" == 1 ]]; then docker rm -f "$fixture_container" >/dev/null 2>&1 || true; fi
    if [[ "$owns_network" == 1 ]]; then docker network rm "$private_network" >/dev/null 2>&1 || true; fi
    rmdir "$fixture_lease"
}
trap cleanup EXIT
docker network create --internal "$private_network" >/dev/null
owns_network=1
docker run --pull never --rm -d --platform linux/amd64 --name "$fixture_container" --network "$private_network" \
    --network-alias "$fixture_host" -e POSTGRES_DB="$fixture_db" -e POSTGRES_PASSWORD="$fixture_password" "$postgres_image" >/dev/null
owns_container=1
for attempt in {1..36}; do
    if docker exec "$fixture_container" pg_isready -h 127.0.0.1 -d "$fixture_db" -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
done
docker run --pull never --rm --platform linux/amd64 --network "$private_network" -v "$project_root/tools:/repo/tools:ro" -w /repo \
    -e DATABASE_URL="postgresql://postgres:$fixture_password@$fixture_host:5432/$fixture_db" \
    "$node_image" node "$probe"
