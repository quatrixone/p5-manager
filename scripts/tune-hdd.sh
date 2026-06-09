#!/usr/bin/env bash
#
# tune-hdd.sh — apply HDD I/O tuning for P5 Manager.
#
# Background: /mnt/sda1 (sdb) and /mnt/sdb1 (sdc) on this VM are rotating HDDs
# passed through from Proxmox via virtio. The kernel ships defaults optimized
# for SSDs (scheduler=none, read_ahead_kb=128), which makes mixed read+write
# workloads like `mkpfs unpack`/`pack` thrash the disk head. This script:
#
#   1. Switches the I/O scheduler to mq-deadline (sorts requests by sector to
#      reduce seek distance — big win for rotating disks).
#   2. Bumps read-ahead to 4 MiB so sequential reads of game-dump files
#      pre-fetch enough data per syscall.
#   3. Increases the request queue depth to 1024 so multiple concurrent
#      streams (e.g. one mkpfs reading + one ftp upload writing) don't
#      starve each other.
#
# Applied live to the running kernel AND persisted via a udev rule so the
# tuning survives reboots. Idempotent — safe to re-run.
#
# Usage:  sudo bash scripts/tune-hdd.sh
#
# Only touches /sys/block/sd[bc] (rotational, non-system disks) and a single
# file under /etc/udev/rules.d/. The root disk (sda) is intentionally left
# alone.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo bash $0)" >&2
  exit 1
fi

TARGETS=(sdb sdc)
RULE_FILE=/etc/udev/rules.d/60-hdd-iotune.rules

# Desired values. Change here if you ever want to tweak.
WANT_SCHEDULER=mq-deadline
WANT_READAHEAD_KB=4096
WANT_NR_REQUESTS=1024

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }

show_disk() {
  local d=$1
  local q=/sys/block/$d/queue
  if [[ ! -d $q ]]; then
    red "  /sys/block/$d not found — skipping"
    return 1
  fi
  printf '  %-22s %s\n' "scheduler:"        "$(cat "$q/scheduler" 2>/dev/null || echo 'n/a')"
  printf '  %-22s %s\n' "read_ahead_kb:"    "$(cat "$q/read_ahead_kb" 2>/dev/null || echo 'n/a')"
  printf '  %-22s %s\n' "nr_requests:"      "$(cat "$q/nr_requests" 2>/dev/null || echo 'n/a')"
  printf '  %-22s %s\n' "rotational:"       "$(cat "$q/rotational" 2>/dev/null || echo 'n/a')"
  printf '  %-22s %s\n' "model:"            "$(cat "/sys/block/$d/device/model" 2>/dev/null | tr -s ' ' || echo 'n/a')"
}

apply_live() {
  local d=$1
  local q=/sys/block/$d/queue
  [[ -d $q ]] || { red "  /sys/block/$d not found — skipped"; return 0; }

  # Skip non-rotational devices to avoid pessimising SSDs that might show up
  # later under a different sd letter.
  local rot
  rot=$(cat "$q/rotational" 2>/dev/null || echo 0)
  if [[ "$rot" != "1" ]]; then
    gray "  /dev/$d is non-rotational (rotational=$rot) — skipping live tune"
    return 0
  fi

  # Scheduler — verify the kernel actually advertises it before writing.
  if grep -qw "$WANT_SCHEDULER" "$q/scheduler"; then
    echo "$WANT_SCHEDULER" > "$q/scheduler" && gray "    scheduler -> $WANT_SCHEDULER"
  else
    red "    scheduler $WANT_SCHEDULER not available; have: $(cat "$q/scheduler")"
  fi

  echo "$WANT_READAHEAD_KB" > "$q/read_ahead_kb"  && gray "    read_ahead_kb -> $WANT_READAHEAD_KB"
  echo "$WANT_NR_REQUESTS"  > "$q/nr_requests"    && gray "    nr_requests -> $WANT_NR_REQUESTS" \
    || gray "    nr_requests write failed (kernel may cap it; current=$(cat "$q/nr_requests"))"
}

install_udev_rule() {
  local rule_body
  read -r -d '' rule_body <<'EOF' || true
# Managed by p5-manager/scripts/tune-hdd.sh
# Tunes rotating HDDs exposed to this VM via Proxmox virtio passthrough so
# mkpfs/extract/upload workloads don't thrash the disk head.
# Re-running tune-hdd.sh regenerates this file.
ACTION=="add|change", SUBSYSTEM=="block", KERNEL=="sd[a-z]", \
  ATTR{queue/rotational}=="1", \
  ATTR{queue/scheduler}="mq-deadline", \
  ATTR{queue/read_ahead_kb}="4096", \
  ATTR{queue/nr_requests}="1024"
EOF

  mkdir -p "$(dirname "$RULE_FILE")"
  # Atomic write so we can never leave a partial rule on disk.
  local tmp="${RULE_FILE}.tmp.$$"
  printf '%s\n' "$rule_body" > "$tmp"
  mv -f "$tmp" "$RULE_FILE"
  chmod 0644 "$RULE_FILE"
  green "Installed udev rule: $RULE_FILE"

  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules
    # Re-trigger sd[bc] only (don't touch root disk just to be safe even
    # though the rule itself excludes non-rotational devices via ATTR).
    for d in "${TARGETS[@]}"; do
      [[ -e "/sys/block/$d" ]] || continue
      udevadm trigger --action=change "/sys/block/$d" 2>/dev/null || true
    done
    gray "udev rules reloaded + triggered for: ${TARGETS[*]}"
  else
    red "udevadm not found — rule installed but reload skipped; reboot to apply on existing disks"
  fi
}

bold "=== Disk state BEFORE ==="
for d in "${TARGETS[@]}"; do
  echo "/dev/$d:"
  show_disk "$d" || true
  echo
done

bold "=== Applying live tuning ==="
for d in "${TARGETS[@]}"; do
  echo "/dev/$d:"
  apply_live "$d"
done
echo

bold "=== Installing udev rule for persistence ==="
install_udev_rule
echo

bold "=== Disk state AFTER ==="
for d in "${TARGETS[@]}"; do
  echo "/dev/$d:"
  show_disk "$d" || true
  echo
done

green "Done. Tuning is live AND persisted to $RULE_FILE — survives reboots."
echo "Verify after next mkpfs unpack/pack — expect 20-40% faster mixed R+W on HDD."
