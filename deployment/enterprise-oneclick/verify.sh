#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH="${OTTO_CONFIG_PATH:-/etc/otto-enterprise/enterprise.env}"
[ -f "$CONFIG_PATH" ] && otto_load_config "$CONFIG_PATH"

INSTALL_ROOT="${OTTO_INSTALL_ROOT:-/opt/otto-enterprise}"
CURRENT="${INSTALL_ROOT}/current"
RUNTIME_NODE="${INSTALL_ROOT}/runtime/current/bin/node"
DATA_ROOT="${OTTO_ENTERPRISE_DIR:-${OTTO_DATA_DIR:-/var/lib/otto-enterprise}}"
DATA_DB="${DATA_ROOT}/data.db"
ALLOW_SMS="${OTTO_ALLOW_SMS_DISABLED:-0}"

[ -x "$RUNTIME_NODE" ] || otto_die "找不到固定 Node runtime：${RUNTIME_NODE}" 3
[ -d "$CURRENT" ] || otto_die "找不到 current release：${CURRENT}" 3

RELEASE_JSON="$("$RUNTIME_NODE" "${SCRIPT_DIR}/tools/verify-release.mjs" "$CURRENT")"
VERSION="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.version)" "$RELEASE_JSON")"
BUILD_ID="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.buildCommit)" "$RELEASE_JSON")"
SCHEMA_TO="$("$RUNTIME_NODE" -e "const x=JSON.parse(process.argv[1]);console.log(x.database.schemaTo)" "$RELEASE_JSON")"

# Inspect encrypted deployments with their own SQLCipher runtime, never with
# the plaintext node:sqlite inspector. This also preserves the installed
# 1.9.14 verifier's encrypted-database path after the deploy tools are replaced.
[ -f "$DATA_DB" ] && [ ! -L "$DATA_DB" ] \
  || otto_die "数据库必须是普通文件且不能是符号链接" 3
otto_require_command od
otto_require_command tr
DATABASE_HEADER="$(od -An -tx1 -N16 "$DATA_DB" | tr -d ' \n')"
if [ "$DATABASE_HEADER" = "53514c69746520666f726d6174203300" ]; then
  "$RUNTIME_NODE" "${SCRIPT_DIR}/tools/db-tool.mjs" inspect "$DATA_DB" >/dev/null
else
  [ "${OTTO_DATABASE_ENCRYPTION:-}" = required ] \
    && [ "${OTTO_DATABASE_ENCRYPTION_KEY_READONLY:-}" = true ] \
    || otto_die "加密数据库验收必须启用 required SQLCipher 与只读密钥" 3
  for configured_file in "${OTTO_DATABASE_ENCRYPTION_KEY_FILE:-}" \
    "${OTTO_SQLCIPHER_NATIVE_BINDING:-}"; do
    [[ "$configured_file" = /* ]] && [ -f "$configured_file" ] \
      && [ ! -L "$configured_file" ] \
      || otto_die "加密数据库验收缺少安全的绝对路径密钥或原生 binding" 3
  done
  "$RUNTIME_NODE" "${SCRIPT_DIR}/tools/migrate-check.mjs" \
    "$CURRENT" "$DATA_ROOT" >/dev/null
fi
"$RUNTIME_NODE" "${SCRIPT_DIR}/tools/health-check.mjs" \
  http://127.0.0.1:7778 "$VERSION" "$BUILD_ID" \
  "$SCHEMA_TO" \
  "$([ "$ALLOW_SMS" = "1" ] && printf 'allow-sms-disabled' || printf 'require-sms')"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet otto-enterprise \
    || otto_die "systemd 服务未处于 active" 5
fi

otto_log "本机验收通过：release、数据库、health、systemd 均正常"
