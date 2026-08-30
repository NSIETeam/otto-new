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
readonly STAGING_ROOT='/var/lib/otto-ci-deploy/staging/mirror'
readonly LOCKS_ROOT='/var/lib/otto-ci-deploy/locks'
readonly CURRENT_OWNER_PATH='/var/lib/otto-ci-deploy/mirror-current-owner'
readonly ROLLBACK_CAPABILITY_PATH='/var/lib/otto-ci-deploy/mirror-rollback-capability'
readonly MIN_MIRROR_FREE_RESERVE_KIB=262144
readonly ROLLBACK_WINDOW_SECONDS=14400

fail() {
  printf 'update mirror publish failed: %s\n' "$*" >&2
  exit 1
}

require_root_owned_nonwritable_path() {
  local path="$1"
  [[ "$(stat -c '%u:%g' -- "$path")" == '0:0' ]] \
    || fail "published path is not root-owned: $path"
  if find "$path" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "published path is group/other writable: $path"
  fi
}

[ "$(id -u)" -eq 0 ] || fail 'publisher must run as root'
[[ -f "$0" && ! -L "$0" ]] || fail 'root-owned publisher is missing or unsafe'
[[ "$(stat -c '%u:%g' "$0")" == '0:0' ]] || fail 'publisher is not root-owned'
if find "$0" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
  fail 'publisher is group/other writable'
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

[[ "$#" -eq 4 ]] \
  || fail 'usage: publish-update-mirror TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
transaction_id="$1"
expected_version="$2"
expected_package_identity="$3"
expected_source_commit="$4"
[[ "$transaction_id" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+)-[0-9]+-[0-9]+$ ]] \
  || fail 'invalid transaction id'
version="${BASH_REMATCH[1]#v}"
[[ "$expected_version" == "$version" ]] \
  || fail 'signed mirror version does not match the transaction id'
[[ "$expected_package_identity" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
  || fail 'invalid expected package identity'
[[ "$expected_source_commit" =~ ^[0-9a-f]{40}$ ]] \
  || fail 'invalid expected source commit'

staging_dir="$STAGING_ROOT/$transaction_id"
manifest_path="$staging_dir/UPDATE-MIRROR-SHA256SUMS"
signature_path="$staging_dir/UPDATE-MIRROR-SHA256SUMS.sig"
[[ -d "$staging_dir" && ! -L "$staging_dir" ]] \
  || fail 'root-owned staging directory is missing or unsafe'
[[ "$(stat -c '%u:%g:%a' "$staging_dir")" == '0:0:700' ]] \
  || fail 'root-owned staging directory has an unsafe owner or mode'
for trusted_file in "$manifest_path" "$signature_path"; do
  [[ -f "$trusted_file" && ! -L "$trusted_file" ]] \
    || fail "signed payload metadata is missing or unsafe: $trusted_file"
  [[ "$(stat -c '%u:%g' "$trusted_file")" == '0:0' ]] \
    || fail "signed payload metadata is not root-owned: $trusted_file"
done

expected_assets=(
  "Otto-${version}-arm64.dmg"
  "Otto-${version}-arm64.dmg.blockmap"
  "Otto-${version}-x64.dmg"
  "Otto-${version}-x64.dmg.blockmap"
  "Otto-Setup-${version}-win-x64.exe"
  "Otto-Setup-${version}-win-x64.exe.blockmap"
  'latest.json'
)
declare -A expected_set=()
declare -A manifest_hashes=()
declare -A manifest_sizes=()
for asset_name in "${expected_assets[@]}"; do
  expected_set["$asset_name"]=1
done

manifest_records="$(/usr/bin/python3 -I -S - \
  "$manifest_path" "$staging_dir" "$expected_version" \
  "$expected_package_identity" "$expected_source_commit" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

manifest_path = pathlib.Path(sys.argv[1])
staging_dir = pathlib.Path(sys.argv[2])
expected_version, expected_package_identity, expected_source_commit = sys.argv[3:]

def reject_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate JSON field: {key}')
        value[key] = item
    return value

raw = manifest_path.read_bytes()
try:
    manifest = json.loads(raw, object_pairs_hook=reject_duplicates)
except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f'payload manifest is invalid JSON: {error}')
if not isinstance(manifest, dict) or set(manifest) != {
    'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'
}:
    raise SystemExit('payload manifest fields are not exact')
if manifest['format'] != 'otto-update-mirror-payload-v1':
    raise SystemExit('payload manifest format is invalid')
if manifest['version'] != expected_version:
    raise SystemExit('payload manifest version does not match the gateway invocation')
if manifest['packageIdentity'] != expected_package_identity:
    raise SystemExit('payload manifest packageIdentity does not match the gateway invocation')
if manifest['sourceCommit'] != expected_source_commit:
    raise SystemExit('payload manifest sourceCommit does not match the gateway invocation')
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', manifest['version']):
    raise SystemExit('payload manifest version is invalid')
if not re.fullmatch(r'[0-9a-f]{12}-[0-9a-f]{12}', manifest['packageIdentity']):
    raise SystemExit('payload manifest packageIdentity is invalid')
if not re.fullmatch(r'[0-9a-f]{40}', manifest['sourceCommit']):
    raise SystemExit('payload manifest sourceCommit is invalid')
version = manifest['version']
expected_names = [
    f'Otto-{version}-arm64.dmg',
    f'Otto-{version}-arm64.dmg.blockmap',
    f'Otto-{version}-x64.dmg',
    f'Otto-{version}-x64.dmg.blockmap',
    f'Otto-Setup-{version}-win-x64.exe',
    f'Otto-Setup-{version}-win-x64.exe.blockmap',
    'latest.json',
]
assets = manifest['assets']
if not isinstance(assets, list) or len(assets) != len(expected_names):
    raise SystemExit('payload manifest does not contain exactly seven assets')
canonical = (json.dumps(manifest, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n').encode()
if raw != canonical:
    raise SystemExit('payload manifest is not canonical')
if {entry.name for entry in staging_dir.iterdir()} != set(expected_names) | {
    manifest_path.name, manifest_path.name + '.sig'
}:
    raise SystemExit('root-owned staging directory contains unexpected files')
for index, expected_name in enumerate(expected_names):
    asset = assets[index]
    if not isinstance(asset, dict) or set(asset) != {'name', 'size', 'sha256'}:
        raise SystemExit('payload manifest asset fields are not exact')
    if asset['name'] != expected_name:
        raise SystemExit('payload manifest asset names or order are invalid')
    if not isinstance(asset['size'], int) or isinstance(asset['size'], bool) or asset['size'] < 1:
        raise SystemExit(f'payload manifest asset size is invalid: {expected_name}')
    if not isinstance(asset['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', asset['sha256']):
        raise SystemExit(f'payload manifest asset digest is invalid: {expected_name}')
    opened = os.open(staging_dir / expected_name, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(opened)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise SystemExit(f'payload is missing or unsafe: {expected_name}')
        if metadata.st_size != asset['size']:
            raise SystemExit(f'payload size does not match signed manifest: {expected_name}')
        digest = hashlib.sha256()
        while chunk := os.read(opened, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise SystemExit(f'payload digest does not match signed manifest: {expected_name}')
    finally:
        os.close(opened)
    print(asset['sha256'], asset['size'], asset['name'])
PY
)"
while read -r expected_hash expected_size payload_name; do
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ \
    && "$expected_size" =~ ^[0-9]+$ \
    && -n "${expected_set[$payload_name]+present}" ]] \
    || fail 'payload manifest validator returned an unsafe entry'
  [[ -z "${manifest_hashes[$payload_name]+present}" ]] \
    || fail "payload manifest contains a duplicate entry: $payload_name"
  manifest_hashes["$payload_name"]="$expected_hash"
  manifest_sizes["$payload_name"]="$expected_size"
done <<< "$manifest_records"

[[ "${#manifest_hashes[@]}" -eq "${#expected_assets[@]}" ]] \
  || fail 'payload manifest does not contain the exact desktop asset set'
for asset_name in "${expected_assets[@]}"; do
  [[ -n "${manifest_hashes[$asset_name]+present}" ]] \
    || fail "payload manifest is missing: $asset_name"
done

downloads_dir="$MIRROR_ROOT/downloads"
releases_dir="$MIRROR_ROOT/otto-releases"
transactions_dir="$MIRROR_ROOT/transactions"
transaction_dir="$transactions_dir/$transaction_id"

# Never let install(1) silently normalize an existing, attacker-writable
# publication path. Validate the immutable ancestry and every existing target
# before creating anything below /opt/otto-website.
for protected_ancestor in / /opt; do
  [[ -d "$protected_ancestor" && ! -L "$protected_ancestor" ]] \
    || fail "protected ancestor is missing or unsafe: $protected_ancestor"
  require_root_owned_nonwritable_path "$protected_ancestor"
done
for protected_path in \
  "$MIRROR_ROOT" "$downloads_dir" "$releases_dir" "$transactions_dir"; do
  if [[ -e "$protected_path" || -L "$protected_path" ]]; then
    [[ -d "$protected_path" && ! -L "$protected_path" ]] \
      || fail "protected path is not a safe directory: $protected_path"
    require_root_owned_nonwritable_path "$protected_path"
    [[ "$(stat -c '%u:%g:%a' -- "$protected_path")" == '0:0:755' ]] \
      || fail "existing published directory does not have exact root:root mode 0755: $protected_path"
  fi
done

install -d -o root -g root -m 0755 \
  "$MIRROR_ROOT" "$downloads_dir" "$releases_dir" "$transactions_dir"
[[ "$(readlink -f -- "$MIRROR_ROOT")" == "$MIRROR_ROOT" ]] \
  || fail 'mirror root resolves outside its fixed path'
for protected_path in \
  "$MIRROR_ROOT" "$downloads_dir" "$releases_dir" "$transactions_dir"; do
  require_root_owned_nonwritable_path "$protected_path"
  [[ "$(stat -c '%u:%g:%a' -- "$protected_path")" == '0:0:755' ]] \
    || fail "published directory does not have exact root:root mode 0755: $protected_path"
done
current_manifest="$releases_dir/latest.json"
if [[ -e "$current_manifest" || -L "$current_manifest" ]]; then
  [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
    || fail 'current latest.json is not a regular file'
  require_root_owned_nonwritable_path "$current_manifest"
  [[ "$(stat -c '%u:%g:%a' -- "$current_manifest")" == '0:0:644' ]] \
    || fail 'current latest.json is not web-readable mode 0644'
fi

# A durable claiming marker means at least one predictable asset URL may have
# been observed, even if the selector never changed. Such a version is burned
# forever: a later run id must not reuse it or cache-alias its immutable URLs.
historical_scan_file="$(mktemp "${LOCKS_ROOT}/.burned-version-scan.XXXXXXXX")"
chmod 0600 "$historical_scan_file"
trap 'rm -f -- "$historical_scan_file"' EXIT
if ! find "$transactions_dir" -mindepth 1 -maxdepth 1 \
  -name "v${version}-*" -print0 > "$historical_scan_file"; then
  fail 'could not enumerate historical mirror transactions'
fi
while IFS= read -r -d '' historical_transaction; do
  historical_name="$(basename -- "$historical_transaction")"
  [[ "$historical_name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail "historical mirror transaction name is invalid: $historical_name"
  [[ -d "$historical_transaction" && ! -L "$historical_transaction" ]] \
    || fail "historical mirror transaction is unsafe: $historical_name"
  require_root_owned_nonwritable_path "$historical_transaction"
  [[ "$(stat -c '%u:%g:%a' "$historical_transaction")" == '0:0:700' ]] \
    || fail "historical mirror transaction has an unsafe mode: $historical_name"
  if [[ -e "$historical_transaction/claiming" \
    || -L "$historical_transaction/claiming" ]]; then
    [[ -f "$historical_transaction/claiming" \
      && ! -L "$historical_transaction/claiming" \
      && "$(stat -c '%u:%g:%a' "$historical_transaction/claiming")" == '0:0:600' ]] \
      || fail "historical claiming marker is unsafe: $historical_name"
    fail "mirror version ${version} was already burned by transaction ${historical_name}"
  fi
done < "$historical_scan_file"
rm -f -- "$historical_scan_file"
trap - EXIT

# The owner ledger and public manifest form one committed state. Read and
# validate them only after taking the mirror lock so a new transaction can
# never preserve a crash-torn state as its rollback baseline. An ownerless
# manifest is allowed only as the legacy baseline before the first v2 publish
# (and after rolling back to that baseline).
current_owner_value=''
if [[ -e "$CURRENT_OWNER_PATH" || -L "$CURRENT_OWNER_PATH" ]]; then
  [[ -f "$CURRENT_OWNER_PATH" && ! -L "$CURRENT_OWNER_PATH" ]] \
    || fail 'mirror current owner is not a regular file'
  [[ "$(stat -c '%u:%g:%a' "$CURRENT_OWNER_PATH")" == '0:0:600' ]] \
    || fail 'mirror current owner has an unsafe owner or mode'
  current_owner_value="$(<"$CURRENT_OWNER_PATH")"
  [[ "$current_owner_value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'mirror current owner is invalid'

  current_owner_transaction="$transactions_dir/$current_owner_value"
  current_owner_manifest="$current_owner_transaction/published-latest.json"
  current_owner_ledger="$current_owner_transaction/UPDATE-MIRROR-SHA256SUMS"
  current_owner_ledger_signature="$current_owner_transaction/UPDATE-MIRROR-SHA256SUMS.sig"
  current_owner_capability="$current_owner_transaction/rollback-capability"
  [[ -d "$current_owner_transaction" && ! -L "$current_owner_transaction" ]] \
    || fail 'current mirror owner has no safe transaction directory'
  require_root_owned_nonwritable_path "$current_owner_transaction"
  [[ "$(stat -c '%u:%g:%a' "$current_owner_transaction")" == '0:0:700' ]] \
    || fail 'current mirror owner transaction has an unsafe owner or mode'
  for owner_state_file in \
    "$current_owner_transaction/claiming" \
    "$current_owner_transaction/committed" \
    "$current_owner_manifest" "$current_owner_ledger" \
    "$current_owner_ledger_signature" "$current_owner_capability"; do
    [[ -f "$owner_state_file" && ! -L "$owner_state_file" ]] \
      || fail "current mirror owner transaction is incomplete: $owner_state_file"
    require_root_owned_nonwritable_path "$owner_state_file"
    [[ "$(stat -c '%u:%g:%a' "$owner_state_file")" == '0:0:600' ]] \
      || fail "current mirror owner state has an unsafe mode: $owner_state_file"
  done
  [[ ! -e "$current_owner_transaction/rolled-back" \
    && ! -L "$current_owner_transaction/rolled-back" ]] \
    || fail 'current mirror owner transaction is marked rolled back'
  [[ ! -e "$current_owner_transaction/rollback-started" \
    && ! -L "$current_owner_transaction/rollback-started" \
    && ! -e "$current_owner_transaction/.rollback-started.next" \
    && ! -L "$current_owner_transaction/.rollback-started.next" ]] \
    || fail 'current mirror owner has an unfinished rollback; refusing a new publication'
  rollback_pending_scan="$(mktemp "${LOCKS_ROOT}/.rollback-pending-scan.XXXXXXXX")"
  chmod 0600 "$rollback_pending_scan"
  trap 'rm -f -- "$rollback_pending_scan"' EXIT
  if ! /usr/bin/find "$current_owner_transaction" -mindepth 1 -maxdepth 1 \
    -name '.rollback-started.*.next' -print0 > "$rollback_pending_scan"; then
    fail 'could not enumerate current owner rollback temporary markers'
  fi
  if [ -s "$rollback_pending_scan" ]; then
    IFS= read -r -d '' rollback_pending_path < "$rollback_pending_scan" || true
    [[ -f "$rollback_pending_path" && ! -L "$rollback_pending_path" \
      && "$(stat -c '%u:%g' "$rollback_pending_path")" == '0:0' ]] \
      || fail 'current mirror owner rollback temporary marker is unsafe'
    fail 'current mirror owner has an unfinished rollback temporary marker; refusing a new publication'
  fi
  rm -f -- "$rollback_pending_scan"
  trap - EXIT
  [[ -f "$current_manifest" && ! -L "$current_manifest" ]] \
    || fail 'current mirror owner has no public manifest'
  cmp -s -- "$current_manifest" "$current_owner_manifest" \
    || fail 'current mirror owner does not match the public manifest'
  mapfile -t current_owner_capability_lines < "$current_owner_capability"
  [[ "${#current_owner_capability_lines[@]}" -eq 2 \
    && "${current_owner_capability_lines[0]}" == "transaction=${current_owner_value}" \
    && "${current_owner_capability_lines[1]}" =~ ^expires=[0-9]+$ ]] \
    || fail 'current mirror owner rollback capability is invalid'
  /usr/bin/python3 -I -S - \
    "$current_owner_ledger" "$current_owner_ledger_signature" \
    "$current_owner_manifest" "$downloads_dir" "${current_owner_value%%-*}" <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

ledger_path = pathlib.Path(sys.argv[1])
signature_path = pathlib.Path(sys.argv[2])
public_manifest = pathlib.Path(sys.argv[3])
downloads_dir = pathlib.Path(sys.argv[4])
expected_version = sys.argv[5].removeprefix('v')

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
    raise SystemExit(f'current mirror owner ledger is invalid JSON: {error}')
if not isinstance(ledger, dict) or set(ledger) != {
    'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'
}:
    raise SystemExit('current mirror owner ledger fields are not exact')
try:
    envelope = json.loads(signature_path.read_bytes(), object_pairs_hook=reject_duplicates)
except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f'current mirror owner signature is invalid JSON: {error}')
if not isinstance(envelope, dict) or set(envelope) != {
    'format', 'algorithm', 'file', 'sha256', 'keyId', 'signature'
}:
    raise SystemExit('current mirror owner signature fields are not exact')
if (envelope['format'] != 'otto-release-payload-signature-v1'
        or envelope['algorithm'] != 'Ed25519'
        or envelope['file'] != ledger_path.name
        or envelope['sha256'] != hashlib.sha256(raw).hexdigest()
        or not isinstance(envelope['keyId'], str)
        or not re.fullmatch(r'[0-9a-f]{16}', envelope['keyId'])
        or not isinstance(envelope['signature'], str)
        or not re.fullmatch(r'[A-Za-z0-9_-]+', envelope['signature'])):
    raise SystemExit('current mirror owner signature does not bind its ledger')
try:
    decoded_signature = base64.urlsafe_b64decode(
        envelope['signature'] + '=' * (-len(envelope['signature']) % 4)
    )
except ValueError:
    raise SystemExit('current mirror owner signature encoding is invalid')
if len(decoded_signature) != 64:
    raise SystemExit('current mirror owner signature encoding is invalid')
if (ledger['format'] != 'otto-update-mirror-payload-v1'
        or ledger['version'] != expected_version
        or not isinstance(ledger['packageIdentity'], str)
        or not re.fullmatch(r'[0-9a-f]{12}-[0-9a-f]{12}', ledger['packageIdentity'])
        or not isinstance(ledger['sourceCommit'], str)
        or not re.fullmatch(r'[0-9a-f]{40}', ledger['sourceCommit'])):
    raise SystemExit('current mirror owner ledger identity is invalid')
names = [
    f'Otto-{expected_version}-arm64.dmg',
    f'Otto-{expected_version}-arm64.dmg.blockmap',
    f'Otto-{expected_version}-x64.dmg',
    f'Otto-{expected_version}-x64.dmg.blockmap',
    f'Otto-Setup-{expected_version}-win-x64.exe',
    f'Otto-Setup-{expected_version}-win-x64.exe.blockmap',
    'latest.json',
]
assets = ledger['assets']
if not isinstance(assets, list) or len(assets) != len(names):
    raise SystemExit('current mirror owner ledger asset set is invalid')
canonical = (json.dumps(ledger, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n').encode()
if raw != canonical:
    raise SystemExit('current mirror owner ledger is not canonical')

def verify(asset, path, expected_mode):
    opened = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(opened)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != expected_mode
                or metadata.st_size != asset['size']):
            raise SystemExit(f'current mirror owner asset is unsafe: {asset["name"]}')
        digest = hashlib.sha256()
        while chunk := os.read(opened, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise SystemExit(f'current mirror owner asset digest mismatch: {asset["name"]}')
    finally:
        os.close(opened)

for index, name in enumerate(names):
    asset = assets[index]
    if (not isinstance(asset, dict) or set(asset) != {'name', 'size', 'sha256'}
            or asset.get('name') != name
            or not isinstance(asset.get('size'), int) or isinstance(asset.get('size'), bool)
            or asset['size'] < 1
            or not isinstance(asset.get('sha256'), str)
            or not re.fullmatch(r'[0-9a-f]{64}', asset['sha256'])):
        raise SystemExit('current mirror owner ledger asset set is invalid')
    verify(asset, public_manifest if name == 'latest.json' else downloads_dir / name,
           0o600 if name == 'latest.json' else 0o644)
PY
fi
/usr/bin/python3 -I -S - \
  "$version" "$staging_dir/latest.json" \
  "$([[ -f "$current_manifest" ]] && printf '%s' "$current_manifest" || printf '%s' '-')" <<'PY'
import json
import pathlib
import re
import sys

target_version, candidate_name, current_name = sys.argv[1:]

def version_tuple(value: object, label: str) -> tuple[int, int, int]:
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise SystemExit(f'{label} latest.json version is invalid')
    return tuple(map(int, value.split('.')))

target = version_tuple(target_version, 'transaction')
candidate_path = pathlib.Path(candidate_name)
candidate = json.loads(candidate_path.read_text(encoding='utf-8'))
candidate_version = version_tuple(candidate.get('version'), 'candidate')
if candidate_version != target:
    raise SystemExit('candidate latest.json does not match the transaction version')
if current_name != '-':
    current_path = pathlib.Path(current_name)
    current = json.loads(current_path.read_text(encoding='utf-8'))
    current_version = version_tuple(current.get('version'), 'current')
    if candidate_version < current_version:
        raise SystemExit('refusing to downgrade the desktop update mirror')
    if candidate_version == current_version and candidate_path.read_bytes() != current_path.read_bytes():
        raise SystemExit('refusing to mutate latest.json for an already published version')
PY
[[ ! -e "$transaction_dir" && ! -L "$transaction_dir" ]] \
  || fail 'mirror transaction already exists; refusing replay'

publish_next_files=()
newly_installed_assets=()
retain_installed_assets='false'
cleanup_publish_next_files() {
  if [ "${#publish_next_files[@]}" -gt 0 ]; then
    rm -f -- "${publish_next_files[@]}"
  fi
  if [ "$retain_installed_assets" = 'false' ] \
    && [ "${#newly_installed_assets[@]}" -gt 0 ]; then
    rm -f -- "${newly_installed_assets[@]}"
    /usr/bin/sync -f "$downloads_dir"
  fi
}
trap cleanup_publish_next_files EXIT

# A published version is immutable. A failed/retried transaction may reuse an
# identical asset, but it must never replace bytes that an existing manifest
# can already reference.
missing_asset_bytes=0
for asset_name in "${expected_assets[@]}"; do
  [[ "$asset_name" != 'latest.json' ]] || continue
  installed_asset="$downloads_dir/$asset_name"
  if [[ -e "$installed_asset" || -L "$installed_asset" ]]; then
    [[ -f "$installed_asset" && ! -L "$installed_asset" ]] \
      || fail "existing desktop asset is not a regular file: $asset_name"
    require_root_owned_nonwritable_path "$installed_asset"
    [[ "$(stat -c '%u:%g:%a' -- "$installed_asset")" == '0:0:644' ]] \
      || fail "existing desktop asset is not web-readable mode 0644: $asset_name"
    [[ "$(sha256sum -- "$installed_asset" | awk '{print $1}')" == "${manifest_hashes[$asset_name]}" ]] \
      || fail "refusing to replace an existing version with different bytes: $asset_name"
  else
    missing_asset_bytes="$((missing_asset_bytes + manifest_sizes[$asset_name]))"
  fi
done
available_mirror_kib="$(df -Pk -- "$downloads_dir" | awk 'NR == 2 { print $4 }')"
[[ "$available_mirror_kib" =~ ^[0-9]+$ ]] \
  || fail 'could not determine mirror filesystem capacity'
required_mirror_kib="$(((missing_asset_bytes + 1023) / 1024 + MIN_MIRROR_FREE_RESERVE_KIB))"
[ "$available_mirror_kib" -ge "$required_mirror_kib" ] \
  || fail 'mirror filesystem does not have capacity for immutable assets and the safety reserve'

mkdir -m 0700 -- "$transaction_dir" \
  || fail 'could not atomically create mirror transaction state'
previous_manifest="$transaction_dir/previous-latest.json"
previous_absent="$transaction_dir/previous-latest.absent"
previous_owner="$transaction_dir/previous-owner"
previous_owner_absent="$transaction_dir/previous-owner.absent"
if [[ -f "$current_manifest" ]]; then
  install -o root -g root -m 0600 -- "$current_manifest" "$previous_manifest"
else
  install -o root -g root -m 0600 /dev/null "$previous_absent"
fi
if [[ -f "$CURRENT_OWNER_PATH" ]]; then
  install -o root -g root -m 0600 -- "$CURRENT_OWNER_PATH" "$previous_owner"
else
  install -o root -g root -m 0600 /dev/null "$previous_owner_absent"
fi
/usr/bin/sync -f "$transaction_dir"

asset_ledger="$transaction_dir/UPDATE-MIRROR-SHA256SUMS"
asset_ledger_signature="$transaction_dir/UPDATE-MIRROR-SHA256SUMS.sig"
published_manifest="$transaction_dir/published-latest.json"
transaction_rollback_capability="$transaction_dir/rollback-capability"
install -o root -g root -m 0600 -- "$manifest_path" "$asset_ledger"
install -o root -g root -m 0600 -- "$signature_path" "$asset_ledger_signature"
install -o root -g root -m 0600 -- "$staging_dir/latest.json" "$published_manifest"
rollback_expires="$(( $(date +%s) + ROLLBACK_WINDOW_SECONDS ))"
printf 'transaction=%s\nexpires=%s\n' "$transaction_id" "$rollback_expires" \
  > "$transaction_rollback_capability"
chown root:root "$transaction_rollback_capability"
chmod 0600 "$transaction_rollback_capability"
/usr/bin/sync -f "$transaction_dir"
rollback_capability_next="${STATE_ROOT}/.mirror-rollback-capability.${transaction_id}.next"
publish_next_files+=("$rollback_capability_next")
[[ ! -e "$rollback_capability_next" && ! -L "$rollback_capability_next" ]] \
  || fail 'rollback capability staging path already exists'
if [[ -e "$ROLLBACK_CAPABILITY_PATH" || -L "$ROLLBACK_CAPABILITY_PATH" ]]; then
  [[ -f "$ROLLBACK_CAPABILITY_PATH" && ! -L "$ROLLBACK_CAPABILITY_PATH" ]] \
    || fail 'existing rollback capability is unsafe'
  require_root_owned_nonwritable_path "$ROLLBACK_CAPABILITY_PATH"
  [[ "$(stat -c '%u:%g:%a' "$ROLLBACK_CAPABILITY_PATH")" == '0:0:600' ]] \
    || fail 'existing rollback capability has an unsafe owner or mode'
fi
install -o root -g root -m 0600 -- \
  "$transaction_rollback_capability" "$rollback_capability_next"
/usr/bin/sync -f "$STATE_ROOT"
mv -f -- "$rollback_capability_next" "$ROLLBACK_CAPABILITY_PATH"
/usr/bin/sync -f "$STATE_ROOT"
install -o root -g root -m 0600 /dev/null "$transaction_dir/claiming"
/usr/bin/sync -f "$transaction_dir"
# The transaction is now irreversibly version-burned before the first public
# asset rename. A process or power failure may leave a subset of verified,
# predictable asset URLs visible; preserve them permanently because a client
# may already have cached one. published-latest.json is the exact audit ledger.
retain_installed_assets='true'

for asset_name in "${expected_assets[@]}"; do
  [[ "$asset_name" != 'latest.json' ]] || continue
  if [[ -f "$downloads_dir/$asset_name" ]]; then
    continue
  fi
  asset_next="$downloads_dir/.${asset_name}.${transaction_id}.next"
  publish_next_files+=("$asset_next")
  install -o root -g root -m 0644 -- "$staging_dir/$asset_name" "$asset_next"
  [[ "$(sha256sum -- "$asset_next" | awk '{print $1}')" == "${manifest_hashes[$asset_name]}" ]] \
    || fail "installed desktop asset digest mismatch: $asset_name"
  /usr/bin/sync -f "$asset_next"
  mv -f -- "$asset_next" "$downloads_dir/$asset_name"
  /usr/bin/sync -f "$downloads_dir"
  newly_installed_assets+=("$downloads_dir/$asset_name")
done

latest_next="$releases_dir/.latest.json.${transaction_id}.next"
owner_next="${STATE_ROOT}/.mirror-current-owner.${transaction_id}.next"
publish_next_files+=("$latest_next")
publish_next_files+=("$owner_next")
install -o root -g root -m 0644 -- "$staging_dir/latest.json" "$latest_next"
printf '%s\n' "$transaction_id" > "$owner_next"
chown root:root "$owner_next"
chmod 0600 "$owner_next"
[[ "$(sha256sum -- "$latest_next" | awk '{print $1}')" == "${manifest_hashes[latest.json]}" ]] \
  || fail 'installed latest.json digest mismatch'
/usr/bin/sync -f "$releases_dir"
/usr/bin/sync -f "$STATE_ROOT"
mv -f -- "$owner_next" "$CURRENT_OWNER_PATH"
/usr/bin/sync -f "$STATE_ROOT"
mv -f -- "$latest_next" "$current_manifest"
/usr/bin/sync -f "$releases_dir"
install -o root -g root -m 0600 /dev/null "$transaction_dir/committed"
/usr/bin/sync -f "$transaction_dir"

printf 'published update mirror transaction %s\n' "$transaction_id"
