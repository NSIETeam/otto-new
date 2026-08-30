#!/bin/bash
set -Eeuo pipefail
umask 077

if [ "${OTTO_CI_INTEGRATION_CONTAINER:-}" != '1' ] || [ ! -f /.dockerenv ]; then
  printf 'refusing to modify fixed deployment paths outside the disposable integration container\n' >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  printf 'integration test must run as root inside the disposable container\n' >&2
  exit 2
fi

REPOSITORY_ROOT='/workspace'
GATEWAY='/usr/local/sbin/otto-enterprise-ci-deploy'
PUBLISHER='/usr/local/libexec/otto-enterprise-ci/publish-update-mirror'
ROLLBACK='/usr/local/libexec/otto-enterprise-ci/rollback-update-mirror'
STATE_ROOT='/var/lib/otto-ci-deploy'
MIRROR_ROOT='/opt/otto-website'
TEST_ROOT='/var/tmp/otto-ci-linux-integration'
MIRROR_PACKAGE_ID='aaaaaaaaaaaa-bbbbbbbbbbbb'
MIRROR_SOURCE_COMMIT='cccccccccccccccccccccccccccccccccccccccc'

cleanup() {
  rm -rf --one-file-system -- \
    "$TEST_ROOT" "$STATE_ROOT" "$MIRROR_ROOT" '/opt/otto-enterprise' \
    '/etc/otto-enterprise' "$GATEWAY" '/usr/local/libexec/otto-enterprise-ci' \
    '/etc/sudoers.d/otto-enterprise-ci-deploy' '/usr/sbin/visudo' '/usr/bin/sudo'
}
trap cleanup EXIT
cleanup

if [ ! -x /usr/bin/python3 ]; then
  ln -s /usr/local/bin/python3 /usr/bin/python3
fi

install -d -o root -g root -m 0755 \
  /usr/local/sbin /usr/local/libexec/otto-enterprise-ci \
  /etc/otto-enterprise /var/lib/otto-enterprise
install -d -o root -g root -m 0711 \
  "$STATE_ROOT" "$STATE_ROOT/uploads" \
  "$STATE_ROOT/uploads/enterprise" "$STATE_ROOT/uploads/mirror"
install -d -o root -g root -m 0700 \
  "$STATE_ROOT/staging" "$STATE_ROOT/staging/enterprise" \
  "$STATE_ROOT/staging/mirror" "$STATE_ROOT/locks" \
  "$STATE_ROOT/deployments" "$TEST_ROOT"
install -o root -g root -m 0755 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci-deploy-gateway.sh" \
  "$GATEWAY"
install -o root -g root -m 0755 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci/publish-update-mirror.sh" \
  "$PUBLISHER"
install -o root -g root -m 0755 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci/rollback-update-mirror.sh" \
  "$ROLLBACK"

openssl genpkey -algorithm ED25519 -out "$TEST_ROOT/signing-private.pem" >/dev/null 2>&1
openssl pkey -in "$TEST_ROOT/signing-private.pem" -pubout \
  -out /etc/otto-enterprise/enterprise-package-signing-public.pem
printf '%s\n' '/etc/otto-enterprise/integration.env' \
  > /etc/otto-enterprise/ci-deploy-config-path
printf '%s\n' 'nobody' > /etc/otto-enterprise/ci-deploy-user
printf '%s\n' 'daemon' > /etc/otto-enterprise/ci-rollback-user
printf '%s\n' 'OTTO_ENTERPRISE_PUBLIC_URL=https://example.invalid' \
  > /etc/otto-enterprise/integration.env
chmod 0644 /etc/otto-enterprise/enterprise-package-signing-public.pem
chmod 0600 \
  /etc/otto-enterprise/ci-deploy-config-path \
  /etc/otto-enterprise/ci-deploy-user \
  /etc/otto-enterprise/ci-rollback-user \
  /etc/otto-enterprise/integration.env
chown root:"$(id -gn nobody)" /etc/otto-enterprise
chmod 0750 /etc/otto-enterprise

# Match the real install.sh layout (root:service-group 0750) and execute the
# installer's failure rollback path. A forced sudoers validation failure occurs
# only after the six other fixed files have been replaced, so every one must be
# restored atomically and the config directory permissions must stay intact.
[ ! -e /usr/sbin/visudo ] && [ ! -L /usr/sbin/visudo ]
INSTALLER_SOURCE_ROOT="$TEST_ROOT/bootstrap-source"
install -d -o root -g root -m 0700 "$INSTALLER_SOURCE_ROOT/ci"
install -o root -g root -m 0700 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/install-ci-deploy-gateway.sh" \
  "$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh"
install -o root -g root -m 0700 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci-deploy-gateway.sh" \
  "$INSTALLER_SOURCE_ROOT/ci-deploy-gateway.sh"
install -o root -g root -m 0700 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci/publish-update-mirror.sh" \
  "$INSTALLER_SOURCE_ROOT/ci/publish-update-mirror.sh"
install -o root -g root -m 0700 \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci/rollback-update-mirror.sh" \
  "$INSTALLER_SOURCE_ROOT/ci/rollback-update-mirror.sh"
printf '%s\n' \
  '#!/bin/sh' \
  ": > '$TEST_ROOT/visudo-invoked'" \
  'exit 1' > /usr/sbin/visudo
chmod 0755 /usr/sbin/visudo
installer_state_before="$(
  sha256sum \
    "$GATEWAY" "$PUBLISHER" "$ROLLBACK" \
    /etc/otto-enterprise/enterprise-package-signing-public.pem \
    /etc/otto-enterprise/ci-deploy-config-path \
    /etc/otto-enterprise/ci-deploy-user \
    /etc/otto-enterprise/ci-rollback-user
  stat -c '%u:%g:%a' /etc/otto-enterprise
)"
if "$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh" \
  --deploy-user nobody \
  --rollback-user daemon \
  --public-key /etc/otto-enterprise/enterprise-package-signing-public.pem \
  --config /etc/otto-enterprise/integration.env; then
  printf 'gateway installer ignored a forced post-replacement validation failure\n' >&2
  exit 1
fi
[ -f "$TEST_ROOT/visudo-invoked" ]
installer_state_after="$(
  sha256sum \
    "$GATEWAY" "$PUBLISHER" "$ROLLBACK" \
    /etc/otto-enterprise/enterprise-package-signing-public.pem \
    /etc/otto-enterprise/ci-deploy-config-path \
    /etc/otto-enterprise/ci-deploy-user \
    /etc/otto-enterprise/ci-rollback-user
  stat -c '%u:%g:%a' /etc/otto-enterprise
)"
[ "$installer_state_after" = "$installer_state_before" ]
[ ! -e /etc/sudoers.d/otto-enterprise-ci-deploy ]
rm -f -- /usr/sbin/visudo

# Different login names must not collapse onto the same kernel UID or primary
# GID, because the gateway's deploy/rollback role split is name-based.
printf '%s\n' \
  'otto-same-uid:x:65534:1:shared uid fixture:/nonexistent:/usr/sbin/nologin' \
  'otto-same-gid:x:61001:65534:shared gid fixture:/nonexistent:/usr/sbin/nologin' \
  >> /etc/passwd
if "$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh" \
  --deploy-user nobody \
  --rollback-user otto-same-uid \
  --public-key /etc/otto-enterprise/enterprise-package-signing-public.pem \
  --config /etc/otto-enterprise/integration.env; then
  printf 'gateway installer accepted distinct names sharing one UID\n' >&2
  exit 1
fi
if "$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh" \
  --deploy-user nobody \
  --rollback-user otto-same-gid \
  --public-key /etc/otto-enterprise/enterprise-package-signing-public.pem \
  --config /etc/otto-enterprise/integration.env; then
  printf 'gateway installer accepted distinct names sharing one primary GID\n' >&2
  exit 1
fi
[ ! -e /etc/sudoers.d/otto-enterprise-ci-deploy ]

# A successful sudoers syntax check is still insufficient when either account
# inherits another effective sudo rule. Feed the installer a deterministic
# sudo -l fixture containing NOPASSWD: ALL and require full rollback.
[ ! -e /usr/bin/sudo ] && [ ! -L /usr/bin/sudo ]
printf '%s\n' '#!/bin/sh' 'exit 0' > /usr/sbin/visudo
chmod 0755 /usr/sbin/visudo
printf '%s\n' \
  '#!/bin/sh' \
  'cat <<EOF' \
  'User fixture may run the following commands:' \
  '    (root) NOPASSWD: /usr/local/sbin/otto-enterprise-ci-deploy' \
  '    (root) NOPASSWD: ALL' \
  'EOF' \
  'exit 0' > /usr/bin/sudo
chmod 0755 /usr/bin/sudo
if "$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh" \
  --deploy-user nobody \
  --rollback-user daemon \
  --public-key /etc/otto-enterprise/enterprise-package-signing-public.pem \
  --config /etc/otto-enterprise/integration.env; then
  printf 'gateway installer accepted an automation principal with NOPASSWD ALL\n' >&2
  exit 1
fi
installer_state_after_privilege_audit="$(
  sha256sum \
    "$GATEWAY" "$PUBLISHER" "$ROLLBACK" \
    /etc/otto-enterprise/enterprise-package-signing-public.pem \
    /etc/otto-enterprise/ci-deploy-config-path \
    /etc/otto-enterprise/ci-deploy-user \
    /etc/otto-enterprise/ci-rollback-user
  stat -c '%u:%g:%a' /etc/otto-enterprise
)"
[ "$installer_state_after_privilege_audit" = "$installer_state_before" ]
[ ! -e /etc/sudoers.d/otto-enterprise-ci-deploy ]
rm -f -- /usr/sbin/visudo /usr/bin/sudo

# Model the exact sudo boundary used by a correctly installed host. A sentinel
# lets later checks inject an effective NOPASSWD: ALL drift without changing
# the root-owned gateway bytes.
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\n" "User fixture may run the following commands:"' \
  'printf "%s\n" "    (root) NOPASSWD: /usr/local/sbin/otto-enterprise-ci-deploy"' \
  "if [ -e '$TEST_ROOT/sudo-drift' ]; then" \
  '  printf "%s\n" "    (root) NOPASSWD: ALL"' \
  'fi' \
  'exit 0' > /usr/bin/sudo
chmod 0755 /usr/bin/sudo

# An installer that snapshots the old trust generation and then queues on the
# production lock must not overwrite a newer generation after it wakes.
rmdir -- "$STATE_ROOT/staging/mirror"
exec 6>"$STATE_ROOT/locks/production.lock"
flock -x 6
"$INSTALLER_SOURCE_ROOT/install-ci-deploy-gateway.sh" \
  --deploy-user nobody \
  --rollback-user daemon \
  --public-key /etc/otto-enterprise/enterprise-package-signing-public.pem \
  --config /etc/otto-enterprise/integration.env \
  >"$TEST_ROOT/stale-installer.out" 2>&1 &
stale_installer_pid=$!
installer_waiting='false'
for _ in $(seq 1 100); do
  if [ -r "/proc/$stale_installer_pid/wchan" ] \
    && grep -Eq 'locks_lock_inode_wait|flock' "/proc/$stale_installer_pid/wchan"; then
    installer_waiting='true'
    break
  fi
  kill -0 "$stale_installer_pid" 2>/dev/null \
    || break
  sleep 0.05
done
if [ "$installer_waiting" = 'false' ] \
  && kill -0 "$stale_installer_pid" 2>/dev/null; then
  installer_waiting='true'
fi
[ "$installer_waiting" = 'true' ] \
  || {
    printf 'stale installer did not reach the production lock\n' >&2
    cat "$TEST_ROOT/stale-installer.out" >&2 || true
    exit 1
  }
cp -- "$GATEWAY" "$TEST_ROOT/new-generation-gateway"
printf '\n# simulated newer installer generation\n' \
  >> "$TEST_ROOT/new-generation-gateway"
install -o root -g root -m 0755 -- "$TEST_ROOT/new-generation-gateway" "$GATEWAY"
install -d -o root -g root -m 0700 "$STATE_ROOT/staging/mirror"
flock -u 6
if wait "$stale_installer_pid"; then
  printf 'stale queued installer overwrote a newer trust generation\n' >&2
  exit 1
fi
if ! grep -F 'stale gateway installer observed a different locked trust generation' \
  "$TEST_ROOT/stale-installer.out" >/dev/null; then
  cat "$TEST_ROOT/stale-installer.out" >&2
  exit 1
fi
[ "$(stat -c '%u:%g:%a' "$STATE_ROOT/staging/mirror")" = '0:0:700' ] || {
  printf 'stale installer rolled back a newer installer directory generation\n' >&2
  exit 1
}

expected_key_id="$(openssl pkey -pubin \
  -in /etc/otto-enterprise/enterprise-package-signing-public.pem \
  -outform DER | sha256sum | awk '{print substr($1,1,16)}')"
expected_preflight="protocol=otto-enterprise-ci-deploy-v5 gateway=$(sha256sum "$GATEWAY" | awk '{print $1}') publish=$(sha256sum "$PUBLISHER" | awk '{print $1}') rollback=$(sha256sum "$ROLLBACK" | awk '{print $1}') key=${expected_key_id} config=/etc/otto-enterprise/integration.env deploy_user=nobody rollback_user=daemon"
actual_preflight="$(SUDO_USER=nobody "$GATEWAY" preflight)"
[ "$actual_preflight" = "$expected_preflight" ] || {
  printf 'gateway preflight identity mismatch\nexpected: %s\nactual:   %s\n' \
    "$expected_preflight" "$actual_preflight" >&2
  exit 1
}

# Every invocation must reject account database, supplementary-group and sudo
# drift that occurred after the installer bootstrap audit.
cp -- /etc/passwd "$TEST_ROOT/passwd.before-principal-drift"
nobody_uid="$(id -u nobody)"
sed -E "s/^daemon:x:[0-9]+:/daemon:x:${nobody_uid}:/" \
  "$TEST_ROOT/passwd.before-principal-drift" > /etc/passwd
if SUDO_USER=nobody "$GATEWAY" preflight; then
  printf 'gateway accepted post-install shared-UID account drift\n' >&2
  exit 1
fi
cp -- "$TEST_ROOT/passwd.before-principal-drift" /etc/passwd

cp -- /etc/group "$TEST_ROOT/group.before-principal-drift"
printf '%s\n' 'otto-drift:x:61003:nobody' >> /etc/group
if SUDO_USER=nobody "$GATEWAY" preflight; then
  printf 'gateway accepted post-install supplementary-group drift\n' >&2
  exit 1
fi
cp -- "$TEST_ROOT/group.before-principal-drift" /etc/group

: > "$TEST_ROOT/sudo-drift"
if SUDO_USER=nobody "$GATEWAY" preflight; then
  printf 'gateway accepted post-install effective sudo privilege drift\n' >&2
  exit 1
fi
rm -f -- "$TEST_ROOT/sudo-drift"

# A Bash process that opened the previous gateway inode before replacement must
# fail after it wakes on production.lock; it may not validate and run new trust
# files with old code.
old_gateway="$TEST_ROOT/old-gateway"
cp -- "$GATEWAY" "$old_gateway"
printf '\n# old queued gateway inode\n' >> "$old_gateway"
install -o root -g root -m 0755 -- "$old_gateway" "$GATEWAY"
exec 7>"$STATE_ROOT/locks/production.lock"
flock -x 7
SUDO_USER=nobody "$GATEWAY" preflight >"$TEST_ROOT/old-gateway.out" 2>&1 &
old_gateway_pid=$!
sleep 0.2
install -o root -g root -m 0755 -- \
  "$REPOSITORY_ROOT/deployment/enterprise-oneclick/ci-deploy-gateway.sh" \
  "$TEST_ROOT/new-gateway"
mv -f -- "$TEST_ROOT/new-gateway" "$GATEWAY"
flock -u 7
if wait "$old_gateway_pid"; then
  printf 'queued old gateway continued after its fixed path was replaced\n' >&2
  exit 1
fi
grep -F 'running gateway inode does not match the locked fixed gateway' \
  "$TEST_ROOT/old-gateway.out" >/dev/null
expected_preflight="protocol=otto-enterprise-ci-deploy-v5 gateway=$(sha256sum "$GATEWAY" | awk '{print $1}') publish=$(sha256sum "$PUBLISHER" | awk '{print $1}') rollback=$(sha256sum "$ROLLBACK" | awk '{print $1}') key=${expected_key_id} config=/etc/otto-enterprise/integration.env deploy_user=nobody rollback_user=daemon"
[ "$(SUDO_USER=daemon "$GATEWAY" preflight)" = "$expected_preflight" ]
if SUDO_USER=nobody "$GATEWAY" rollback-mirror v1.9.14-100-1; then
  printf 'deploy principal was allowed to invoke mirror rollback\n' >&2
  exit 1
fi
if SUDO_USER=daemon "$GATEWAY" prepare-upload enterprise v1.9.14-100-1; then
  printf 'rollback principal was allowed to stage a deployment\n' >&2
  exit 1
fi

gateway_upload_file() {
  local kind="$1"
  local transaction_id="$2"
  local role="$3"
  local file="$4"
  local size
  local digest
  local expected_receipt
  local actual_receipt
  size="$(stat -c '%s' -- "$file")"
  digest="$(sha256sum -- "$file" | awk '{print $1}')"
  expected_receipt="uploaded kind=${kind} transaction=${transaction_id} role=${role} size=${size} sha256=${digest}"
  actual_receipt="$(SUDO_USER=nobody "$GATEWAY" \
    upload-file "$kind" "$transaction_id" "$role" "$size" "$digest" \
    < "$file")"
  [ "$actual_receipt" = "$expected_receipt" ]
}

# The fixed gateway lock must make cleanup wait for an in-flight root operation.
(
  exec 7>"$STATE_ROOT/locks/production.lock"
  /usr/bin/flock -x 7
  touch "$TEST_ROOT/production-lock-ready"
  sleep 2
) &
lock_holder=$!
while [ ! -f "$TEST_ROOT/production-lock-ready" ]; do sleep 0.05; done
lock_started="$(date +%s)"
SUDO_USER=nobody "$GATEWAY" cleanup-upload enterprise v1.9.14-100-1
lock_elapsed="$(( $(date +%s) - lock_started ))"
wait "$lock_holder"
[ "$lock_elapsed" -ge 1 ] || {
  printf 'gateway cleanup did not wait for the production lock\n' >&2
  exit 1
}

# A failed root directory enumeration must never be interpreted as an empty
# upload namespace. Replace find only inside this disposable container and
# restore it before continuing.
mv -- /usr/bin/find "$TEST_ROOT/find.real"
printf '%s\n' \
  '#!/bin/sh' \
  "if [ \"\$1\" = '$STATE_ROOT/uploads/enterprise' ] && [ \"\$2\" = '-mindepth' ]; then" \
  '  exit 74' \
  'fi' \
  "exec '$TEST_ROOT/find.real' \"\$@\"" > /usr/bin/find
chmod 0755 /usr/bin/find
if SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-199-1; then
  printf 'gateway treated a failed pending-transaction scan as empty\n' >&2
  exit 1
fi
mv -- "$TEST_ROOT/find.real" /usr/bin/find
[ ! -e "$STATE_ROOT/uploads/enterprise/v1.9.14-199-1" ]

SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-101-1
[ "$(stat -c '%u:%g:%a' "$STATE_ROOT/uploads/enterprise/v1.9.14-101-1")" = '0:0:700' ]
if SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-102-1; then
  printf 'gateway accepted a second outstanding enterprise upload\n' >&2
  exit 1
fi
SUDO_USER=nobody "$GATEWAY" cleanup-upload enterprise v1.9.14-101-1

# The root gateway, not scp, owns the upload write boundary. Oversized and
# short streams must fail without leaving a partial accepted file.
SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-103-1
oversize_digest="$(printf 'a%.0s' $(seq 1 64))"
if printf x | SUDO_USER=nobody "$GATEWAY" upload-file enterprise \
  v1.9.14-103-1 archive-aaaaaaaaaaaa-bbbbbbbbbbbb \
  1073741825 "$oversize_digest"; then
  printf 'gateway accepted an enterprise archive above the hard size ceiling\n' >&2
  exit 1
fi
short_digest="$(printf short | sha256sum | awk '{print $1}')"
if printf short | SUDO_USER=nobody "$GATEWAY" upload-file enterprise \
  v1.9.14-103-1 archive-aaaaaaaaaaaa-bbbbbbbbbbbb \
  6 "$short_digest"; then
  printf 'gateway accepted an upload shorter than its declared size\n' >&2
  exit 1
fi
[ -z "$(find "$STATE_ROOT/uploads/enterprise/v1.9.14-103-1" \
  -mindepth 1 -maxdepth 1 -print -quit)" ]
SUDO_USER=nobody "$GATEWAY" cleanup-upload enterprise v1.9.14-103-1

create_mirror_staging() {
  local transaction_id="$1"
  local latest_value="$2"
  local staging_dir="$STATE_ROOT/staging/mirror/$transaction_id"
  local version="${transaction_id%%-*}"
  version="${version#v}"
  local -a assets=(
    "Otto-${version}-arm64.dmg"
    "Otto-${version}-arm64.dmg.blockmap"
    "Otto-${version}-x64.dmg"
    "Otto-${version}-x64.dmg.blockmap"
    "Otto-Setup-${version}-win-x64.exe"
    "Otto-Setup-${version}-win-x64.exe.blockmap"
  )
  mkdir -m 0700 -- "$staging_dir"
  for asset in "${assets[@]}"; do
    printf 'immutable-%s\n' "$asset" > "$staging_dir/$asset"
  done
  printf '%s\n' "$latest_value" > "$staging_dir/latest.json"
  /usr/bin/python3 -I -S - \
    "$staging_dir" "$version" "$MIRROR_PACKAGE_ID" "$MIRROR_SOURCE_COMMIT" <<'PY'
import base64
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
version, package_identity, source_commit = sys.argv[2:]
names = [
    f'Otto-{version}-arm64.dmg',
    f'Otto-{version}-arm64.dmg.blockmap',
    f'Otto-{version}-x64.dmg',
    f'Otto-{version}-x64.dmg.blockmap',
    f'Otto-Setup-{version}-win-x64.exe',
    f'Otto-Setup-{version}-win-x64.exe.blockmap',
    'latest.json',
]
manifest = {
    'format': 'otto-update-mirror-payload-v1',
    'version': version,
    'packageIdentity': package_identity,
    'sourceCommit': source_commit,
    'assets': [],
}
for name in names:
    data = (root / name).read_bytes()
    manifest['assets'].append({
        'name': name,
        'size': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })
manifest_bytes = (
    json.dumps(manifest, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n'
).encode()
(root / 'UPDATE-MIRROR-SHA256SUMS').write_bytes(manifest_bytes)
signature = {
    'format': 'otto-release-payload-signature-v1',
    'algorithm': 'Ed25519',
    'file': 'UPDATE-MIRROR-SHA256SUMS',
    'sha256': hashlib.sha256(manifest_bytes).hexdigest(),
    'keyId': '0' * 16,
    'signature': base64.urlsafe_b64encode(b'x' * 64).decode().rstrip('='),
}
(root / 'UPDATE-MIRROR-SHA256SUMS.sig').write_text(
    json.dumps(signature, separators=(',', ':')) + '\n', encoding='utf-8'
)
PY
  chown -R root:root "$staging_dir"
}

publish_mirror() {
  local transaction_id="$1"
  local version="${transaction_id%%-*}"
  version="${version#v}"
  "$PUBLISHER" "$transaction_id" "$version" \
    "$MIRROR_PACKAGE_ID" "$MIRROR_SOURCE_COMMIT"
}

# Existing publication paths are trust boundaries. The publisher must reject,
# not silently chmod, a legacy group-writable directory before creating any
# child publication state.
create_mirror_staging v1.9.14-200-1 '{"version":"1.9.14","marker":"unsafe-root"}'
install -d -o root -g root -m 0775 "$MIRROR_ROOT"
if publish_mirror v1.9.14-200-1; then
  printf 'publisher normalized and accepted a group-writable mirror root\n' >&2
  exit 1
fi
[ "$(stat -c '%u:%g:%a' "$MIRROR_ROOT")" = '0:0:775' ]
[ ! -e "$MIRROR_ROOT/downloads" ]
[ ! -e "$MIRROR_ROOT/otto-releases" ]
[ ! -e "$MIRROR_ROOT/transactions" ]
rm -rf --one-file-system -- \
  "$STATE_ROOT/staging/mirror/v1.9.14-200-1" "$MIRROR_ROOT"

install -d -o root -g root -m 0755 "$MIRROR_ROOT/otto-releases"
printf '%s\n' '{"version":"1.9.13","marker":"old"}' \
  > "$MIRROR_ROOT/otto-releases/latest.json"
chmod 0644 "$MIRROR_ROOT/otto-releases/latest.json"

create_mirror_staging v1.9.14-201-1 '{"version":"1.9.14","marker":"a"}'
publish_mirror v1.9.14-201-1
grep -Fx '{"version":"1.9.14","marker":"a"}' \
  "$MIRROR_ROOT/otto-releases/latest.json" >/dev/null
if publish_mirror v1.9.14-201-1; then
  printf 'publisher accepted a replayed transaction\n' >&2
  exit 1
fi

create_mirror_staging v1.9.15-202-1 '{"version":"1.9.15","marker":"b"}'
publish_mirror v1.9.15-202-1
create_mirror_staging v1.9.13-205-1 '{"version":"1.9.13","marker":"downgrade"}'
if publish_mirror v1.9.13-205-1; then
  printf 'publisher accepted a mirror version downgrade\n' >&2
  exit 1
fi
if "$ROLLBACK" v1.9.14-201-1; then
  printf 'rollback accepted a stale transaction owner\n' >&2
  exit 1
fi
"$ROLLBACK" v1.9.15-202-1
grep -Fx '{"version":"1.9.14","marker":"a"}' \
  "$MIRROR_ROOT/otto-releases/latest.json" >/dev/null
grep -Fx 'v1.9.14-201-1' "$STATE_ROOT/mirror-current-owner" >/dev/null

# A version with a durable claiming marker is burned even when a later
# transaction presents byte-identical assets and manifest content.
create_mirror_staging v1.9.14-204-1 '{"version":"1.9.14","marker":"a"}'
if publish_mirror v1.9.14-204-1; then
  printf 'publisher reused a burned version with byte-identical assets\n' >&2
  exit 1
fi
rm -rf --one-file-system -- "$STATE_ROOT/staging/mirror/v1.9.14-204-1"
install -o root -g root -m 0644 \
  "$MIRROR_ROOT/transactions/v1.9.14-201-1/previous-latest.json" \
  "$MIRROR_ROOT/otto-releases/latest.json"
rm -f -- "$STATE_ROOT/mirror-current-owner"
grep -Fx '{"version":"1.9.13","marker":"old"}' \
  "$MIRROR_ROOT/otto-releases/latest.json" >/dev/null
[ ! -e "$STATE_ROOT/mirror-current-owner" ]

# A corrupt/power-loss state that claims ownership without retaining the
# published manifest cannot be proven safe. Rollback must fail closed instead
# of returning a digest that could let the workflow hide both Releases.
broken_transaction="$MIRROR_ROOT/transactions/v1.9.12-208-1"
mkdir -m 0700 -- "$broken_transaction"
install -o root -g root -m 0600 \
  "$MIRROR_ROOT/otto-releases/latest.json" \
  "$broken_transaction/previous-latest.json"
install -o root -g root -m 0600 /dev/null \
  "$broken_transaction/previous-owner.absent"
install -o root -g root -m 0600 /dev/null "$broken_transaction/claiming"
printf '%s\n' 'v1.9.12-208-1' > "$STATE_ROOT/mirror-current-owner"
chmod 0600 "$STATE_ROOT/mirror-current-owner"
if "$ROLLBACK" v1.9.12-208-1; then
  printf 'rollback accepted an owner ledger with no published manifest\n' >&2
  exit 1
fi
[ ! -e "$broken_transaction/rolled-back" ]
rm -f -- "$STATE_ROOT/mirror-current-owner"
rm -rf --one-file-system -- "$broken_transaction"

# A crash while recording the rollback baseline is still safely compensatable:
# the publisher has not created the claiming marker and therefore has not
# changed either the public owner ledger or latest.json.
partial_baseline_transaction="$MIRROR_ROOT/transactions/v1.9.18-209-1"
mkdir -m 0700 -- "$partial_baseline_transaction"
install -o root -g root -m 0600 \
  "$MIRROR_ROOT/otto-releases/latest.json" \
  "$partial_baseline_transaction/previous-latest.json"
manifest_before_partial_rollback="$(sha256sum -- \
  "$MIRROR_ROOT/otto-releases/latest.json" | awk '{print $1}')"
partial_baseline_output="$("$ROLLBACK" v1.9.18-209-1)"
printf '%s\n' "$partial_baseline_output" | \
  grep -F 'stopped before claiming publication' >/dev/null
[ -f "$partial_baseline_transaction/rolled-back" ]
[ "$(sha256sum -- "$MIRROR_ROOT/otto-releases/latest.json" | awk '{print $1}')" \
  = "$manifest_before_partial_rollback" ]
partial_baseline_retry_output="$("$ROLLBACK" v1.9.18-209-1)"
printf '%s\n' "$partial_baseline_retry_output" | \
  grep -F 'already marked rolled back' >/dev/null
printf '%s\n' "$partial_baseline_retry_output" | \
  grep -Eq '^restored_manifest_sha256=[0-9a-f]{64}$'

# Staging published-latest.json is also pre-claim state. A crash at this point
# must not strand the draft releases merely because the transaction captured
# more of its private rollback metadata.
published_before_claim_transaction="$MIRROR_ROOT/transactions/v1.9.19-210-1"
mkdir -m 0700 -- "$published_before_claim_transaction"
install -o root -g root -m 0600 \
  "$MIRROR_ROOT/otto-releases/latest.json" \
  "$published_before_claim_transaction/previous-latest.json"
install -o root -g root -m 0600 /dev/null \
  "$published_before_claim_transaction/previous-owner.absent"
install -o root -g root -m 0600 \
  "$MIRROR_ROOT/otto-releases/latest.json" \
  "$published_before_claim_transaction/published-latest.json"
published_before_claim_output="$("$ROLLBACK" v1.9.19-210-1)"
printf '%s\n' "$published_before_claim_output" | \
  grep -F 'stopped before claiming publication' >/dev/null
[ -f "$published_before_claim_transaction/rolled-back" ]
[ "$(sha256sum -- "$MIRROR_ROOT/otto-releases/latest.json" | awk '{print $1}')" \
  = "$manifest_before_partial_rollback" ]
published_before_claim_retry_output="$("$ROLLBACK" v1.9.19-210-1)"
printf '%s\n' "$published_before_claim_retry_output" | \
  grep -F 'already marked rolled back' >/dev/null
printf '%s\n' "$published_before_claim_retry_output" | \
  grep -Eq '^restored_manifest_sha256=[0-9a-f]{64}$'

# Once claiming is durable, the version is burned before any asset can become
# public. A crash after one asset rename must restore only the selector and
# permanently preserve the verified immutable URL for exact reconciliation.
claimed_assets_transaction="$MIRROR_ROOT/transactions/v1.9.20-211-1"
mkdir -m 0700 -- "$claimed_assets_transaction"
install -o root -g root -m 0600 \
  "$MIRROR_ROOT/otto-releases/latest.json" \
  "$claimed_assets_transaction/previous-latest.json"
install -o root -g root -m 0600 /dev/null \
  "$claimed_assets_transaction/previous-owner.absent"
printf '%s\n' '{"version":"1.9.20","marker":"claimed-assets"}' \
  > "$claimed_assets_transaction/published-latest.json"
claimed_asset_source="$TEST_ROOT/Otto-Setup-1.9.20-win-x64.exe"
printf '%s\n' 'version-burned-immutable-asset' > "$claimed_asset_source"
absent_asset_hash='0000000000000000000000000000000000000000000000000000000000000000'
claimed_asset_hash="$(sha256sum -- "$claimed_asset_source" | awk '{print $1}')"
claimed_manifest_hash="$(sha256sum -- \
  "$claimed_assets_transaction/published-latest.json" | awk '{print $1}')"
/usr/bin/python3 -I -S - \
  "$claimed_assets_transaction/UPDATE-MIRROR-SHA256SUMS" \
  "$claimed_asset_hash" "$(stat -c '%s' "$claimed_asset_source")" \
  "$claimed_manifest_hash" \
  "$(stat -c '%s' "$claimed_assets_transaction/published-latest.json")" \
  "$MIRROR_PACKAGE_ID" "$MIRROR_SOURCE_COMMIT" <<'PY'
import json
import pathlib
import sys

output = pathlib.Path(sys.argv[1])
claimed_hash, claimed_size, latest_hash, latest_size, package_identity, source_commit = sys.argv[2:]
absent_hash = '0' * 64
names = [
    'Otto-1.9.20-arm64.dmg',
    'Otto-1.9.20-arm64.dmg.blockmap',
    'Otto-1.9.20-x64.dmg',
    'Otto-1.9.20-x64.dmg.blockmap',
    'Otto-Setup-1.9.20-win-x64.exe',
    'Otto-Setup-1.9.20-win-x64.exe.blockmap',
    'latest.json',
]
assets = [{'name': name, 'size': 1, 'sha256': absent_hash} for name in names]
assets[4] = {'name': names[4], 'size': int(claimed_size), 'sha256': claimed_hash}
assets[6] = {'name': names[6], 'size': int(latest_size), 'sha256': latest_hash}
ledger = {
    'format': 'otto-update-mirror-payload-v1',
    'version': '1.9.20',
    'packageIdentity': package_identity,
    'sourceCommit': source_commit,
    'assets': assets,
}
output.write_text(
    json.dumps(ledger, ensure_ascii=False, indent=2, separators=(',', ': ')) + '\n',
    encoding='utf-8',
)
PY
printf '%s\n' 'signed-ledger-envelope-placeholder' \
  > "$claimed_assets_transaction/UPDATE-MIRROR-SHA256SUMS.sig"
chmod 0600 \
  "$claimed_assets_transaction/published-latest.json" \
  "$claimed_assets_transaction/UPDATE-MIRROR-SHA256SUMS" \
  "$claimed_assets_transaction/UPDATE-MIRROR-SHA256SUMS.sig"
claimed_rollback_expires="$(( $(date +%s) + 3600 ))"
printf 'transaction=%s\nexpires=%s\n' \
  'v1.9.20-211-1' "$claimed_rollback_expires" \
  > "$claimed_assets_transaction/rollback-capability"
chmod 0600 "$claimed_assets_transaction/rollback-capability"
install -o root -g root -m 0600 -- \
  "$claimed_assets_transaction/rollback-capability" \
  "$STATE_ROOT/mirror-rollback-capability"
install -o root -g root -m 0600 /dev/null \
  "$claimed_assets_transaction/claiming"
claimed_asset="$MIRROR_ROOT/downloads/Otto-Setup-1.9.20-win-x64.exe"
install -o root -g root -m 0644 -- "$claimed_asset_source" "$claimed_asset"
claimed_assets_output="$(SUDO_USER=daemon "$GATEWAY" \
  rollback-mirror v1.9.20-211-1)"
printf '%s\n' "$claimed_assets_output" | \
  grep -F 'preserved any version-burned immutable assets' >/dev/null
[ -f "$claimed_asset" ]
[ -f "$claimed_assets_transaction/rolled-back" ]
[ ! -e "$STATE_ROOT/mirror-rollback-capability" ]
[ "$(sha256sum -- "$MIRROR_ROOT/otto-releases/latest.json" | awk '{print $1}')" \
  = "$manifest_before_partial_rollback" ]
create_mirror_staging v1.9.20-212-1 '{"version":"1.9.20","marker":"must-not-reuse-burned-version"}'
if publish_mirror v1.9.20-212-1; then
  printf 'publisher reused a version burned by another claimed transaction\n' >&2
  exit 1
fi
rm -rf --one-file-system -- "$STATE_ROOT/staging/mirror/v1.9.20-212-1"

# Crash recovery: if the public manifest and owner were already restored but
# the rolled-back marker was not written, a retry must complete bookkeeping
# instead of treating the committed transaction as stale.
create_mirror_staging v1.9.16-206-1 '{"version":"1.9.16","marker":"crash-recovery"}'
publish_mirror v1.9.16-206-1
install -o root -g root -m 0644 \
  "$MIRROR_ROOT/transactions/v1.9.16-206-1/previous-latest.json" \
  "$MIRROR_ROOT/otto-releases/latest.json"
rm -f -- "$STATE_ROOT/mirror-current-owner"
rollback_output="$("$ROLLBACK" v1.9.16-206-1)"
printf '%s\n' "$rollback_output" | \
  grep -Eq '^restored_manifest_sha256=[0-9a-f]{64}$'
[ -f "$MIRROR_ROOT/transactions/v1.9.16-206-1/rolled-back" ]

# A new publish must fail closed if the owner ledger points at an incomplete,
# rolled-back or byte-mismatched transaction. It must not preserve that torn
# state as the next transaction's rollback baseline.
printf '%s\n' 'v1.9.16-206-1' > "$STATE_ROOT/mirror-current-owner"
chmod 0600 "$STATE_ROOT/mirror-current-owner"
create_mirror_staging v1.9.17-207-1 '{"version":"1.9.17","marker":"must-not-publish"}'
if publish_mirror v1.9.17-207-1; then
  printf 'publisher accepted a crash-torn current owner ledger\n' >&2
  exit 1
fi
rm -f -- "$STATE_ROOT/mirror-current-owner"
rm -rf --one-file-system -- "$STATE_ROOT/staging/mirror/v1.9.17-207-1"

chmod 0666 "$MIRROR_ROOT/downloads/Otto-1.9.14-arm64.dmg"
create_mirror_staging v1.9.14-203-1 '{"version":"1.9.14","marker":"c"}'
if publish_mirror v1.9.14-203-1; then
  printf 'publisher accepted a writable existing release asset\n' >&2
  exit 1
fi
[ ! -e "$MIRROR_ROOT/transactions/v1.9.14-203-1" ]
preflight_rollback_output="$("$ROLLBACK" v1.9.14-203-1)"
printf '%s\n' "$preflight_rollback_output" | \
  grep -Eq '^restored_manifest_sha256=[0-9a-f]{64}$'
chmod 0644 "$MIRROR_ROOT/downloads/Otto-1.9.14-arm64.dmg"

mark_expired_rollback_started() {
  local transaction_id="$1"
  local transaction_dir="$MIRROR_ROOT/transactions/$transaction_id"
  printf 'transaction=%s\nexpires=1\n' "$transaction_id" \
    > "$transaction_dir/rollback-capability"
  install -o root -g root -m 0600 -- \
    "$transaction_dir/rollback-capability" "$STATE_ROOT/mirror-rollback-capability"
  local capability_digest
  capability_digest="$(sha256sum "$transaction_dir/rollback-capability" | awk '{print $1}')"
  printf 'transaction=%s\ncapability_sha256=%s\n' \
    "$transaction_id" "$capability_digest" > "$transaction_dir/rollback-started"
  chmod 0600 "$transaction_dir/rollback-capability" "$transaction_dir/rollback-started"
  sync -f "$transaction_dir/rollback-started"
  sync -f "$transaction_dir"
}

# Deterministic crash injection immediately after rollback-started: a newer
# publication is blocked, while the authorized rollback must finish after expiry.
create_mirror_staging v1.9.21-213-1 '{"version":"1.9.21","marker":"rollback-started"}'
publish_mirror v1.9.21-213-1
# The publisher must observe a random crash temp created by the rollback helper,
# not just the legacy fixed .rollback-started.next name.
: > "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.deadbeef.next"
chmod 0600 "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.deadbeef.next"
create_mirror_staging v1.9.22-214-1 '{"version":"1.9.22","marker":"must-not-chain"}'
if publish_mirror v1.9.22-214-1; then
  printf 'publisher accepted a new release while a random rollback temp existed\n' >&2
  exit 1
fi
rm -rf --one-file-system -- "$STATE_ROOT/staging/mirror/v1.9.22-214-1"
rm -f -- "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.deadbeef.next"
# A killed writer may leave any exact byte-prefix of the authorized marker,
# including a partial first or second line. The retry must remove those
# uncommitted root-owned files inside the root-only transaction and continue.
: > "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.next"
chmod 0644 "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.next"
printf 'transact' \
  > "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.first.next"
printf 'transaction=v1.9.21-213-1\ncapability_' \
  > "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.second.next"
chmod 0600 \
  "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.first.next" \
  "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.second.next"
# Publisher EXIT traps cannot survive SIGKILL or power loss. Inject every
# fixed transaction-bound namespace, including a potentially large asset.
install -o root -g root -m 0644 /dev/null \
  "$MIRROR_ROOT/downloads/.Otto-1.9.21-arm64.dmg.v1.9.21-213-1.next"
install -o root -g root -m 0644 /dev/null \
  "$MIRROR_ROOT/otto-releases/.latest.json.v1.9.21-213-1.next"
install -o root -g root -m 0600 /dev/null \
  "$STATE_ROOT/.mirror-current-owner.v1.9.21-213-1.next"
install -o root -g root -m 0600 /dev/null \
  "$STATE_ROOT/.mirror-rollback-capability.v1.9.21-213-1.next"
mark_expired_rollback_started v1.9.21-213-1
"$ROLLBACK" v1.9.21-213-1 >/dev/null
[ ! -e "$STATE_ROOT/mirror-rollback-capability" ]
[ ! -e "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.next" ]
[ ! -e "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.first.next" ]
[ ! -e "$MIRROR_ROOT/transactions/v1.9.21-213-1/.rollback-started.second.next" ]
[ ! -e "$MIRROR_ROOT/downloads/.Otto-1.9.21-arm64.dmg.v1.9.21-213-1.next" ]
[ ! -e "$MIRROR_ROOT/otto-releases/.latest.json.v1.9.21-213-1.next" ]
[ ! -e "$STATE_ROOT/.mirror-current-owner.v1.9.21-213-1.next" ]
[ ! -e "$STATE_ROOT/.mirror-rollback-capability.v1.9.21-213-1.next" ]

# Crash after selector restoration but before owner restoration, after expiry.
create_mirror_staging v1.9.23-215-1 '{"version":"1.9.23","marker":"selector-crash"}'
publish_mirror v1.9.23-215-1
mark_expired_rollback_started v1.9.23-215-1
install -o root -g root -m 0644 \
  "$MIRROR_ROOT/transactions/v1.9.23-215-1/previous-latest.json" \
  "$MIRROR_ROOT/otto-releases/latest.json"
"$ROLLBACK" v1.9.23-215-1 >/dev/null

# Crash after owner restoration but before selector restoration, after expiry.
create_mirror_staging v1.9.24-216-1 '{"version":"1.9.24","marker":"owner-crash"}'
publish_mirror v1.9.24-216-1
mark_expired_rollback_started v1.9.24-216-1
rm -f -- "$STATE_ROOT/mirror-current-owner"
"$ROLLBACK" v1.9.24-216-1 >/dev/null
[ ! -e "$STATE_ROOT/mirror-rollback-capability" ]

PACKAGE_ID='aaaaaaaaaaaa-bbbbbbbbbbbb'
SOURCE_COMMIT='cccccccccccccccccccccccccccccccccccccccc'
PACKAGE_ROOT="otto-enterprise-oneclick-v1.9.14-${PACKAGE_ID}"
ARCHIVE_NAME="${PACKAGE_ROOT}.tar.gz"
PACKAGE_WORK="$TEST_ROOT/$PACKAGE_ROOT"
mkdir -p "$PACKAGE_WORK/release" "$PACKAGE_WORK/fillers"
printf '#!/bin/bash\nset -Eeuo pipefail\nexit 0\n' > "$PACKAGE_WORK/install.sh"
printf '#!/bin/bash\nset -Eeuo pipefail\nexit 0\n' > "$PACKAGE_WORK/upgrade.sh"
chmod 0755 "$PACKAGE_WORK/install.sh" "$PACKAGE_WORK/upgrade.sh"
printf '%s\n' \
  '{"format":"otto-enterprise-release-v1","version":"1.9.14","releaseChannel":"stable","buildCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","buildIdentityKind":"release-content-sha1","sourceCommit":"cccccccccccccccccccccccccccccccccccccccc","sourceTreeDirty":false,"sourceDiffSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sourceInputSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runtime":{"node":"22.23.1","supportedArchitectures":["linux-x64","linux-arm64"]}}' \
  > "$PACKAGE_WORK/release/manifest.json"
for number in 1 2 3 4 5 6 7 8; do
  printf 'filler-%s\n' "$number" > "$PACKAGE_WORK/fillers/$number.txt"
done
tar -czf "$TEST_ROOT/$ARCHIVE_NAME" -C "$TEST_ROOT" "$PACKAGE_ROOT"
(
  cd "$TEST_ROOT"
  sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
)
openssl pkeyutl -sign -rawin -inkey "$TEST_ROOT/signing-private.pem" \
  -in "$TEST_ROOT/$ARCHIVE_NAME" -out "$TEST_ROOT/archive-signature.bin"
openssl pkey -pubin \
  -in /etc/otto-enterprise/enterprise-package-signing-public.pem \
  -outform DER -out "$TEST_ROOT/signing-public.der"
/usr/bin/python3 -I -S - \
  "$TEST_ROOT/$ARCHIVE_NAME" "$TEST_ROOT/archive-signature.bin" \
  "$TEST_ROOT/signing-public.der" "$TEST_ROOT/$ARCHIVE_NAME.sig" <<'PY'
import base64
import hashlib
import json
import pathlib
import sys

payload_path, signature_path, public_key_path, output_path = map(pathlib.Path, sys.argv[1:])
payload = payload_path.read_bytes()
signature = signature_path.read_bytes()
public_key = public_key_path.read_bytes()
envelope = {
    'format': 'otto-enterprise-package-signature-v1',
    'algorithm': 'Ed25519',
    'file': payload_path.name,
    'sha256': hashlib.sha256(payload).hexdigest(),
    'keyId': hashlib.sha256(public_key).hexdigest()[:16],
    'signature': base64.urlsafe_b64encode(signature).decode('ascii').rstrip('='),
}
output_path.write_text(json.dumps(envelope, indent=2) + '\n', encoding='utf-8')
PY

# The v5 CI gateway is upgrade-only, including dry-run. Model the direct
# one-click install layout before asking it to inspect the 1.9.14 package.
install -d -o root -g root -m 0755 \
  /opt/otto-enterprise/releases/1.9.13-dddddddddddd \
  /opt/otto-enterprise/deploy
printf '%s\n' \
  '{"format":"otto-enterprise-release-v1","version":"1.9.13","releaseChannel":"stable","buildCommit":"dddddddddddddddddddddddddddddddddddddddd","buildIdentityKind":"release-content-sha1","sourceCommit":"ffffffffffffffffffffffffffffffffffffffff","sourceTreeDirty":false,"sourceDiffSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sourceInputSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","runtime":{"node":"22.23.1","supportedArchitectures":["linux-x64","linux-arm64"]}}' \
  > /opt/otto-enterprise/releases/1.9.13-dddddddddddd/manifest.json
chown root:root /opt/otto-enterprise/releases/1.9.13-dddddddddddd/manifest.json
chmod 0644 /opt/otto-enterprise/releases/1.9.13-dddddddddddd/manifest.json
ln -s /opt/otto-enterprise/releases/1.9.13-dddddddddddd \
  /opt/otto-enterprise/current
printf '%s\n' '#!/bin/bash' 'set -Eeuo pipefail' 'exit 0' \
  > /opt/otto-enterprise/deploy/verify.sh
chmod 0755 /opt/otto-enterprise/deploy/verify.sh

SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-301-1
UPLOAD_DIR="$STATE_ROOT/uploads/enterprise/v1.9.14-301-1"
gateway_upload_file enterprise v1.9.14-301-1 \
  "archive-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME"
gateway_upload_file enterprise v1.9.14-301-1 \
  "checksum-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sha256"
gateway_upload_file enterprise v1.9.14-301-1 \
  "signature-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sig"
# A lost SSH receipt can retry the same role only with identical bytes.
gateway_upload_file enterprise v1.9.14-301-1 \
  "signature-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sig"
SUDO_USER=nobody "$GATEWAY" deploy \
  v1.9.14-301-1 "$ARCHIVE_NAME" 1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT" true
[ ! -e "$UPLOAD_DIR" ] || {
  printf 'successful dry-run left its upload directory behind\n' >&2
  exit 1
}

install -d -o root -g root -m 0755 \
  /opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa \
  /opt/otto-enterprise/deploy
install -o root -g root -m 0644 \
  "$PACKAGE_WORK/release/manifest.json" \
  /opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa/manifest.json
ln -sfn /opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa \
  /opt/otto-enterprise/current.next
mv -Tf /opt/otto-enterprise/current.next /opt/otto-enterprise/current
printf '%s\n' \
  '#!/bin/bash' \
  'set -Eeuo pipefail' \
  '[ "$OTTO_CONFIG_PATH" = "/etc/otto-enterprise/integration.env" ]' \
  > /opt/otto-enterprise/deploy/verify.sh
chmod 0755 /opt/otto-enterprise/deploy/verify.sh
VERIFY_TRANSACTION='v1.9.14-300-1'
VERIFY_TRANSACTION_DIR="$STATE_ROOT/deployments/$VERIFY_TRANSACTION"
install -d -o root -g root -m 0700 \
  "$VERIFY_TRANSACTION_DIR" \
  "$VERIFY_TRANSACTION_DIR/upgrade" \
  "$VERIFY_TRANSACTION_DIR/upgrade/deploy.before"
{
  printf '%s\n' \
    'format=otto-enterprise-deployment-state-v1' \
    "transaction=$VERIFY_TRANSACTION" \
    'action=upgrade' \
    'target_version=1.9.14' \
    "target_package=$PACKAGE_ID" \
    "target_source=$SOURCE_COMMIT" \
    'previous_version=1.9.13' \
    'previous_package=dddddddddddd-eeeeeeeeeeee' \
    'previous_source=ffffffffffffffffffffffffffffffffffffffff' \
    'previous_current=/opt/otto-enterprise/releases/1.9.13-dddddddddddd'
} > "$VERIFY_TRANSACTION_DIR/state"
chown root:root "$VERIFY_TRANSACTION_DIR/state"
chmod 0600 "$VERIFY_TRANSACTION_DIR/state"
for snapshot in \
  data.db.before \
  enterprise.env.before \
  resident-recurring-tasks.absent \
  database-key-preserved; do
  install -o root -g root -m 0600 /dev/null \
    "$VERIFY_TRANSACTION_DIR/upgrade/$snapshot"
done
install -o root -g root -m 0644 /dev/null \
  "$VERIFY_TRANSACTION_DIR/upgrade/otto-enterprise.service.before"
VERIFY_WITNESS="otto-enterprise-rollback-witness-v1 transaction=$VERIFY_TRANSACTION target_version=1.9.14 target_package=$PACKAGE_ID target_source=$SOURCE_COMMIT previous_version=1.9.13 previous_package=dddddddddddd-eeeeeeeeeeee previous_source=ffffffffffffffffffffffffffffffffffffffff"
printf '%s\n' "$VERIFY_WITNESS" > "$VERIFY_TRANSACTION_DIR/rollback-witness.expected"
chown root:root "$VERIFY_TRANSACTION_DIR/rollback-witness.expected"
chmod 0600 "$VERIFY_TRANSACTION_DIR/rollback-witness.expected"
SUDO_USER=nobody "$GATEWAY" verify-deployment \
  "$VERIFY_TRANSACTION" 1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT"
if SUDO_USER=nobody "$GATEWAY" verify-deployment \
  "$VERIFY_TRANSACTION" 1.9.14 cccccccccccc-bbbbbbbbbbbb "$SOURCE_COMMIT"; then
  printf 'gateway reconciliation accepted the wrong build identity\n' >&2
  exit 1
fi
# A new run with the same package identity must not silently adopt this older
# unfinished transaction. Recovery requires the old exact transaction id.
NEW_SAME_PACKAGE_TRANSACTION='v1.9.14-302-1'
SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise \
  "$NEW_SAME_PACKAGE_TRANSACTION"
gateway_upload_file enterprise "$NEW_SAME_PACKAGE_TRANSACTION" \
  "archive-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME"
gateway_upload_file enterprise "$NEW_SAME_PACKAGE_TRANSACTION" \
  "checksum-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sha256"
gateway_upload_file enterprise "$NEW_SAME_PACKAGE_TRANSACTION" \
  "signature-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sig"
if SUDO_USER=nobody "$GATEWAY" deploy \
  "$NEW_SAME_PACKAGE_TRANSACTION" "$ARCHIVE_NAME" \
  1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT" false; then
  printf 'gateway adopted an older unfinished same-package transaction\n' >&2
  exit 1
fi
if [ -e "$STATE_ROOT/uploads/enterprise/$NEW_SAME_PACKAGE_TRANSACTION" ]; then
  SUDO_USER=nobody "$GATEWAY" cleanup-upload enterprise \
    "$NEW_SAME_PACKAGE_TRANSACTION"
fi
RECOVERED_DEPLOYMENT="$(SUDO_USER=nobody "$GATEWAY" reconcile-deployment \
  "$VERIFY_TRANSACTION" 1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT")"
case "$RECOVERED_DEPLOYMENT" in
  "recovered_deployed transaction=$VERIFY_TRANSACTION version=1.9.14 package=$PACKAGE_ID source=$SOURCE_COMMIT "*) ;;
  *)
    printf 'gateway did not durably recover the exact deployed receipt: %s\n' \
      "$RECOVERED_DEPLOYMENT" >&2
    exit 1
    ;;
esac
SUDO_USER=nobody "$GATEWAY" finalize-deployment \
  "$VERIFY_TRANSACTION" 1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT" >/dev/null
[ -f "$VERIFY_TRANSACTION_DIR/finalized" ]

# Simulate an upgrade that failed before cutover after its transaction state
# became durable. Reconciliation must verify the still-running previous release,
# write an exact terminal rollback receipt, and leave no unfinished blocker.
FAILED_TRANSACTION='v1.9.15-303-1'
FAILED_TRANSACTION_DIR="$STATE_ROOT/deployments/$FAILED_TRANSACTION"
FAILED_PACKAGE='111111111111-222222222222'
FAILED_SOURCE='3333333333333333333333333333333333333333'
install -d -o root -g root -m 0700 \
  "$FAILED_TRANSACTION_DIR" "$FAILED_TRANSACTION_DIR/upgrade"
{
  printf '%s\n' \
    'format=otto-enterprise-deployment-state-v1' \
    "transaction=$FAILED_TRANSACTION" \
    'action=upgrade' \
    'target_version=1.9.15' \
    "target_package=$FAILED_PACKAGE" \
    "target_source=$FAILED_SOURCE" \
    'previous_version=1.9.14' \
    "previous_package=$PACKAGE_ID" \
    "previous_source=$SOURCE_COMMIT" \
    'previous_current=/opt/otto-enterprise/releases/1.9.14-aaaaaaaaaaaa'
} > "$FAILED_TRANSACTION_DIR/state"
chown root:root "$FAILED_TRANSACTION_DIR/state"
chmod 0600 "$FAILED_TRANSACTION_DIR/state"
FAILED_WITNESS="otto-enterprise-rollback-witness-v1 transaction=$FAILED_TRANSACTION target_version=1.9.15 target_package=$FAILED_PACKAGE target_source=$FAILED_SOURCE previous_version=1.9.14 previous_package=$PACKAGE_ID previous_source=$SOURCE_COMMIT"
printf '%s\n' "$FAILED_WITNESS" \
  > "$FAILED_TRANSACTION_DIR/rollback-witness.expected"
printf '%s\n' "$FAILED_WITNESS" \
  > "$FAILED_TRANSACTION_DIR/upgrade/rollback-verified"
chown root:root \
  "$FAILED_TRANSACTION_DIR/rollback-witness.expected" \
  "$FAILED_TRANSACTION_DIR/upgrade/rollback-verified"
chmod 0600 \
  "$FAILED_TRANSACTION_DIR/rollback-witness.expected" \
  "$FAILED_TRANSACTION_DIR/upgrade/rollback-verified"
RECOVERED_ROLLBACK="$(SUDO_USER=nobody "$GATEWAY" reconcile-deployment \
  "$FAILED_TRANSACTION" 1.9.15 "$FAILED_PACKAGE" "$FAILED_SOURCE")"
EXPECTED_RECOVERED_ROLLBACK="recovered_rolled_back transaction=$FAILED_TRANSACTION restored_version=1.9.14 restored_package=$PACKAGE_ID restored_source=$SOURCE_COMMIT replaced_version=1.9.15 replaced_package=$FAILED_PACKAGE replaced_source=$FAILED_SOURCE"
[ "$RECOVERED_ROLLBACK" = "$EXPECTED_RECOVERED_ROLLBACK" ] || {
  printf 'gateway did not durably classify the pre-cutover failure\nexpected: %s\nactual:   %s\n' \
    "$EXPECTED_RECOVERED_ROLLBACK" "$RECOVERED_ROLLBACK" >&2
  exit 1
}
[ "$(<"$FAILED_TRANSACTION_DIR/rolled-back")" = \
  "${EXPECTED_RECOVERED_ROLLBACK#recovered_}" ]

SUDO_USER=nobody "$GATEWAY" prepare-upload enterprise v1.9.14-302-1
TAMPERED_UPLOAD="$STATE_ROOT/uploads/enterprise/v1.9.14-302-1"
cp -- "$TEST_ROOT/$ARCHIVE_NAME" "$TEST_ROOT/tampered-$ARCHIVE_NAME"
printf 'tampered\n' >> "$TEST_ROOT/tampered-$ARCHIVE_NAME"
gateway_upload_file enterprise v1.9.14-302-1 \
  "archive-$PACKAGE_ID" "$TEST_ROOT/tampered-$ARCHIVE_NAME"
gateway_upload_file enterprise v1.9.14-302-1 \
  "checksum-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sha256"
gateway_upload_file enterprise v1.9.14-302-1 \
  "signature-$PACKAGE_ID" "$TEST_ROOT/$ARCHIVE_NAME.sig"
if SUDO_USER=nobody "$GATEWAY" deploy \
  v1.9.14-302-1 "$ARCHIVE_NAME" 1.9.14 "$PACKAGE_ID" "$SOURCE_COMMIT" true; then
  printf 'gateway accepted a tampered signed archive\n' >&2
  exit 1
fi
[ ! -e "$TAMPERED_UPLOAD" ] || {
  printf 'failed signature verification left its upload directory behind\n' >&2
  exit 1
}

printf 'enterprise CI Linux integration checks passed\n'
