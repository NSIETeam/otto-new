#!/bin/bash -p
set -Eeuo pipefail
umask 022

unset BASH_ENV ENV CDPATH TMPDIR PYTHONHOME PYTHONPATH OPENSSL_CONF \
  OPENSSL_MODULES OPENSSL_ENGINES TAR_OPTIONS GZIP GZIP_OPT XZ_OPT BZIP2 \
  NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS \
  LD_PRELOAD LD_LIBRARY_PATH XDG_CONFIG_HOME XDG_CACHE_HOME \
  GCONV_PATH LOCPATH NLSPATH PYTHONWARNINGS RUBYOPT PERL5OPT PERL5LIB
readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C
export HOME=/root USER=root LOGNAME=root SHELL=/bin/bash
cd /

readonly MIRROR_ROOT='/opt/otto-website'
readonly STATE_ROOT='/var/lib/otto-ci-deploy'
readonly LOCKS_ROOT='/var/lib/otto-ci-deploy/locks'
readonly CURRENT_OWNER_PATH='/var/lib/otto-ci-deploy/mirror-current-owner'
readonly ROLLBACK_CAPABILITY_PATH='/var/lib/otto-ci-deploy/mirror-rollback-capability'

fail() {
  printf 'update mirror rollback failed: %s\n' "$*" >&2
  exit 1
}

require_root_owned_nonwritable_path() {
  local path="$1"
  [[ "$(stat -c '%u:%g' -- "$path")" == '0:0' ]] \
    || fail "rollback path is not root-owned: $path"
  if find "$path" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "rollback path is group/other writable: $path"
  fi
}

[ "$(id -u)" -eq 0 ] || fail 'rollback must run as root'
[[ -f "$0" && ! -L "$0" ]] || fail 'root-owned rollback is missing or unsafe'
[[ "$(stat -c '%u:%g' "$0")" == '0:0' ]] || fail 'rollback is not root-owned'
if find "$0" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
  fail 'rollback is group/other writable'
fi
[[ -d "$LOCKS_ROOT" && ! -L "$LOCKS_ROOT" ]] \
  || fail 'root-owned lock directory is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' "$LOCKS_ROOT")" == '0:0:700' ]] \
  || fail 'root-owned lock directory has an unsafe owner or mode'
[[ -x /usr/bin/flock ]] || fail 'required /usr/bin/flock is unavailable'
[[ -x /usr/bin/sync ]] || fail 'required /usr/bin/sync is unavailable'
[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] \
  || fail 'root-owned state directory is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' "$STATE_ROOT")" == '0:0:711' ]] \
  || fail 'root-owned state directory has an unsafe owner or mode'
mirror_lock_path="${LOCKS_ROOT}/mirror-publication.lock"
if [[ -e "$mirror_lock_path" || -L "$mirror_lock_path" ]]; then
  [[ -f "$mirror_lock_path" && ! -L "$mirror_lock_path" ]] \
    || fail 'mirror lock is not a regular file'
  [[ "$(stat -c '%u:%g' "$mirror_lock_path")" == '0:0' ]] \
    || fail 'mirror lock is not root-owned'
fi
exec 8>"$mirror_lock_path"
chmod 0600 "$mirror_lock_path"
/usr/bin/flock -x -w 600 8 \
  || fail 'another mirror publication or rollback did not finish within 600 seconds'

transaction_id="${1:-}"
[[ "$transaction_id" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+)-[0-9]+-[0-9]+$ ]] \
  || fail 'invalid transaction id'
version="${BASH_REMATCH[1]#v}"

releases_dir="$MIRROR_ROOT/otto-releases"
downloads_dir="$MIRROR_ROOT/downloads"
transaction_dir="$MIRROR_ROOT/transactions/$transaction_id"
previous_manifest="$transaction_dir/previous-latest.json"
previous_absent="$transaction_dir/previous-latest.absent"
previous_owner="$transaction_dir/previous-owner"
previous_owner_absent="$transaction_dir/previous-owner.absent"
published_manifest="$transaction_dir/published-latest.json"
asset_ledger="$transaction_dir/UPDATE-MIRROR-SHA256SUMS"
asset_ledger_signature="$transaction_dir/UPDATE-MIRROR-SHA256SUMS.sig"
transaction_rollback_capability="$transaction_dir/rollback-capability"
rollback_started="$transaction_dir/rollback-started"
current_manifest="$releases_dir/latest.json"
rollback_next_files=()
cleanup_rollback_next_files() {
  if [[ "${#rollback_next_files[@]}" -gt 0 ]]; then
    rm -f -- "${rollback_next_files[@]}"
  fi
}
trap cleanup_rollback_next_files EXIT

emit_current_manifest_digest() {
  if [[ -e "$current_manifest" || -L "$current_manifest" ]]; then
    [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
      || fail 'current latest.json is not a regular file'
    require_root_owned_nonwritable_path "$current_manifest"
    [[ "$(stat -c '%u:%g:%a' -- "$current_manifest")" == '0:0:644' ]] \
      || fail 'current latest.json is not web-readable mode 0644'
    printf 'restored_manifest_sha256=%s\n' \
      "$(sha256sum -- "$current_manifest" | awk '{print $1}')"
  else
    printf 'restored_manifest_sha256=absent\n'
  fi
}

current_owner=''
if [[ -e "$CURRENT_OWNER_PATH" || -L "$CURRENT_OWNER_PATH" ]]; then
  [[ -f "$CURRENT_OWNER_PATH" && ! -L "$CURRENT_OWNER_PATH" ]] \
    || fail 'mirror current owner is not a regular file'
  [[ "$(stat -c '%u:%g:%a' "$CURRENT_OWNER_PATH")" == '0:0:600' ]] \
    || fail 'mirror current owner has an unsafe owner or mode'
  current_owner="$(<"$CURRENT_OWNER_PATH")"
  [[ "$current_owner" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'mirror current owner is invalid'
fi

if [[ ! -d "$transaction_dir" ]]; then
  [[ "$current_owner" != "$transaction_id" ]] \
    || fail 'current mirror owner has no transaction state'
  printf 'mirror transaction state was never created; no public manifest was changed\n'
  emit_current_manifest_digest
  exit 0
fi
for protected_path in \
  "$MIRROR_ROOT" "$releases_dir" "$downloads_dir" "$transaction_dir"; do
  [[ ! -L "$protected_path" ]] || fail "protected path is a symlink: $protected_path"
  require_root_owned_nonwritable_path "$protected_path"
done
[[ "$(stat -c '%u:%g:%a' -- "$MIRROR_ROOT")" == '0:0:755' ]] \
  || fail 'mirror root does not have exact root:root mode 0755'
[[ "$(stat -c '%u:%g:%a' -- "$releases_dir")" == '0:0:755' ]] \
  || fail 'release directory does not have exact root:root mode 0755'
[[ "$(stat -c '%u:%g:%a' -- "$downloads_dir")" == '0:0:755' ]] \
  || fail 'download directory does not have exact root:root mode 0755'
[[ "$(readlink -f -- "$MIRROR_ROOT")" == "$MIRROR_ROOT" ]] \
  || fail 'mirror root resolves outside its fixed path'
[[ "$(stat -c '%u:%g:%a' -- "$transaction_dir")" == '0:0:700' ]] \
  || fail 'transaction state directory is not root-owned mode 0700'
[[ ! -L "$previous_manifest" && ! -L "$previous_absent" \
  && ! -L "$previous_owner" && ! -L "$previous_owner_absent" \
  && ! -L "$published_manifest" && ! -L "$asset_ledger" \
  && ! -L "$asset_ledger_signature" \
  && ! -L "$transaction_rollback_capability" && ! -L "$rollback_started" ]] \
  || fail 'transaction state contains a symlink'
[[ ! -e "$previous_manifest" || ! -e "$previous_absent" ]] \
  || fail 'transaction state has conflicting backups'
[[ ! -e "$previous_owner" || ! -e "$previous_owner_absent" ]] \
  || fail 'transaction state has conflicting owner backups'
for transaction_file in \
  "$previous_manifest" "$previous_absent" \
  "$previous_owner" "$previous_owner_absent" "$published_manifest" \
  "$asset_ledger" "$asset_ledger_signature" \
  "$transaction_rollback_capability" "$rollback_started" \
  "$transaction_dir/claiming" "$transaction_dir/committed" \
  "$transaction_dir/rolled-back"; do
  if [[ -e "$transaction_file" ]]; then
    [[ -f "$transaction_file" && ! -L "$transaction_file" ]] \
      || fail "transaction state is not a regular file: $transaction_file"
    require_root_owned_nonwritable_path "$transaction_file"
    [[ "$(stat -c '%u:%g:%a' -- "$transaction_file")" == '0:0:600' ]] \
      || fail "transaction state does not have exact root:root mode 0600: $transaction_file"
  fi
done
if [[ -f "$previous_owner" ]]; then
  saved_previous_owner="$(<"$previous_owner")"
  [[ "$saved_previous_owner" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'saved previous mirror owner is invalid'
fi
if [[ -e "$current_manifest" || -L "$current_manifest" ]]; then
  [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
    || fail 'current latest.json is not a regular file'
  require_root_owned_nonwritable_path "$current_manifest"
  [[ "$(stat -c '%u:%g:%a' -- "$current_manifest")" == '0:0:644' ]] \
    || fail 'current latest.json is not web-readable mode 0644'
fi

cleanup_abandoned_publish_temps() {
  local asset_name temp_path
  local removed='false'
  local -a abandoned_publish_temps=(
    "${STATE_ROOT}/.mirror-rollback-capability.${transaction_id}.next"
    "${STATE_ROOT}/.mirror-current-owner.${transaction_id}.next"
    "${releases_dir}/.latest.json.${transaction_id}.next"
  )
  local -a immutable_asset_names=(
    "Otto-${version}-arm64.dmg"
    "Otto-${version}-arm64.dmg.blockmap"
    "Otto-${version}-x64.dmg"
    "Otto-${version}-x64.dmg.blockmap"
    "Otto-Setup-${version}-win-x64.exe"
    "Otto-Setup-${version}-win-x64.exe.blockmap"
  )
  for asset_name in "${immutable_asset_names[@]}"; do
    abandoned_publish_temps+=(
      "${downloads_dir}/.${asset_name}.${transaction_id}.next"
    )
  done
  for temp_path in "${abandoned_publish_temps[@]}"; do
    if [[ ! -e "$temp_path" && ! -L "$temp_path" ]]; then
      continue
    fi
    [[ -f "$temp_path" && ! -L "$temp_path" ]] \
      || fail "abandoned publish temporary path is unsafe: $temp_path"
    require_root_owned_nonwritable_path "$temp_path"
    rm -f -- "$temp_path"
    removed='true'
  done
  if [[ "$removed" == 'true' ]]; then
    /usr/bin/sync -f "$STATE_ROOT"
    /usr/bin/sync -f "$releases_dir"
    /usr/bin/sync -f "$downloads_dir"
  fi
}

# Publication and rollback hold the same lock. Any exact transaction-bound
# .next path still present here is an uncommitted publisher write, including a
# crash-torn large asset. Remove only this transaction's fixed whitelist.
cleanup_abandoned_publish_temps

mark_rolled_back() {
  install -o root -g root -m 0600 /dev/null "$transaction_dir/rolled-back"
  /usr/bin/sync -f "$transaction_dir"
}

previous_manifest_is_current() {
  if [[ -f "$previous_manifest" && -f "$current_manifest" \
    && ! -L "$current_manifest" ]] \
    && cmp -s -- "$current_manifest" "$previous_manifest"; then
    return 0
  elif [[ -f "$previous_absent" && ! -e "$current_manifest" \
    && ! -L "$current_manifest" ]]; then
    return 0
  fi
  return 1
}

previous_owner_is_current() {
  if [[ -f "$previous_owner" \
    && "$current_owner" == "$(<"$previous_owner")" ]]; then
    return 0
  elif [[ -f "$previous_owner_absent" && -z "$current_owner" ]]; then
    return 0
  fi
  return 1
}

previous_state_is_current() {
  previous_manifest_is_current && previous_owner_is_current
}

validate_claimed_asset_ledger() {
  [[ -f "$published_manifest" && ! -L "$published_manifest" \
    && -f "$asset_ledger" && ! -L "$asset_ledger" \
    && -f "$asset_ledger_signature" && ! -L "$asset_ledger_signature" ]] \
    || fail 'claimed transaction has no complete immutable asset audit ledger'
  /usr/bin/python3 -I -S - \
    "$asset_ledger" "$published_manifest" "$MIRROR_ROOT/downloads" "$version" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

ledger_path = pathlib.Path(sys.argv[1])
published_manifest = pathlib.Path(sys.argv[2])
downloads_dir = pathlib.Path(sys.argv[3])
expected_version = sys.argv[4]

def reject_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate JSON field: {key}')
        value[key] = item
    return value

raw = ledger_path.read_bytes()
try:
    ledger = json.loads(raw, object_pairs_hook=reject_duplicates)
except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f'immutable asset audit ledger is invalid JSON: {error}')
if not isinstance(ledger, dict) or set(ledger) != {
    'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'
}:
    raise SystemExit('immutable asset audit ledger fields are not exact')
if ledger['format'] != 'otto-update-mirror-payload-v1':
    raise SystemExit('immutable asset audit ledger format is invalid')
if ledger['version'] != expected_version:
    raise SystemExit('immutable asset audit ledger version does not match its transaction')
if not isinstance(ledger['packageIdentity'], str) or not re.fullmatch(
    r'[0-9a-f]{12}-[0-9a-f]{12}', ledger['packageIdentity']
):
    raise SystemExit('immutable asset audit ledger packageIdentity is invalid')
if not isinstance(ledger['sourceCommit'], str) or not re.fullmatch(
    r'[0-9a-f]{40}', ledger['sourceCommit']
):
    raise SystemExit('immutable asset audit ledger sourceCommit is invalid')
expected_names = [
    f'Otto-{expected_version}-arm64.dmg',
    f'Otto-{expected_version}-arm64.dmg.blockmap',
    f'Otto-{expected_version}-x64.dmg',
    f'Otto-{expected_version}-x64.dmg.blockmap',
    f'Otto-Setup-{expected_version}-win-x64.exe',
    f'Otto-Setup-{expected_version}-win-x64.exe.blockmap',
    'latest.json',
]
assets = ledger['assets']
if not isinstance(assets, list) or len(assets) != len(expected_names):
    raise SystemExit('immutable asset audit ledger does not contain the exact asset set')
canonical = (json.dumps(ledger, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n').encode()
if raw != canonical:
    raise SystemExit('immutable asset audit ledger is not canonical')
for index, expected_name in enumerate(expected_names):
    asset = assets[index]
    if not isinstance(asset, dict) or set(asset) != {'name', 'size', 'sha256'}:
        raise SystemExit('immutable asset audit ledger asset fields are not exact')
    if asset['name'] != expected_name:
        raise SystemExit('immutable asset audit ledger does not contain the exact asset set')
    if not isinstance(asset['size'], int) or isinstance(asset['size'], bool) or asset['size'] < 1:
        raise SystemExit(f'immutable asset audit ledger size is invalid: {expected_name}')
    if not isinstance(asset['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', asset['sha256']):
        raise SystemExit(f'immutable asset audit ledger digest is invalid: {expected_name}')

def verify_file(file_path, asset, failure):
    opened = os.open(file_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(opened)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0:
            raise SystemExit(failure)
        if metadata.st_size != asset['size']:
            raise SystemExit(failure)
        digest = hashlib.sha256()
        while chunk := os.read(opened, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise SystemExit(failure)
    finally:
        os.close(opened)

latest_asset = assets[-1]
verify_file(
    published_manifest,
    latest_asset,
    'private published manifest does not match its immutable asset ledger',
)
for asset in assets[:-1]:
    installed_asset = downloads_dir / asset['name']
    if installed_asset.exists() or installed_asset.is_symlink():
        try:
            mode = installed_asset.lstat().st_mode
        except OSError:
            raise SystemExit(f'version-burned immutable asset is unsafe: {asset["name"]}')
        if not stat.S_ISREG(mode) or stat.S_IMODE(mode) != 0o644:
            raise SystemExit(f'version-burned immutable asset is unsafe: {asset["name"]}')
        verify_file(
            installed_asset,
            asset,
            f'version-burned immutable asset does not match its audit ledger: {asset["name"]}',
        )
PY
}

load_rollback_capability() {
  [[ -f "$ROLLBACK_CAPABILITY_PATH" && ! -L "$ROLLBACK_CAPABILITY_PATH" ]] \
    || fail 'active rollback capability is missing or unsafe'
  require_root_owned_nonwritable_path "$ROLLBACK_CAPABILITY_PATH"
  [[ "$(stat -c '%u:%g:%a' "$ROLLBACK_CAPABILITY_PATH")" == '0:0:600' ]] \
    || fail 'active rollback capability has an unsafe owner or mode'
  local -a capability_lines
  mapfile -t capability_lines < "$ROLLBACK_CAPABILITY_PATH"
  [[ "${#capability_lines[@]}" -eq 2 \
    && "${capability_lines[0]}" =~ ^transaction=(v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+)$ \
    && "${capability_lines[1]}" =~ ^expires=([0-9]+)$ ]] \
    || fail 'active rollback capability format is invalid'
  CAPABILITY_TRANSACTION="${capability_lines[0]#transaction=}"
  CAPABILITY_EXPIRES="${capability_lines[1]#expires=}"
}

require_active_rollback_capability() {
  [[ -f "$transaction_rollback_capability" \
    && ! -L "$transaction_rollback_capability" ]] \
    || fail 'transaction rollback capability is missing or unsafe'
  local -a transaction_capability_lines
  mapfile -t transaction_capability_lines < "$transaction_rollback_capability"
  [[ "${#transaction_capability_lines[@]}" -eq 2 \
    && "${transaction_capability_lines[0]}" == "transaction=${transaction_id}" \
    && "${transaction_capability_lines[1]}" =~ ^expires=([0-9]+)$ ]] \
    || fail 'transaction rollback capability format is invalid'
  local capability_digest
  capability_digest="$(sha256sum -- "$transaction_rollback_capability" | awk '{print $1}')"
  [[ "$capability_digest" =~ ^[0-9a-f]{64}$ ]] \
    || fail 'transaction rollback capability digest is invalid'
  local rollback_started_next=''
  local expected_rollback_started=''
  printf -v expected_rollback_started \
    'transaction=%s\ncapability_sha256=%s\n' \
    "$transaction_id" "$capability_digest"
  local candidate pending_complete=''
  local -a pending_candidates=()
  if [[ -e "$transaction_dir/.rollback-started.next" \
    || -L "$transaction_dir/.rollback-started.next" ]]; then
    pending_candidates+=("$transaction_dir/.rollback-started.next")
  fi
  shopt -s nullglob
  pending_candidates+=("$transaction_dir"/.rollback-started.*.next)
  shopt -u nullglob
  for candidate in "${pending_candidates[@]}"; do
    [[ -f "$candidate" && ! -L "$candidate" \
      && "$(stat -c '%u:%g' "$candidate")" == '0:0' ]] \
      || fail 'rollback-started temporary marker is unsafe'
    local -a pending_started_lines
    mapfile -t pending_started_lines < "$candidate"
    if [[ "${#pending_started_lines[@]}" -eq 2 \
      && "${pending_started_lines[0]}" == "transaction=${transaction_id}" \
      && "${pending_started_lines[1]}" == "capability_sha256=${capability_digest}" ]]; then
      [[ -z "$pending_complete" ]] \
        || fail 'multiple complete rollback-started temporary markers exist'
      chmod 0600 "$candidate"
      /usr/bin/sync -f "$candidate"
      pending_complete="$candidate"
    elif [[ "$(stat -c '%s' "$candidate")" -lt \
      "${#expected_rollback_started}" ]] \
      && /usr/bin/cmp -n "$(stat -c '%s' "$candidate")" -- \
        "$candidate" <(printf '%s' "$expected_rollback_started"); then
      # printf > file can be interrupted at any byte. A root-owned file inside
      # this root-only directory that is an exact prefix of the authorized
      # marker is uncommitted state, so remove it and rebuild after validation.
      rm -f -- "$candidate"
      /usr/bin/sync -f "$transaction_dir"
    else
      fail 'rollback-started temporary marker does not match its transaction capability'
    fi
  done
  if [[ -n "$pending_complete" ]]; then
    mv -f -- "$pending_complete" "$rollback_started"
    /usr/bin/sync -f "$transaction_dir"
    return 0
  fi

  if [[ -e "$rollback_started" || -L "$rollback_started" ]]; then
    [[ -f "$rollback_started" && ! -L "$rollback_started" ]] \
      || fail 'rollback-started marker is missing or unsafe'
    local -a started_lines
    mapfile -t started_lines < "$rollback_started"
    [[ "${#started_lines[@]}" -eq 2 \
      && "${started_lines[0]}" == "transaction=${transaction_id}" \
      && "${started_lines[1]}" == "capability_sha256=${capability_digest}" ]] \
      || fail 'rollback-started marker does not match its transaction capability'
    return 0
  fi

  load_rollback_capability
  [[ "$CAPABILITY_TRANSACTION" == "$transaction_id" ]] \
    || fail 'rollback capability is not bound to this transaction'
  cmp -s -- "$ROLLBACK_CAPABILITY_PATH" "$transaction_rollback_capability" \
    || fail 'active rollback capability does not match its transaction record'
  [[ "$(date +%s)" -le "$CAPABILITY_EXPIRES" ]] \
    || fail 'rollback capability has expired'

  rollback_started_next="$(mktemp "$transaction_dir/.rollback-started.XXXXXXXX.next")"
  [[ -f "$rollback_started_next" && ! -L "$rollback_started_next" ]] \
    || fail 'could not safely create rollback-started temporary marker'
  chown root:root "$rollback_started_next"
  chmod 0600 "$rollback_started_next"
  printf 'transaction=%s\ncapability_sha256=%s\n' \
    "$transaction_id" "$capability_digest" > "$rollback_started_next"
  /usr/bin/sync -f "$rollback_started_next"
  mv -f -- "$rollback_started_next" "$rollback_started"
  /usr/bin/sync -f "$transaction_dir"
}

consume_rollback_capability_if_owned() {
  if [[ ! -e "$ROLLBACK_CAPABILITY_PATH" \
    && ! -L "$ROLLBACK_CAPABILITY_PATH" ]]; then
    return 0
  fi
  load_rollback_capability
  [[ "$CAPABILITY_TRANSACTION" == "$transaction_id" ]] || return 0
  [[ -f "$transaction_rollback_capability" \
    && ! -L "$transaction_rollback_capability" ]] \
    || fail 'transaction rollback capability is missing or unsafe'
  cmp -s -- "$ROLLBACK_CAPABILITY_PATH" "$transaction_rollback_capability" \
    || fail 'active rollback capability does not match its transaction record'
  rm -f -- "$ROLLBACK_CAPABILITY_PATH"
  /usr/bin/sync -f "$STATE_ROOT"
}

if [[ -e "$transaction_dir/claiming" ]]; then
  validate_claimed_asset_ledger
fi

if [[ -f "$transaction_dir/rolled-back" ]]; then
  if [[ ! -e "$transaction_dir/claiming" \
    && ! -e "$transaction_dir/committed" \
    && "$current_owner" != "$transaction_id" ]]; then
    consume_rollback_capability_if_owned
    printf 'mirror transaction stopped before claiming publication and was already marked rolled back\n'
    emit_current_manifest_digest
    exit 0
  fi
  previous_state_is_current \
    || fail 'rolled-back transaction no longer matches the current public state'
  consume_rollback_capability_if_owned
  printf 'mirror transaction %s was already rolled back\n' "$transaction_id"
  emit_current_manifest_digest
  exit 0
fi

restore_previous_owner() {
  if [[ -f "$previous_owner" ]]; then
    owner_next="${STATE_ROOT}/.mirror-current-owner.${transaction_id}.rollback-next"
    rollback_next_files+=("$owner_next")
    install -o root -g root -m 0600 -- "$previous_owner" "$owner_next"
    /usr/bin/sync -f "$STATE_ROOT"
    mv -f -- "$owner_next" "$CURRENT_OWNER_PATH"
    /usr/bin/sync -f "$STATE_ROOT"
  elif [[ -f "$previous_owner_absent" ]]; then
    rm -f -- "$CURRENT_OWNER_PATH"
    /usr/bin/sync -f "$STATE_ROOT"
  else
    fail 'mirror transaction has no previous owner state'
  fi
}

if [[ ! -e "$transaction_dir/claiming" \
  && ! -e "$transaction_dir/committed" \
  && "$current_owner" != "$transaction_id" ]]; then
  mark_rolled_back
  consume_rollback_capability_if_owned
  printf 'mirror transaction stopped before claiming publication; no public manifest was changed\n'
  emit_current_manifest_digest
  exit 0
fi

require_active_rollback_capability

if [[ ! -f "$published_manifest" ]]; then
  [[ "$current_owner" != "$transaction_id" ]] \
    || fail 'current mirror owner has no published manifest; refusing an unverifiable rollback'
  previous_state_is_current \
    || fail 'mirror transaction has no published manifest and its previous state is not current'
  mark_rolled_back
  consume_rollback_capability_if_owned
  printf 'mirror transaction did not stage a public manifest; no public manifest was changed\n'
  emit_current_manifest_digest
  exit 0
fi

if [[ "$current_owner" != "$transaction_id" ]]; then
  if previous_state_is_current; then
    mark_rolled_back
    consume_rollback_capability_if_owned
    printf 'mirror public selector is already at its previous state; preserved any version-burned immutable assets\n'
    emit_current_manifest_digest
    exit 0
  elif previous_owner_is_current \
    && [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
    && cmp -s -- "$current_manifest" "$published_manifest"; then
    # A prior attempt durably restored the owner before the selector. The
    # rollback-started record authorizes convergence even after capability expiry.
    :
  else
    fail 'current public manifest no longer belongs to this transaction; refusing stale rollback'
  fi
fi

if [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
  && cmp -s -- "$current_manifest" "$published_manifest"; then
  :
elif previous_manifest_is_current; then
  restore_previous_owner
  mark_rolled_back
  consume_rollback_capability_if_owned
  printf 'mirror transaction claimed ownership but did not replace the previous manifest\n'
  emit_current_manifest_digest
  exit 0
else
  fail 'current public manifest does not match its transaction owner'
fi

if [[ -f "$previous_manifest" ]]; then
  rollback_next="$releases_dir/.latest.json.${transaction_id}.rollback-next"
  rollback_next_files+=("$rollback_next")
  install -o root -g root -m 0644 -- "$previous_manifest" "$rollback_next"
  /usr/bin/sync -f "$releases_dir"
  mv -f -- "$rollback_next" "$current_manifest"
  /usr/bin/sync -f "$releases_dir"
elif [[ -f "$previous_absent" ]]; then
  rm -f -- "$current_manifest"
  /usr/bin/sync -f "$releases_dir"
else
  fail 'mirror transaction has no previous manifest state'
fi

restore_previous_owner
mark_rolled_back
consume_rollback_capability_if_owned
printf 'rolled back update mirror transaction %s\n' "$transaction_id"
emit_current_manifest_digest
