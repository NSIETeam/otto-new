#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

readonly MIRROR_ROOT='/opt/otto-website'
readonly STAGING_ROOT='/var/tmp/otto-update-mirror'

fail() {
  printf 'update mirror publish failed: %s\n' "$*" >&2
  exit 1
}

transaction_id="${1:-}"
expected_manifest_sha256="${2:-}"
expected_script_sha256="${3:-}"

[[ "$transaction_id" =~ ^v[0-9A-Za-z._-]+-[0-9]+-[0-9]+$ ]] ||
  fail 'invalid transaction id'
[[ "$transaction_id" != *'..'* ]] || fail 'invalid transaction id'
[[ "$expected_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'invalid payload manifest digest'
[[ "$expected_script_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'invalid publish script digest'

staging_dir="$STAGING_ROOT/$transaction_id"
manifest_path="$staging_dir/SHA256SUMS"
script_path="$staging_dir/publish-update-mirror.sh"

[[ -d "$staging_dir" && ! -L "$staging_dir" ]] ||
  fail 'staging directory is missing or is a symlink'
[[ -f "$manifest_path" && ! -L "$manifest_path" ]] ||
  fail 'payload manifest is missing or is a symlink'
[[ -f "$script_path" && ! -L "$script_path" ]] ||
  fail 'publish script is missing or is a symlink'
[[ "$(readlink -f -- "$0")" == "$(readlink -f -- "$script_path")" ]] ||
  fail 'unexpected publish script path'
[[ "$(sha256sum -- "$script_path" | awk '{print $1}')" == "$expected_script_sha256" ]] ||
  fail 'publish script digest mismatch'
[[ "$(sha256sum -- "$manifest_path" | awk '{print $1}')" == "$expected_manifest_sha256" ]] ||
  fail 'payload manifest digest mismatch'

declare -A manifest_files=()
declare -a asset_files=()
latest_count=0
while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
  [[ "$manifest_line" =~ ^([0-9a-f]{64})[[:space:]][[:space:]](Otto-[0-9A-Za-z._-]+|latest\.json)$ ]] ||
    fail 'payload manifest contains an unsafe entry'
  payload_name="${BASH_REMATCH[2]}"
  [[ -z "${manifest_files[$payload_name]+present}" ]] ||
    fail "payload manifest contains a duplicate entry: $payload_name"
  [[ -f "$staging_dir/$payload_name" && ! -L "$staging_dir/$payload_name" ]] ||
    fail "payload is missing or is a symlink: $payload_name"
  manifest_files["$payload_name"]="${BASH_REMATCH[1]}"
  if [[ "$payload_name" == 'latest.json' ]]; then
    latest_count=$((latest_count + 1))
  else
    asset_files+=("$payload_name")
  fi
done < "$manifest_path"

[[ "$latest_count" -eq 1 ]] || fail 'payload must contain one latest.json'
[[ "${#asset_files[@]}" -eq 6 ]] || fail 'payload must contain six desktop assets'

mapfile -d '' -t staged_assets < <(
  find "$staging_dir" -maxdepth 1 -type f -name 'Otto-*' -print0
)
[[ "${#staged_assets[@]}" -eq "${#asset_files[@]}" ]] ||
  fail 'staging directory contains an unmanifested desktop asset'

(
  cd -- "$staging_dir"
  sha256sum -c -- SHA256SUMS
)

downloads_dir="$MIRROR_ROOT/downloads"
releases_dir="$MIRROR_ROOT/otto-releases"
transactions_dir="$MIRROR_ROOT/transactions"
transaction_dir="$transactions_dir/$transaction_id"

for protected_path in \
  "$MIRROR_ROOT" \
  "$downloads_dir" \
  "$releases_dir" \
  "$transactions_dir" \
  "$transaction_dir"; do
  [[ ! -L "$protected_path" ]] || fail "protected path is a symlink: $protected_path"
done

install -d -o root -g root -m 0755 \
  "$MIRROR_ROOT" "$downloads_dir" "$releases_dir" "$transactions_dir"
[[ "$(readlink -f -- "$MIRROR_ROOT")" == "$MIRROR_ROOT" ]] ||
  fail 'mirror root resolves outside its fixed path'
install -d -o root -g root -m 0700 "$transaction_dir"
[[ "$(stat -c '%u:%g:%a' -- "$transaction_dir")" == '0:0:700' ]] ||
  fail 'transaction state directory is not root-owned mode 0700'

previous_manifest="$transaction_dir/previous-latest.json"
previous_absent="$transaction_dir/previous-latest.absent"
current_manifest="$releases_dir/latest.json"
[[ ! -L "$previous_manifest" && ! -L "$previous_absent" ]] ||
  fail 'transaction state contains a symlink'
[[ ! -e "$previous_manifest" || ! -e "$previous_absent" ]] ||
  fail 'transaction state has conflicting backups'

if [[ ! -e "$previous_manifest" && ! -e "$previous_absent" ]]; then
  if [[ -e "$current_manifest" || -L "$current_manifest" ]]; then
    [[ -f "$current_manifest" && ! -L "$current_manifest" ]] ||
      fail 'current latest.json is not a regular file'
    install -o root -g root -m 0600 -- \
      "$current_manifest" "$previous_manifest.next"
    mv -f -- "$previous_manifest.next" "$previous_manifest"
  else
    install -o root -g root -m 0600 /dev/null "$previous_absent"
  fi
fi

for asset_name in "${asset_files[@]}"; do
  asset_next="$downloads_dir/.${asset_name}.${transaction_id}.next"
  install -o root -g root -m 0644 -- "$staging_dir/$asset_name" "$asset_next"
  [[ "$(sha256sum -- "$asset_next" | awk '{print $1}')" == "${manifest_files[$asset_name]}" ]] ||
    fail "installed desktop asset digest mismatch: $asset_name"
  mv -f -- "$asset_next" "$downloads_dir/$asset_name"
done

latest_next="$releases_dir/.latest.json.${transaction_id}.next"
install -o root -g root -m 0644 -- "$staging_dir/latest.json" "$latest_next"
[[ "$(sha256sum -- "$latest_next" | awk '{print $1}')" == "${manifest_files[latest.json]}" ]] ||
  fail 'installed latest.json digest mismatch'
mv -f -- "$latest_next" "$current_manifest"
install -o root -g root -m 0600 /dev/null "$transaction_dir/committed"

printf 'published update mirror transaction %s\n' "$transaction_id"
