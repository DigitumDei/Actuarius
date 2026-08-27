#!/bin/bash
# One-time cutover to the systemd-owned container lifecycle with metadata
# isolation (security review 2026-08-24, finding C-1).
#
# Run ON THE VM (IAP SSH) after the two reviewed script payloads have been
# published with the non-stopping `gcloud compute instances add-metadata`
# command documented in docs/deploy.md, and BEFORE any full Terraform apply
# or reboot. Until this runs, the legacy container still carries
# `unless-stopped` and would auto-start unprotected at boot — rebooting before
# this cutover completes is unsafe.
#
# Ordered fail-closed preconditions:
#   1. Docker daemon must answer (`docker info`). An unreachable daemon is
#      NEVER reported as "nothing to migrate".
#   2. BOTH env-startup-script and env-redeploy-script metadata payloads are
#      fetched to disk (raw bytes preserved) and their SHA-256 digests are
#      compared against the EXPECTED_* constants below BEFORE any mutation.
#      Those constants bind this script to the exact independently reviewed
#      infra/startup.sh and scripts/redeploy.sh of its own commit — structural
#      markers alone cannot distinguish a known-vulnerable prior revision.
#      Missing payloads, HTTP errors, partial publication, or stale content
#      all abort — so a completed run can never be followed by a reboot into
#      the old lifecycle. Regenerate the constants whenever either file
#      changes: sha256sum infra/startup.sh scripts/redeploy.sh
#
# Idempotent and resumable: safe to re-run; exits 0 immediately once
# migrated, and resumes safely from an interrupted run (policy already 'no',
# container still up) without repeating the update.
set -euo pipefail

CONTAINER="actuarius"
MDS="http://metadata.google.internal/computeMetadata/v1/instance/attributes"

# Release identity — SHA-256 of infra/startup.sh and scripts/redeploy.sh at
# the reviewed commit this script ships with. Update both together with any
# change to those files.
EXPECTED_STARTUP_SHA256="ec74a0c4c7e01ea94f37dbd73552bab8751018e7d21cae30cfc1109649fe2a80"
EXPECTED_REDEPLOY_SHA256="ff039d7aaba92e3e5a05241f465be0995950890d72eab7a1843ddbfceeda85cb"

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

echo "0/6 Checking Docker daemon health..."
docker info >/dev/null 2>&1 || fail "docker daemon unavailable; refusing to reason about migration state"

echo "1/6 Verifying published metadata against the reviewed release..."
TMP_STARTUP=$(mktemp)
TMP_REDEPLOY=$(mktemp)
trap 'rm -f "$TMP_STARTUP" "$TMP_REDEPLOY"' EXIT

fetch_and_hash() {
  local url="$1" out="$2" expected="$3" label="$4" actual
  curl -sf -m 10 -H "Metadata-Flavor: Google" "$url" -o "$out" \
    || fail "could not fetch $label metadata (have the reviewed payloads been published?)"
  actual=$(sha256sum "$out" | awk '{print $1}')
  [ -n "$expected" ] || fail "expected hash for $label is not configured"
  [ "$actual" = "$expected" ] \
    || fail "published $label payload does not match the reviewed release (hash mismatch; stale or partial publication)"
}

fetch_and_hash "$MDS/env-startup-script" "$TMP_STARTUP" "$EXPECTED_STARTUP_SHA256" "env-startup-script"
fetch_and_hash "$MDS/env-redeploy-script" "$TMP_REDEPLOY" "$EXPECTED_REDEPLOY_SHA256" "env-redeploy-script"

restart_policy() {
  docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null
}

is_running() {
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null
}

echo "2/6 Checking existing container state..."
inspect_out=""
inspect_status=0
inspect_out=$(docker inspect "$CONTAINER" 2>&1) || inspect_status=$?
if [ "$inspect_status" -ne 0 ]; then
  if printf '%s' "$inspect_out" | grep -q "No such object"; then
    echo "Verified safe: no '$CONTAINER' container exists (daemon healthy, new lifecycle published)."
    exit 0
  fi
  fail "docker inspect failed unexpectedly: $inspect_out"
fi

CURRENT_POLICY="$(restart_policy)" || fail "could not read restart policy"
IS_RUNNING="$(is_running)" || fail "could not read container state"

if [ "$CURRENT_POLICY" = "no" ] && [ "$IS_RUNNING" = "false" ]; then
  echo "Already migrated: restart policy 'no' and container stopped."
  exit 0
fi

echo "3/6 Flipping restart policy to 'no'..."
if [ "$CURRENT_POLICY" != "no" ]; then
  if [ "$CURRENT_POLICY" != "unless-stopped" ]; then
    fail "unexpected current restart policy '$CURRENT_POLICY'; inspect manually before proceeding"
  fi
  docker update --restart=no "$CONTAINER" || fail "docker update failed"
else
  # Resumable intermediate state from a previous failed run: the policy is
  # already correct but the container is still up. Skip the update.
  echo "    policy already 'no'; resuming interrupted migration"
fi

echo "4/6 Verifying restart policy..."
[ "$(restart_policy)" = "no" ] || fail "restart policy did not take effect"

echo "5/6 Stopping the legacy container..."
docker stop "$CONTAINER" >/dev/null || true

echo "6/6 Verifying the container is stopped..."
[ "$(is_running)" = "false" ] || fail "container is still running after stop"

echo "Cutover complete: restart policy 'no', container stopped."
echo "It is now safe to reboot. After the reboot verify:"
echo "  systemctl status actuarius-firewall.service actuarius-bot.service"
echo "  docker exec $CONTAINER getent hosts metadata.google.internal   # must resolve (DNS)"
echo "  docker exec $CONTAINER curl -sf -m 3 -H 'Metadata-Flavor: Google' \\"
echo "    http://metadata.google.internal/computeMetadata/v1/project/project-id  # must FAIL"
