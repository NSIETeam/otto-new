#!/bin/bash -p
set -Eeuo pipefail
umask 077

# Root-owned, fail-closed entrypoint for automated enterprise deployments.
# The SSH account may write only the transaction upload directory. This
# gateway copies the candidate into a root-owned staging directory, verifies
# the server-pinned Ed25519 trust anchor, and only then executes package code.

unset BASH_ENV ENV CDPATH TMPDIR PYTHONHOME PYTHONPATH OPENSSL_CONF \
  OPENSSL_MODULES OPENSSL_ENGINES TAR_OPTIONS GZIP GZIP_OPT XZ_OPT BZIP2 \
  NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS \
  LD_PRELOAD LD_LIBRARY_PATH XDG_CONFIG_HOME XDG_CACHE_HOME \
  CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR \
  GCONV_PATH LOCPATH NLSPATH PYTHONWARNINGS RUBYOPT PERL5OPT PERL5LIB
readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C
export HOME=/root USER=root LOGNAME=root SHELL=/bin/bash
cd /

GATEWAY_PATH="/usr/local/sbin/otto-enterprise-ci-deploy"
GATEWAY_PROTOCOL="otto-enterprise-ci-deploy-v5"
LIBEXEC_ROOT="/usr/local/libexec/otto-enterprise-ci"
PUBLISH_HELPER_PATH="${LIBEXEC_ROOT}/publish-update-mirror"
ROLLBACK_HELPER_PATH="${LIBEXEC_ROOT}/rollback-update-mirror"
TRUST_KEY_PATH="/etc/otto-enterprise/enterprise-package-signing-public.pem"
CONFIG_PATH_FILE="/etc/otto-enterprise/ci-deploy-config-path"
DEPLOY_USER_FILE="/etc/otto-enterprise/ci-deploy-user"
ROLLBACK_USER_FILE="/etc/otto-enterprise/ci-rollback-user"
STATE_ROOT="/var/lib/otto-ci-deploy"
UPLOADS_ROOT="${STATE_ROOT}/uploads"
STAGES_ROOT="${STATE_ROOT}/staging"
LOCKS_ROOT="${STATE_ROOT}/locks"
DEPLOYMENTS_ROOT="${STATE_ROOT}/deployments"
UPLOAD_ROOT="${UPLOADS_ROOT}/enterprise"
MIRROR_UPLOAD_ROOT="${UPLOADS_ROOT}/mirror"
STAGING_ROOT="${STAGES_ROOT}/enterprise"
MIRROR_STAGING_ROOT="${STAGES_ROOT}/mirror"
INSTALL_ROOT="/opt/otto-enterprise"
MAX_ENTERPRISE_ARCHIVE_BYTES=1073741824
MAX_ENTERPRISE_METADATA_BYTES=1048576
MAX_ENTERPRISE_TRANSACTION_BYTES=1075838976
MAX_MIRROR_INSTALLER_BYTES=536870912
MAX_MIRROR_BLOCKMAP_BYTES=67108864
MAX_MIRROR_METADATA_BYTES=1048576
MAX_MIRROR_TRANSACTION_BYTES=1815085056
MIN_UPLOAD_FREE_RESERVE_KIB=262144
UPLOAD_TIMEOUT_SECONDS=1800

fail() {
  printf '[Otto CI Deploy] %s\n' "$*" >&2
  exit 2
}

require_root_owned_regular_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] \
    || fail "required root-owned regular file is missing: $file"
  [ "$(stat -c '%u:%g' "$file")" = '0:0' ] \
    || fail "trusted file is not owned by root: $file"
  if find "$file" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "trusted file is group/other writable: $file"
  fi
}

require_root_owned_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    || fail "required root-owned directory is missing: $directory"
  [ "$(stat -c '%u' "$directory")" = '0' ] \
    || fail "trusted directory is not owned by root: $directory"
  if find "$directory" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "trusted directory is group/other writable: $directory"
  fi
}

require_root_owned_directory_chain() {
  local current="$1"
  while :; do
    require_root_owned_directory "$current"
    [ "$current" = '/' ] && break
    current="$(dirname -- "$current")"
  done
}

acquire_production_lock() {
  if [ "${PRODUCTION_LOCK_HELD:-false}" = 'true' ]; then
    return 0
  fi
  local lock_path="${LOCKS_ROOT}/production.lock"
  if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
    require_root_owned_regular_file "$lock_path"
  fi
  exec 9>"$lock_path"
  chmod 0600 "$lock_path"
  /usr/bin/flock -x -w 600 9 \
    || fail 'another production deployment operation did not finish within 600 seconds'
  PRODUCTION_LOCK_HELD='true'
}

verify_running_gateway_identity() {
  local running_gateway_fd="/proc/$$/fd/255"
  [ -e "$running_gateway_fd" ] \
    || fail 'running gateway script descriptor is unavailable'
  [ -f "$running_gateway_fd" ] \
    || fail 'running gateway script descriptor is not a regular file'
  [ "$(stat -Lc '%u:%g' "$running_gateway_fd")" = '0:0' ] \
    || fail 'running gateway script is not root-owned'
  local running_mode
  running_mode="$(stat -Lc '%a' "$running_gateway_fd")"
  (( (8#$running_mode & 8#022) == 0 )) \
    || fail 'running gateway script is group/other writable'
  [ -f "$GATEWAY_PATH" ] && [ ! -L "$GATEWAY_PATH" ] \
    || fail 'fixed gateway path is missing or unsafe'
  [ "$(stat -Lc '%d:%i' "$running_gateway_fd")" \
    = "$(stat -c '%d:%i' "$GATEWAY_PATH")" ] \
    || fail 'running gateway inode does not match the locked fixed gateway'
  [ "$(sha256sum "$running_gateway_fd" | awk '{print $1}')" \
    = "$(sha256sum "$GATEWAY_PATH" | awk '{print $1}')" ] \
    || fail 'running gateway bytes do not match the locked fixed gateway'
}

verify_signed_file() {
  local payload_path="$1"
  local signature_path="$2"
  local expected_format="$3"
  local signature_bin="$4"
  local signature_meta="$5"

  /usr/bin/python3 -I -S - \
    "$payload_path" "$signature_path" "$expected_format" \
    "$signature_bin" "$signature_meta" <<'PY'
import base64
import json
import pathlib
import re
import sys

payload_path, signature_path, expected_format, signature_bin, signature_meta = (
    pathlib.Path(sys.argv[1]),
    pathlib.Path(sys.argv[2]),
    sys.argv[3],
    pathlib.Path(sys.argv[4]),
    pathlib.Path(sys.argv[5]),
)
envelope = json.loads(signature_path.read_text(encoding='utf-8'))
required = {'format', 'algorithm', 'file', 'sha256', 'keyId', 'signature'}
if not isinstance(envelope, dict) or set(envelope) != required:
    raise SystemExit('signature envelope fields are not exact')
if envelope['format'] != expected_format:
    raise SystemExit('signature envelope format is invalid')
if envelope['algorithm'] != 'Ed25519' or envelope['file'] != payload_path.name:
    raise SystemExit('signature envelope identity is invalid')
if not re.fullmatch(r'[0-9a-f]{64}', envelope['sha256']):
    raise SystemExit('signature payload digest is invalid')
if not re.fullmatch(r'[0-9a-f]{16}', envelope['keyId']):
    raise SystemExit('signature key id is invalid')
encoded = envelope['signature']
if not isinstance(encoded, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', encoded):
    raise SystemExit('signature encoding is invalid')
signature = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
if len(signature) != 64:
    raise SystemExit('Ed25519 signature length is invalid')
signature_bin.write_bytes(signature)
signature_meta.write_text(
    f"{envelope['sha256']}\n{envelope['keyId']}\n", encoding='ascii'
)
PY
  chmod 0600 "$signature_bin" "$signature_meta"

  local -a signature_metadata
  mapfile -t signature_metadata < "$signature_meta"
  [ "${#signature_metadata[@]}" -eq 2 ] \
    || fail 'signature metadata is incomplete'
  local signed_payload_sha256="${signature_metadata[0]}"
  local signed_key_id="${signature_metadata[1]}"
  local actual_payload_sha256
  local trusted_key_id
  actual_payload_sha256="$(sha256sum "$payload_path" | awk '{print $1}')"
  [ "$actual_payload_sha256" = "$signed_payload_sha256" ] \
    || fail 'root-staged payload digest does not match its signature envelope'
  trusted_key_id="$(openssl pkey -pubin -in "$TRUST_KEY_PATH" -outform DER | sha256sum | awk '{print substr($1,1,16)}')"
  [ "$trusted_key_id" = "$signed_key_id" ] \
    || fail 'payload signing key does not match the server-pinned trust anchor'
  openssl pkeyutl -verify -pubin -inkey "$TRUST_KEY_PATH" -rawin \
    -in "$payload_path" -sigfile "$signature_bin" >/dev/null \
    || fail 'payload Ed25519 signature verification failed'
}

verify_update_mirror_manifest() {
  local manifest_path="$1"
  local staging_dir="$2"
  local expected_version="$3"
  local expected_package_identity="$4"
  local expected_source_commit="$5"

  /usr/bin/python3 -I -S - \
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
    raise SystemExit(f'signed update mirror manifest is invalid JSON: {error}')
required = {'format', 'version', 'packageIdentity', 'sourceCommit', 'assets'}
if not isinstance(manifest, dict) or set(manifest) != required:
    raise SystemExit('signed update mirror manifest fields are not exact')
if manifest['format'] != 'otto-update-mirror-payload-v1':
    raise SystemExit('signed update mirror manifest format is invalid')
if manifest['version'] != expected_version:
    raise SystemExit('signed update mirror manifest version does not match the invocation')
if manifest['packageIdentity'] != expected_package_identity:
    raise SystemExit('signed update mirror manifest packageIdentity does not match the invocation')
if manifest['sourceCommit'] != expected_source_commit:
    raise SystemExit('signed update mirror manifest sourceCommit does not match the invocation')
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', manifest['version']):
    raise SystemExit('signed update mirror manifest version is invalid')
if not re.fullmatch(r'[0-9a-f]{12}-[0-9a-f]{12}', manifest['packageIdentity']):
    raise SystemExit('signed update mirror manifest packageIdentity is invalid')
if not re.fullmatch(r'[0-9a-f]{40}', manifest['sourceCommit']):
    raise SystemExit('signed update mirror manifest sourceCommit is invalid')
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
    raise SystemExit('signed update mirror manifest does not contain exactly seven assets')
for index, expected_name in enumerate(expected_names):
    asset = assets[index]
    if not isinstance(asset, dict) or set(asset) != {'name', 'size', 'sha256'}:
        raise SystemExit('signed update mirror manifest asset fields are not exact')
    if asset['name'] != expected_name:
        raise SystemExit('signed update mirror manifest asset names or order are invalid')
    if not isinstance(asset['size'], int) or isinstance(asset['size'], bool) or asset['size'] < 1:
        raise SystemExit(f'signed update mirror manifest asset size is invalid: {expected_name}')
    if not isinstance(asset['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', asset['sha256']):
        raise SystemExit(f'signed update mirror manifest asset digest is invalid: {expected_name}')
canonical = (json.dumps(manifest, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n').encode()
if raw != canonical:
    raise SystemExit('signed update mirror manifest is not canonical')
expected_files = set(expected_names) | {manifest_path.name, manifest_path.name + '.sig'}
actual_files = {entry.name for entry in staging_dir.iterdir()}
if actual_files != expected_files:
    raise SystemExit('root-staged mirror payload does not contain the exact signed file set')
for asset in assets:
    asset_path = staging_dir / asset['name']
    opened = os.open(asset_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(opened)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0:
            raise SystemExit(f'root-staged mirror asset is unsafe: {asset["name"]}')
        if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size != asset['size']:
            raise SystemExit(f'root-staged mirror asset size or mode mismatch: {asset["name"]}')
        digest = hashlib.sha256()
        while chunk := os.read(opened, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise SystemExit(f'root-staged mirror asset digest mismatch: {asset["name"]}')
    finally:
        os.close(opened)
PY
}

verify_release_identity_at_path() {
  local current_release="$1"
  local expected_version="$2"
  local package_id="$3"
  local expected_source_commit="$4"
  local expected_build_prefix="${package_id%%-*}"
  local expected_source_input_prefix="${package_id#*-}"
  local expected_release="${INSTALL_ROOT}/releases/${expected_version}-${expected_build_prefix}"
  [ "$current_release" = "$expected_release" ] \
    || fail "deployed release identity is unexpected: $current_release"
  require_root_owned_directory_chain "$current_release"
  require_root_owned_regular_file "${current_release}/manifest.json"
  /usr/bin/python3 -I -S - \
    "${current_release}/manifest.json" "$expected_version" \
    "$expected_build_prefix" "$expected_source_input_prefix" \
    "$expected_source_commit" <<'PY'
import json
import pathlib
import re
import sys

manifest_path = pathlib.Path(sys.argv[1])
expected_version, expected_build, expected_source_input, expected_source_commit = sys.argv[2:]
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
if (
    manifest.get('version') != expected_version
    or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('buildCommit', ''))
    or not manifest['buildCommit'].startswith(expected_build)
    or not re.fullmatch(r'[0-9a-f]{64}', manifest.get('sourceInputSha256', ''))
    or not manifest['sourceInputSha256'].startswith(expected_source_input)
    or manifest.get('sourceCommit') != expected_source_commit
    or manifest.get('sourceTreeDirty') is not False
):
    raise SystemExit('current deployment manifest identity is unexpected')
PY
}

verify_current_deployment() {
  local expected_version="$1"
  local package_id="$2"
  local expected_source_commit="$3"
  local current_release
  local deploy_config_path
  local -a verify_env=(
    /usr/bin/env -i
    PATH=/usr/sbin:/usr/bin:/sbin:/bin
    LC_ALL=C
    HOME=/root
    USER=root
    LOGNAME=root
    SHELL=/bin/bash
  )

  [ -L "${INSTALL_ROOT}/current" ] \
    || fail 'enterprise current release is not a managed symlink'
  current_release="$(readlink -f "${INSTALL_ROOT}/current")"
  verify_release_identity_at_path \
    "$current_release" "$expected_version" "$package_id" \
    "$expected_source_commit"
  IFS= read -r deploy_config_path < "$CONFIG_PATH_FILE" \
    || fail 'deployment config path is unreadable'
  [[ "$deploy_config_path" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
    || fail 'server-pinned deployment config path is invalid'
  require_root_owned_directory_chain "$(dirname -- "$deploy_config_path")"
  require_root_owned_regular_file "$deploy_config_path"
  require_root_owned_directory_chain "${INSTALL_ROOT}/deploy"
  require_root_owned_regular_file "${INSTALL_ROOT}/deploy/verify.sh"
  "${verify_env[@]}" \
    OTTO_CONFIG_PATH="$deploy_config_path" \
    "${INSTALL_ROOT}/deploy/verify.sh"
}

sync_live_deployment_filesystems() {
  local deploy_config_path durability_path
  IFS= read -r deploy_config_path < "$CONFIG_PATH_FILE" \
    || fail 'deployment config path is unreadable for durability barrier'
  [[ "$deploy_config_path" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
    || fail 'server-pinned deployment config path is invalid for durability barrier'
  for durability_path in \
    "$INSTALL_ROOT" \
    /var/lib/otto-enterprise \
    "$(dirname -- "$deploy_config_path")" \
    /etc/systemd/system; do
    [ -d "$durability_path" ] && [ ! -L "$durability_path" ] \
      || fail "deployment durability path is missing or unsafe: $durability_path"
    /usr/bin/sync -f "$durability_path"
  done
}

read_deployment_state_field() {
  local state_file="$1"
  local key="$2"
  local -a matches
  mapfile -t matches < <(grep -E "^${key}=[^[:space:]]+$" "$state_file" || true)
  [ "${#matches[@]}" -eq 1 ] \
    || fail "deployment state field is missing or ambiguous: $key"
  printf '%s\n' "${matches[0]#*=}"
}

require_deployment_transaction() {
  local transaction_id="$1"
  local expected_version="$2"
  local expected_package="$3"
  local expected_source="$4"
  local transaction_dir="${DEPLOYMENTS_ROOT}/${transaction_id}"
  local state_file="${transaction_dir}/state"
  [[ "$transaction_id" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'invalid enterprise deployment transaction id'
  [[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail 'invalid expected enterprise version'
  [[ "$expected_package" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
    || fail 'invalid expected enterprise package identity'
  [[ "$expected_source" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'invalid expected enterprise source commit'
  require_root_owned_directory "$transaction_dir"
  [ "$(stat -c '%u:%g:%a' "$transaction_dir")" = '0:0:700' ] \
    || fail 'enterprise deployment transaction owner or mode is invalid'
  require_root_owned_regular_file "$state_file"
  [ "$(stat -c '%u:%g:%a' "$state_file")" = '0:0:600' ] \
    || fail 'enterprise deployment state owner or mode is invalid'
  [ "$(read_deployment_state_field "$state_file" format)" = \
      'otto-enterprise-deployment-state-v1' ] \
    || fail 'enterprise deployment state format is invalid'
  [ "$(read_deployment_state_field "$state_file" transaction)" = "$transaction_id" ] \
    || fail 'enterprise deployment transaction binding changed'
  [ "$(read_deployment_state_field "$state_file" target_version)" = "$expected_version" ] \
    || fail 'enterprise deployment version binding changed'
  [ "$(read_deployment_state_field "$state_file" target_package)" = "$expected_package" ] \
    || fail 'enterprise deployment package binding changed'
  [ "$(read_deployment_state_field "$state_file" target_source)" = "$expected_source" ] \
    || fail 'enterprise deployment source binding changed'
  printf '%s\n' "$transaction_dir"
}

deployment_receipt_for_state() {
  local transaction_dir="$1"
  local state_file="${transaction_dir}/state"
  printf 'deployed transaction=%s version=%s package=%s source=%s previous_version=%s previous_package=%s previous_source=%s\n' \
    "$(read_deployment_state_field "$state_file" transaction)" \
    "$(read_deployment_state_field "$state_file" target_version)" \
    "$(read_deployment_state_field "$state_file" target_package)" \
    "$(read_deployment_state_field "$state_file" target_source)" \
    "$(read_deployment_state_field "$state_file" previous_version)" \
    "$(read_deployment_state_field "$state_file" previous_package)" \
    "$(read_deployment_state_field "$state_file" previous_source)"
}

rollback_receipt_for_state() {
  local transaction_dir="$1"
  local state_file="${transaction_dir}/state"
  printf 'rolled_back transaction=%s restored_version=%s restored_package=%s restored_source=%s replaced_version=%s replaced_package=%s replaced_source=%s\n' \
    "$(read_deployment_state_field "$state_file" transaction)" \
    "$(read_deployment_state_field "$state_file" previous_version)" \
    "$(read_deployment_state_field "$state_file" previous_package)" \
    "$(read_deployment_state_field "$state_file" previous_source)" \
    "$(read_deployment_state_field "$state_file" target_version)" \
    "$(read_deployment_state_field "$state_file" target_package)" \
    "$(read_deployment_state_field "$state_file" target_source)"
}

rollback_witness_for_state() {
  local transaction_dir="$1"
  local state_file="${transaction_dir}/state"
  printf 'otto-enterprise-rollback-witness-v1 transaction=%s target_version=%s target_package=%s target_source=%s previous_version=%s previous_package=%s previous_source=%s\n' \
    "$(read_deployment_state_field "$state_file" transaction)" \
    "$(read_deployment_state_field "$state_file" target_version)" \
    "$(read_deployment_state_field "$state_file" target_package)" \
    "$(read_deployment_state_field "$state_file" target_source)" \
    "$(read_deployment_state_field "$state_file" previous_version)" \
    "$(read_deployment_state_field "$state_file" previous_package)" \
    "$(read_deployment_state_field "$state_file" previous_source)"
}

write_once_durable() {
  local marker_file="$1"
  local expected_content="$2"
  local marker_directory
  local marker_next="${marker_file}.next"
  marker_directory="$(dirname -- "$marker_file")"
  require_root_owned_directory "$marker_directory"
  if [ -e "$marker_file" ] || [ -L "$marker_file" ]; then
    require_root_owned_regular_file "$marker_file"
    [ "$(stat -c '%u:%g:%a' "$marker_file")" = '0:0:600' ] \
      || fail "durable marker owner or mode is invalid: $marker_file"
    [ "$(<"$marker_file")" = "$expected_content" ] \
      || fail "durable marker content changed: $marker_file"
    if [ -e "$marker_next" ] || [ -L "$marker_next" ]; then
      require_root_owned_regular_file "$marker_next"
      [ "$(stat -c '%u:%g:%a' "$marker_next")" = '0:0:600' ] \
        && [ "$(<"$marker_next")" = "$expected_content" ] \
        || fail "durable marker staging content is invalid: $marker_next"
      rm -f -- "$marker_next"
    fi
    /usr/bin/sync -f "$marker_file"
    /usr/bin/sync -f "$marker_directory"
    return 0
  fi
  if [ -e "$marker_next" ] || [ -L "$marker_next" ]; then
    require_root_owned_regular_file "$marker_next"
    [ "$(stat -c '%u:%g:%a' "$marker_next")" = '0:0:600' ] \
      || fail "durable marker staging owner or mode is invalid: $marker_next"
    rm -f -- "$marker_next"
  fi
  /usr/bin/python3 -I -S - \
    "$marker_next" "$marker_file" "$expected_content" <<'PY'
import os
import pathlib
import sys

next_path = pathlib.Path(sys.argv[1])
final_path = pathlib.Path(sys.argv[2])
payload = (sys.argv[3] + '\n').encode('utf-8')
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
descriptor = os.open(next_path, flags, 0o600)
try:
    offset = 0
    while offset < len(payload):
        offset += os.write(descriptor, payload[offset:])
    os.fchmod(descriptor, 0o600)
    os.fchown(descriptor, 0, 0)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
try:
    os.link(next_path, final_path, follow_symlinks=False)
finally:
    if next_path.exists():
        next_path.unlink()
directory = os.open(final_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  require_root_owned_regular_file "$marker_file"
  [ "$(stat -c '%u:%g:%a' "$marker_file")" = '0:0:600' ] \
    || fail "new durable marker owner or mode is invalid: $marker_file"
  [ "$(<"$marker_file")" = "$expected_content" ] \
    || fail "new durable marker content is invalid: $marker_file"
}

complete_deployment_receipt() {
  local transaction_dir="$1"
  local receipt_file="${transaction_dir}/receipt"
  local expected_receipt
  require_complete_upgrade_rollback_snapshot "$transaction_dir"
  sync_live_deployment_filesystems
  expected_receipt="$(deployment_receipt_for_state "$transaction_dir")"
  write_once_durable "$receipt_file" "$expected_receipt"
  printf '%s\n' "$expected_receipt"
}

require_complete_upgrade_rollback_snapshot() {
  local transaction_dir="$1"
  local state_file="${transaction_dir}/state"
  local upgrade_dir="${transaction_dir}/upgrade"
  local expected_witness witness_file resident_backup resident_absent
  local database_key_created database_key_preserved database_key_snapshot
  [ "$(read_deployment_state_field "$state_file" action)" = upgrade ] \
    || fail 'enterprise rollback snapshot is not bound to an upgrade'
  require_root_owned_directory "$upgrade_dir"
  [ "$(stat -c '%u:%g:%a' "$upgrade_dir")" = '0:0:700' ] \
    || fail 'enterprise rollback snapshot directory owner or mode is invalid'
  for snapshot in \
    data.db.before enterprise.env.before otto-enterprise.service.before; do
    require_root_owned_regular_file "${upgrade_dir}/${snapshot}"
  done
  [ "$(stat -c '%u:%g:%a' "${upgrade_dir}/data.db.before")" = '0:0:600' ] \
    && [ "$(stat -c '%u:%g:%a' "${upgrade_dir}/enterprise.env.before")" = '0:0:600' ] \
    && [ "$(stat -c '%u:%g:%a' "${upgrade_dir}/otto-enterprise.service.before")" = '0:0:644' ] \
    || fail 'enterprise rollback snapshot file owner or mode is invalid'
  require_root_owned_directory "${upgrade_dir}/deploy.before"
  resident_backup="${upgrade_dir}/resident-recurring-tasks.json.before"
  resident_absent="${upgrade_dir}/resident-recurring-tasks.absent"
  if { [ -e "$resident_backup" ] || [ -L "$resident_backup" ]; } \
    && { [ -e "$resident_absent" ] || [ -L "$resident_absent" ]; }; then
    fail 'enterprise rollback snapshot has conflicting resident task state'
  elif [ -e "$resident_backup" ] || [ -L "$resident_backup" ]; then
    require_root_owned_regular_file "$resident_backup"
    [ "$(stat -c '%u:%g:%a' "$resident_backup")" = '0:0:600' ] \
      || fail 'resident task state rollback snapshot owner or mode is invalid'
  elif [ -e "$resident_absent" ] || [ -L "$resident_absent" ]; then
    require_root_owned_regular_file "$resident_absent"
    [ "$(stat -c '%u:%g:%a' "$resident_absent")" = '0:0:600' ] \
      && [ ! -s "$resident_absent" ] \
      || fail 'resident task state absence snapshot is invalid'
  else
    fail 'enterprise rollback snapshot lacks resident task state identity'
  fi
  database_key_created="${upgrade_dir}/database-key-created"
  database_key_preserved="${upgrade_dir}/database-key-preserved"
  if { [ -e "$database_key_created" ] || [ -L "$database_key_created" ]; } \
    && { [ -e "$database_key_preserved" ] || [ -L "$database_key_preserved" ]; }; then
    fail 'enterprise rollback snapshot has conflicting database key identity'
  elif [ -e "$database_key_created" ] || [ -L "$database_key_created" ]; then
    database_key_snapshot="$database_key_created"
  elif [ -e "$database_key_preserved" ] || [ -L "$database_key_preserved" ]; then
    database_key_snapshot="$database_key_preserved"
  else
    fail 'enterprise rollback snapshot lacks database key identity'
  fi
  require_root_owned_regular_file "$database_key_snapshot"
  [ "$(stat -c '%u:%g:%a' "$database_key_snapshot")" = '0:0:600' ] \
    && [ ! -s "$database_key_snapshot" ] \
    || fail 'database key rollback identity marker is invalid'
  witness_file="${transaction_dir}/rollback-witness.expected"
  require_root_owned_regular_file "$witness_file"
  [ "$(stat -c '%u:%g:%a' "$witness_file")" = '0:0:600' ] \
    || fail 'enterprise rollback witness owner or mode is invalid'
  expected_witness="$(rollback_witness_for_state "$transaction_dir")"
  [ "$(<"$witness_file")" = "$expected_witness" ] \
    || fail 'enterprise rollback witness binding changed'
  /usr/bin/sync -f "$upgrade_dir"
}

find_unfinished_deployment() {
  local -a transaction_directories unfinished=()
  local transaction_dir transaction_id state_file deployment_receipt rollback_receipt
  [ -z "$(find "$DEPLOYMENTS_ROOT" -mindepth 1 -maxdepth 1 ! -type d -print -quit)" ] \
    || fail 'enterprise deployment state root contains a non-directory entry'
  mapfile -d '' transaction_directories < <(
    find "$DEPLOYMENTS_ROOT" -mindepth 1 -maxdepth 1 -type d -print0
  )
  for transaction_dir in "${transaction_directories[@]}"; do
    transaction_id="${transaction_dir##*/}"
    [[ "$transaction_id" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
      || fail "unexpected enterprise deployment transaction directory: $transaction_id"
    require_root_owned_directory "$transaction_dir"
    [ "$(stat -c '%u:%g:%a' "$transaction_dir")" = '0:0:700' ] \
      || fail "enterprise deployment transaction owner or mode is invalid: $transaction_id"
    state_file="${transaction_dir}/state"
    require_root_owned_regular_file "$state_file"
    [ "$(stat -c '%u:%g:%a' "$state_file")" = '0:0:600' ] \
      || fail "enterprise deployment state owner or mode is invalid: $transaction_id"
    [ "$(read_deployment_state_field "$state_file" format)" = \
        'otto-enterprise-deployment-state-v1' ] \
      || fail "enterprise deployment state format is invalid: $transaction_id"
    [ "$(read_deployment_state_field "$state_file" transaction)" = "$transaction_id" ] \
      || fail "enterprise deployment transaction binding changed: $transaction_id"
    if { [ -e "${transaction_dir}/finalized" ] || [ -L "${transaction_dir}/finalized" ]; } \
      && { [ -e "${transaction_dir}/rolled-back" ] || [ -L "${transaction_dir}/rolled-back" ]; }; then
      fail "enterprise deployment transaction has conflicting terminal markers: $transaction_id"
    elif [ -e "${transaction_dir}/finalized" ] || [ -L "${transaction_dir}/finalized" ]; then
      deployment_receipt="$(deployment_receipt_for_state "$transaction_dir")"
      write_once_durable "${transaction_dir}/finalized" "$deployment_receipt"
    elif [ -e "${transaction_dir}/rolled-back" ] || [ -L "${transaction_dir}/rolled-back" ]; then
      rollback_receipt="$(rollback_receipt_for_state "$transaction_dir")"
      write_once_durable "${transaction_dir}/rolled-back" "$rollback_receipt"
    else
      unfinished+=("$transaction_dir")
    fi
  done
  [ "${#unfinished[@]}" -le 1 ] \
    || fail 'multiple unfinished enterprise deployment transactions require manual recovery'
  if [ "${#unfinished[@]}" -eq 1 ]; then
    printf '%s\n' "${unfinished[0]}"
  fi
}

complete_rolled_back_receipt_if_previous() {
  local transaction_dir="$1"
  local state_file="${transaction_dir}/state"
  local previous_version previous_package previous_source previous_current
  local current_release expected_receipt expected_witness witness_file verified_file
  previous_version="$(read_deployment_state_field "$state_file" previous_version)"
  previous_package="$(read_deployment_state_field "$state_file" previous_package)"
  previous_source="$(read_deployment_state_field "$state_file" previous_source)"
  previous_current="$(read_deployment_state_field "$state_file" previous_current)"
  [[ "$previous_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    && [[ "$previous_package" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
    && [[ "$previous_source" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'previous enterprise deployment identity is invalid during recovery'
  [[ "$previous_current" =~ ^/opt/otto-enterprise/releases/[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$ ]] \
    || fail 'previous enterprise current target is invalid during recovery'
  [ -L "${INSTALL_ROOT}/current" ] \
    || fail 'enterprise current release is not a managed symlink during recovery'
  current_release="$(readlink -f -- "${INSTALL_ROOT}/current")"
  [ "$current_release" = "$previous_current" ] \
    || fail 'failed enterprise deployment did not restore the locked previous current release'
  witness_file="${transaction_dir}/rollback-witness.expected"
  verified_file="${transaction_dir}/upgrade/rollback-verified"
  expected_witness="$(rollback_witness_for_state "$transaction_dir")"
  for witness_path in "$witness_file" "$verified_file"; do
    require_root_owned_regular_file "$witness_path"
    [ "$(stat -c '%u:%g:%a' "$witness_path")" = '0:0:600' ] \
      || fail 'enterprise rollback verification witness owner or mode is invalid'
    [ "$(<"$witness_path")" = "$expected_witness" ] \
      || fail 'enterprise rollback verification witness binding changed'
    /usr/bin/sync -f "$witness_path"
  done
  /usr/bin/sync -f "$transaction_dir"
  verify_current_deployment \
    "$previous_version" "$previous_package" "$previous_source"
  sync_live_deployment_filesystems
  expected_receipt="$(rollback_receipt_for_state "$transaction_dir")"
  write_once_durable "${transaction_dir}/rolled-back" "$expected_receipt"
  printf '%s\n' "$expected_receipt"
}

[ "$(id -u)" -eq 0 ] || fail 'gateway must run as root through sudo -n'
# Establish the only pre-snapshot trust boundary first. No replaceable gateway,
# helper, key, config or principal file is read until production.lock is held.
require_root_owned_directory_chain "$LOCKS_ROOT"
require_root_owned_directory "$LOCKS_ROOT"
[ "$(stat -c '%u:%g:%a' "$LOCKS_ROOT")" = '0:0:700' ] \
  || fail 'production lock directory owner or mode is invalid'
[ -x /usr/bin/flock ] || fail 'required /usr/bin/flock is unavailable'
acquire_production_lock
verify_running_gateway_identity
for trusted_directory in \
  "$(dirname -- "$GATEWAY_PATH")" \
  "$LIBEXEC_ROOT" \
  "$(dirname -- "$TRUST_KEY_PATH")" \
  "$STATE_ROOT"; do
  require_root_owned_directory_chain "$trusted_directory"
done
require_root_owned_regular_file "$GATEWAY_PATH"
require_root_owned_regular_file "$PUBLISH_HELPER_PATH"
require_root_owned_regular_file "$ROLLBACK_HELPER_PATH"
require_root_owned_regular_file "$TRUST_KEY_PATH"
require_root_owned_regular_file "$CONFIG_PATH_FILE"
require_root_owned_regular_file "$DEPLOY_USER_FILE"
require_root_owned_regular_file "$ROLLBACK_USER_FILE"
require_root_owned_directory "$STATE_ROOT"
require_root_owned_directory "$UPLOADS_ROOT"
require_root_owned_directory "$STAGES_ROOT"
require_root_owned_directory "$LOCKS_ROOT"
require_root_owned_directory "$UPLOAD_ROOT"
require_root_owned_directory "$MIRROR_UPLOAD_ROOT"
require_root_owned_directory "$STAGING_ROOT"
require_root_owned_directory "$MIRROR_STAGING_ROOT"
require_root_owned_directory "$DEPLOYMENTS_ROOT"

IFS= read -r DEPLOY_USER < "$DEPLOY_USER_FILE" || \
  fail 'pinned deploy user is unreadable'
IFS= read -r ROLLBACK_USER < "$ROLLBACK_USER_FILE" || \
  fail 'pinned rollback user is unreadable'
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
  || fail 'pinned deploy user is invalid'
[[ "$ROLLBACK_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
  || fail 'pinned rollback user is invalid'
[ "$DEPLOY_USER" != "$ROLLBACK_USER" ] \
  || fail 'deploy and rollback users must be distinct'
id -u "$DEPLOY_USER" >/dev/null || fail 'pinned deploy user does not exist'
id -u "$ROLLBACK_USER" >/dev/null || fail 'pinned rollback user does not exist'
DEPLOY_USER_UID="$(id -u "$DEPLOY_USER")"
ROLLBACK_USER_UID="$(id -u "$ROLLBACK_USER")"
DEPLOY_USER_GID="$(id -g "$DEPLOY_USER")" \
  || fail 'pinned deploy user primary group does not exist'
ROLLBACK_USER_GID="$(id -g "$ROLLBACK_USER")" \
  || fail 'pinned rollback user primary group does not exist'
[ "$DEPLOY_USER_UID" -ne 0 ] && [ "$ROLLBACK_USER_UID" -ne 0 ] \
  || fail 'pinned automation principals must be non-root'
[ "$DEPLOY_USER_UID" != "$ROLLBACK_USER_UID" ] \
  || fail 'pinned automation principals must have distinct UIDs'
[ "$DEPLOY_USER_GID" != "$ROLLBACK_USER_GID" ] \
  || fail 'pinned automation principals must have distinct primary GIDs'
require_root_owned_regular_file /usr/bin/sudo
[ -x /usr/bin/sudo ] || fail 'required /usr/bin/sudo is unavailable'

audit_automation_principal() {
  local principal="$1"
  local primary_group all_groups sudo_listing expected_rule
  local -a privilege_rules
  primary_group="$(id -gn "$principal")" \
    || fail "could not resolve primary group for pinned principal: $principal"
  all_groups="$(id -nG "$principal")" \
    || fail "could not resolve groups for pinned principal: $principal"
  [ "$all_groups" = "$primary_group" ] \
    || fail "pinned automation principal has supplementary group privileges: $principal"
  sudo_listing="$(COLUMNS=4096 /usr/bin/sudo -n -l -U "$principal")" \
    || fail "could not enumerate effective sudo privileges for pinned principal: $principal"
  mapfile -t privilege_rules < <(
    printf '%s\n' "$sudo_listing" | \
      sed -n -E 's/^[[:space:]]+(\([^)]*\)[[:space:]]+.*)$/\1/p'
  )
  expected_rule="(root) NOPASSWD: $GATEWAY_PATH"
  [ "${#privilege_rules[@]}" -eq 1 ] \
    && [ "${privilege_rules[0]}" = "$expected_rule" ] \
    || fail "pinned automation principal has sudo privileges outside the fixed gateway: $principal"
}

audit_automation_principal "$DEPLOY_USER"
audit_automation_principal "$ROLLBACK_USER"

COMMAND="${1:-}"
case "${SUDO_USER:-}" in
  "$DEPLOY_USER")
    CALLER_ROLE='deploy'
    case "$COMMAND" in
      rollback-mirror|rollback-enterprise)
        fail 'deploy principal is not authorized to perform rollback operations'
        ;;
    esac
    ;;
  "$ROLLBACK_USER")
    CALLER_ROLE='rollback'
    case "$COMMAND" in
      preflight|rollback-mirror|rollback-enterprise) ;;
      *) fail 'rollback principal may only preflight or perform a locked rollback' ;;
    esac
    ;;
  *) fail 'gateway caller does not match a pinned automation principal' ;;
esac
if [ "$COMMAND" = 'prepare-upload' ] \
  || [ "$COMMAND" = 'cleanup-upload' ] \
  || [ "$COMMAND" = 'upload-file' ]; then
  if [ "$COMMAND" = 'upload-file' ]; then
    [ "$#" -eq 6 ] \
      || fail 'usage: upload-file KIND TRANSACTION ROLE SIZE SHA256'
  else
    [ "$#" -eq 3 ] || fail "usage: ${COMMAND} KIND TRANSACTION"
  fi
  UPLOAD_KIND="$2"
  TRANSACTION_ID="$3"
  [[ "$TRANSACTION_ID" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'invalid upload transaction id'
  case "$UPLOAD_KIND" in
    enterprise)
      TRANSACTION_UPLOAD_ROOT="$UPLOAD_ROOT"
      TRANSACTION_STAGING_ROOT="$STAGING_ROOT"
      ;;
    mirror)
      TRANSACTION_UPLOAD_ROOT="$MIRROR_UPLOAD_ROOT"
      TRANSACTION_STAGING_ROOT="$MIRROR_STAGING_ROOT"
      ;;
    *) fail 'upload kind must be enterprise or mirror' ;;
  esac
  acquire_production_lock
  TRANSACTION_UPLOAD_DIR="${TRANSACTION_UPLOAD_ROOT}/${TRANSACTION_ID}"
  if [ "$COMMAND" = 'prepare-upload' ]; then
    TRANSACTION_SCAN_FILE="$(mktemp "${LOCKS_ROOT}/.transaction-scan.XXXXXXXX")"
    chmod 0600 "$TRANSACTION_SCAN_FILE"
    trap 'rm -f -- "$TRANSACTION_SCAN_FILE"' EXIT
    if ! /usr/bin/find "$TRANSACTION_UPLOAD_ROOT" \
      -mindepth 1 -maxdepth 1 -print -quit > "$TRANSACTION_SCAN_FILE"; then
      fail 'could not enumerate pending upload transactions'
    fi
    [ ! -s "$TRANSACTION_SCAN_FILE" ] \
      || fail 'another upload transaction is still pending cleanup'
    rm -f -- "$TRANSACTION_SCAN_FILE"
    trap - EXIT
    [ ! -e "$TRANSACTION_UPLOAD_DIR" ] && [ ! -L "$TRANSACTION_UPLOAD_DIR" ] \
      || fail 'upload transaction already exists; refusing replay'
    prepare_upload_created='false'
    cleanup_incomplete_prepare() {
      if [ "$prepare_upload_created" = 'true' ]; then
        rm -rf --one-file-system -- "$TRANSACTION_UPLOAD_DIR"
      fi
    }
    trap cleanup_incomplete_prepare EXIT
    mkdir -m 0700 -- "$TRANSACTION_UPLOAD_DIR" \
      || fail 'could not atomically create upload transaction'
    prepare_upload_created='true'
    chown root:root "$TRANSACTION_UPLOAD_DIR"
    chmod 0700 "$TRANSACTION_UPLOAD_DIR"
    prepare_upload_created='false'
    trap - EXIT
    exit 0
  fi
  if [ "$COMMAND" = 'upload-file' ]; then
    UPLOAD_ROLE="$4"
    EXPECTED_SIZE="$5"
    EXPECTED_SHA256="$6"
    [[ "$EXPECTED_SIZE" =~ ^[1-9][0-9]{0,9}$ ]] \
      || fail 'upload size is invalid'
    [[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] \
      || fail 'upload sha256 is invalid'
    TRANSACTION_VERSION="${TRANSACTION_ID%%-*}"
    TRANSACTION_VERSION="${TRANSACTION_VERSION#v}"
    case "$UPLOAD_KIND:$UPLOAD_ROLE" in
      enterprise:archive-*)
        PACKAGE_ID="${UPLOAD_ROLE#archive-}"
        [[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
          || fail 'enterprise upload role has an invalid package identity'
        UPLOAD_NAME="otto-enterprise-oneclick-v${TRANSACTION_VERSION}-${PACKAGE_ID}.tar.gz"
        FILE_SIZE_LIMIT="$MAX_ENTERPRISE_ARCHIVE_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_ENTERPRISE_TRANSACTION_BYTES"
        ;;
      enterprise:checksum-*)
        PACKAGE_ID="${UPLOAD_ROLE#checksum-}"
        [[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
          || fail 'enterprise upload role has an invalid package identity'
        UPLOAD_NAME="otto-enterprise-oneclick-v${TRANSACTION_VERSION}-${PACKAGE_ID}.tar.gz.sha256"
        FILE_SIZE_LIMIT="$MAX_ENTERPRISE_METADATA_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_ENTERPRISE_TRANSACTION_BYTES"
        ;;
      enterprise:signature-*)
        PACKAGE_ID="${UPLOAD_ROLE#signature-}"
        [[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
          || fail 'enterprise upload role has an invalid package identity'
        UPLOAD_NAME="otto-enterprise-oneclick-v${TRANSACTION_VERSION}-${PACKAGE_ID}.tar.gz.sig"
        FILE_SIZE_LIMIT="$MAX_ENTERPRISE_METADATA_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_ENTERPRISE_TRANSACTION_BYTES"
        ;;
      mirror:mac-arm64-installer)
        UPLOAD_NAME="Otto-${TRANSACTION_VERSION}-arm64.dmg"
        FILE_SIZE_LIMIT="$MAX_MIRROR_INSTALLER_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:mac-arm64-blockmap)
        UPLOAD_NAME="Otto-${TRANSACTION_VERSION}-arm64.dmg.blockmap"
        FILE_SIZE_LIMIT="$MAX_MIRROR_BLOCKMAP_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:mac-x64-installer)
        UPLOAD_NAME="Otto-${TRANSACTION_VERSION}-x64.dmg"
        FILE_SIZE_LIMIT="$MAX_MIRROR_INSTALLER_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:mac-x64-blockmap)
        UPLOAD_NAME="Otto-${TRANSACTION_VERSION}-x64.dmg.blockmap"
        FILE_SIZE_LIMIT="$MAX_MIRROR_BLOCKMAP_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:windows-x64-installer)
        UPLOAD_NAME="Otto-Setup-${TRANSACTION_VERSION}-win-x64.exe"
        FILE_SIZE_LIMIT="$MAX_MIRROR_INSTALLER_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:windows-x64-blockmap)
        UPLOAD_NAME="Otto-Setup-${TRANSACTION_VERSION}-win-x64.exe.blockmap"
        FILE_SIZE_LIMIT="$MAX_MIRROR_BLOCKMAP_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:latest-manifest)
        UPLOAD_NAME='latest.json'
        FILE_SIZE_LIMIT="$MAX_MIRROR_METADATA_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:payload-checksums)
        UPLOAD_NAME='UPDATE-MIRROR-SHA256SUMS'
        FILE_SIZE_LIMIT="$MAX_MIRROR_METADATA_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      mirror:payload-signature)
        UPLOAD_NAME='UPDATE-MIRROR-SHA256SUMS.sig'
        FILE_SIZE_LIMIT="$MAX_MIRROR_METADATA_BYTES"
        TRANSACTION_SIZE_LIMIT="$MAX_MIRROR_TRANSACTION_BYTES"
        ;;
      *) fail 'upload role is not allowed for this kind' ;;
    esac
    [ "$EXPECTED_SIZE" -le "$FILE_SIZE_LIMIT" ] \
      || fail 'upload exceeds its role-specific size limit'
    [ -d "$TRANSACTION_UPLOAD_DIR" ] && [ ! -L "$TRANSACTION_UPLOAD_DIR" ] \
      || fail 'upload transaction directory is missing or unsafe'
    [ "$(stat -c '%u:%g:%a' "$TRANSACTION_UPLOAD_DIR")" = '0:0:700' ] \
      || fail 'upload transaction directory owner or mode is invalid'
    TARGET_UPLOAD_PATH="${TRANSACTION_UPLOAD_DIR}/${UPLOAD_NAME}"
    UPLOAD_RETRY='false'
    if [ -e "$TARGET_UPLOAD_PATH" ] || [ -L "$TARGET_UPLOAD_PATH" ]; then
      [ -f "$TARGET_UPLOAD_PATH" ] && [ ! -L "$TARGET_UPLOAD_PATH" ] \
        || fail 'existing upload target is unsafe'
      [ "$(stat -c '%u:%g:%a' "$TARGET_UPLOAD_PATH")" = '0:0:600' ] \
        || fail 'existing upload target owner or mode is invalid'
      [ "$(stat -c '%s' "$TARGET_UPLOAD_PATH")" = "$EXPECTED_SIZE" ] \
        && [ "$(sha256sum "$TARGET_UPLOAD_PATH" | awk '{print $1}')" = "$EXPECTED_SHA256" ] \
        || fail 'existing upload target does not match the retry identity'
      UPLOAD_RETRY='true'
    fi
    if [ "$UPLOAD_RETRY" = 'false' ]; then
      CURRENT_TRANSACTION_BYTES=0
      UPLOAD_SCAN_FILE="$(mktemp "${LOCKS_ROOT}/.upload-quota-scan.XXXXXXXX")"
      chmod 0600 "$UPLOAD_SCAN_FILE"
      trap 'rm -f -- "$UPLOAD_SCAN_FILE"' EXIT
      if ! find "$TRANSACTION_UPLOAD_DIR" -mindepth 1 -maxdepth 1 -print0 \
        > "$UPLOAD_SCAN_FILE"; then
        fail 'could not enumerate the upload transaction for quota enforcement'
      fi
      while IFS= read -r -d '' existing_upload; do
        [ -f "$existing_upload" ] && [ ! -L "$existing_upload" ] \
          || fail 'upload transaction contains an unsafe entry'
        [ "$(stat -c '%u:%g:%a' "$existing_upload")" = '0:0:600' ] \
          || fail 'upload transaction contains a file with unsafe owner or mode'
        CURRENT_TRANSACTION_BYTES="$((CURRENT_TRANSACTION_BYTES + $(stat -c '%s' "$existing_upload")))"
      done < "$UPLOAD_SCAN_FILE"
      rm -f -- "$UPLOAD_SCAN_FILE"
      trap - EXIT
      RESULTING_TRANSACTION_BYTES="$((CURRENT_TRANSACTION_BYTES + EXPECTED_SIZE))"
      [ "$RESULTING_TRANSACTION_BYTES" -le "$TRANSACTION_SIZE_LIMIT" ] \
        || fail 'upload transaction exceeds its total size limit'
      AVAILABLE_KIB="$(df -Pk -- "$TRANSACTION_UPLOAD_DIR" | awk 'NR == 2 { print $4 }')"
      [[ "$AVAILABLE_KIB" =~ ^[0-9]+$ ]] \
        || fail 'could not determine upload filesystem capacity'
      # The deploy/publish phase creates a root-only staging copy. Before
      # accepting this stream, reserve space for the incoming bytes, a complete
      # copy of the resulting transaction, and an operational safety margin.
      REQUIRED_KIB="$(((EXPECTED_SIZE + RESULTING_TRANSACTION_BYTES + 1023) / 1024 + MIN_UPLOAD_FREE_RESERVE_KIB))"
      [ "$AVAILABLE_KIB" -ge "$REQUIRED_KIB" ] \
        || fail 'upload filesystem does not have the required free-space reserve'
    fi
    /usr/bin/python3 -I -S /dev/fd/3 \
      "$TRANSACTION_UPLOAD_DIR" "$UPLOAD_NAME" "$EXPECTED_SIZE" \
      "$EXPECTED_SHA256" "$UPLOAD_TIMEOUT_SECONDS" "$UPLOAD_RETRY" 3<<'PY'
import hashlib
import os
import secrets
import signal
import stat
import sys

directory, name, raw_size, expected_digest, raw_timeout, raw_retry = sys.argv[1:]
expected_size = int(raw_size)
timeout = int(raw_timeout)
is_retry = raw_retry == 'true'

def timeout_upload(_signum, _frame):
    raise TimeoutError('upload timed out')

signal.signal(signal.SIGALRM, timeout_upload)
signal.alarm(timeout)
directory_fd = os.open(
    directory,
    os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0),
)
temporary_name = f'.upload-{secrets.token_hex(16)}'
temporary_fd = -1
try:
    if is_retry:
        existing_fd = os.open(
            name,
            os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
            dir_fd=directory_fd,
        )
        try:
            metadata = os.fstat(existing_fd)
            existing_digest = hashlib.sha256()
            while True:
                existing_chunk = os.read(existing_fd, 1024 * 1024)
                if not existing_chunk:
                    break
                existing_digest.update(existing_chunk)
            if (
                metadata.st_uid != 0
                or metadata.st_gid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_size != expected_size
                or existing_digest.hexdigest() != expected_digest
            ):
                raise ValueError('existing upload target changed during retry')
        finally:
            os.close(existing_fd)
    else:
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
            0o600,
            dir_fd=directory_fd,
        )
    digest = hashlib.sha256()
    remaining = expected_size
    while remaining:
        chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
        if not chunk:
            raise ValueError('upload ended before the declared size')
        if not is_retry:
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    raise OSError('upload write made no progress')
                view = view[written:]
        digest.update(chunk)
        remaining -= len(chunk)
    if sys.stdin.buffer.read(1):
        raise ValueError('upload exceeded the declared size')
    if digest.hexdigest() != expected_digest:
        raise ValueError('upload digest does not match the declared sha256')
    if not is_retry:
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        os.rename(
            temporary_name,
            name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
finally:
    signal.alarm(0)
    if temporary_fd >= 0:
        os.close(temporary_fd)
    try:
        os.unlink(temporary_name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass
    os.close(directory_fd)
PY
    [ "$(stat -c '%u:%g:%a' "$TARGET_UPLOAD_PATH")" = '0:0:600' ] \
      || fail 'accepted upload target owner or mode is invalid'
    printf 'uploaded kind=%s transaction=%s role=%s size=%s sha256=%s\n' \
      "$UPLOAD_KIND" "$TRANSACTION_ID" "$UPLOAD_ROLE" \
      "$EXPECTED_SIZE" "$EXPECTED_SHA256"
    exit 0
  fi
  if [ -e "$TRANSACTION_UPLOAD_DIR" ] || [ -L "$TRANSACTION_UPLOAD_DIR" ]; then
    [ -d "$TRANSACTION_UPLOAD_DIR" ] && [ ! -L "$TRANSACTION_UPLOAD_DIR" ] \
      || fail 'upload transaction path is unsafe'
    rm -rf --one-file-system -- "$TRANSACTION_UPLOAD_DIR"
  fi
  TRANSACTION_STAGING_DIR="${TRANSACTION_STAGING_ROOT}/${TRANSACTION_ID}"
  if [ -e "$TRANSACTION_STAGING_DIR" ] || [ -L "$TRANSACTION_STAGING_DIR" ]; then
    [ -d "$TRANSACTION_STAGING_DIR" ] && [ ! -L "$TRANSACTION_STAGING_DIR" ] \
      || fail 'staging transaction path is unsafe'
    [ "$(stat -c '%u:%g' "$TRANSACTION_STAGING_DIR")" = '0:0' ] \
      || fail 'staging transaction path is not root-owned'
    rm -rf --one-file-system -- "$TRANSACTION_STAGING_DIR"
  fi
  exit 0
fi

if [ "$COMMAND" = 'preflight' ]; then
  [ "$#" -eq 1 ] || fail 'usage: preflight'
  acquire_production_lock
  IFS= read -r DEPLOY_CONFIG_PATH < "$CONFIG_PATH_FILE" || \
    fail 'deployment config path is unreadable'
  [[ "$DEPLOY_CONFIG_PATH" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
    || fail 'server-pinned deployment config path is invalid'
  require_root_owned_directory_chain "$(dirname -- "$DEPLOY_CONFIG_PATH")"
  require_root_owned_regular_file "$DEPLOY_CONFIG_PATH"
  TRUST_KEY_ID="$(openssl pkey -pubin -in "$TRUST_KEY_PATH" -outform DER | sha256sum | awk '{print substr($1,1,16)}')"
  GATEWAY_SHA256="$(sha256sum "$GATEWAY_PATH" | awk '{print $1}')"
  PUBLISH_HELPER_SHA256="$(sha256sum "$PUBLISH_HELPER_PATH" | awk '{print $1}')"
  ROLLBACK_HELPER_SHA256="$(sha256sum "$ROLLBACK_HELPER_PATH" | awk '{print $1}')"
  printf 'protocol=%s gateway=%s publish=%s rollback=%s key=%s config=%s deploy_user=%s rollback_user=%s\n' \
    "$GATEWAY_PROTOCOL" "$GATEWAY_SHA256" "$PUBLISH_HELPER_SHA256" \
    "$ROLLBACK_HELPER_SHA256" "$TRUST_KEY_ID" "$DEPLOY_CONFIG_PATH" \
    "$DEPLOY_USER" "$ROLLBACK_USER"
  exit 0
fi

if [ "$COMMAND" = 'verify-deployment' ]; then
  [ "$#" -eq 5 ] \
    || fail 'usage: verify-deployment TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
  TRANSACTION_ID="$2"
  EXPECTED_VERSION="$3"
  PACKAGE_ID="$4"
  EXPECTED_SOURCE_COMMIT="$5"
  acquire_production_lock
  DEPLOYMENT_STATE_DIR="$(require_deployment_transaction \
    "$TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
    "$EXPECTED_SOURCE_COMMIT")"
  verify_current_deployment \
    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
  sync_live_deployment_filesystems
  complete_deployment_receipt "$DEPLOYMENT_STATE_DIR"
  exit 0
fi

if [ "$COMMAND" = 'reconcile-deployment' ]; then
  [ "$#" -eq 5 ] \
    || fail 'usage: reconcile-deployment REQUESTED_TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
  REQUESTED_TRANSACTION_ID="$2"
  EXPECTED_VERSION="$3"
  PACKAGE_ID="$4"
  EXPECTED_SOURCE_COMMIT="$5"
  [[ "$REQUESTED_TRANSACTION_ID" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'invalid requested enterprise reconciliation transaction'
  [[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail 'invalid expected enterprise version'
  [[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
    || fail 'invalid expected enterprise package identity'
  [[ "$EXPECTED_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'invalid expected enterprise source commit'
  acquire_production_lock
  REQUESTED_TRANSACTION_DIR="${DEPLOYMENTS_ROOT}/${REQUESTED_TRANSACTION_ID}"
  [ -e "$REQUESTED_TRANSACTION_DIR" ] \
    && [ ! -L "$REQUESTED_TRANSACTION_DIR" ] \
    || fail 'the exact requested enterprise reconciliation transaction does not exist'
  DEPLOYMENT_STATE_DIR="$(require_deployment_transaction \
    "$REQUESTED_TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
    "$EXPECTED_SOURCE_COMMIT")"
  # Validate every other transaction and reject any unrelated unfinished
  # deployment before reconciling this exact workflow-owned transaction.
  UNFINISHED_DEPLOYMENT="$(find_unfinished_deployment)"
  [ -z "$UNFINISHED_DEPLOYMENT" ] \
    || [ "$UNFINISHED_DEPLOYMENT" = "$DEPLOYMENT_STATE_DIR" ] \
    || fail 'another unfinished enterprise deployment blocks reconciliation'
  TRANSACTION_ID="${DEPLOYMENT_STATE_DIR##*/}"
  require_deployment_transaction \
    "$TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
    "$EXPECTED_SOURCE_COMMIT" >/dev/null
  if [ -e "${DEPLOYMENT_STATE_DIR}/rolled-back" ] \
    || [ -L "${DEPLOYMENT_STATE_DIR}/rolled-back" ]; then
    ROLLBACK_RECEIPT="$(complete_rolled_back_receipt_if_previous \
      "$DEPLOYMENT_STATE_DIR")"
    printf 'recovered_%s\n' "$ROLLBACK_RECEIPT"
  else
    STATE_FILE="${DEPLOYMENT_STATE_DIR}/state"
    CURRENT_RELEASE=''
    if [ -L "${INSTALL_ROOT}/current" ]; then
      CURRENT_RELEASE="$(readlink -f -- "${INSTALL_ROOT}/current")"
    fi
    TARGET_RELEASE="${INSTALL_ROOT}/releases/${EXPECTED_VERSION}-${PACKAGE_ID%%-*}"
    PREVIOUS_CURRENT="$(read_deployment_state_field "$STATE_FILE" previous_current)"
    if [ "$CURRENT_RELEASE" = "$TARGET_RELEASE" ]; then
      verify_current_deployment \
        "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
      DEPLOYMENT_RECEIPT="$(complete_deployment_receipt "$DEPLOYMENT_STATE_DIR")"
      printf 'recovered_%s\n' "$DEPLOYMENT_RECEIPT"
    elif [ "$CURRENT_RELEASE" = "$PREVIOUS_CURRENT" ]; then
      ROLLBACK_RECEIPT="$(complete_rolled_back_receipt_if_previous \
        "$DEPLOYMENT_STATE_DIR")"
      printf 'recovered_%s\n' "$ROLLBACK_RECEIPT"
    else
      fail 'unfinished enterprise deployment is neither the locked target nor previous release'
    fi
  fi
  exit 0
fi

if [ "$COMMAND" = 'finalize-deployment' ]; then
  [ "$#" -eq 5 ] \
    || fail 'usage: finalize-deployment TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
  TRANSACTION_ID="$2"
  EXPECTED_VERSION="$3"
  PACKAGE_ID="$4"
  EXPECTED_SOURCE_COMMIT="$5"
  acquire_production_lock
  DEPLOYMENT_STATE_DIR="$(require_deployment_transaction \
    "$TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
    "$EXPECTED_SOURCE_COMMIT")"
  verify_current_deployment \
    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
  # Re-establish the live-filesystem durability barrier before either the
  # first terminal marker or an idempotent replay after a lost SSH response.
  sync_live_deployment_filesystems
  EXPECTED_RECEIPT="$(deployment_receipt_for_state "$DEPLOYMENT_STATE_DIR")"
  [ ! -e "${DEPLOYMENT_STATE_DIR}/rolled-back" ] \
    && [ ! -L "${DEPLOYMENT_STATE_DIR}/rolled-back" ] \
    || fail 'cannot finalize a rolled-back enterprise deployment'
  if [ -e "${DEPLOYMENT_STATE_DIR}/finalized" ] \
    || [ -L "${DEPLOYMENT_STATE_DIR}/finalized" ]; then
    # A prior attempt may have durably committed and garbage-collected the
    # rollback snapshot before its SSH response was delivered. Re-establish
    # both durability barriers and replay the exact same receipt.
    write_once_durable "${DEPLOYMENT_STATE_DIR}/receipt" "$EXPECTED_RECEIPT"
    write_once_durable "${DEPLOYMENT_STATE_DIR}/finalized" "$EXPECTED_RECEIPT"
    if [ -e "${DEPLOYMENT_STATE_DIR}/upgrade" ] \
      || [ -L "${DEPLOYMENT_STATE_DIR}/upgrade" ]; then
      require_root_owned_directory "${DEPLOYMENT_STATE_DIR}/upgrade"
      rm -rf --one-file-system -- "${DEPLOYMENT_STATE_DIR}/upgrade"
      /usr/bin/sync -f "$DEPLOYMENT_STATE_DIR"
    fi
    printf 'finalized %s\n' "$EXPECTED_RECEIPT"
    exit 0
  fi
  EXPECTED_RECEIPT="$(complete_deployment_receipt "$DEPLOYMENT_STATE_DIR")"
  # Commit the terminal state durably before treating the rollback snapshot as
  # garbage. A crash can therefore leave extra backup bytes, never an allowed
  # rollback transaction with its backup already deleted.
  write_once_durable "${DEPLOYMENT_STATE_DIR}/finalized" "$EXPECTED_RECEIPT"
  if [ -e "${DEPLOYMENT_STATE_DIR}/upgrade" ] \
    || [ -L "${DEPLOYMENT_STATE_DIR}/upgrade" ]; then
    require_root_owned_directory "${DEPLOYMENT_STATE_DIR}/upgrade"
    rm -rf --one-file-system -- "${DEPLOYMENT_STATE_DIR}/upgrade"
    /usr/bin/sync -f "$DEPLOYMENT_STATE_DIR"
  fi
  printf 'finalized %s\n' "$EXPECTED_RECEIPT"
  exit 0
fi

if [ "$COMMAND" = 'publish-mirror' ]; then
  [ "$#" -eq 5 ] || fail 'usage: publish-mirror TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
  TRANSACTION_ID="$2"
  EXPECTED_VERSION="$3"
  PACKAGE_ID="$4"
  EXPECTED_SOURCE_COMMIT="$5"
  [[ "$TRANSACTION_ID" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'invalid mirror transaction id'
  [[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail 'invalid mirror version'
  [[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
    || fail 'invalid package identity'
  [[ "$EXPECTED_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'invalid expected source commit'
  [[ "$TRANSACTION_ID" == "v${EXPECTED_VERSION}-"* ]] \
    || fail 'mirror transaction does not match the expected version'
  acquire_production_lock
  verify_current_deployment \
    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"

  MIRROR_UPLOAD_DIR="${MIRROR_UPLOAD_ROOT}/${TRANSACTION_ID}"
  [ -d "$MIRROR_UPLOAD_DIR" ] && [ ! -L "$MIRROR_UPLOAD_DIR" ] \
    || fail 'mirror upload directory is missing or unsafe'
  [ "$(stat -c '%u:%g:%a' "$MIRROR_UPLOAD_DIR")" = '0:0:700' ] \
    || fail 'mirror upload directory owner or mode is invalid'
  MIRROR_FILES=(
    "Otto-${EXPECTED_VERSION}-arm64.dmg"
    "Otto-${EXPECTED_VERSION}-arm64.dmg.blockmap"
    "Otto-${EXPECTED_VERSION}-x64.dmg"
    "Otto-${EXPECTED_VERSION}-x64.dmg.blockmap"
    "Otto-Setup-${EXPECTED_VERSION}-win-x64.exe"
    "Otto-Setup-${EXPECTED_VERSION}-win-x64.exe.blockmap"
    'latest.json'
    'UPDATE-MIRROR-SHA256SUMS'
    'UPDATE-MIRROR-SHA256SUMS.sig'
  )
  for name in "${MIRROR_FILES[@]}"; do
    [ -f "${MIRROR_UPLOAD_DIR}/${name}" ] \
      && [ ! -L "${MIRROR_UPLOAD_DIR}/${name}" ] \
      || fail "mirror upload is missing or unsafe: $name"
    [ "$(stat -c '%u:%g:%a' "${MIRROR_UPLOAD_DIR}/${name}")" = '0:0:600' ] \
      || fail "mirror upload owner or mode is invalid: $name"
  done

  [ "$(find "$MIRROR_UPLOAD_DIR" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = '9' ] \
    && [ -z "$(find "$MIRROR_UPLOAD_DIR" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ] \
    || fail 'mirror upload directory does not contain the exact file set'

  MIRROR_STAGING_DIR="${MIRROR_STAGING_ROOT}/${TRANSACTION_ID}"
  [ ! -e "$MIRROR_STAGING_DIR" ] && [ ! -L "$MIRROR_STAGING_DIR" ] \
    || fail 'mirror transaction already exists; refusing replay'
  cleanup_mirror_candidate() {
    rm -rf --one-file-system -- "$MIRROR_STAGING_DIR" "$MIRROR_UPLOAD_DIR"
  }
  mkdir -m 0700 -- "$MIRROR_STAGING_DIR" \
    || fail 'could not atomically create mirror staging transaction'
  trap cleanup_mirror_candidate EXIT
  for name in "${MIRROR_FILES[@]}"; do
    install -o root -g root -m 0600 -- \
      "${MIRROR_UPLOAD_DIR}/${name}" "${MIRROR_STAGING_DIR}/${name}"
  done
  verify_signed_file \
    "${MIRROR_STAGING_DIR}/UPDATE-MIRROR-SHA256SUMS" \
    "${MIRROR_STAGING_DIR}/UPDATE-MIRROR-SHA256SUMS.sig" \
    'otto-release-payload-signature-v1' \
    "${MIRROR_STAGING_DIR}/payload-signature.bin" \
    "${MIRROR_STAGING_DIR}/payload-signature.meta"
  rm -f -- \
    "${MIRROR_STAGING_DIR}/payload-signature.bin" \
    "${MIRROR_STAGING_DIR}/payload-signature.meta"
  verify_update_mirror_manifest \
    "${MIRROR_STAGING_DIR}/UPDATE-MIRROR-SHA256SUMS" \
    "$MIRROR_STAGING_DIR" "$EXPECTED_VERSION" \
    "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
  "$PUBLISH_HELPER_PATH" "$TRANSACTION_ID" \
    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
  exit 0
fi

if [ "$COMMAND" = 'rollback-mirror' ]; then
  [ "$#" -eq 2 ] || fail 'usage: rollback-mirror TRANSACTION'
  TRANSACTION_ID="$2"
  [[ "$TRANSACTION_ID" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
    || fail 'invalid mirror transaction id'
  acquire_production_lock
  "$ROLLBACK_HELPER_PATH" "$TRANSACTION_ID"
  exit 0
fi

if [ "$COMMAND" = 'rollback-enterprise' ]; then
  [ "$#" -eq 5 ] \
    || fail 'usage: rollback-enterprise TRANSACTION VERSION PACKAGE_ID SOURCE_COMMIT'
  TRANSACTION_ID="$2"
  EXPECTED_VERSION="$3"
  PACKAGE_ID="$4"
  EXPECTED_SOURCE_COMMIT="$5"
  acquire_production_lock
  DEPLOYMENT_STATE_DIR="$(require_deployment_transaction \
    "$TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
    "$EXPECTED_SOURCE_COMMIT")"
  STATE_FILE="${DEPLOYMENT_STATE_DIR}/state"
  [ ! -e "${DEPLOYMENT_STATE_DIR}/finalized" ] \
    && [ ! -L "${DEPLOYMENT_STATE_DIR}/finalized" ] \
    || fail 'finalized enterprise deployment is outside the rollback window'
  PREVIOUS_VERSION="$(read_deployment_state_field "$STATE_FILE" previous_version)"
  PREVIOUS_PACKAGE="$(read_deployment_state_field "$STATE_FILE" previous_package)"
  PREVIOUS_SOURCE="$(read_deployment_state_field "$STATE_FILE" previous_source)"
  DEPLOY_ACTION="$(read_deployment_state_field "$STATE_FILE" action)"
  ROLLBACK_RECEIPT="rolled_back transaction=${TRANSACTION_ID} restored_version=${PREVIOUS_VERSION} restored_package=${PREVIOUS_PACKAGE} restored_source=${PREVIOUS_SOURCE} replaced_version=${EXPECTED_VERSION} replaced_package=${PACKAGE_ID} replaced_source=${EXPECTED_SOURCE_COMMIT}"
  if [ -e "${DEPLOYMENT_STATE_DIR}/rolled-back" ]; then
    require_root_owned_regular_file "${DEPLOYMENT_STATE_DIR}/rolled-back"
    [ "$(<"${DEPLOYMENT_STATE_DIR}/rolled-back")" = "$ROLLBACK_RECEIPT" ] \
      || fail 'enterprise rollback receipt changed'
    verify_current_deployment \
      "$PREVIOUS_VERSION" "$PREVIOUS_PACKAGE" "$PREVIOUS_SOURCE"
    sync_live_deployment_filesystems
    write_once_durable "${DEPLOYMENT_STATE_DIR}/rolled-back" "$ROLLBACK_RECEIPT"
    printf '%s\n' "$ROLLBACK_RECEIPT"
    exit 0
  fi
  EXPECTED_DEPLOY_RECEIPT="$(complete_deployment_receipt "$DEPLOYMENT_STATE_DIR")"
  IFS= read -r DEPLOY_CONFIG_PATH < "$CONFIG_PATH_FILE" \
    || fail 'deployment config path is unreadable'
  [[ "$DEPLOY_CONFIG_PATH" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
    || fail 'server-pinned deployment config path is invalid'
  [ "$DEPLOY_ACTION" = upgrade ] \
    || fail 'automated enterprise rollback only supports a locked one-click upgrade'
  UPGRADE_STATE="${DEPLOYMENT_STATE_DIR}/upgrade"
  require_root_owned_directory "$UPGRADE_STATE"
  [ "$(stat -c '%u:%g:%a' "$UPGRADE_STATE")" = '0:0:700' ] \
    || fail 'enterprise rollback backup owner or mode is invalid'
  for backup_file in \
    data.db.before enterprise.env.before otto-enterprise.service.before; do
    require_root_owned_regular_file "${UPGRADE_STATE}/${backup_file}"
  done
  RESIDENT_STATE_BACKUP="${UPGRADE_STATE}/resident-recurring-tasks.json.before"
  RESIDENT_STATE_ABSENT="${UPGRADE_STATE}/resident-recurring-tasks.absent"
  if { [ -e "$RESIDENT_STATE_BACKUP" ] || [ -L "$RESIDENT_STATE_BACKUP" ]; } \
    && { [ -e "$RESIDENT_STATE_ABSENT" ] || [ -L "$RESIDENT_STATE_ABSENT" ]; }; then
    fail 'enterprise rollback contains conflicting resident task state snapshots'
  elif [ -e "$RESIDENT_STATE_BACKUP" ] || [ -L "$RESIDENT_STATE_BACKUP" ]; then
    require_root_owned_regular_file "$RESIDENT_STATE_BACKUP"
    [ "$(stat -c '%u:%g:%a' "$RESIDENT_STATE_BACKUP")" = '0:0:600' ] \
      || fail 'resident task state backup owner or mode is invalid'
    RESIDENT_STATE_WAS_PRESENT=true
  elif [ -e "$RESIDENT_STATE_ABSENT" ] || [ -L "$RESIDENT_STATE_ABSENT" ]; then
    require_root_owned_regular_file "$RESIDENT_STATE_ABSENT"
    [ "$(stat -c '%u:%g:%a' "$RESIDENT_STATE_ABSENT")" = '0:0:600' ] \
      || fail 'resident task state absence marker owner or mode is invalid'
    [ ! -s "$RESIDENT_STATE_ABSENT" ] \
      || fail 'resident task state absence marker is not empty'
    RESIDENT_STATE_WAS_PRESENT=false
  else
    fail 'enterprise rollback is missing resident task state snapshot identity'
  fi
  require_root_owned_directory "${UPGRADE_STATE}/deploy.before"
  PREVIOUS_CURRENT="$(read_deployment_state_field "$STATE_FILE" previous_current)"
  [[ "$PREVIOUS_CURRENT" =~ ^/opt/otto-enterprise/releases/[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$ ]] \
    || fail 'previous enterprise current target is invalid'
  require_root_owned_directory_chain "$PREVIOUS_CURRENT"
  [ -L "${INSTALL_ROOT}/current" ] \
    || fail 'enterprise current release is not a managed symlink before rollback'
  CURRENT_BEFORE_ROLLBACK="$(readlink -f -- "${INSTALL_ROOT}/current")"
  TARGET_CURRENT="${INSTALL_ROOT}/releases/${EXPECTED_VERSION}-${PACKAGE_ID%%-*}"
  case "$CURRENT_BEFORE_ROLLBACK" in
    "$TARGET_CURRENT")
      verify_release_identity_at_path \
        "$CURRENT_BEFORE_ROLLBACK" "$EXPECTED_VERSION" "$PACKAGE_ID" \
        "$EXPECTED_SOURCE_COMMIT"
      ;;
    "$PREVIOUS_CURRENT")
      verify_release_identity_at_path \
        "$CURRENT_BEFORE_ROLLBACK" "$PREVIOUS_VERSION" "$PREVIOUS_PACKAGE" \
        "$PREVIOUS_SOURCE"
      ;;
    *) fail 'current enterprise release is neither the locked target nor previous identity' ;;
  esac
  # All state, action, backup and release identity checks complete before the
  # first service mutation. Re-running the following restore is idempotent even
  # when a previous attempt crashed after switching current but before receipt.
  systemctl stop otto-enterprise
  install -o otto-enterprise -g otto-enterprise -m 0600 \
    "${UPGRADE_STATE}/data.db.before" /var/lib/otto-enterprise/data.db
  if [ "$RESIDENT_STATE_WAS_PRESENT" = true ]; then
    install -o otto-enterprise -g otto-enterprise -m 0600 \
      "$RESIDENT_STATE_BACKUP" \
      /var/lib/otto-enterprise/resident-recurring-tasks.json
  else
    rm -f -- /var/lib/otto-enterprise/resident-recurring-tasks.json
  fi
  install -o root -g root -m 0600 \
    "${UPGRADE_STATE}/enterprise.env.before" "$DEPLOY_CONFIG_PATH"
  install -o root -g root -m 0644 \
    "${UPGRADE_STATE}/otto-enterprise.service.before" \
    /etc/systemd/system/otto-enterprise.service
  rm -rf --one-file-system -- "${INSTALL_ROOT}/deploy.rollback"
  cp -a -- "${UPGRADE_STATE}/deploy.before" "${INSTALL_ROOT}/deploy.rollback"
  rm -rf --one-file-system -- "${INSTALL_ROOT}/deploy"
  mv -- "${INSTALL_ROOT}/deploy.rollback" "${INSTALL_ROOT}/deploy"
  if [ -f "${UPGRADE_STATE}/database-key-created" ]; then
    rm -f -- "$(dirname -- "$DEPLOY_CONFIG_PATH")/database-sqlcipher.key"
  fi
  ln -sfn -- "$PREVIOUS_CURRENT" "${INSTALL_ROOT}/current.rollback"
  mv -Tf -- "${INSTALL_ROOT}/current.rollback" "${INSTALL_ROOT}/current"
  systemctl daemon-reload
  systemctl start otto-enterprise
  verify_current_deployment \
    "$PREVIOUS_VERSION" "$PREVIOUS_PACKAGE" "$PREVIOUS_SOURCE"
  sync_live_deployment_filesystems
  write_once_durable "${DEPLOYMENT_STATE_DIR}/rolled-back" "$ROLLBACK_RECEIPT"
  printf '%s\n' "$ROLLBACK_RECEIPT"
  exit 0
fi

[ "$COMMAND" = 'deploy' ] || fail 'usage: deploy TRANSACTION ARCHIVE VERSION PACKAGE_ID SOURCE_COMMIT DRY_RUN'
[ "$#" -eq 7 ] || fail 'unexpected argument count'
TRANSACTION_ID="$2"
ARCHIVE_NAME="$3"
EXPECTED_VERSION="$4"
PACKAGE_ID="$5"
EXPECTED_SOURCE_COMMIT="$6"
DRY_RUN="$7"

[[ "$TRANSACTION_ID" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] \
  || fail 'invalid transaction id'
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'invalid expected version'
[[ "$PACKAGE_ID" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] \
  || fail 'invalid package identity'
[[ "$EXPECTED_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || fail 'invalid expected source commit'
[ "$ARCHIVE_NAME" = "otto-enterprise-oneclick-v${EXPECTED_VERSION}-${PACKAGE_ID}.tar.gz" ] \
  || fail 'archive name does not match the locked version and package identity'
case "$DRY_RUN" in true|false) ;; *) fail 'dry-run must be true or false' ;; esac
acquire_production_lock

UPLOAD_DIR="${UPLOAD_ROOT}/${TRANSACTION_ID}"
[ -d "$UPLOAD_DIR" ] && [ ! -L "$UPLOAD_DIR" ] \
  || fail 'transaction upload directory is missing or unsafe'
[ "$(stat -c '%u:%g:%a' "$UPLOAD_DIR")" = '0:0:700' ] \
  || fail 'transaction upload directory owner or mode is invalid'

CHECKSUM_NAME="${ARCHIVE_NAME}.sha256"
SIGNATURE_NAME="${ARCHIVE_NAME}.sig"
for name in "$ARCHIVE_NAME" "$CHECKSUM_NAME" "$SIGNATURE_NAME"; do
  [ -f "${UPLOAD_DIR}/${name}" ] && [ ! -L "${UPLOAD_DIR}/${name}" ] \
    || fail "uploaded package file is missing or unsafe: $name"
  [ "$(stat -c '%u:%g:%a' "${UPLOAD_DIR}/${name}")" = '0:0:600' ] \
    || fail "uploaded package file owner or mode is invalid: $name"
done

[ "$(find "$UPLOAD_DIR" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = '3' ] \
  && [ -z "$(find "$UPLOAD_DIR" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ] \
  || fail 'transaction upload directory does not contain the exact file set'

STAGING_DIR="${STAGING_ROOT}/${TRANSACTION_ID}"
[ ! -e "$STAGING_DIR" ] && [ ! -L "$STAGING_DIR" ] \
  || fail 'deployment transaction already exists; refusing replay'
cleanup_deploy_candidate() {
  rm -rf --one-file-system -- "$STAGING_DIR" "$UPLOAD_DIR"
}
mkdir -m 0700 -- "$STAGING_DIR" \
  || fail 'could not atomically create deployment staging transaction'
trap cleanup_deploy_candidate EXIT

for name in "$ARCHIVE_NAME" "$CHECKSUM_NAME" "$SIGNATURE_NAME"; do
  install -o root -g root -m 0600 -- \
    "${UPLOAD_DIR}/${name}" "${STAGING_DIR}/${name}"
done

ARCHIVE_PATH="${STAGING_DIR}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${STAGING_DIR}/${CHECKSUM_NAME}"
SIGNATURE_PATH="${STAGING_DIR}/${SIGNATURE_NAME}"
SIGNATURE_BIN="${STAGING_DIR}/enterprise-package-signature.bin"
SIGNATURE_META="${STAGING_DIR}/enterprise-package-signature.meta"
verify_signed_file \
  "$ARCHIVE_PATH" "$SIGNATURE_PATH" \
  'otto-enterprise-package-signature-v1' \
  "$SIGNATURE_BIN" "$SIGNATURE_META"
ACTUAL_ARCHIVE_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"

read -r CHECKSUM_SHA256 CHECKSUM_FILE CHECKSUM_EXTRA < "$CHECKSUM_PATH" || \
  fail 'package checksum file is unreadable'
[ -z "${CHECKSUM_EXTRA:-}" ] \
  && [ "$CHECKSUM_SHA256" = "$ACTUAL_ARCHIVE_SHA256" ] \
  && [ "$CHECKSUM_FILE" = "$ARCHIVE_NAME" ] \
  || fail 'package checksum file does not exactly identify the signed archive'

EXPECTED_PACKAGE_ROOT="otto-enterprise-oneclick-v${EXPECTED_VERSION}-${PACKAGE_ID}"
EXPANDED_ARCHIVE_BYTES="$(/usr/bin/python3 -I -S - \
  "$ARCHIVE_PATH" "$EXPECTED_PACKAGE_ROOT" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
expected_root = sys.argv[2]
count = 0
total_size = 0
with tarfile.open(archive_path, 'r:gz') as archive:
    for member in archive.getmembers():
        count += 1
        total_size += member.size
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise SystemExit(f'unsafe archive path: {member.name}')
        if path.parts[0] != expected_root:
            raise SystemExit(f'unexpected archive root: {member.name}')
        if not (member.isdir() or member.isreg()):
            raise SystemExit(f'unsupported archive entry type: {member.name}')
if count < 10 or count > 200000 or total_size > 2 * 1024 * 1024 * 1024:
    raise SystemExit('archive entry count or expanded size is outside the deployment boundary')
print(total_size)
PY
)"
[[ "$EXPANDED_ARCHIVE_BYTES" =~ ^[0-9]+$ ]] \
  || fail 'could not determine the expanded archive size'
AVAILABLE_UNPACK_KIB="$(df -Pk -- "$STAGING_DIR" | awk 'NR == 2 { print $4 }')"
[[ "$AVAILABLE_UNPACK_KIB" =~ ^[0-9]+$ ]] \
  || fail 'could not determine staging filesystem capacity'
REQUIRED_UNPACK_KIB="$(((EXPANDED_ARCHIVE_BYTES + 1023) / 1024 + MIN_UPLOAD_FREE_RESERVE_KIB))"
[ "$AVAILABLE_UNPACK_KIB" -ge "$REQUIRED_UNPACK_KIB" ] \
  || fail 'staging filesystem does not have capacity to unpack the archive and retain the safety reserve'

UNPACK_DIR="${STAGING_DIR}/unpack"
install -d -o root -g root -m 0700 "$UNPACK_DIR"
tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE_PATH" -C "$UNPACK_DIR"
PACKAGE_ROOT="${UNPACK_DIR}/${EXPECTED_PACKAGE_ROOT}"
[ -d "$PACKAGE_ROOT" ] && [ ! -L "$PACKAGE_ROOT" ] \
  || fail 'root-owned package directory is missing after extraction'
[ -x "${PACKAGE_ROOT}/install.sh" ] && [ -x "${PACKAGE_ROOT}/upgrade.sh" ] \
  || fail 'package deployment entrypoints are missing'

EXPECTED_BUILD_PREFIX="${PACKAGE_ID%%-*}"
EXPECTED_SOURCE_INPUT_PREFIX="${PACKAGE_ID#*-}"
RELEASE_MANIFEST="${PACKAGE_ROOT}/release/manifest.json"
[ -f "$RELEASE_MANIFEST" ] && [ ! -L "$RELEASE_MANIFEST" ] \
  || fail 'signed package release manifest is missing or unsafe'
/usr/bin/python3 -I -S - \
  "$RELEASE_MANIFEST" "$EXPECTED_VERSION" \
  "$EXPECTED_BUILD_PREFIX" "$EXPECTED_SOURCE_INPUT_PREFIX" \
  "$EXPECTED_SOURCE_COMMIT" "$DRY_RUN" <<'PY'
import json
import pathlib
import re
import sys

manifest_path = pathlib.Path(sys.argv[1])
expected_version, expected_build, expected_source, expected_source_commit, dry_run = sys.argv[2:]
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
build_commit = manifest.get('buildCommit')
source_input = manifest.get('sourceInputSha256')
if (
    manifest.get('format') != 'otto-enterprise-release-v1'
    or manifest.get('version') != expected_version
    or not isinstance(build_commit, str)
    or not re.fullmatch(r'[0-9a-f]{40}', build_commit)
    or build_commit[:12] != expected_build
    or not isinstance(source_input, str)
    or not re.fullmatch(r'[0-9a-f]{64}', source_input)
    or source_input[:12] != expected_source
    or manifest.get('sourceCommit') != expected_source_commit
    or manifest.get('sourceTreeDirty') is not False
    or manifest.get('releaseChannel') not in (
        ['stable', 'transition'] if dry_run == 'true' else ['stable']
    )
):
    raise SystemExit('signed package manifest does not match the locked package identity')
PY

UNFINISHED_DEPLOYMENT="$(find_unfinished_deployment)"

if [ -L "${INSTALL_ROOT}/current" ]; then
  CURRENT_RELEASE="$(readlink -f -- "${INSTALL_ROOT}/current")"
  require_root_owned_directory_chain "$CURRENT_RELEASE"
  CURRENT_RELEASE_MANIFEST="${CURRENT_RELEASE}/manifest.json"
  require_root_owned_regular_file "$CURRENT_RELEASE_MANIFEST"
  VERSION_RELATION="$(/usr/bin/python3 -I -S - \
    "$CURRENT_RELEASE_MANIFEST" "$EXPECTED_VERSION" \
    "$EXPECTED_BUILD_PREFIX" "$EXPECTED_SOURCE_INPUT_PREFIX" \
    "$EXPECTED_SOURCE_COMMIT" <<'PY'
import json
import pathlib
import re
import sys

current_path = pathlib.Path(sys.argv[1])
target_version, target_build, target_source_input, target_source_commit = sys.argv[2:]
current = json.loads(current_path.read_text(encoding='utf-8'))
current_version = current.get('version')
if not isinstance(current_version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', current_version):
    raise SystemExit('current enterprise version is invalid')
current_tuple = tuple(map(int, current_version.split('.')))
target_tuple = tuple(map(int, target_version.split('.')))
if target_tuple < current_tuple:
    print('downgrade')
elif target_tuple > current_tuple:
    print('upgrade')
else:
    exact = (
        isinstance(current.get('buildCommit'), str)
        and current['buildCommit'].startswith(target_build)
        and isinstance(current.get('sourceInputSha256'), str)
        and current['sourceInputSha256'].startswith(target_source_input)
        and current.get('sourceCommit') == target_source_commit
        and current.get('sourceTreeDirty') is False
    )
    print('same' if exact else 'same-conflict')
PY
)" || fail 'could not compare the signed package with the current enterprise release'
  case "$VERSION_RELATION" in
    downgrade)
      fail 'refusing to deploy a signed enterprise package older than the current release'
      ;;
    same-conflict)
      fail 'refusing a different signed package identity for the current enterprise version'
      ;;
    same)
      verify_current_deployment \
        "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
      if [ -n "$UNFINISHED_DEPLOYMENT" ]; then
        [ "$DRY_RUN" = false ] \
          || fail 'dry-run cannot reconcile an unfinished enterprise deployment transaction'
        UNFINISHED_TRANSACTION_ID="${UNFINISHED_DEPLOYMENT##*/}"
        [ "$UNFINISHED_TRANSACTION_ID" = "$TRANSACTION_ID" ] \
          || fail 'an older exact deployment transaction requires explicit reconciliation before a new run'
        require_deployment_transaction \
          "$UNFINISHED_TRANSACTION_ID" "$EXPECTED_VERSION" "$PACKAGE_ID" \
          "$EXPECTED_SOURCE_COMMIT" >/dev/null
        DEPLOYMENT_RECEIPT="$(complete_deployment_receipt "$UNFINISHED_DEPLOYMENT")"
        printf 'recovered_%s\n' "$DEPLOYMENT_RECEIPT"
        exit 0
      fi
      printf 'already_deployed version=%s package=%s source=%s\n' \
        "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
      exit 0
      ;;
    upgrade) ;;
    *) fail 'enterprise version comparison returned an unexpected result' ;;
  esac
fi

[ -z "$UNFINISHED_DEPLOYMENT" ] \
  || fail 'an unfinished enterprise deployment transaction must be reconciled before another upgrade'

IFS= read -r DEPLOY_CONFIG_PATH < "$CONFIG_PATH_FILE" || \
  fail 'deployment config path is unreadable'
[[ "$DEPLOY_CONFIG_PATH" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
  || fail 'server-pinned deployment config path is invalid'
require_root_owned_directory_chain "$(dirname -- "$DEPLOY_CONFIG_PATH")"
require_root_owned_regular_file "$DEPLOY_CONFIG_PATH"

if [ -L "${INSTALL_ROOT}/current" ]; then
  DEPLOY_ACTION='upgrade'
elif [ ! -e "${INSTALL_ROOT}/current" ]; then
  fail 'automated stable deployment requires an existing one-click current symlink; perform the first install through the audited installer'
else
  fail 'enterprise current path exists but is not a symlink'
fi

DEPLOYMENT_STATE_DIR=''
if [ "$DRY_RUN" = false ]; then
  DEPLOYMENT_STATE_DIR="${DEPLOYMENTS_ROOT}/${TRANSACTION_ID}"
  [ ! -e "$DEPLOYMENT_STATE_DIR" ] && [ ! -L "$DEPLOYMENT_STATE_DIR" ] \
    || fail 'enterprise deployment transaction already exists; refusing replay'
  DEPLOYMENT_STATE_STAGING="${STAGING_DIR}/deployment-state"
  [ ! -e "$DEPLOYMENT_STATE_STAGING" ] \
    && [ ! -L "$DEPLOYMENT_STATE_STAGING" ] \
    || fail 'enterprise deployment state staging path already exists'
  install -d -o root -g root -m 0700 "$DEPLOYMENT_STATE_STAGING"
  PREVIOUS_CURRENT="$(readlink -f -- "${INSTALL_ROOT}/current")"
  require_root_owned_directory_chain "$PREVIOUS_CURRENT"
  PREVIOUS_MANIFEST="${PREVIOUS_CURRENT}/manifest.json"
  require_root_owned_regular_file "$PREVIOUS_MANIFEST"
  read -r PREVIOUS_VERSION PREVIOUS_PACKAGE PREVIOUS_SOURCE < <(
    /usr/bin/python3 -I -S - "$PREVIOUS_MANIFEST" <<'PY'
import json
import pathlib
import re
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
version = manifest.get('version', '')
build = manifest.get('buildCommit', '')
source_input = manifest.get('sourceInputSha256', '')
source = manifest.get('sourceCommit', '')
if (
    not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version)
    or not re.fullmatch(r'[0-9a-f]{40}', build)
    or not re.fullmatch(r'[0-9a-f]{64}', source_input)
    or not re.fullmatch(r'[0-9a-f]{40}', source)
):
    raise SystemExit('previous enterprise release identity is invalid')
print(version, f'{build[:12]}-{source_input[:12]}', source)
PY
  ) || fail 'could not lock the previous enterprise deployment identity'
  install -d -o root -g root -m 0700 \
    "${DEPLOYMENT_STATE_STAGING}/upgrade"
  STATE_FILE="${DEPLOYMENT_STATE_STAGING}/state"
  STATE_CONTENT="$(printf '%s\n' \
    'format=otto-enterprise-deployment-state-v1' \
    "transaction=${TRANSACTION_ID}" \
    "action=${DEPLOY_ACTION}" \
    "target_version=${EXPECTED_VERSION}" \
    "target_package=${PACKAGE_ID}" \
    "target_source=${EXPECTED_SOURCE_COMMIT}" \
    "previous_version=${PREVIOUS_VERSION}" \
    "previous_package=${PREVIOUS_PACKAGE}" \
    "previous_source=${PREVIOUS_SOURCE}" \
    "previous_current=${PREVIOUS_CURRENT}")"
  write_once_durable "$STATE_FILE" "$STATE_CONTENT"
  ROLLBACK_WITNESS_CONTENT="$(rollback_witness_for_state \
    "$DEPLOYMENT_STATE_STAGING")"
  write_once_durable \
    "${DEPLOYMENT_STATE_STAGING}/rollback-witness.expected" \
    "$ROLLBACK_WITNESS_CONTENT"
  /usr/bin/sync -f "$DEPLOYMENT_STATE_STAGING"
  mv -- "$DEPLOYMENT_STATE_STAGING" "$DEPLOYMENT_STATE_DIR"
  /usr/bin/sync -f "$DEPLOYMENT_STATE_DIR"
  /usr/bin/sync -f "$DEPLOYMENTS_ROOT"
fi

DEPLOY_ARGUMENTS=(--config "$DEPLOY_CONFIG_PATH")
CLEAN_ENV=(
  /usr/bin/env -i
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  LC_ALL=C
  HOME=/root
  USER=root
  LOGNAME=root
  SHELL=/bin/bash
)
if [ "$DRY_RUN" = 'true' ]; then
  DEPLOY_ARGUMENTS+=(--dry-run)
elif [ "$DEPLOY_ACTION" = 'upgrade' ]; then
  "${CLEAN_ENV[@]}" "${PACKAGE_ROOT}/backup-now.sh" "$DEPLOY_CONFIG_PATH"
  DEPLOY_ARGUMENTS+=(--rollback-dir "${DEPLOYMENT_STATE_DIR}/upgrade")
  DEPLOY_ARGUMENTS+=(--rollback-witness-file \
    "${DEPLOYMENT_STATE_DIR}/rollback-witness.expected")
fi

DEPLOY_STATUS=0
if "${CLEAN_ENV[@]}" \
  "${PACKAGE_ROOT}/${DEPLOY_ACTION}.sh" "${DEPLOY_ARGUMENTS[@]}"; then
  DEPLOY_STATUS=0
else
  DEPLOY_STATUS=$?
fi

if [ "$DEPLOY_STATUS" -ne 0 ]; then
  if [ "$DRY_RUN" = false ] && [ "$DEPLOY_ACTION" = upgrade ]; then
    # upgrade.sh retains the caller-provided snapshot and, when possible,
    # restores and verifies the previous release in its EXIT trap.  Bind that
    # verified outcome to a durable terminal receipt so a lost SSH response can
    # be reconciled and cannot leave an unfinalized transaction blocking every
    # future deployment.
    complete_rolled_back_receipt_if_previous "$DEPLOYMENT_STATE_DIR"
  fi
  exit "$DEPLOY_STATUS"
fi

if [ "$DRY_RUN" = 'false' ]; then
  verify_current_deployment \
    "$EXPECTED_VERSION" "$PACKAGE_ID" "$EXPECTED_SOURCE_COMMIT"
  complete_deployment_receipt "$DEPLOYMENT_STATE_DIR"
fi

printf '[Otto CI Deploy] action=%s version=%s package=%s dry_run=%s\n' \
  "$DEPLOY_ACTION" "$EXPECTED_VERSION" "$PACKAGE_ID" "$DRY_RUN"
