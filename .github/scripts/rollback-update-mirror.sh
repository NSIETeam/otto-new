#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

readonly MIRROR_ROOT='/opt/otto-website'

fail() {
  printf 'update mirror rollback failed: %s\n' "$*" >&2
  exit 1
}

transaction_id="${1:-}"
expected_script_sha256="${2:-}"

[[ "$transaction_id" =~ ^v[0-9A-Za-z._-]+-[0-9]+-[0-9]+$ ]] ||
  fail 'invalid transaction id'
[[ "$transaction_id" != *'..'* ]] || fail 'invalid transaction id'
[[ "$expected_script_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'invalid rollback script digest'
[[ -f "$0" && ! -L "$0" ]] || fail 'rollback script is missing or is a symlink'
[[ "$(sha256sum -- "$0" | awk '{print $1}')" == "$expected_script_sha256" ]] ||
  fail 'rollback script digest mismatch'

releases_dir="$MIRROR_ROOT/otto-releases"
transaction_dir="$MIRROR_ROOT/transactions/$transaction_id"
previous_manifest="$transaction_dir/previous-latest.json"
previous_absent="$transaction_dir/previous-latest.absent"
current_manifest="$releases_dir/latest.json"

if [[ ! -d "$transaction_dir" ]]; then
  printf 'mirror transaction state was never created; no public manifest was changed\n'
  exit 0
fi

for protected_path in "$MIRROR_ROOT" "$releases_dir" "$transaction_dir"; do
  [[ ! -L "$protected_path" ]] || fail "protected path is a symlink: $protected_path"
done
[[ "$(readlink -f -- "$MIRROR_ROOT")" == "$MIRROR_ROOT" ]] ||
  fail 'mirror root resolves outside its fixed path'
[[ "$(stat -c '%u:%g:%a' -- "$transaction_dir")" == '0:0:700' ]] ||
  fail 'transaction state directory is not root-owned mode 0700'
[[ ! -L "$previous_manifest" && ! -L "$previous_absent" ]] ||
  fail 'transaction state contains a symlink'
[[ ! -e "$previous_manifest" || ! -e "$previous_absent" ]] ||
  fail 'transaction state has conflicting backups'

if [[ -f "$previous_manifest" ]]; then
  rollback_next="$releases_dir/.latest.json.${transaction_id}.rollback-next"
  install -o root -g root -m 0644 -- "$previous_manifest" "$rollback_next"
  mv -f -- "$rollback_next" "$current_manifest"
elif [[ -f "$previous_absent" ]]; then
  rm -f -- "$current_manifest"
else
  printf 'mirror transaction did not reach the manifest backup; no public manifest was changed\n'
  exit 0
fi

install -o root -g root -m 0600 /dev/null "$transaction_dir/rolled-back"
printf 'rolled back update mirror transaction %s\n' "$transaction_id"
