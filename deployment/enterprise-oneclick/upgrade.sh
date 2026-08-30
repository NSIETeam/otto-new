#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH="/etc/otto-enterprise/enterprise.env"
DRY_RUN=0
ROLLBACK_DIR=""
ROLLBACK_WITNESS_FILE=""
INSTALL_ROOT="${OTTO_INSTALL_ROOT:-/opt/otto-enterprise}"
DATA_DIR="${OTTO_DATA_DIR:-/var/lib/otto-enterprise}"
RESIDENT_STATE_PATH="${DATA_DIR}/resident-recurring-tasks.json"
SERVICE_UNIT="/etc/systemd/system/otto-enterprise.service"
LOCK_FILE="/run/lock/otto-enterprise-deploy.lock"
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

usage() {
  cat <<'EOF'
用法：
  sudo ./upgrade.sh [--config /etc/otto-enterprise/enterprise.env] [--rollback-dir /var/lib/otto-ci-deploy/deployments/TRANSACTION/upgrade] [--rollback-witness-file /var/lib/otto-ci-deploy/deployments/TRANSACTION/rollback-witness.expected]
  ./upgrade.sh [--config ...] --dry-run

边界：
  - 仅升级已经由 one-click current symlink 管理的 Otto Enterprise 安装。
  - 先复制现有 data.db 到隔离目录迁移并启动 canary；通过后才切换 current。
  - 失败会恢复旧 current、旧 data.db，并重启旧服务。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || otto_die "--config 缺少值"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --rollback-dir)
      [ "$#" -ge 2 ] || otto_die "--rollback-dir 缺少值"
      ROLLBACK_DIR="$2"
      shift 2
      ;;
    --rollback-witness-file)
      [ "$#" -ge 2 ] || otto_die "--rollback-witness-file 缺少值"
      ROLLBACK_WITNESS_FILE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      otto_die "未知参数：$1"
      ;;
  esac
done

if [ -n "$ROLLBACK_DIR" ]; then
  [ "$DRY_RUN" -eq 0 ] || otto_die "--rollback-dir 不能用于 dry-run"
  [[ "$ROLLBACK_DIR" =~ ^/var/lib/otto-ci-deploy/deployments/v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+/upgrade$ ]] \
    || otto_die "--rollback-dir 不在固定部署事务目录内"
  [ -d "$ROLLBACK_DIR" ] && [ ! -L "$ROLLBACK_DIR" ] \
    || otto_die "--rollback-dir 不存在或不安全"
  [ "$(stat -c '%u:%g:%a' "$ROLLBACK_DIR")" = '0:0:700' ] \
    || otto_die "--rollback-dir 必须为 root:root 0700"
  [ -z "$(find "$ROLLBACK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] \
    || otto_die "--rollback-dir 必须为空"
  [ "$ROLLBACK_WITNESS_FILE" = \
    "$(dirname -- "$ROLLBACK_DIR")/rollback-witness.expected" ] \
    || otto_die "--rollback-witness-file 必须绑定同一部署事务"
  [ -f "$ROLLBACK_WITNESS_FILE" ] && [ ! -L "$ROLLBACK_WITNESS_FILE" ] \
    || otto_die "--rollback-witness-file 不存在或不安全"
  [ "$(stat -c '%u:%g:%a' "$ROLLBACK_WITNESS_FILE")" = '0:0:600' ] \
    || otto_die "--rollback-witness-file 必须为 root:root 0600"
  mapfile -t ROLLBACK_WITNESS_LINES < "$ROLLBACK_WITNESS_FILE"
  [ "${#ROLLBACK_WITNESS_LINES[@]}" -eq 1 ] \
    && [[ "${ROLLBACK_WITNESS_LINES[0]}" =~ ^otto-enterprise-rollback-witness-v1\ transaction=v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+\ target_version=[0-9]+\.[0-9]+\.[0-9]+\ target_package=[0-9a-f]{12}-[0-9a-f]{12}\ target_source=[0-9a-f]{40}\ previous_version=[0-9]+\.[0-9]+\.[0-9]+\ previous_package=[0-9a-f]{12}-[0-9a-f]{12}\ previous_source=[0-9a-f]{40}$ ]] \
    || otto_die "--rollback-witness-file 内容无效"
elif [ -n "$ROLLBACK_WITNESS_FILE" ]; then
  otto_die "--rollback-witness-file 只能与 --rollback-dir 一起使用"
fi

otto_load_config "$CONFIG_PATH"
OTTO_ALLOW_SMS_DISABLED="${OTTO_ALLOW_SMS_DISABLED:-0}"
OTTO_DATABASE_ENCRYPTION_KEY_FILE="${OTTO_DATABASE_ENCRYPTION_KEY_FILE:-}"
case "$OTTO_ALLOW_SMS_DISABLED" in
  0|1) ;;
  *) otto_die "OTTO_ALLOW_SMS_DISABLED 只能是 0 或 1" ;;
esac

[ -d "${SCRIPT_DIR}/release" ] || otto_die "部署包缺少 release 目录" 3
[ -f "${SCRIPT_DIR}/release/manifest.json" ] || otto_die "部署包缺少 release manifest" 3
otto_verify_package_manifest "$SCRIPT_DIR"

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || otto_die "正式升级必须使用 sudo/root" 3
  [ "$(uname -s)" = "Linux" ] || otto_die "正式升级仅支持 Linux" 3
  command -v systemctl >/dev/null 2>&1 || otto_die "目标机没有 systemd" 3
  mkdir -p "$(dirname -- "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || otto_die "已有另一个 Otto 部署正在运行" 3
fi

[ -L "${INSTALL_ROOT}/current" ] || otto_die "${INSTALL_ROOT}/current 不存在或不是 symlink；请先用 install.sh 完成首装" 3
CURRENT_REAL="$(readlink -f "${INSTALL_ROOT}/current")"
[ -d "$CURRENT_REAL" ] || otto_die "current 指向不存在或不是目录：${CURRENT_REAL}" 3
[ -x "${INSTALL_ROOT}/runtime/current/bin/node" ] || otto_die "现有安装缺少固定 Node runtime" 3
[ -f "${DATA_DIR}/data.db" ] && [ ! -L "${DATA_DIR}/data.db" ] || otto_die "现有数据文件不存在或不安全：${DATA_DIR}/data.db" 3
[ ! -e "$RESIDENT_STATE_PATH" ] \
  || { [ -f "$RESIDENT_STATE_PATH" ] && [ ! -L "$RESIDENT_STATE_PATH" ]; } \
  || otto_die "常驻任务状态文件不是安全的普通文件：${RESIDENT_STATE_PATH}" 3
[ -f "$SERVICE_UNIT" ] && [ ! -L "$SERVICE_UNIT" ] || otto_die "systemd 单元不存在或不安全：${SERVICE_UNIT}" 3

NODE_PATH="${INSTALL_ROOT}/runtime/current/bin/node"
[ "$("$NODE_PATH" --version)" = "v${OTTO_NODE_VERSION}" ] \
  || otto_die "现有固定 Node runtime 与 SQLCipher ABI 不匹配；需要 v${OTTO_NODE_VERSION}" 3
RELEASE_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "${SCRIPT_DIR}/release")"
RELEASE_VERSION="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_INFO")"
BUILD_ID="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_INFO")"
RELEASE_SCHEMA_TO="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_INFO")"
RELEASE_NAME="${RELEASE_VERSION}-${BUILD_ID:0:12}"
TARGET_RELEASE="${INSTALL_ROOT}/releases/${RELEASE_NAME}"
RUNTIME_ARCH="$(otto_arch)"
SQLCIPHER_RELEASE_BINDING="${SCRIPT_DIR}/release/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node"
[ -f "$SQLCIPHER_RELEASE_BINDING" ] && [ ! -L "$SQLCIPHER_RELEASE_BINDING" ] \
  || otto_die "升级包缺少当前架构的 SQLCipher Node.js 原生产物：linux-${RUNTIME_ARCH}" 3

CURRENT_VERIFY_OPTIONS=(--allow-legacy-lstc --allow-legacy-sqlite)
if [ -f "${CURRENT_REAL}/HOTFIX-INFO" ] || [ -f "${CURRENT_REAL}/HOTFIX-PREVIOUS-RELEASE" ]; then
  CURRENT_VERIFY_OPTIONS+=(--allow-registration-legal-hotfix)
fi
CURRENT_INFO="$("$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" "$CURRENT_REAL" "${CURRENT_VERIFY_OPTIONS[@]}")"
CURRENT_BUILD="$("$NODE_PATH" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$CURRENT_INFO")"
if [ "$CURRENT_BUILD" = "$BUILD_ID" ]; then
  otto_log "相同 release 已安装；执行幂等验收"
  if [ "$DRY_RUN" -eq 0 ]; then
    OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"
  fi
  exit 0
fi

REUSE_TARGET_RELEASE=0
if [ -e "$TARGET_RELEASE" ] || [ -L "$TARGET_RELEASE" ]; then
  # A failed, fully compensated attempt can leave its immutable target tree
  # behind. Permit an exact retry only after binding that tree byte-for-byte to
  # this signed package manifest and re-verifying every manifest file hash.
  # Unknown, replaceable or differently owned paths remain fail-closed.
  [ -d "$TARGET_RELEASE" ] && [ ! -L "$TARGET_RELEASE" ] \
    || otto_die "既有目标 release 不是安全目录：${TARGET_RELEASE}" 3
  [ "$(stat -c '%u:%g' "$TARGET_RELEASE")" = '0:0' ] \
    || otto_die "既有目标 release 不是 root 所有：${TARGET_RELEASE}" 3
  [ -z "$(find "$TARGET_RELEASE" -xdev \( ! -user root -o ! -group root \) -print -quit)" ] \
    || otto_die "既有目标 release 包含非 root 所有内容：${TARGET_RELEASE}" 3
  [ -f "${TARGET_RELEASE}/manifest.json" ] \
    && [ ! -L "${TARGET_RELEASE}/manifest.json" ] \
    && cmp -s -- "${SCRIPT_DIR}/release/manifest.json" \
      "${TARGET_RELEASE}/manifest.json" \
    || otto_die "既有目标 release 与本次签名包身份不一致：${TARGET_RELEASE}" 3
  "$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" \
    "$TARGET_RELEASE" >/dev/null \
    || otto_die "既有目标 release 完整性复验失败：${TARGET_RELEASE}" 3
  REUSE_TARGET_RELEASE=1
  otto_log "复用上次已验证但未切换成功的 exact target release"
fi

if [ -n "$ROLLBACK_DIR" ]; then
  TXN_DIR="$ROLLBACK_DIR"
else
  TXN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/otto-enterprise-upgrade.XXXXXX")"
fi
chmod 0700 "$TXN_DIR"
CANARY_PID=""
OLD_DATA_BACKUP="${TXN_DIR}/data.db.before"
OLD_RESIDENT_STATE_BACKUP="${TXN_DIR}/resident-recurring-tasks.json.before"
OLD_RESIDENT_STATE_ABSENT="${TXN_DIR}/resident-recurring-tasks.absent"
NEW_DATA="${TXN_DIR}/data.db.next"
ROLLBACK_NEEDED=0
OLD_DEPLOY_BACKUP="${TXN_DIR}/deploy.before"
CONFIG_BACKUP="${TXN_DIR}/enterprise.env.before"
SERVICE_UNIT_BACKUP="${TXN_DIR}/otto-enterprise.service.before"
BASELINE_INSPECTION="${TXN_DIR}/database-inspection.before.json"
MANAGED_DATABASE_KEY_PATH="$(dirname -- "$CONFIG_PATH")/database-sqlcipher.key"
DATABASE_KEY_MANAGED=0
DATABASE_KEY_CREATED=0
SERVICE_STOPPED=0
UPGRADE_SUCCEEDED=0
RESIDENT_STATE_EXISTED=0
TARGET_RELEASE_STAGE=""

install -o root -g root -m 0600 "$CONFIG_PATH" "$CONFIG_BACKUP"
install -o root -g root -m 0644 "$SERVICE_UNIT" "$SERVICE_UNIT_BACKUP"

write_rollback_verified_witness() {
  local expected_content marker_file marker_next
  [ -n "$ROLLBACK_DIR" ] && [ -n "$ROLLBACK_WITNESS_FILE" ] || return 0
  expected_content="$(<"$ROLLBACK_WITNESS_FILE")"
  marker_file="${ROLLBACK_DIR}/rollback-verified"
  marker_next="${marker_file}.next"
  "$NODE_PATH" --input-type=module - \
    "$marker_next" "$marker_file" "$expected_content" <<'NODE'
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const [nextPath, finalPath, expected] = process.argv.slice(2);
const payload = `${expected}\n`;
if (existsSync(finalPath)) {
  if (readFileSync(finalPath, 'utf8') !== payload) {
    throw new Error('rollback verification witness changed');
  }
  const file = openSync(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(new URL('.', `file://${finalPath}`), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  process.exit(0);
}

if (existsSync(nextPath)) unlinkSync(nextPath);
const descriptor = openSync(
  nextPath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o600,
);
try {
  writeFileSync(descriptor, payload);
  chmodSync(nextPath, 0o600);
  chownSync(nextPath, 0, 0);
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
try {
  linkSync(nextPath, finalPath);
} finally {
  if (existsSync(nextPath)) unlinkSync(nextPath);
}
const directory = openSync(new URL('.', `file://${finalPath}`), constants.O_RDONLY);
try { fsyncSync(directory); } finally { closeSync(directory); }
NODE
  [ -f "$marker_file" ] && [ ! -L "$marker_file" ] \
    && [ "$(stat -c '%u:%g:%a' "$marker_file")" = '0:0:600' ] \
    && [ "$(<"$marker_file")" = "$expected_content" ]
}

sync_live_deployment_filesystems() {
  local durability_path
  for durability_path in \
    "$INSTALL_ROOT" \
    "$DATA_DIR" \
    "$(dirname -- "$CONFIG_PATH")" \
    "$(dirname -- "$SERVICE_UNIT")"; do
    [ -d "$durability_path" ] && [ ! -L "$durability_path" ] || return 1
    /usr/bin/sync -f "$durability_path" || return 1
  done
}

cleanup() {
  local rollback_ok=1
  local preserve_transaction=0
  local old_release_verified=0
  if [ -n "$CANARY_PID" ] && kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
    wait "$CANARY_PID" || true
  fi
  if [ -n "$TARGET_RELEASE_STAGE" ] \
    && [ "$TARGET_RELEASE_STAGE" != "$TARGET_RELEASE" ]; then
    case "$TARGET_RELEASE_STAGE" in
      "${TARGET_RELEASE}.next-"*)
        if [ -e "$TARGET_RELEASE_STAGE" ] || [ -L "$TARGET_RELEASE_STAGE" ]; then
          if [ -d "$TARGET_RELEASE_STAGE" ] && [ ! -L "$TARGET_RELEASE_STAGE" ]; then
            rm -rf --one-file-system -- "$TARGET_RELEASE_STAGE" \
              || otto_warn "无法清理未发布的 target staging：${TARGET_RELEASE_STAGE}"
          else
            otto_warn "未发布的 target staging 类型异常，保留供人工审计：${TARGET_RELEASE_STAGE}"
          fi
        fi
        ;;
      *) otto_warn "拒绝清理未绑定的 target staging 路径：${TARGET_RELEASE_STAGE}" ;;
    esac
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ "$UPGRADE_SUCCEEDED" -eq 0 ]; then
    if [ "$ROLLBACK_NEEDED" -eq 1 ]; then
      otto_warn "升级失败，开始回滚旧 release"
      systemctl stop otto-enterprise >/dev/null 2>&1 || true
      if ! ln -sfn "$CURRENT_REAL" "${INSTALL_ROOT}/current.rollback" \
        || ! mv -Tf "${INSTALL_ROOT}/current.rollback" "${INSTALL_ROOT}/current"; then
        rollback_ok=0
      fi
      if [ -f "$OLD_DATA_BACKUP" ]; then
        install -o otto-enterprise -g otto-enterprise -m 0600 \
          "$OLD_DATA_BACKUP" "${DATA_DIR}/data.db" || rollback_ok=0
      else
        rollback_ok=0
      fi
      if [ "$RESIDENT_STATE_EXISTED" -eq 1 ]; then
        if [ -f "$OLD_RESIDENT_STATE_BACKUP" ] \
          && [ ! -L "$OLD_RESIDENT_STATE_BACKUP" ]; then
          install -o otto-enterprise -g otto-enterprise -m 0600 \
            "$OLD_RESIDENT_STATE_BACKUP" "$RESIDENT_STATE_PATH" \
            || rollback_ok=0
        else
          rollback_ok=0
        fi
      elif [ -f "$OLD_RESIDENT_STATE_ABSENT" ] \
        && [ ! -L "$OLD_RESIDENT_STATE_ABSENT" ]; then
        rm -f -- "$RESIDENT_STATE_PATH" || rollback_ok=0
      else
        rollback_ok=0
      fi
      if [ -f "$CONFIG_BACKUP" ]; then
        install -o root -g root -m 0600 "$CONFIG_BACKUP" "$CONFIG_PATH" \
          || rollback_ok=0
      else
        rollback_ok=0
      fi
      if [ -f "$SERVICE_UNIT_BACKUP" ]; then
        install -o root -g root -m 0644 "$SERVICE_UNIT_BACKUP" "$SERVICE_UNIT" \
          || rollback_ok=0
      else
        rollback_ok=0
      fi
      if [ "$DATABASE_KEY_CREATED" -eq 1 ] \
        && [ -f "$MANAGED_DATABASE_KEY_PATH" ]; then
        rm -f "$MANAGED_DATABASE_KEY_PATH"
      fi
      if [ -d "$OLD_DEPLOY_BACKUP" ]; then
        if rm -rf "${INSTALL_ROOT}/deploy.rollback" \
          && cp -a "$OLD_DEPLOY_BACKUP" "${INSTALL_ROOT}/deploy.rollback" \
          && rm -rf "${INSTALL_ROOT}/deploy" \
          && mv "${INSTALL_ROOT}/deploy.rollback" "${INSTALL_ROOT}/deploy"; then
          :
        else
          rollback_ok=0
        fi
      else
        rollback_ok=0
      fi
    fi
    if [ "$SERVICE_STOPPED" -eq 1 ]; then
      systemctl daemon-reload >/dev/null 2>&1 || rollback_ok=0
      systemctl start otto-enterprise >/dev/null 2>&1 || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ] \
      && [ -x "${INSTALL_ROOT}/deploy/verify.sh" ]; then
      if OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" \
        "${INSTALL_ROOT}/deploy/verify.sh" >/dev/null 2>&1; then
        if sync_live_deployment_filesystems; then
          old_release_verified=1
          otto_log "旧 release、数据和服务已回滚并通过健康验收"
        else
          rollback_ok=0
        fi
      else
        rollback_ok=0
      fi
    else
      rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ] && [ "$old_release_verified" -eq 1 ] \
      && [ -n "$ROLLBACK_DIR" ]; then
      if ! write_rollback_verified_witness; then
        rollback_ok=0
      fi
    fi
    if [ "$rollback_ok" -eq 0 ]; then
      preserve_transaction=1
      otto_warn "自动回滚未通过健康验收；保留事务证据：${TXN_DIR}"
    fi
  fi
  # A caller-provided rollback directory is part of the CI deployment
  # transaction.  Never delete it here: the root gateway must be able to
  # durably classify a failed upgrade as rolled back, or retain the evidence
  # for manual recovery when the previous service cannot be re-verified.
  if [ "$preserve_transaction" -eq 0 ] && [ -z "$ROLLBACK_DIR" ]; then
    rm -rf "$TXN_DIR" || otto_warn "无法清理升级事务目录：${TXN_DIR}"
  fi
}
trap cleanup EXIT

if [ "$DRY_RUN" -eq 0 ]; then
  SERVICE_STOPPED=1
  systemctl stop otto-enterprise
  GRACEFUL_ACTIVE_STATE="$(systemctl show otto-enterprise \
    --property=ActiveState --value)"
  GRACEFUL_RESULT="$(systemctl show otto-enterprise \
    --property=Result --value)"
  GRACEFUL_MAIN_STATUS="$(systemctl show otto-enterprise \
    --property=ExecMainStatus --value)"
  [ "$GRACEFUL_ACTIVE_STATE" = inactive ] \
    && [ "$GRACEFUL_RESULT" = success ] \
    && [ "$GRACEFUL_MAIN_STATUS" = 0 ] \
    || otto_die "旧服务未完成 graceful drain/checkpoint，拒绝升级" 5
fi
if [ -e "$RESIDENT_STATE_PATH" ] || [ -L "$RESIDENT_STATE_PATH" ]; then
  [ -f "$RESIDENT_STATE_PATH" ] && [ ! -L "$RESIDENT_STATE_PATH" ] \
    || otto_die "常驻任务状态文件在快照前变得不安全：${RESIDENT_STATE_PATH}" 3
  install -o root -g root -m 0600 \
    "$RESIDENT_STATE_PATH" "$OLD_RESIDENT_STATE_BACKUP"
  RESIDENT_STATE_EXISTED=1
else
  install -o root -g root -m 0600 /dev/null "$OLD_RESIDENT_STATE_ABSENT"
fi
otto_require_command od
otto_require_command tr
DATABASE_HEADER="$(od -An -tx1 -N16 "${DATA_DIR}/data.db" | tr -d ' \n')"
if [ "$DATABASE_HEADER" = "53514c69746520666f726d6174203300" ]; then
  "$NODE_PATH" "${SCRIPT_DIR}/tools/db-tool.mjs" backup \
    "${DATA_DIR}/data.db" "$OLD_DATA_BACKUP" >"$BASELINE_INSPECTION"
else
  [ -n "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" ] \
    || otto_die "现有数据库不是明文 SQLite，但运行配置缺少 SQLCipher 密钥" 3
  "$NODE_PATH" "${SCRIPT_DIR}/tools/migrate-check.mjs" \
    "$CURRENT_REAL" "$DATA_DIR" --snapshot "$OLD_DATA_BACKUP" \
    >"$BASELINE_INSPECTION"
fi
chown root:root "$OLD_DATA_BACKUP"
chmod 0600 "$OLD_DATA_BACKUP"
cp -p "$OLD_DATA_BACKUP" "$NEW_DATA"
CANARY_DIR="${TXN_DIR}/canary"
mkdir -p "$CANARY_DIR"
cp -p "$NEW_DATA" "${CANARY_DIR}/data.db"
if [ "$RESIDENT_STATE_EXISTED" -eq 1 ]; then
  install -o root -g root -m 0600 \
    "$OLD_RESIDENT_STATE_BACKUP" \
    "${CANARY_DIR}/resident-recurring-tasks.json"
fi

if [ -z "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" ]; then
  if [ -e "$MANAGED_DATABASE_KEY_PATH" ] || [ -L "$MANAGED_DATABASE_KEY_PATH" ]; then
    otto_die "运行配置未声明 SQLCipher 密钥，但托管密钥路径已存在；拒绝覆盖" 3
  fi
  CANARY_DATABASE_KEY="${TXN_DIR}/database-sqlcipher.key"
  "$NODE_PATH" --input-type=module -e \
    "import { randomBytes } from 'node:crypto'; import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], randomBytes(32), { flag: 'wx', mode: 0o600 });" \
    "$CANARY_DATABASE_KEY"
  OTTO_DATABASE_ENCRYPTION_KEY_FILE="$CANARY_DATABASE_KEY"
  DATABASE_KEY_MANAGED=1
else
  [[ "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" = /* ]] \
    || otto_die "OTTO_DATABASE_ENCRYPTION_KEY_FILE 必须使用绝对路径"
  [ -f "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" ] \
    && [ ! -L "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" ] \
    || otto_die "OTTO_DATABASE_ENCRYPTION_KEY_FILE 必须指向普通文件且不能是符号链接"
fi
export OTTO_DATABASE_ENCRYPTION="required"
export OTTO_DATABASE_ENCRYPTION_KEY_FILE
export OTTO_DATABASE_ENCRYPTION_KEY_ID="oneclick-offline-database-key"
export OTTO_DATABASE_ENCRYPTION_KEY_READONLY="true"
export OTTO_SQLCIPHER_NATIVE_BINDING="$SQLCIPHER_RELEASE_BINDING"

CANARY_READY_FILE="${CANARY_DIR}/canary-ready.json"
CANARY_PORT=""
export OTTO_ENTERPRISE_DIR="$CANARY_DIR"
export OTTO_ENTERPRISE_HOST="127.0.0.1"
export OTTO_ENTERPRISE_PORT="0"
export OTTO_ENTERPRISE_READY_FILE="$CANARY_READY_FILE"
export OTTO_ENTERPRISE_CANARY_MODE="1"
OTTO_PUBLIC_HOST="${OTTO_PUBLIC_HOST:-localhost}"
OTTO_PUBLIC_PORT="${OTTO_PUBLIC_PORT:-7777}"
OTTO_ENTERPRISE_PUBLIC_URL="${OTTO_ENTERPRISE_PUBLIC_URL:-https://${OTTO_PUBLIC_HOST}:${OTTO_PUBLIC_PORT}}"
export OTTO_ENTERPRISE_PUBLIC_URL
export OTTO_ENTERPRISE_ADMIN_TOKEN="${OTTO_ENTERPRISE_ADMIN_TOKEN:-upgrade-canary-token-not-for-public-use}"
export OTTO_ENTERPRISE_TRUST_PROXY_HOPS="1"
export OTTO_APP_VERSION="$RELEASE_VERSION"
export OTTO_BUILD_COMMIT="$BUILD_ID"
export OTTO_LICENSE_TRUST_FILE="${SCRIPT_DIR}/release/license-public-keys.json"

"$NODE_PATH" "${SCRIPT_DIR}/tools/migrate-check.mjs" \
  "${SCRIPT_DIR}/release" "$CANARY_DIR" \
  --baseline "$BASELINE_INSPECTION" >/dev/null
otto_log "启动 127.0.0.1:自动分配端口 升级 canary"
"$NODE_PATH" "${SCRIPT_DIR}/release/run.mjs" >"${TXN_DIR}/canary.log" 2>&1 &
CANARY_PID=$!
CANARY_OK=0
for _ in $(seq 1 30); do
  if ! kill -0 "$CANARY_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "${TXN_DIR}/canary.log" >&2
    otto_die "升级 canary 启动后提前退出" 5
  fi
  if [ -f "$CANARY_READY_FILE" ]; then
    CANARY_PORT="$("$NODE_PATH" --input-type=module - \
      "$CANARY_READY_FILE" "$RELEASE_VERSION" "$BUILD_ID" <<'NODE'
import { lstatSync, readFileSync } from 'node:fs';
const [readyFile, expectedVersion, expectedBuild] = process.argv.slice(2);
const metadata = lstatSync(readyFile);
if (metadata.isSymbolicLink() || !metadata.isFile()) {
  throw new Error('canary readiness file is not a regular file');
}
const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
if (
  !ready ||
  ready.host !== '127.0.0.1' ||
  !Number.isInteger(ready.port) ||
  ready.port < 1 ||
  ready.port > 65535 ||
  ready.version !== expectedVersion ||
  ready.buildCommit !== expectedBuild
) {
  throw new Error('canary readiness content does not match the release');
}
process.stdout.write(String(ready.port));
NODE
    )" || {
      sed -n '1,160p' "${TXN_DIR}/canary.log" >&2
      otto_die "升级 canary 就绪文件无效" 5
    }
    if "$NODE_PATH" "${SCRIPT_DIR}/tools/health-check.mjs" \
      "http://127.0.0.1:${CANARY_PORT}" "$RELEASE_VERSION" "$BUILD_ID" \
      "$RELEASE_SCHEMA_TO" \
      "$([ "$OTTO_ALLOW_SMS_DISABLED" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')" \
      >/dev/null 2>&1; then
      CANARY_OK=1
      break
  fi
  fi
  sleep 1
done
[ "$CANARY_OK" -eq 1 ] || {
  sed -n '1,160p' "${TXN_DIR}/canary.log" >&2
  otto_die "升级 canary 未通过" 5
}
kill -TERM "$CANARY_PID" >/dev/null 2>&1 || true
wait "$CANARY_PID" || true
CANARY_PID=""
unset OTTO_ENTERPRISE_CANARY_MODE OTTO_ENTERPRISE_READY_FILE

if [ "$DRY_RUN" -eq 1 ]; then
  otto_log "dry-run 通过：release、数据库迁移和 canary health 均正常；未切换 current"
  exit 0
fi

mkdir -p "${INSTALL_ROOT}/releases"
if [ "$REUSE_TARGET_RELEASE" -eq 0 ]; then
  TARGET_RELEASE_STAGE="${TARGET_RELEASE}.next-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  [ ! -e "$TARGET_RELEASE_STAGE" ] && [ ! -L "$TARGET_RELEASE_STAGE" ] \
    || otto_die "target staging 已存在，拒绝覆盖：${TARGET_RELEASE_STAGE}" 5
  cp -a "${SCRIPT_DIR}/release" "$TARGET_RELEASE_STAGE"
  chown -R root:root "$TARGET_RELEASE_STAGE"
  otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE_STAGE"
  "$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" \
    "$TARGET_RELEASE_STAGE" >/dev/null
  /usr/bin/sync -f "$TARGET_RELEASE_STAGE"
  mv -T -- "$TARGET_RELEASE_STAGE" "$TARGET_RELEASE"
  TARGET_RELEASE_STAGE=""
  /usr/bin/sync -f "${INSTALL_ROOT}/releases"
else
  otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"
  "$NODE_PATH" "${SCRIPT_DIR}/tools/verify-release.mjs" \
    "$TARGET_RELEASE" >/dev/null
fi

if [ -d "${INSTALL_ROOT}/deploy" ] && [ ! -L "${INSTALL_ROOT}/deploy" ]; then
  cp -a "${INSTALL_ROOT}/deploy" "$OLD_DEPLOY_BACKUP"
fi
[ -f "$OLD_DATA_BACKUP" ] && [ ! -L "$OLD_DATA_BACKUP" ] \
  && [ "$(stat -c '%u:%g:%a' "$OLD_DATA_BACKUP")" = '0:0:600' ] \
  || otto_die "升级回滚数据库快照不完整或不安全" 5
[ -f "$CONFIG_BACKUP" ] && [ ! -L "$CONFIG_BACKUP" ] \
  && [ "$(stat -c '%u:%g:%a' "$CONFIG_BACKUP")" = '0:0:600' ] \
  || otto_die "升级回滚配置快照不完整或不安全" 5
[ -f "$SERVICE_UNIT_BACKUP" ] && [ ! -L "$SERVICE_UNIT_BACKUP" ] \
  && [ "$(stat -c '%u:%g:%a' "$SERVICE_UNIT_BACKUP")" = '0:0:644' ] \
  || otto_die "升级回滚 systemd 快照不完整或不安全" 5
[ -d "$OLD_DEPLOY_BACKUP" ] && [ ! -L "$OLD_DEPLOY_BACKUP" ] \
  && [ "$(stat -c '%u:%g' "$OLD_DEPLOY_BACKUP")" = '0:0' ] \
  || otto_die "升级回滚 deploy 快照不完整或不安全" 5
if [ "$RESIDENT_STATE_EXISTED" -eq 1 ]; then
  [ -f "$OLD_RESIDENT_STATE_BACKUP" ] \
    && [ ! -L "$OLD_RESIDENT_STATE_BACKUP" ] \
    && [ "$(stat -c '%u:%g:%a' "$OLD_RESIDENT_STATE_BACKUP")" = '0:0:600' ] \
    || otto_die "升级回滚常驻任务状态快照不完整或不安全" 5
else
  [ -f "$OLD_RESIDENT_STATE_ABSENT" ] \
    && [ ! -L "$OLD_RESIDENT_STATE_ABSENT" ] \
    && [ "$(stat -c '%u:%g:%a' "$OLD_RESIDENT_STATE_ABSENT")" = '0:0:600' ] \
    && [ ! -s "$OLD_RESIDENT_STATE_ABSENT" ] \
    || otto_die "升级回滚常驻任务缺失哨兵不完整或不安全" 5
fi
if [ -n "$ROLLBACK_DIR" ]; then
  if [ "$DATABASE_KEY_MANAGED" -eq 1 ]; then
    DATABASE_KEY_SNAPSHOT="$TXN_DIR/database-key-created"
  else
    DATABASE_KEY_SNAPSHOT="$TXN_DIR/database-key-preserved"
  fi
  install -o root -g root -m 0600 /dev/null "$DATABASE_KEY_SNAPSHOT"
fi
# syncfs the transaction filesystem before the first live DB/current mutation.
# The gateway may only commit a receipt while this exact rollback set remains.
/usr/bin/sync -f "$TXN_DIR"
ROLLBACK_NEEDED=1
systemctl stop otto-enterprise
install -o otto-enterprise -g otto-enterprise -m 0600 "${CANARY_DIR}/data.db" "${DATA_DIR}/data.db"
CANARY_RESIDENT_STATE="${CANARY_DIR}/resident-recurring-tasks.json"
if [ -e "$CANARY_RESIDENT_STATE" ] || [ -L "$CANARY_RESIDENT_STATE" ]; then
  [ -f "$CANARY_RESIDENT_STATE" ] && [ ! -L "$CANARY_RESIDENT_STATE" ] \
    || otto_die "canary 常驻任务状态文件不安全" 5
  install -o otto-enterprise -g otto-enterprise -m 0600 \
    "$CANARY_RESIDENT_STATE" "$RESIDENT_STATE_PATH"
elif [ "$RESIDENT_STATE_EXISTED" -eq 1 ]; then
  otto_die "canary 丢失了既有常驻任务状态文件" 5
else
  rm -f -- "$RESIDENT_STATE_PATH"
fi
if [ "$DATABASE_KEY_MANAGED" -eq 1 ]; then
  chown root:otto-enterprise "$(dirname -- "$MANAGED_DATABASE_KEY_PATH")"
  chmod 0750 "$(dirname -- "$MANAGED_DATABASE_KEY_PATH")"
  # Arm cleanup before install can create the destination. GNU install may
  # return non-zero after opening/writing the managed key (for example during
  # its final ownership/mode work); EXIT cleanup must still remove that partial
  # credential on every failure path.
  DATABASE_KEY_CREATED=1
  install -o root -g otto-enterprise -m 0640 \
    "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" "$MANAGED_DATABASE_KEY_PATH"
  OTTO_DATABASE_ENCRYPTION_KEY_FILE="$MANAGED_DATABASE_KEY_PATH"
else
  runuser -u otto-enterprise -- test -r "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" \
    || otto_die "otto-enterprise 服务账号无法读取外部 SQLCipher 密钥"
fi
UPDATED_CONFIG="${TXN_DIR}/enterprise.env.next"
"$NODE_PATH" --input-type=module - "$CONFIG_PATH" "$UPDATED_CONFIG" \
  "$OTTO_DATABASE_ENCRYPTION_KEY_FILE" \
  "${TARGET_RELEASE}/native/sqlcipher/linux-${RUNTIME_ARCH}/better_sqlite3.node" \
  "$RELEASE_VERSION" "$BUILD_ID" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [source, target, keyPath, bindingPath, appVersion, buildCommit] =
  process.argv.slice(2);
const managedKeys = new Set([
  'OTTO_ENTERPRISE_CANARY_MODE',
  'OTTO_ENTERPRISE_READY_FILE',
  'OTTO_DATABASE_ENCRYPTION',
  'OTTO_DATABASE_ENCRYPTION_KEY_FILE',
  'OTTO_DATABASE_ENCRYPTION_KEY_ID',
  'OTTO_DATABASE_ENCRYPTION_KEY_READONLY',
  'OTTO_SQLCIPHER_NATIVE_BINDING',
  'OTTO_APP_VERSION',
  'OTTO_BUILD_COMMIT',
]);
const retained = readFileSync(source, 'utf8')
  .split(/\r?\n/)
  .filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    return !match || !managedKeys.has(match[1]);
  });
while (retained.at(-1) === '') retained.pop();
for (const [key, value] of [
  ['OTTO_DATABASE_ENCRYPTION', 'required'],
  ['OTTO_DATABASE_ENCRYPTION_KEY_FILE', keyPath],
  ['OTTO_DATABASE_ENCRYPTION_KEY_ID', 'oneclick-offline-database-key'],
  ['OTTO_DATABASE_ENCRYPTION_KEY_READONLY', 'true'],
  ['OTTO_SQLCIPHER_NATIVE_BINDING', bindingPath],
  ['OTTO_APP_VERSION', appVersion],
  ['OTTO_BUILD_COMMIT', buildCommit],
]) retained.push(`${key}=${JSON.stringify(value)}`);
writeFileSync(target, `${retained.join('\n')}\n`, { mode: 0o600 });
NODE
install -o root -g root -m 0600 "$UPDATED_CONFIG" "$CONFIG_PATH"
ln -s "$TARGET_RELEASE" "${INSTALL_ROOT}/current.next"
mv -Tf "${INSTALL_ROOT}/current.next" "${INSTALL_ROOT}/current"
install -o root -g root -m 0644 "${SCRIPT_DIR}/templates/otto-enterprise.service" "$SERVICE_UNIT"
rm -rf "${INSTALL_ROOT}/deploy.next"
mkdir -p "${INSTALL_ROOT}/deploy.next"
cp -a "${SCRIPT_DIR}/tools" "${INSTALL_ROOT}/deploy.next/"
cp -a "${SCRIPT_DIR}/lib" "${INSTALL_ROOT}/deploy.next/"
cp -a "${SCRIPT_DIR}/verify.sh" "${INSTALL_ROOT}/deploy.next/verify.sh"
cp -a "${SCRIPT_DIR}/backup-now.sh" "${INSTALL_ROOT}/deploy.next/backup-now.sh"
cp -a "${SCRIPT_DIR}/restore-backup.sh" "${INSTALL_ROOT}/deploy.next/restore-backup.sh"
chmod 755 \
  "${INSTALL_ROOT}/deploy.next/verify.sh" \
  "${INSTALL_ROOT}/deploy.next/backup-now.sh" \
  "${INSTALL_ROOT}/deploy.next/restore-backup.sh"
rm -rf "${INSTALL_ROOT}/deploy"
mv "${INSTALL_ROOT}/deploy.next" "${INSTALL_ROOT}/deploy"
sync_live_deployment_filesystems \
  || otto_die "无法在启动新服务前持久化升级切换" 5
systemctl daemon-reload
systemctl start otto-enterprise
OTTO_ALLOW_SMS_DISABLED="$OTTO_ALLOW_SMS_DISABLED" "${INSTALL_ROOT}/deploy/verify.sh"
sync_live_deployment_filesystems \
  || otto_die "无法在验收后持久化升级状态" 5
ROLLBACK_NEEDED=0
SERVICE_STOPPED=0
UPGRADE_SUCCEEDED=1
otto_log "升级完成：v${RELEASE_VERSION} ${BUILD_ID}"
