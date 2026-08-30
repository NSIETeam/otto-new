#!/bin/bash -p
set -Eeuo pipefail
umask 077

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

INSTALLER_GATEWAY_PROTOCOL='otto-enterprise-ci-deploy-v5'

fail() {
  printf '[Otto CI Gateway Install] %s\n' "$*" >&2
  exit 2
}

require_root_controlled_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    || fail "trusted directory is missing or unsafe: $directory"
  [ "$(stat -c '%u' "$directory")" = '0' ] \
    || fail "trusted directory is not root-owned: $directory"
  if find "$directory" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "trusted directory is group/other writable: $directory"
  fi
}

require_root_controlled_ancestry() {
  local current="$1"
  require_root_controlled_directory "$current"
  current="$(dirname -- "$current")"
  while :; do
    [ -d "$current" ] && [ ! -L "$current" ] \
      || fail "trusted parent directory is missing or unsafe: $current"
    [ "$(stat -c '%u' "$current")" = '0' ] \
      || fail "trusted parent directory is not root-owned: $current"
    if find "$current" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
      find "$current" -maxdepth 0 -perm -1000 -print -quit | grep -q . \
        || fail "writable trusted parent directory is not sticky: $current"
    fi
    [ "$current" = '/' ] && break
    current="$(dirname -- "$current")"
  done
}

require_root_controlled_file() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] \
    || fail "trusted file is missing or unsafe: $file"
  [ "$(stat -c '%u:%g' "$file")" = '0:0' ] \
    || fail "trusted file is not root-owned: $file"
  if find "$file" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    fail "trusted file is group/other writable: $file"
  fi
}

require_root_controlled_target() {
  local target="$1"
  local expected_type="$2"
  local current="$target"
  [[ "$target" = /* ]] || fail "install target must be absolute: $target"
  while :; do
    [ ! -L "$current" ] || fail "install target ancestry contains a symlink: $current"
    if [ -e "$current" ]; then
      [ "$(stat -c '%u' "$current")" = '0' ] \
        || fail "install target ancestry is not root-owned: $current"
      if find "$current" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
        fail "install target ancestry is group/other writable: $current"
      fi
      if [ "$current" = "$target" ]; then
        case "$expected_type" in
          directory) [ -d "$current" ] \
            || fail "install target is not a directory: $current" ;;
          file) [ -f "$current" ] \
            || fail "install target is not a regular file: $current" ;;
          *) fail "unknown install target type: $expected_type" ;;
        esac
      else
        [ -d "$current" ] \
          || fail "install target ancestor is not a directory: $current"
      fi
    fi
    [ "$current" = '/' ] && break
    current="$(dirname -- "$current")"
  done
}

[ "$(id -u)" -eq 0 ] || fail 'installer must run as root'

DEPLOY_USER=''
ROLLBACK_USER=''
PUBLIC_KEY=''
DEPLOY_CONFIG_PATH='/etc/otto-enterprise/enterprise.env'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy-user)
      [ "$#" -ge 2 ] || fail '--deploy-user requires a value'
      DEPLOY_USER="$2"
      shift 2
      ;;
    --rollback-user)
      [ "$#" -ge 2 ] || fail '--rollback-user requires a value'
      ROLLBACK_USER="$2"
      shift 2
      ;;
    --public-key)
      [ "$#" -ge 2 ] || fail '--public-key requires a value'
      PUBLIC_KEY="$2"
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || fail '--config requires a value'
      DEPLOY_CONFIG_PATH="$2"
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
  || fail 'deploy user is invalid'
[[ "$ROLLBACK_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
  || fail 'rollback user is invalid'
[ "$DEPLOY_USER" != "$ROLLBACK_USER" ] \
  || fail 'deploy and rollback users must be distinct'
DEPLOY_USER_UID="$(id -u "$DEPLOY_USER")" || fail 'deploy user does not exist'
ROLLBACK_USER_UID="$(id -u "$ROLLBACK_USER")" || fail 'rollback user does not exist'
DEPLOY_USER_GID="$(id -g "$DEPLOY_USER")" || fail 'deploy user primary group does not exist'
ROLLBACK_USER_GID="$(id -g "$ROLLBACK_USER")" || fail 'rollback user primary group does not exist'
[ "$DEPLOY_USER_UID" -ne 0 ] \
  || fail 'deploy user must be an unprivileged non-root account'
[ "$ROLLBACK_USER_UID" -ne 0 ] \
  || fail 'rollback user must be an unprivileged non-root account'
[ "$DEPLOY_USER_UID" != "$ROLLBACK_USER_UID" ] \
  || fail 'deploy and rollback users must have distinct UIDs'
[ "$DEPLOY_USER_GID" != "$ROLLBACK_USER_GID" ] \
  || fail 'deploy and rollback users must have distinct primary GIDs'
[ -f "$PUBLIC_KEY" ] && [ ! -L "$PUBLIC_KEY" ] \
  || fail 'public key must be a regular file and not a symlink'
PUBLIC_KEY_REAL="$(readlink -f -- "$PUBLIC_KEY")"
[ "$PUBLIC_KEY" = "$PUBLIC_KEY_REAL" ] \
  || fail 'public key path must be absolute, canonical and symlink-free'
require_root_controlled_ancestry "$(dirname -- "$PUBLIC_KEY")"
require_root_controlled_file "$PUBLIC_KEY"
[ -d /var/tmp ] && [ ! -L /var/tmp ] \
  && [ "$(stat -c '%u:%g' /var/tmp)" = '0:0' ] \
  && find /var/tmp -maxdepth 0 -perm -1000 -print -quit | grep -q . \
  || fail '/var/tmp must be a root-owned sticky directory'
BOOTSTRAP_TEMP_DIR="$(mktemp -d /var/tmp/otto-ci-gateway-bootstrap.XXXXXXXX)"
[[ "$BOOTSTRAP_TEMP_DIR" =~ ^/var/tmp/otto-ci-gateway-bootstrap\.[A-Za-z0-9]{8}$ ]] \
  && [ "$(stat -c '%u:%g:%a' "$BOOTSTRAP_TEMP_DIR")" = '0:0:700' ] \
  || fail 'failed to create a root-only bootstrap staging directory'
cleanup_bootstrap_temp() {
  case "$BOOTSTRAP_TEMP_DIR" in
    /var/tmp/otto-ci-gateway-bootstrap.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9])
      rm -rf -- "$BOOTSTRAP_TEMP_DIR"
      ;;
    *) fail 'refusing to clean an unexpected bootstrap staging path' ;;
  esac
}
ROLLBACK_ARMED='false'
DIRECTORY_ROLLBACK_ARMED='false'
INSTALL_NEXT_FILES=()
FIXED_TARGETS=()
FIXED_BACKUPS=()
FIXED_EXISTED=()
DIRECTORY_EXISTED=()
DIRECTORY_METADATA=()

cleanup_install_next_files() {
  local next_file
  for next_file in "${INSTALL_NEXT_FILES[@]}"; do
    if [ -n "$next_file" ]; then
      rm -f -- "$next_file"
    fi
  done
}

rollback_fixed_files() {
  local index target backup next_file
  set +e
  for ((index=${#FIXED_TARGETS[@]} - 1; index >= 0; index--)); do
    target="${FIXED_TARGETS[$index]}"
    if [ "${FIXED_EXISTED[$index]}" = 'true' ]; then
      backup="${FIXED_BACKUPS[$index]}"
      next_file="$(dirname -- "$target")/.${target##*/}.otto-rollback.$$.${RANDOM}.next"
      if [ -e "$next_file" ] || [ -L "$next_file" ]; then
        printf '[Otto CI Gateway Install] rollback staging path already exists: %s\n' \
          "$next_file" >&2
        continue
      fi
      INSTALL_NEXT_FILES+=("$next_file")
      cp --preserve=all -- "$backup" "$next_file" \
        && /usr/bin/sync -f "$next_file" \
        && mv -fT -- "$next_file" "$target" \
        && /usr/bin/sync -f "$(dirname -- "$target")" \
        || printf '[Otto CI Gateway Install] failed to restore %s\n' "$target" >&2
    else
      rm -f -- "$target" \
        && /usr/bin/sync -f "$(dirname -- "$target")" \
        || printf '[Otto CI Gateway Install] failed to remove %s\n' "$target" >&2
    fi
  done
}

rollback_install_directories() {
  local index target metadata uid gid mode
  set +e
  for ((index=${#DIRECTORY_TARGETS[@]} - 1; index >= 0; index--)); do
    target="${DIRECTORY_TARGETS[$index]}"
    # The fixed lock inode and its root-only hierarchy are permanent
    # serialization infrastructure. Removing them could let a waiter retain
    # the old inode while a new caller locks a replacement inode.
    if { [ "$target" = "$STATE_ROOT" ] || [ "$target" = "$LOCKS_ROOT" ]; } \
      && [ "${DIRECTORY_EXISTED[$index]}" = 'false' ]; then
      continue
    fi
    if [ "${DIRECTORY_EXISTED[$index]}" = 'true' ]; then
      metadata="${DIRECTORY_METADATA[$index]}"
      IFS=: read -r uid gid mode <<< "$metadata"
      chown "$uid:$gid" "$target" \
        && chmod "$mode" "$target" \
        && /usr/bin/sync -f "$target" \
        || printf '[Otto CI Gateway Install] failed to restore directory metadata %s\n' \
          "$target" >&2
    elif [ -d "$target" ] && [ ! -L "$target" ]; then
      rmdir -- "$target" \
        && /usr/bin/sync -f "$(dirname -- "$target")" \
        || printf '[Otto CI Gateway Install] failed to remove new directory %s\n' \
          "$target" >&2
    fi
  done
}

installer_exit() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$ROLLBACK_ARMED" = 'true' ]; then
    rollback_fixed_files
  fi
  if [ "$status" -ne 0 ] && [ "$DIRECTORY_ROLLBACK_ARMED" = 'true' ]; then
    rollback_install_directories
  fi
  cleanup_install_next_files
  cleanup_bootstrap_temp
  exit "$status"
}
trap installer_exit EXIT
TRUST_KEY_TEMP="${BOOTSTRAP_TEMP_DIR}/trusted-public.pem"
CONFIG_PATH_TEMP="${BOOTSTRAP_TEMP_DIR}/config-path"
DEPLOY_USER_TEMP="${BOOTSTRAP_TEMP_DIR}/deploy-user"
ROLLBACK_USER_TEMP="${BOOTSTRAP_TEMP_DIR}/rollback-user"
SUDOERS_TEMP="${BOOTSTRAP_TEMP_DIR}/sudoers"
GATEWAY_TEMP="${BOOTSTRAP_TEMP_DIR}/gateway"
PUBLISH_TEMP="${BOOTSTRAP_TEMP_DIR}/publish-mirror"
ROLLBACK_TEMP="${BOOTSTRAP_TEMP_DIR}/rollback-mirror"
install -o root -g root -m 0600 -- "$PUBLIC_KEY" "$TRUST_KEY_TEMP"
openssl pkey -pubin -in "$TRUST_KEY_TEMP" -noout >/dev/null \
  || fail 'public key is not a valid PEM public key'
openssl pkey -pubin -in "$TRUST_KEY_TEMP" -text -noout 2>/dev/null | \
  grep -qi 'ED25519' \
  || fail 'public key must be Ed25519'
[[ "$DEPLOY_CONFIG_PATH" =~ ^/etc/otto-enterprise/[A-Za-z0-9._-]+\.env$ ]] \
  || fail 'deployment config path is invalid'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

require_root_controlled_ancestry "$SCRIPT_DIR"
GATEWAY_SOURCE="${SCRIPT_DIR}/ci-deploy-gateway.sh"
PUBLISH_SOURCE="${SCRIPT_DIR}/ci/publish-update-mirror.sh"
ROLLBACK_SOURCE="${SCRIPT_DIR}/ci/rollback-update-mirror.sh"
for source_file in \
  "${SCRIPT_DIR}/install-ci-deploy-gateway.sh" \
  "$GATEWAY_SOURCE" "$PUBLISH_SOURCE" "$ROLLBACK_SOURCE"; do
  require_root_controlled_ancestry "$(dirname -- "$source_file")"
  require_root_controlled_file "$source_file"
done
mapfile -t SOURCE_GATEWAY_PROTOCOL_LINES < <(
  grep -E '^GATEWAY_PROTOCOL="otto-enterprise-ci-deploy-v[0-9]+"$' "$GATEWAY_SOURCE"
)
[ "${#SOURCE_GATEWAY_PROTOCOL_LINES[@]}" -eq 1 ] \
  && [ "${SOURCE_GATEWAY_PROTOCOL_LINES[0]}" \
    = "GATEWAY_PROTOCOL=\"${INSTALLER_GATEWAY_PROTOCOL}\"" ] \
  || fail 'installer and gateway source protocols do not match'
require_root_controlled_ancestry "$(dirname -- "$DEPLOY_CONFIG_PATH")"
require_root_controlled_file "$DEPLOY_CONFIG_PATH"
install -o root -g root -m 0700 "$GATEWAY_SOURCE" "$GATEWAY_TEMP"
install -o root -g root -m 0700 "$PUBLISH_SOURCE" "$PUBLISH_TEMP"
install -o root -g root -m 0700 "$ROLLBACK_SOURCE" "$ROLLBACK_TEMP"

GATEWAY_PATH='/usr/local/sbin/otto-enterprise-ci-deploy'
LIBEXEC_DIR='/usr/local/libexec/otto-enterprise-ci'
PUBLISH_PATH="${LIBEXEC_DIR}/publish-update-mirror"
ROLLBACK_PATH="${LIBEXEC_DIR}/rollback-update-mirror"
TRUST_KEY_PATH='/etc/otto-enterprise/enterprise-package-signing-public.pem'
CONFIG_PATH_FILE='/etc/otto-enterprise/ci-deploy-config-path'
DEPLOY_USER_FILE='/etc/otto-enterprise/ci-deploy-user'
ROLLBACK_USER_FILE='/etc/otto-enterprise/ci-rollback-user'
SUDOERS_PATH='/etc/sudoers.d/otto-enterprise-ci-deploy'
STATE_ROOT='/var/lib/otto-ci-deploy'
UPLOADS_ROOT="${STATE_ROOT}/uploads"
STAGES_ROOT="${STATE_ROOT}/staging"
LOCKS_ROOT="${STATE_ROOT}/locks"
DEPLOYMENTS_ROOT="${STATE_ROOT}/deployments"
UPLOAD_ROOT="${UPLOADS_ROOT}/enterprise"
MIRROR_UPLOAD_ROOT="${UPLOADS_ROOT}/mirror"
STAGING_ROOT="${STAGES_ROOT}/enterprise"
MIRROR_STAGING_ROOT="${STAGES_ROOT}/mirror"
PRODUCTION_LOCK="${LOCKS_ROOT}/production.lock"

DIRECTORY_TARGETS=(
  /usr/local/sbin "$LIBEXEC_DIR" /etc/otto-enterprise /etc/sudoers.d
  "$STATE_ROOT" "$UPLOADS_ROOT" "$STAGES_ROOT" "$LOCKS_ROOT"
  "$DEPLOYMENTS_ROOT"
  "$UPLOAD_ROOT" "$MIRROR_UPLOAD_ROOT"
  "$STAGING_ROOT" "$MIRROR_STAGING_ROOT"
)
FIXED_TARGETS=(
  "$GATEWAY_PATH" "$PUBLISH_PATH" "$ROLLBACK_PATH" \
  "$TRUST_KEY_PATH" "$CONFIG_PATH_FILE" "$DEPLOY_USER_FILE" \
  "$ROLLBACK_USER_FILE" \
  "$SUDOERS_PATH"
)

snapshot_fixed_generation() {
  local target
  local -a generation_lines=()
  for target in "${FIXED_TARGETS[@]}"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      require_root_controlled_target "$target" file
      generation_lines+=("sha256=$(sha256sum "$target" | awk '{print $1}') path=$target")
    else
      generation_lines+=("absent path=$target")
    fi
  done
  printf '%s\n' "${generation_lines[@]}"
}

STARTING_FIXED_GENERATION="$(snapshot_fixed_generation)"

for target in "${DIRECTORY_TARGETS[@]}"; do
  require_root_controlled_target "$target" directory
done
for target in "${FIXED_TARGETS[@]}" "$PRODUCTION_LOCK"; do
  require_root_controlled_target "$target" file
done

if [ ! -e "$STATE_ROOT" ]; then
  install -d -o root -g root -m 0711 "$STATE_ROOT"
fi
if [ ! -e "$LOCKS_ROOT" ]; then
  install -d -o root -g root -m 0700 "$LOCKS_ROOT"
fi
require_root_controlled_target "$STATE_ROOT" directory
require_root_controlled_target "$LOCKS_ROOT" directory
[ -x /usr/bin/flock ] || fail 'required /usr/bin/flock is unavailable'
[ -x /usr/bin/sync ] || fail 'required /usr/bin/sync is unavailable'
exec 9>"$PRODUCTION_LOCK"
chown root:root "$PRODUCTION_LOCK"
chmod 0600 "$PRODUCTION_LOCK"
require_root_controlled_target "$PRODUCTION_LOCK" file
/usr/bin/flock -x -w 600 9 \
  || fail 'timed out waiting for the production deployment lock'
LOCKED_FIXED_GENERATION="$(snapshot_fixed_generation)"
[ "$LOCKED_FIXED_GENERATION" = "$STARTING_FIXED_GENERATION" ] \
  || fail 'stale gateway installer observed a different locked trust generation'

# Snapshot mutable installation directories only after owning the fixed lock
# and proving the trust generation did not change while queued. A stale waiter
# must never roll back directory state committed by the installer ahead of it.
for index in "${!DIRECTORY_TARGETS[@]}"; do
  target="${DIRECTORY_TARGETS[$index]}"
  if [ -e "$target" ]; then
    DIRECTORY_EXISTED[$index]='true'
    DIRECTORY_METADATA[$index]="$(stat -c '%u:%g:%a' "$target")"
  else
    DIRECTORY_EXISTED[$index]='false'
    DIRECTORY_METADATA[$index]=''
  fi
done
DIRECTORY_ROLLBACK_ARMED='true'

if [ -e "$GATEWAY_PATH" ]; then
  mapfile -t INSTALLED_GATEWAY_PROTOCOL_LINES < <(
    grep -E '^GATEWAY_PROTOCOL="otto-enterprise-ci-deploy-v[0-9]+"$' "$GATEWAY_PATH"
  )
  [ "${#INSTALLED_GATEWAY_PROTOCOL_LINES[@]}" -eq 1 ] \
    || fail 'installed gateway protocol is missing or ambiguous'
  INSTALLED_GATEWAY_PROTOCOL="${INSTALLED_GATEWAY_PROTOCOL_LINES[0]#GATEWAY_PROTOCOL=\"}"
  INSTALLED_GATEWAY_PROTOCOL="${INSTALLED_GATEWAY_PROTOCOL%\"}"
  [[ "$INSTALLED_GATEWAY_PROTOCOL" =~ ^otto-enterprise-ci-deploy-v([0-9]+)$ ]]
  INSTALLED_GATEWAY_PROTOCOL_NUMBER="${BASH_REMATCH[1]}"
  [[ "$INSTALLER_GATEWAY_PROTOCOL" =~ ^otto-enterprise-ci-deploy-v([0-9]+)$ ]]
  INSTALLER_GATEWAY_PROTOCOL_NUMBER="${BASH_REMATCH[1]}"
  [ "$INSTALLER_GATEWAY_PROTOCOL_NUMBER" -ge "$INSTALLED_GATEWAY_PROTOCOL_NUMBER" ] \
    || fail 'refusing to downgrade the installed gateway protocol'
fi

install -d -o root -g root -m 0755 \
  /usr/local/sbin "$LIBEXEC_DIR" /etc/sudoers.d
install -d -o root -g root -m 0711 \
  "$STATE_ROOT" "$UPLOADS_ROOT" "$UPLOAD_ROOT" "$MIRROR_UPLOAD_ROOT"
install -d -o root -g root -m 0700 \
  "$STAGES_ROOT" "$LOCKS_ROOT" "$DEPLOYMENTS_ROOT" \
  "$STAGING_ROOT" "$MIRROR_STAGING_ROOT"

for target in "${DIRECTORY_TARGETS[@]}"; do
  require_root_controlled_target "$target" directory
done
for target in "${FIXED_TARGETS[@]}"; do
  require_root_controlled_target "$target" file
done

for index in "${!FIXED_TARGETS[@]}"; do
  target="${FIXED_TARGETS[$index]}"
  backup="${BOOTSTRAP_TEMP_DIR}/rollback-${index}"
  if [ -e "$target" ]; then
    cp --preserve=all -- "$target" "$backup"
    FIXED_BACKUPS[$index]="$backup"
    FIXED_EXISTED[$index]='true'
  else
    FIXED_BACKUPS[$index]=''
    FIXED_EXISTED[$index]='false'
  fi
done
ROLLBACK_ARMED='true'

atomic_install_fixed_file() {
  local source="$1"
  local target="$2"
  local mode="$3"
  local target_directory next_file next_index
  target_directory="$(dirname -- "$target")"
  next_file="${target_directory}/.${target##*/}.otto-install.$$.${RANDOM}.next"
  [ ! -e "$next_file" ] && [ ! -L "$next_file" ] \
    || fail "atomic install staging path already exists: $next_file"
  INSTALL_NEXT_FILES+=("$next_file")
  next_index=$((${#INSTALL_NEXT_FILES[@]} - 1))
  install -o root -g root -m "$mode" -- "$source" "$next_file"
  require_root_controlled_file "$next_file"
  /usr/bin/sync -f "$next_file"
  mv -fT -- "$next_file" "$target"
  /usr/bin/sync -f "$target_directory"
  INSTALL_NEXT_FILES[$next_index]=''
  require_root_controlled_target "$target" file
}

atomic_install_fixed_file "$GATEWAY_TEMP" "$GATEWAY_PATH" 0755
atomic_install_fixed_file "$PUBLISH_TEMP" "$PUBLISH_PATH" 0755
atomic_install_fixed_file "$ROLLBACK_TEMP" "$ROLLBACK_PATH" 0755
atomic_install_fixed_file "$TRUST_KEY_TEMP" "$TRUST_KEY_PATH" 0644
printf '%s\n' "$DEPLOY_CONFIG_PATH" > "$CONFIG_PATH_TEMP"
atomic_install_fixed_file "$CONFIG_PATH_TEMP" "$CONFIG_PATH_FILE" 0600
printf '%s\n' "$DEPLOY_USER" > "$DEPLOY_USER_TEMP"
atomic_install_fixed_file "$DEPLOY_USER_TEMP" "$DEPLOY_USER_FILE" 0600
printf '%s\n' "$ROLLBACK_USER" > "$ROLLBACK_USER_TEMP"
atomic_install_fixed_file "$ROLLBACK_USER_TEMP" "$ROLLBACK_USER_FILE" 0600

printf '%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$GATEWAY_PATH" > "$SUDOERS_TEMP"
printf '%s ALL=(root) NOPASSWD: %s\n' "$ROLLBACK_USER" "$GATEWAY_PATH" >> "$SUDOERS_TEMP"
chmod 0440 "$SUDOERS_TEMP"
visudo -cf "$SUDOERS_TEMP" >/dev/null || fail 'generated sudoers policy is invalid'
atomic_install_fixed_file "$SUDOERS_TEMP" "$SUDOERS_PATH" 0440
visudo -cf "$SUDOERS_PATH" >/dev/null || fail 'installed sudoers policy is invalid'

audit_automation_principal() {
  local principal="$1"
  local primary_group all_groups sudo_listing expected_rule
  local -a privilege_rules
  primary_group="$(id -gn "$principal")" \
    || fail "could not resolve primary group for automation principal: $principal"
  all_groups="$(id -nG "$principal")" \
    || fail "could not resolve groups for automation principal: $principal"
  [ "$all_groups" = "$primary_group" ] \
    || fail "automation principal has supplementary group privileges: $principal"
  sudo_listing="$(COLUMNS=4096 sudo -n -l -U "$principal")" \
    || fail "could not enumerate effective sudo privileges for: $principal"
  mapfile -t privilege_rules < <(
    printf '%s\n' "$sudo_listing" | \
      sed -n -E 's/^[[:space:]]+(\([^)]*\)[[:space:]]+.*)$/\1/p'
  )
  expected_rule="(root) NOPASSWD: $GATEWAY_PATH"
  [ "${#privilege_rules[@]}" -eq 1 ] \
    && [ "${privilege_rules[0]}" = "$expected_rule" ] \
    || fail "automation principal has sudo privileges outside the fixed gateway: $principal"
}

audit_automation_principal "$DEPLOY_USER"
audit_automation_principal "$ROLLBACK_USER"

runuser -u "$DEPLOY_USER" -- \
  sudo -n -l -- "$GATEWAY_PATH" >/dev/null \
  || fail 'deploy user is not authorized for the fixed gateway'
runuser -u "$ROLLBACK_USER" -- \
  sudo -n -l -- "$GATEWAY_PATH" >/dev/null \
  || fail 'rollback user is not authorized for the fixed gateway'

printf '[Otto CI Gateway Install] installed for deploy user %s and rollback user %s\n' \
  "$DEPLOY_USER" "$ROLLBACK_USER"
ROLLBACK_ARMED='false'
DIRECTORY_ROLLBACK_ARMED='false'
