#!/bin/bash
# Actuarius bot startup script — runs on every VM boot (must be idempotent)
set -euo pipefail

# --- Mount persistent data disk ---
DATA_DEV="/dev/disk/by-id/google-actuarius-data"
DATA_MNT="/mnt/disks/data"
mkdir -p "$DATA_MNT"

# Try to mount first. Only format if mount fails (truly new/empty disk).
# This avoids accidental data loss from blkid race conditions on boot.
if ! mount -o defaults "$DATA_DEV" "$DATA_MNT" 2>/dev/null; then
  echo "Mount failed — formatting new disk..."
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DATA_DEV"
  mount -o defaults "$DATA_DEV" "$DATA_MNT"
fi

if ! grep -q "google-actuarius-data" /etc/fstab; then
  echo "$DATA_DEV $DATA_MNT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

mkdir -p "$DATA_MNT/repos"

# --- Ensure app data is owned by appuser (UID 1001) inside the container ---
touch "$DATA_MNT/app.db"
chown 1001:1001 "$DATA_MNT"
find "$DATA_MNT" -maxdepth 1 -not -name .swapfile -not -path "$DATA_MNT" -exec chown -R 1001:1001 {} +

# --- Swap file (safety margin for Claude CLI subprocesses) ---
# Lives on the stateful partition, NOT the data disk: the data disk holds the
# palace/repos/worktrees and is space-constrained — a full /data wedges the bot,
# whereas the stateful partition (shared with /var/lib/docker) has headroom.
SWAP="/mnt/stateful_partition/swapfile"
# Migrate off the old data-disk location if present, reclaiming ~1 GB on /data.
OLD_SWAP="$DATA_MNT/.swapfile"
if [ -f "$OLD_SWAP" ]; then
  swapoff "$OLD_SWAP" 2>/dev/null || true
  rm -f "$OLD_SWAP"
fi
if [ ! -f "$SWAP" ]; then
  fallocate -l 1536M "$SWAP"
  chmod 600 "$SWAP"
  mkswap "$SWAP"
fi
swapon "$SWAP" 2>/dev/null || true

# --- Block containers from reaching the GCP metadata server ---
# A prompt-injected agent must never mint a GCP access token: the VM service
# account holds secretmanager.secretAccessor on every bot secret, so a single
# unauthenticated HTTP call to 169.254.169.254 from inside the container is
# total compromise (security review 2026-08-24, finding C-1).
#
# Boot model on COS (validated against production 2026-08-25): /etc is
# STATELESS on Container-Optimized OS — unit files and `systemctl enable`
# symlinks written here do NOT survive a reboot. Nothing about the units
# below is persistent; this script recreates them on every boot.
#   1. docker.service starts; dockerd creates DOCKER-USER and its FORWARD
#      jump. The bot container does NOT autostart: its restart policy is
#      "no". Legacy containers created before this design carry
#      unless-stopped and MUST be migrated first — see
#      scripts/cutover-metadata-isolation.sh, which flips the policy,
#      stops the container, and gates the reboot on both checkpoints.
#   2. google-startup-scripts runs THIS script: it writes the bootstrap and
#      both unit definitions into the fresh /etc, daemon-reloads, enables
#      them for this boot, and converges any drift by running the bootstrap
#      directly against the now-existing Docker chains.
#   3. Within this boot, actuarius-firewall.service wraps the same
#      bootstrap (Requires+After=docker.service) and actuarius-bot.service
#      Requires+Afters both — so the container starts only after verified
#      isolation, and a failed bootstrap keeps the bot down entirely
#      (fail closed).
#   4. The script finishes by redeploying, which starts the container
#      through `systemctl restart actuarius-bot.service`.
#
# Packet path once installed:
#   container -> FORWARD -> DOCKER-USER(rule 1: -j ACTUARIUS-META-A|B)
#     tcp|udp dpt 53 -> 169.254.169.254/32 : RETURN (container DNS works;
#       GCE resolves via the metadata address)
#     any other metadata traffic           : DROP
#     everything else                      : implicit return, normal traversal
#
# Repair transitions are exposure-free by construction: policy lives in two
# private generations; repairs populate the UNREFERENCED generation, switch
# the jump with ONE atomic rule operation, and only then touch the retired
# generation. The referenced chain is never flushed. Verification uses
# semantic probes (iptables -C membership, -nL row counts/target columns
# under LC_ALL=C) instead of -S text comparison, which real backends
# canonicalize unpredictably — with one exception: rule 1 must be an
# UNCONDITIONAL jump, and a conditionless rule serializes identically on
# every backend, so exact -S equality is used there. Absence of the legacy
# inline rules from older versions of this script is itself load-bearing —
# a surviving legacy DROP below the jump would break container DNS after a
# RETURN — so their removal is verified, not assumed.
EARLY_DIR="/etc/actuarius"
BOOTSTRAP="$EARLY_DIR/metadata-firewall-bootstrap.sh"
FIREWALL_UNIT="/etc/systemd/system/actuarius-firewall.service"
BOT_UNIT="/etc/systemd/system/actuarius-bot.service"
mkdir -p "$EARLY_DIR"

cat > "$BOOTSTRAP" <<'METADATA_FIREWALL_EOF'
#!/bin/bash
# Metadata-isolation engine for Actuarius (see infra/startup.sh for the boot
# model). Invoked by actuarius-firewall.service after docker.service, and
# directly by startup.sh for post-boot convergence. Idempotent; fail-closed.
set -euo pipefail

METADATA_IP="169.254.169.254"
GEN_A="ACTUARIUS-META-A"
GEN_B="ACTUARIUS-META-B"
LEGACY_SPECS=(
  "-d 169.254.169.254/32 -j DROP"
  "-p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT"
  "-p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT"
)
GEN_RULES=(
  "-p tcp -d 169.254.169.254/32 --dport 53 -j RETURN"
  "-p udp -d 169.254.169.254/32 --dport 53 -j RETURN"
  "-d 169.254.169.254/32 -j DROP"
)

fatal() {
  echo "FATAL: $*; refusing to continue without metadata isolation" >&2
}

# Semantic content check: exactly three rules, all three expected specs
# present, and the last rule's target is DROP. Uses -C (canonicalization-
# immune) and -nL columns under LC_ALL=C — never -S text comparison.
content_ok() {
  local gen="$1" rows last_target spec
  rows=$(LC_ALL=C iptables -w -nL "$gen" --line-numbers 2>/dev/null | grep -cE '^[[:space:]]*[0-9]+[[:space:]]' || true)
  [ "$rows" = "3" ] || return 1
  for spec in "${GEN_RULES[@]}"; do
    iptables -w -C "$gen" $spec 2>/dev/null || return 1
  done
  last_target=$(LC_ALL=C iptables -w -nL "$gen" --line-numbers 2>/dev/null | grep -E '^[[:space:]]*[0-9]+[[:space:]]' | tail -n 1 | awk '{print $2}')
  [ "$last_target" = "DROP" ]
}

# Target name of the FIRST rule of DOCKER-USER (a chain name when the rule
# is a jump). Canonicalization-immune: reads the -nL target column.
docker_user_first_target() {
  LC_ALL=C iptables -w -nL DOCKER-USER --line-numbers 2>/dev/null \
    | grep -E '^[[:space:]]*[0-9]+[[:space:]]' | head -n 1 | awk '{print $2}'
}

# First referenced managed generation anywhere in DOCKER-USER. A rule above
# it may itself be drift, but the referenced generation must remain attached
# until a complete replacement has been installed at rule 1.
docker_user_first_managed_target() {
  LC_ALL=C iptables -w -nL DOCKER-USER --line-numbers 2>/dev/null \
    | awk -v a="$GEN_A" -v b="$GEN_B" \
      '/^[[:space:]]*[0-9]+[[:space:]]/ && ($2 == a || $2 == b) { print $2; exit }'
}

managed_target_present() {
  local target="$1"
  LC_ALL=C iptables -w -nL DOCKER-USER --line-numbers 2>/dev/null \
    | awk -v target="$target" \
      '/^[[:space:]]*[0-9]+[[:space:]]/ && $2 == target { found=1 } END { exit !found }'
}

# Docker normally installs this as the first FORWARD rule. Accepting a
# conditional or shadowed occurrence would let some container traffic bypass
# DOCKER-USER entirely, so require the exact unconditional first rule.
forward_jump_is_unconditional_first() {
  local line
  line=$(iptables -S FORWARD 2>/dev/null | grep -- '-A FORWARD ' | head -n 1 || true)
  [ "$line" = "-A FORWARD -j DOCKER-USER" ]
}

# Rule 1 must be EXACTLY an unconditional jump. The -nL target column cannot
# distinguish `-j GEN` from `-p tcp -j GEN` (both report target GEN), so the
# fast path would accept conditional jumps that let UDP bypass policy. A
# conditionless rule has no match fields to canonicalize, so its serialized
# form is definitionally `-A DOCKER-USER -j GEN` on every backend — exact
# equality is safe precisely here, and only here.
jump_is_unconditional_first() {
  local gen="$1" line
  line=$(iptables -S DOCKER-USER 2>/dev/null | grep -- '-A DOCKER-USER ' | head -n 1)
  [ "$line" = "-A DOCKER-USER -j $gen" ]
}

# Every occurrence of a rule must be gone when its absence is load-bearing.
# Bounded loop distinguishes "absent" from "stuck": persistent presence is a
# failure, not completion.
purge_rule() {
  local chain="$1" i=0 spec
  shift
  spec="$*"
  while [ "$i" -lt 10 ]; do
    iptables -w -C "$chain" $spec 2>/dev/null || break
    iptables -w -D "$chain" $spec 2>/dev/null || break
    i=$((i + 1))
  done
  iptables -w -C "$chain" $spec 2>/dev/null && return 1
  return 0
}

# Remove every conditional or unconditional rule that targets a managed
# generation. The rule is round-tripped from iptables -S so deletion uses its
# canonical form. Callers keep another complete generation referenced until
# this returns successfully.
purge_managed_target() {
  local target="$1" line spec i=0
  while [ "$i" -lt 10 ]; do
    line=$(iptables -S DOCKER-USER 2>/dev/null \
      | grep -E -- "^-A DOCKER-USER (.* )?-j $target$" | head -n 1 || true)
    [ -n "$line" ] || break
    spec="${line#-A DOCKER-USER }"
    iptables -w -D DOCKER-USER $spec 2>/dev/null || break
    i=$((i + 1))
  done
  managed_target_present "$target" && return 1
  return 0
}

legacy_rules_absent() {
  local spec
  for spec in "${LEGACY_SPECS[@]}"; do
    iptables -w -C DOCKER-USER $spec 2>/dev/null && return 1
  done
  return 0
}

build_generation() {
  # Caller guarantees the generation is unreferenced, so flushing partial
  # state here can never expose live traffic.
  local gen="$1" spec
  iptables -w -N "$gen" 2>/dev/null || true
  iptables -w -F "$gen" || return 1
  for spec in "${GEN_RULES[@]}"; do
    iptables -w -A "$gen" $spec || return 1
  done
}

harden_metadata_access() {
  local attempts=60 first target source spec
  until systemctl is-active --quiet docker \
    && iptables -w -nL DOCKER-USER >/dev/null 2>&1 \
    && forward_jump_is_unconditional_first; do
    attempts=$((attempts - 1))
    if [ "$attempts" -le 0 ]; then
      fatal "docker/DOCKER-USER chain not ready in time"
      return 1
    fi
    sleep 1
  done

  first="$(docker_user_first_target)"
  source="$(docker_user_first_managed_target)"
  case "$source" in
    "$GEN_A") source="$GEN_A"; target="$GEN_B" ;;
    "$GEN_B") source="$GEN_B"; target="$GEN_A" ;;
    *) source=""; target="$GEN_A" ;;
  esac

  if [ -n "$source" ] \
    && content_ok "$source" \
    && jump_is_unconditional_first "$source" \
    && legacy_rules_absent \
    && ! managed_target_present "$target"; then
    return 0
  fi

  # Keep the first referenced managed generation attached while rebuilding.
  # Even when drift precedes it, removing that last policy before a successful
  # replacement would create a new exposure window and leave it open forever
  # if population failed.
  if [ -n "$source" ]; then
    purge_managed_target "$target" || { fatal "cannot detach $target"; return 1; }
  else
    purge_managed_target "$GEN_A" || { fatal "cannot detach $GEN_A"; return 1; }
    purge_managed_target "$GEN_B" || { fatal "cannot detach $GEN_B"; return 1; }
  fi
  build_generation "$target" || { fatal "could not build $target"; return 1; }

  if [ -n "$source" ] && [ "$first" = "$source" ]; then
    iptables -w -R DOCKER-USER 1 -j "$target" || { fatal "could not switch the jump"; return 1; }
  else
    iptables -w -I DOCKER-USER 1 -j "$target" || { fatal "could not install the jump"; return 1; }
  fi

  if [ -n "$source" ]; then
    purge_managed_target "$source" || { fatal "cannot retire $source"; return 1; }
    iptables -w -F "$source" 2>/dev/null || true
    iptables -w -X "$source" 2>/dev/null || true
  fi
  for spec in "${LEGACY_SPECS[@]}"; do
    purge_rule DOCKER-USER $spec || { fatal "cannot remove legacy rule ($*)"; return 1; }
  done

  # Post-repair gate: trust nothing above, including our own mutations.
  content_ok "$target" || { fatal "post-repair verification of $target failed"; return 1; }
  jump_is_unconditional_first "$target" || { fatal "jump is not an unconditional first rule after repair"; return 1; }
  legacy_rules_absent || { fatal "legacy metadata rules survive in DOCKER-USER"; return 1; }
  if [ -n "$source" ]; then
    managed_target_present "$source" && { fatal "$source jump survives after repair"; return 1; }
  fi
  return 0
}
METADATA_FIREWALL_EOF

cat >> "$BOOTSTRAP" <<'METADATA_FIREWALL_GUARD_EOF'

harden_metadata_access || exit 1
METADATA_FIREWALL_GUARD_EOF
chmod 700 "$BOOTSTRAP"

cat > "$FIREWALL_UNIT" <<EOF
[Unit]
Description=Actuarius metadata-server isolation (requires Docker chains)
Requires=docker.service
After=docker.service
PartOf=docker.service
Before=actuarius-bot.service

[Service]
Type=oneshot
ExecStart=/bin/bash ${BOOTSTRAP}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > "$BOT_UNIT" <<EOF
[Unit]
Description=Actuarius bot container lifecycle (owned by systemd)
Requires=docker.service actuarius-firewall.service
After=docker.service actuarius-firewall.service
PartOf=docker.service

[Service]
Type=simple
ExecStartPre=/bin/bash ${BOOTSTRAP}
ExecStart=/usr/bin/docker start -a actuarius
ExecStop=/usr/bin/docker stop -t 30 actuarius
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

# COS /etc is stateless: these files are recreated on every boot by this
# script, so enablement is per-boot by construction.
systemctl daemon-reload
systemctl enable actuarius-firewall.service actuarius-bot.service >/dev/null

# Converge this boot's drift through the exact code the firewall unit runs.
bash "$BOOTSTRAP"

# --- Install redeploy helper script from metadata ---
# Note: /var is mounted noexec on COS, so scripts must be invoked with `bash`
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
curl -sf -H "$HDR" "$META/env-redeploy-script" > /var/redeploy.sh

# --- Deploy the bot (reuses the same script used for manual redeploys) ---
bash /var/redeploy.sh
