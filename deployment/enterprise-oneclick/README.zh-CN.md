# Otto Enterprise 私有化部署包

本包是 1.9.14 稳定发布所支持的单机企业服务配置，不是 PostgreSQL/Redis/S3 集群部署
包。集群迁移和提升必须按独立运行手册完成能力兼容、数据权威与容灾验收。

这是一套面向 Ubuntu 22.04/24.04 的“上传、填配置、执行一条安装命令”迁移包。它会安装固定并校验过 SHA-256 的 Node.js 22 LTS、最小企业服务、systemd 单元，并可选配置 Caddy HTTPS。

它不会携带任何生产数据库、手机号、短信密钥、管理员密码或平台令牌。旧服务器的数据要用包内 `export-migration.sh` 单独导出。

## 安全边界

- 只支持 `amd64/x86_64` 与 `arm64/aarch64`。
- 默认面向全新服务器。完全相同 build 重跑时只验收、不重启；检测到不同的现有 Otto 安装会拒绝覆盖。
- 这是“当前服务器原样迁入新机器”的过渡发布包。实际可导入版本及目标版本以同一发布包内 `release/manifest.json` 的 `database.schemaFrom`、`database.schemaTo` 为准，安装器会在隔离副本上迁移并拒绝未声明或未来版本。
- `upgrade.sh` 仅在校验现有旧 release 时显式兼容历史 `lstc` 渠道；新包自身仍只能使用 `stable` 或 `transition`，不能借此重新发布旧渠道包。
- 数据导出使用 SQLite Online Backup API，不直接复制正在写入的 `data.db`。
- 导入先在隔离目录迁移，再在 `127.0.0.1:17777` 启动 canary；schema、外键、数据行数和 health 全部通过后才安装。
- 服务只监听 `127.0.0.1:7778`，公网必须经过 HTTPS 反向代理。
- 未完成的本机配对接口在 Caddy 边缘固定返回 404。
- `managed` 模式会验收公网 HTTPS 和三个 404；`external` 模式只验收本机 systemd/health，不能据此宣称公网已完成。
- 不自动修改 DNS、云安全组或 UFW。
- 迁移包是包含账号、手机号、会话和企业密钥的敏感文件，默认权限为 0600；传输完成后请妥善删除。
- 外层 SHA-256 与包内清单用于发现传输损坏；正式包还必须携带 Ed25519 `.sig`，并使用从独立可信渠道取得的 Otto 发布公钥验签，不能信任签名文件自行提供的公钥。
- 正式写入前会创建 `/opt/otto-enterprise/.installing` 事务标记；断电或 `SIGKILL` 后标记会保留，重跑将 fail closed，避免把半安装状态当成新服务器。

### 发布自动化的首次网关安装（必须人工完成一次）

GitHub Actions 不接收、保存或传递服务器 sudo 密码。正式自动部署只允许 CI 的 SSH
账号通过 `sudo -n` 调用固定的 root-owned 网关
`/usr/local/sbin/otto-enterprise-ci-deploy`；网关会先把上传内容复制到 root-only 暂存区，
再用服务器预置的 Ed25519 公钥验签。签名、版本、包身份或文件集合有任意不一致都会
fail closed。

因此，首次启用自动发布前，必须由有 root 权限的管理员通过独立可信通道完成一次
bootstrap。不要让 CI 自行上传并以 root 身份执行安装网关的脚本，也不要把 sudo 密码
配置为 GitHub Secret。管理员应先按本说明验证正式包的 Ed25519 签名和 SHA-256，再把
它解压到 root 管理且 CI 账号不可写的目录；不能直接从 CI 账号的 home、上传目录或其他该账号可写的路径
运行安装器：

首次 bootstrap 不依赖 Otto 包中的 Node.js。下面的 `TRUSTED_PYTHON` 必须指向 Ubuntu
系统包管理器从受信软件源预装的**版本化真实文件**（22.04 通常是
`/usr/bin/python3.10`，24.04 通常是 `/usr/bin/python3.12`），不能使用通常为符号链接的
`/usr/bin/python3`；`TRUSTED_OPENSSL`、Python 标准库和发布公钥也必须在接触上传文件前
由管理员通过系统包校验或独立可信介质确认。它们不能来自待验包、上传目录或 CI 工作区。

```bash
sudo -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root USER=root LOGNAME=root SHELL=/usr/bin/bash /usr/bin/bash -p <<'ROOT_BOOTSTRAP'
set -Eeuo pipefail
umask 077

# 按服务器版本修改这些精确路径和值；三个 SOURCE_* 文件可以来自上传区。
SOURCE_ARCHIVE=/上传区/otto-enterprise-oneclick-v1.9.14-精确包身份.tar.gz
SOURCE_SIGNATURE="${SOURCE_ARCHIVE}.sig"
SOURCE_CHECKSUM="${SOURCE_ARCHIVE}.sha256"
TRUST_ROOT=/root/otto-release-trust
TRUSTED_PUBLIC_KEY="${TRUST_ROOT}/otto-enterprise-release-public.pem"
TRUSTED_PYTHON=/usr/bin/python3.12
TRUSTED_OPENSSL=/usr/bin/openssl
DEPLOY_USER=你的CI部署专用SSH账号
ROLLBACK_USER=你的CI回滚专用SSH账号
DEPLOY_CONFIG=/etc/otto-enterprise/enterprise.env
BOOTSTRAP_DIR=''
MAX_ARCHIVE_BYTES=$((8 * 1024 * 1024 * 1024))
MAX_SIGNATURE_BYTES=$((16 * 1024))
MAX_CHECKSUM_BYTES=256
MAX_UNPACKED_BYTES=$((16 * 1024 * 1024 * 1024))
SPACE_RESERVE_BYTES=$((256 * 1024 * 1024))

fail_bootstrap() {
  printf 'Otto gateway bootstrap: %s\n' "$*" >&2
  exit 2
}

require_root_controlled_path() {
  local trusted_path="$1" expected_type="$2" current="$1"
  [[ "$trusted_path" = /* ]] || fail_bootstrap "trusted path is not absolute: $trusted_path"
  [ "$(readlink -f -- "$trusted_path")" = "$trusted_path" ] \
    || fail_bootstrap "trusted path is not canonical or contains a symlink: $trusted_path"
  while :; do
    [ ! -L "$current" ] || fail_bootstrap "trusted path contains a symlink: $current"
    [ "$(stat -c '%u:%g' -- "$current")" = '0:0' ] \
      || fail_bootstrap "trusted path is not root-owned: $current"
    if find "$current" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
      fail_bootstrap "trusted path is group/other writable: $current"
    fi
    if [ "$current" = "$trusted_path" ]; then
      case "$expected_type" in
        file) [ -f "$current" ] || fail_bootstrap "trusted path is not a regular file: $current" ;;
        directory) [ -d "$current" ] || fail_bootstrap "trusted path is not a directory: $current" ;;
        *) fail_bootstrap "unknown trusted path type" ;;
      esac
    else
      [ -d "$current" ] || fail_bootstrap "trusted ancestor is not a directory: $current"
    fi
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

cleanup_bootstrap() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$BOOTSTRAP_DIR" ]; then
    if [[ "$BOOTSTRAP_DIR" =~ ^/var/tmp/otto-ci-gateway-bootstrap\.[A-Za-z0-9]{8}$ ]] \
      && [ -d "$BOOTSTRAP_DIR" ] && [ ! -L "$BOOTSTRAP_DIR" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$BOOTSTRAP_DIR")" = '0:0:700' ]; then
      rm -rf --one-file-system -- "$BOOTSTRAP_DIR" || status=1
    else
      printf 'Otto gateway bootstrap: refusing unsafe cleanup path: %s\n' \
        "$BOOTSTRAP_DIR" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup_bootstrap EXIT
trap 'exit 130' HUP INT TERM

for trusted_file in "$TRUSTED_PUBLIC_KEY" "$TRUSTED_PYTHON" "$TRUSTED_OPENSSL"; do
  require_root_controlled_path "$trusted_file" file
done
require_root_controlled_path "$TRUST_ROOT" directory
require_root_controlled_path "$DEPLOY_CONFIG" file

ARCHIVE_NAME="$(basename -- "$SOURCE_ARCHIVE")"
[[ "$ARCHIVE_NAME" =~ ^otto-enterprise-oneclick-v[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}-[0-9a-f]{12}\.tar\.gz$ ]] \
  || fail_bootstrap 'unexpected archive name'

BOOTSTRAP_DIR="$(mktemp -d /var/tmp/otto-ci-gateway-bootstrap.XXXXXXXX)"
[[ "$BOOTSTRAP_DIR" =~ ^/var/tmp/otto-ci-gateway-bootstrap\.[A-Za-z0-9]{8}$ ]] \
  && [ "$(stat -c '%u:%g:%a' -- "$BOOTSTRAP_DIR")" = '0:0:700' ] \
  || fail_bootstrap 'unsafe bootstrap directory'
SNAPSHOT_ARCHIVE="$BOOTSTRAP_DIR/$ARCHIVE_NAME"
SNAPSHOT_SIGNATURE="${SNAPSHOT_ARCHIVE}.sig"
SNAPSHOT_CHECKSUM="${SNAPSHOT_ARCHIVE}.sha256"
SIGNATURE_BIN="$BOOTSTRAP_DIR/archive-signature.bin"

# 一个可信 Python 进程同时持有三个上传文件的 fd。容量判断使用这些 fd 的 fstat 大小，
# 复制只读取该精确长度；上传者并发截短、增长、换成 symlink/FIFO 都会 fail closed。
read -r ARCHIVE_BYTES SIGNATURE_BYTES CHECKSUM_BYTES < <(
  "$TRUSTED_PYTHON" -I -S - \
    "$BOOTSTRAP_DIR" "$SPACE_RESERVE_BYTES" \
    "$SOURCE_ARCHIVE" "$SNAPSHOT_ARCHIVE" "$MAX_ARCHIVE_BYTES" \
    "$SOURCE_SIGNATURE" "$SNAPSHOT_SIGNATURE" "$MAX_SIGNATURE_BYTES" \
    "$SOURCE_CHECKSUM" "$SNAPSHOT_CHECKSUM" "$MAX_CHECKSUM_BYTES" <<'PYTHON_COPY'
import os
import stat
import sys

destination_dir = sys.argv[1]
reserve_bytes = int(sys.argv[2])
raw_specs = sys.argv[3:]
if len(raw_specs) != 9 or reserve_bytes != 256 * 1024 * 1024:
    raise ValueError('invalid bounded-copy arguments')
specs = [
    (raw_specs[index], raw_specs[index + 1], int(raw_specs[index + 2]))
    for index in range(0, len(raw_specs), 3)
]
open_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
source_fds = []
try:
    for source_path, target_path, cap in specs:
        descriptor = os.open(source_path, open_flags)
        source_fds.append((descriptor, source_path, target_path, cap))
    opened = []
    for descriptor, source_path, target_path, cap in source_fds:
        source_stat = os.fstat(descriptor)
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError(f'upload is not a regular file: {source_path}')
        if source_stat.st_size <= 0 or source_stat.st_size > cap:
            raise ValueError(f'upload size is outside its cap: {source_path}')
        opened.append((descriptor, source_path, target_path, source_stat.st_size))
    filesystem = os.statvfs(destination_dir)
    available_bytes = filesystem.f_bavail * filesystem.f_frsize
    required_bytes = sum(item[3] for item in opened) + reserve_bytes
    if available_bytes < required_bytes:
        raise ValueError('insufficient space for bounded snapshots plus reserve')

    copied_sizes = []
    for descriptor, source_path, target_path, expected_size in opened:
        target_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
        target_fd = os.open(target_path, target_flags, 0o600)
        try:
            remaining = expected_size
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError(f'upload was truncated while copying: {source_path}')
                view = memoryview(chunk)
                while view:
                    written = os.write(target_fd, view)
                    if written <= 0:
                        raise OSError(f'bounded snapshot write made no progress: {target_path}')
                    view = view[written:]
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                raise ValueError(f'upload grew while copying: {source_path}')
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
        copied_sizes.append(expected_size)
    directory_fd = os.open(destination_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    print(*copied_sizes)
finally:
    for descriptor, *_ in source_fds:
        os.close(descriptor)
PYTHON_COPY
)
[[ "$ARCHIVE_BYTES" =~ ^[0-9]+$ ]] \
  && [[ "$SIGNATURE_BYTES" =~ ^[0-9]+$ ]] \
  && [[ "$CHECKSUM_BYTES" =~ ^[0-9]+$ ]] \
  || fail_bootstrap 'trusted bounded copier returned an invalid result'
for snapshot_spec in \
  "$SNAPSHOT_ARCHIVE:$MAX_ARCHIVE_BYTES" \
  "$SNAPSHOT_SIGNATURE:$MAX_SIGNATURE_BYTES" \
  "$SNAPSHOT_CHECKSUM:$MAX_CHECKSUM_BYTES"; do
  snapshot_file="${snapshot_spec%:*}"
  snapshot_cap="${snapshot_spec##*:}"
  [ -f "$snapshot_file" ] && [ ! -L "$snapshot_file" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$snapshot_file")" = '0:0:600' ] \
    || fail_bootstrap "unsafe root-only snapshot: $snapshot_file"
  snapshot_bytes="$(stat -c '%s' -- "$snapshot_file")"
  [ "$snapshot_bytes" -gt 0 ] && [ "$snapshot_bytes" -le "$snapshot_cap" ] \
    || fail_bootstrap "root-only snapshot exceeds its size cap: $snapshot_file"
done

# 严格拒绝重复/额外 envelope 字段和多行 checksum；checksum 只作与已签名摘要的交叉比对，
# 不执行由 checksum 内容驱动的批量校验命令，也不允许它选择其他文件名。
read -r VERIFIED_DIGEST UNPACKED_BYTES < <(
  "$TRUSTED_PYTHON" -I -S - \
    "$SNAPSHOT_ARCHIVE" "$SNAPSHOT_SIGNATURE" "$SNAPSHOT_CHECKSUM" \
    "$TRUSTED_PUBLIC_KEY" "$TRUSTED_OPENSSL" "$ARCHIVE_NAME" \
    "$SIGNATURE_BIN" "$MAX_UNPACKED_BYTES" <<'PYTHON_VERIFY'
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile

(archive_path, envelope_path, checksum_path, public_key_path, openssl_path,
 expected_name, signature_bin, max_unpacked_text) = sys.argv[1:]

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate envelope field: {key}')
        result[key] = value
    return result

with open(envelope_path, 'r', encoding='utf-8', errors='strict') as stream:
    envelope = json.load(stream, object_pairs_hook=reject_duplicates)
expected_fields = {'algorithm', 'file', 'format', 'keyId', 'sha256', 'signature'}
if not isinstance(envelope, dict) or set(envelope) != expected_fields:
    raise ValueError('signature envelope fields are not exact')
if envelope['format'] != 'otto-enterprise-package-signature-v1':
    raise ValueError('signature envelope format is invalid')
if envelope['algorithm'] != 'Ed25519' or envelope['file'] != expected_name:
    raise ValueError('signature envelope algorithm or filename is invalid')
if not re.fullmatch(r'[0-9a-f]{64}', envelope['sha256']):
    raise ValueError('signature envelope digest is invalid')
if not re.fullmatch(r'[0-9a-f]{16}', envelope['keyId']):
    raise ValueError('signature envelope key id is invalid')
if not re.fullmatch(r'[A-Za-z0-9_-]{86}', envelope['signature']):
    raise ValueError('signature envelope signature encoding is invalid')

digest = hashlib.sha256()
with open(archive_path, 'rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
actual_digest = digest.hexdigest()
if actual_digest != envelope['sha256']:
    raise ValueError('archive digest does not match the signature envelope')

checksum_bytes = pathlib.Path(checksum_path).read_bytes()
checksum_match = re.fullmatch(
    rb'([0-9a-f]{64})  (' + re.escape(expected_name.encode('ascii')) + rb')\n?',
    checksum_bytes,
)
if not checksum_match or checksum_match.group(1).decode('ascii') != actual_digest:
    raise ValueError('checksum must be one exact line bound to the signed archive')

public_der = subprocess.run(
    [openssl_path, 'pkey', '-pubin', '-in', public_key_path, '-outform', 'DER'],
    check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
).stdout
if hashlib.sha256(public_der).hexdigest()[:16] != envelope['keyId']:
    raise ValueError('trusted public key id does not match the signature envelope')
signature = base64.b64decode(envelope['signature'] + '==', altchars=b'-_', validate=True)
if len(signature) != 64:
    raise ValueError('Ed25519 signature length is invalid')
with open(signature_bin, 'xb') as stream:
    os.fchmod(stream.fileno(), 0o600)
    stream.write(signature)
subprocess.run(
    [openssl_path, 'pkeyutl', '-verify', '-pubin', '-inkey', public_key_path,
     '-rawin', '-in', archive_path, '-sigfile', signature_bin],
    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)

unpacked_bytes = 0
with tarfile.open(archive_path, mode='r:gz') as archive:
    for member in archive:
        if member.isreg():
            unpacked_bytes += member.size
            if unpacked_bytes > int(max_unpacked_text):
                raise ValueError('archive exceeds the unpacked-size cap')
print(actual_digest, unpacked_bytes)
PYTHON_VERIFY
)
[[ "$VERIFIED_DIGEST" =~ ^[0-9a-f]{64}$ ]] \
  && [[ "$UNPACKED_BYTES" =~ ^[0-9]+$ ]] \
  || fail_bootstrap 'trusted verifier returned an invalid result'
AVAILABLE_BYTES="$(df -B1 --output=avail "$BOOTSTRAP_DIR" | tail -n 1 | tr -d ' ')"
REQUIRED_BYTES=$((UNPACKED_BYTES + SPACE_RESERVE_BYTES))
[ "$AVAILABLE_BYTES" -ge "$REQUIRED_BYTES" ] \
  || fail_bootstrap 'insufficient bootstrap space to extract with reserve'

EXTRACT_DIR="$BOOTSTRAP_DIR/extracted"
install -d -o root -g root -m 0700 -- "$EXTRACT_DIR"
tar --no-same-owner --no-same-permissions -xzf "$SNAPSHOT_ARCHIVE" -C "$EXTRACT_DIR"
EXPECTED_PACKAGE_DIR="${ARCHIVE_NAME%.tar.gz}"
mapfile -d '' PACKAGE_DIRS < <(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 \
  -type d -name "$EXPECTED_PACKAGE_DIR" -print0)
[ "${#PACKAGE_DIRS[@]}" -eq 1 ] \
  || fail_bootstrap 'expected exactly one extracted package directory'
PACKAGE_DIR="${PACKAGE_DIRS[0]}"
"$PACKAGE_DIR/install-ci-deploy-gateway.sh" \
  --deploy-user "$DEPLOY_USER" \
  --rollback-user "$ROLLBACK_USER" \
  --public-key "$TRUSTED_PUBLIC_KEY" \
  --config "$DEPLOY_CONFIG"
ROOT_BOOTSTRAP
```

随机目录从创建到安装结束始终保持 `root:root:0700`，严格 `EXIT/HUP/INT/TERM` trap 会在
成功或失败后删除它。不要复用旧目录，也不要把它改成 CI 账号可写。上传区中的三个文件
只允许作为 root-only 快照的输入；验签、摘要比对、空间验收、解压和安装都只读取同一份
快照。`--public-key` 必须是绝对、规范、无符号链接的路径，文件及其目录链必须由 root
管理且不能由 CI 账号、组或其他用户写入。

安装器会固定安装网关、两个镜像 helper、服务器信任公钥和最小 sudoers 规则。部署账号与
回滚账号必须是新建的两个不同非 root 专用系统账号，UID 与主 GID 均不得相同，并使用不同的 SSH 私钥；每个账号只能
属于自己的主组，不得属于 `sudo`、`admin`、`wheel` 或任何其他补充组，也不得已有任何其他
sudo/NOPASSWD 规则。生产 workflow 会从两把私钥派生公钥，只比较 SHA-256 fingerprint
并拒绝相同 fingerprint，不会输出私钥或公钥；安装器会审计两个账号的完整有效 sudo 命令集，除
`(root) NOPASSWD: /usr/local/sbin/otto-enterprise-ci-deploy` 外出现任何规则都会失败。部署账号
不能执行镜像回滚，回滚账号只能执行只读预检和带事务能力票据的镜像回滚。安装器只验证
sudo 授权边界，不会在仍持有安装锁时执行 preflight；安装完成后必须分别检查：

```bash
sudo -u 你的CI部署专用SSH账号 \
  sudo -n /usr/local/sbin/otto-enterprise-ci-deploy preflight
sudo -u 你的CI回滚专用SSH账号 \
  sudo -n /usr/local/sbin/otto-enterprise-ci-deploy preflight
```

预检必须输出且只输出一行
`protocol=otto-enterprise-ci-deploy-v5 gateway=<sha256> publish=<sha256> rollback=<sha256> key=<key-id> config=/etc/otto-enterprise/enterprise.env deploy_user=<部署账号> rollback_user=<回滚账号>`，
其中三个 SHA-256 与本次锁定源码完全一致，key id 与本次企业包签名公钥一致，config
必须逐字等于生产固定配置路径。任一字段
不一致都不得触发稳定版发布。每次网关、helper 或信任公钥变化后，服务器管理员都必须
从锁定源码重新执行上述安装流程；普通发布工作流没有修改 root 信任边界的权限。

CI 网关只接受已经存在且通过身份验证的 one-click `current` 升级，不执行自动首装。全新
服务器必须由管理员先按本说明人工审计并运行 `install.sh`；只有旧版本身份、数据库、配置、
systemd 单元和部署工具都已锁入 root-only 事务快照后，工作流才允许切换并在公网验收失败时
调用独立回滚账号恢复旧版本。成功验收后 `finalize-deployment` 才会清除该快照。

## 一、在旧服务器导出

先把本压缩包上传到旧服务器并解压，然后确认实际数据库位置。当前标准安装位置是 `/var/lib/otto-enterprise/data.db`。

只读预检：

```bash
./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-migration.tar.gz \
  --dry-run
```

正式在线快照：

```bash
sudo ./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-migration.tar.gz
```

得到两个文件：

```text
/root/otto-enterprise-migration.tar.gz
/root/otto-enterprise-migration.tar.gz.sha256
```

导出不会停止或修改旧服务。为了最终切换时不丢写入，建议在短维护窗口内先停止旧服务，再做最后一次导出：

```bash
sudo systemctl stop otto-enterprise
sudo ./export-migration.sh \
  --data-dir /var/lib/otto-enterprise \
  --output /root/otto-enterprise-final.tar.gz
```

如果新服务器没有通过验收，立即重新启动旧服务：

```bash
sudo systemctl start otto-enterprise
```

不要把旧 `/etc/otto-enterprise/enterprise.env` 放进迁移压缩包。短信密钥应通过你自己的安全渠道单独复制到新配置。

## 二、准备新服务器

1. 使用 Ubuntu 22.04 或 24.04。
2. 为最终域名添加 A/AAAA 记录，指向新服务器。
3. 云安全组至少开放 TCP `80`、`443`、`7777`。
4. 上传：
   - 本一键部署压缩包；
   - 最终迁移包；
   - 迁移包 `.sha256`。
5. 不要提前关闭旧服务器；保留它作为切回点。

正式包必须同时带有 `.sig`。必须完整执行前文的“随机 root-only 目录 → 三文件快照 →
使用独立 root-controlled 校验器和 Ed25519 公钥重验 → 从同一快照解压”流程。`.sha256`
只负责发现传输损坏，不能替代 Ed25519 发布者签名。若签名、公钥、校验器或 root-only
快照缺少任意一项，不应把该包用于正式服务器。不得从上传账号可写的解压目录运行
`install.sh`、`upgrade.sh` 或任何包内工具。

## 三、填写配置

```bash
CONFIG_SNAPSHOT="$BOOTSTRAP_DIR/enterprise.env"
sudo -- /usr/bin/install -o root -g root -m 0600 -- \
  "$PACKAGE_DIR/config/enterprise.env.example" "$CONFIG_SNAPSHOT"
sudoedit "$CONFIG_SNAPSHOT"
[ "$(sudo -- /usr/bin/stat -c '%u:%g:%a' -- "$CONFIG_SNAPSHOT")" = '0:0:600' ] \
  || { printf 'unsafe config snapshot\n' >&2; exit 1; }
```

必须修改：

- `OTTO_PUBLIC_HOST`：最终企业域名；
- 阿里云短信四项：`ACCESS_KEY_ID`、`ACCESS_KEY_SECRET`、签名和模板；
- 若不用包管理 Caddy，把 `OTTO_CADDY_MODE` 改为 `external`。

园区报修通知为可选配置：

- `ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID`：报修短信通知模板；它与注册验证码的 `ALIYUN_SMS_TEMPLATE_ID` 分开配置；
- `OTTO_ENTERPRISE_FEISHU_APP_ID` 与 `OTTO_ENTERPRISE_FEISHU_APP_SECRET`：必须成对填写，服务端只从 0600 运行配置读取；
- `OTTO_ENTERPRISE_FEISHU_DOMAIN`：`feishu` 使用飞书中国站，`lark` 使用 Lark 国际站，留空默认飞书中国站。

这些可选项留空不会阻止报修记录写入，但对应的外部通知通道不会发送。安装器会把它们写入 `/etc/otto-enterprise/enterprise.env`，不会放进迁移包或日志。

拼车助手地图能力为可选配置：

- `OTTO_AMAP_WEB_SERVICE_KEY`：高德 Web 服务 Key，仅供服务端地点检索和驾车路线规划；不会通过桌面端 IPC 返回给用户；
- `OTTO_PARK_CARPOOL_MINIMUM_OVERLAP`：路线最低重合比例，取值 `0` 至 `1`，默认 `0.35`。

Key 留空时，拼车接口会明确返回“地图服务尚未配置”，客户端保留可诊断入口但禁用发布，不会降级为虚构地点、直线距离或伪造匹配百分比。出发地、目的地和路线按敏感字段加密保存；候选结果只返回概略区域、时间差和可解释重合度。

跨私有服务器联邦为可选配置：

- `OTTO_FEDERATION_ENABLED`：仅在已完成 Control 联邦网关注册和验签配置后设为 `1`；
- `OTTO_FEDERATION_GATEWAY_URL`：Control 联邦网关的 HTTPS 地址；
- `OTTO_FEDERATION_DISPLAY_NAME`：该私有部署在联邦目录中展示的名称；
- `OTTO_FEDERATION_POLL_INTERVAL_MS`：离线消息领取间隔，留空使用服务端安全默认值；
- `OTTO_FEDERATION_SIGNING_KEY_FILE`：部署签名私钥的绝对路径，文件不得是符号链接且只能由服务账号读取。

未启用联邦时应保留 `OTTO_FEDERATION_ENABLED=0`。安装和升级会原样保存上述配置，但不会自动生成签名私钥，也不会绕过 Control 的部署注册与吊销检查。

`OTTO_ENTERPRISE_ADMIN_TOKEN=auto` 会生成不输出到日志的随机平台令牌。迁移库已有管理员账号时不会重建账号；空库会生成一次性管理员密码，安装结束后只写到 `/root/otto-enterprise-bootstrap-*.txt`。

`external` 表示你自行管理 Nginx/Caddy/负载均衡器。安装器不会验证外置证书、公网 health 或 404 屏蔽规则，完成提示也会明确标为“待外置代理验收”。

正式迁移不要把 `OTTO_ALLOW_SMS_DISABLED` 设为 `1`。短信未配置时，邀请码注册必然不可用，安装器会默认阻断。

## 四、一条命令安装

先做不写盘预检：

```bash
sudo -- "$PACKAGE_DIR/install.sh" \
  --config "$CONFIG_SNAPSHOT" \
  --migration /root/otto-enterprise-final.tar.gz \
  --dry-run
```

dry-run 会校验包内每个文件、release manifest、迁移归档、SQLite `quick_check`、外键、schema 和隔离副本数据对账。若机器没有兼容 Node，它可能把固定 Node runtime 下载到私有临时目录并在成功后删除；不会写 `/etc`、`/opt`、`/var/lib`，也不会创建用户或操作服务。若机器同时没有 Node、`curl` 或 CA 证书，dry-run 会给出明确错误，不会自行运行 `apt`。

正式安装：

```bash
sudo -- "$PACKAGE_DIR/install.sh" \
  --config "$CONFIG_SNAPSHOT" \
  --migration /root/otto-enterprise-final.tar.gz
```

安装器会依次完成：

1. 验证 Ubuntu、架构、磁盘、域名、短信配置、`PACKAGE-MANIFEST.sha256` 和迁移包；
2. 下载 Node.js `v22.23.1` 并核对官方 SHA-256；
3. 校验最小 release 文件集合和每个文件的 SHA-256；
4. 校验迁移数据库 `quick_check`、外键和 schema；
5. 按发布清单在隔离副本上迁移到该包声明的目标 schema，并逐表对账；旧 schema 数据库会先保留在线一致性快照，迁移后任一原有表行数减少都会阻断安装；
6. 启动 `127.0.0.1:17777` canary；
7. 安装专用 `otto-enterprise` 用户、只读 release 和 0600 运行配置；
8. 启动 systemd 服务；
9. 可选安装/验证/重载 Caddy；
10. 验证公网 HTTPS、精确版本、短信状态，以及
    `/enterprise/local-agent`、`/enterprise/local-agent/pair`、
    `/enterprise/sdk/otto-discovery.js` 三个路径均返回 404。

## 五、验收

本机验收：

```bash
sudo /opt/otto-enterprise/deploy/verify.sh
sudo systemctl status otto-enterprise --no-pager
sudo journalctl -u otto-enterprise -n 100 --no-pager
```

公网 health：

```bash
curl --fail --show-error \
  https://你的域名:7777/enterprise/health
```

上面的公网验收只适用于 `managed` 模式。`external` 模式必须在外置代理配置完成后手动执行同等 health 与三个 404 检查。

公网响应必须看到：

- `status: ok`
- `service: otto-enterprise`
- `apiVersion: 4`
- `version` 必须与本次发布版本一致
- `appVersion` 必须与本次发布版本一致
- `capabilities` 同时包含 `password_auth`、`sms_registration`、
  `personal_enterprise_upgrade`、`organization_invites`、`usage_summary`、
  `admin_console`、`direct_messages`、`atoa`、`position_invites`、
  `park_service_push`、`park_repair_v1`、`park_carpool_v1`、`data_protection_v1`、
  `encrypted_attachment_storage_v1`、`encrypted_message_storage_v1`、
  `signed_telemetry_transport_v1`、`data_governance_v1`、
  `privacy_self_service`

公网响应不得包含 build、schema、数据库、许可证、短信、备份、存储或运行时私有状态。
schema、数据库就绪、SQLCipher、许可证强制执行和备份状态只能由服务器本地的
`verify.sh` 使用管理员令牌检查；不得把管理员令牌发送到公网跳转目标。认证后的
`/enterprise/deployment/status` 还必须返回
`runtime.version=<本次发布版本>` 和
`runtime.buildCommit=<签名 manifest 中的完整 buildCommit>`，两项都要求精确匹配，不能
用公网 `version` 或包文件名的 12 位前缀代替完整 build identity。

浏览器验收：

1. 打开 `https://你的域名:7777/enterprise/admin`；
2. 用迁移前的管理员账号登录；
3. 核对企业、账号和成员数量；
4. 打开已有邀请落地页，确认不是 404/410；
5. 用修复后的 Otto 客户端完成一次“邀请链接 → 短信注册 → 进入工作区 → 展开企业组织树”；
6. 确认真实账号看到服务端组织，而不是机器上残留的本机树。
7. 用两个测试账号互发一条私聊，再发起一次 A2A 请求；确认接收方明确同意后才执行，且请求方收到结果；
8. 用成员账号提交一次园区报修，确认管理员可见；若配置了短信或飞书通知，再核对对应通道真实收到通知；
9. 用管理员向测试成员推送一次园区服务，确认成员消息中可读。

注意：管理员手动“生成新邀请”会立即废止旧邀请。若只是迁移验收，不要无意点击生成按钮。

## 六、切换与回退

新服务器全部通过后再恢复业务写入。旧服务器建议保持停止但不删除至少 7 天。

若新服务器在恢复写入前失败：

1. 将 DNS 指回旧服务器；
2. `sudo systemctl start otto-enterprise` 启动旧服务；
3. 保留新服务器 `/var/tmp/otto-enterprise-deploy-*` 失败目录供排查。

一旦新服务器已经接收新注册、邀请码或业务写入，不能直接回到旧数据库，否则会丢失这段时间的数据。此时应先重新导出新库，再制定明确的数据恢复方案。

## 七、安装被中断，看到 `.installing`

不要直接删除标记并重跑。先检查：

```bash
sudo cat /opt/otto-enterprise/.installing
sudo systemctl status otto-enterprise --no-pager
sudo readlink -f /opt/otto-enterprise/current
sudo ls -la /opt/otto-enterprise /var/lib/otto-enterprise /etc/otto-enterprise
sudo ls -ld /var/tmp/otto-enterprise-deploy-*
```

若服务已启用，先停止它；保留 `/var/tmp/otto-enterprise-deploy-*` 和数据库副本。确认这是未接收任何业务写入的新服务器后，按事务目录中的失败文件恢复或清理，再移除标记。对状态没有把握时不要覆盖安装，直接把上述输出交给维护者。

## 八、验证边界

构建包内 `BUILD-INFO.json`、`SOURCE-INPUTS.sha256`、`PACKAGE-MANIFEST.sha256` 和 release manifest 记录了源状态与实际交付内容。`sourceTreeDirty=true` 表示包来自尚未提交的工作树；这不改变内容哈希校验，但不能冒充“可由某个 Git commit 单独复现”。

本包在 macOS 上完成了语法、清单、release、SQLite 迁移、未来 schema 拒绝和本地隔离 canary 验证。Ubuntu 22.04/24.04 × amd64/arm64 的 systemd、apt、Caddy 和真实公网证书必须在目标机执行安装器自验，未跑目标机前不能声称该矩阵已经实机通过。

## 九、备份、恢复与容量保护

服务默认每 24 小时创建一份在线一致性快照，保留 30 天且至少保留 3 份。备份包含
SQLite、加密附件对象、账号同步密钥、附件密钥和消息字段密钥，外层再使用 AES-256-GCM 加密；
带管理员令牌的 `/enterprise/deployment/status` 中 `dataProtection` 会显示最近成功时间、
文件 SHA-256、失败原因、磁盘余量和异地副本状态；这些信息不会出现在公网 health。

手动备份：

```bash
sudo /opt/otto-enterprise/deploy/backup-now.sh
```

恢复前会先完成解密认证、SQLite `quick_check`、外键和 schema 校验。恢复后服务不健康时
脚本会自动换回恢复前数据：

```bash
sudo /opt/otto-enterprise/deploy/restore-backup.sh \
  /var/lib/otto-enterprise/backups/otto-enterprise-*.otto-backup
```

`OTTO_BACKUP_ENCRYPTION_KEY` 必须由客户和交付方按合同约定托管；只剩备份文件但
丢失该密钥时无法解密。服务会记录不含密钥材料的 SHA-256 密钥标识。已有备份时若当前
密钥缺失、被替换或无法解密历史归档，新备份会 fail closed，不会生成新密钥掩盖事故。
旧部署首次升级时会流式验证最新历史归档，验证成功后才登记密钥标识。

独立恢复副本通过 `OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE` 指向已挂载的密钥托管
卷或 Secret 文件。该路径必须位于数据目录和所有备份目录之外；挂载缺失时服务拒绝把
密钥落回本机目录。需要异地副本时，将备份卷挂载到
`/var/backups/otto-enterprise`，设置
`OTTO_BACKUP_REPLICA_DIR=/var/backups/otto-enterprise`，并同时配置独立恢复密钥路径。
异地副本只复制加密归档与元数据，不复制明文密钥；写入后会重新计算 SHA-256。副本或
密钥托管失败不会中断 Otto 业务，但会进入健康状态告警，管理员页不会显示为完整成功。

高安全部署可以预先创建三个恰好 32 字节的原始密钥文件，并在配置中填写
`OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE`、`OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE`、
`OTTO_FIELD_ENCRYPTION_KEY_FILE`。文件必须使用绝对路径、不能是符号链接，并且
`otto-enterprise` 服务账号必须可读；恢复时外部密钥与备份不一致会 fail closed，安装器
不会替客户覆盖密钥。私聊正文以及 License 内的租约令牌、遥测令牌均使用字段密钥
AES-256-GCM 加密，服务启动时会先迁移旧明文数据并验证密钥，失败时拒绝对外提供服务。

一键安装还会强制使用 SQLCipher 加密整个 `data.db`。默认由安装器生成独立的 32 字节
密钥并以 `root:otto-enterprise`、`0640` 保存到
`/etc/otto-enterprise/database-sqlcipher.key`；客户已有密钥托管时可在安装前设置
`OTTO_DATABASE_ENCRYPTION_KEY_FILE` 为服务账号可读的绝对路径。升级会先识别明文或
SQLCipher 数据库，创建一致性快照并逐表核对行数，canary 通过后才切换 release；不得删除、
替换或把该密钥提交到 Git、迁移压缩包和日志。

如配置 `OTTO_TELEMETRY_ENDPOINT`，地址必须使用 HTTPS。遥测请求除 Bearer 令牌外还
携带 HMAC-SHA256 签名、时间戳和一次性随机数；接收端只接受 5 分钟窗口内且未重放的
请求，本地遥测保留期由 `OTTO_TELEMETRY_RETENTION_DAYS` 控制。正式交付前必须填写
`OTTO_DATA_CONTROLLER_NAME` 和 `OTTO_PRIVACY_CONTACT`，由部署方法务确认当前完整正文后再把
`OTTO_LEGAL_DOCUMENTS_APPROVED` 设为 `true`，
并确认 `OTTO_DATA_REGION`、`OTTO_DATA_RESIDENCY` 与
`OTTO_CROSS_BORDER_DATA_ENABLED` 符合客户实际数据流。只有数据目录所在磁盘已经启用
LUKS、云盘加密卷或等价保护后，才能把 `OTTO_STORAGE_VOLUME_ENCRYPTED` 设为 `true`；
否则管理页会持续显示未达到数据治理就绪状态。

聊天附件不再以大 BLOB 写进 SQLite，而是以 AES-256-GCM 加密对象写入
`/var/lib/otto-enterprise/attachments`。大客户可把该目录映射到持久卷、MinIO/S3 网关
或客户对象存储；数据库只保存受控对象键，不保存任意文件路径。

建议每季度在隔离服务器执行一次真实恢复演练，并记录恢复点目标（默认 24 小时）和
恢复时间目标。磁盘可用空间低于 `OTTO_DISK_MIN_FREE_MB` 时 health 会告警，空间不足以
容纳校验副本时新备份会拒绝执行，但现有业务数据不会被自动删除。

License 验签支持多把 Ed25519 公钥并行。`OTTO_LICENSE_PUBLIC_KEYS` 可以填写 PEM 数组，
也可以填写 Otto Control `GET /v1/signing-keyring` 返回的完整 JSON；客户端会接受
`active`、`standby` 和 `retired` 公钥，因此密钥轮换后历史 License 仍可验证，并自动排除
`revoked` 公钥。紧急处置还可通过 `OTTO_LICENSE_REVOKED_KEY_IDS` 填写 JSON 数组或
逗号分隔的 16 位 key ID。更新这两个配置前必须先用已信任公钥验证控制面密钥环签名，
不能把 HTTPS 下载结果直接当作新的信任根。在线 License 还会在下一次短租约刷新时由
控制面检查签名密钥状态；离线 License 无法实时接收吊销，必须使用较短有效期并由交付
流程同步吊销清单。

### 签名执行收据与积分结算

在线商业部署不再向旧的 `/v1/billing/usage/consume` 发送无签名用量。Otto Server 会为
每个部署生成独立 Ed25519 执行收据密钥，私钥使用字段加密密钥进行 AES-256-GCM 加密，
只保存在客户服务器；Control 只登记公钥。管理员可从
`/enterprise/deployment/status` 的 `billing.executionReceipt.key` 读取 key ID 和公钥，
再由两名具备 `billing.manage` 权限的 Control 管理员完成登记审批。

每条收费任务会先写入 `billing_usage_outbox`，再按部署连续序号上传到
`/v1/billing/execution-receipts`。第一条失败时后续收据不会越过它；服务重启或网络恢复后
仍按原顺序补传，相同任务和相同收据不会重复扣费。收据只包含部署、组织、模块、模型、
计量单位和不透明任务 ID，不包含提示词、回复、聊天、文件名、会议内容或个人身份信息。
升级时尚未发送的旧用量会在本地转换为 v2 收据，已经结算的历史记录不会重复转换。

收据有效期最长七天。持续离线超过七天会让队首收据进入需人工对账状态，不能通过跳号
绕过；正式交付应对 `billing.failed` 和 `billing.lastError` 配置告警。字段加密密钥必须与
数据库一起备份，丢失该密钥将无法继续使用原收据签名身份。

## 十、常见问题

### Caddy 证书申请失败

检查：

```bash
getent ahosts 你的域名
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

确认 DNS 已指向新服务器，且云安全组开放 80、443、7777。安装器不会替你修改这些外部资源。

### 邀请码能打开，但收不到验证码

检查 `/etc/otto-enterprise/enterprise.env` 中短信四项，再在服务器本地运行
`sudo /opt/otto-enterprise/deploy/verify.sh`。公网 health 不暴露短信配置。不要用
`OTTO_ALLOW_SMS_DISABLED=1` 绕过正式迁移验收。

### 客户端仍没有组织树

旧 v1.8.6 客户端把“免登录 UI”错误地同时当成了“禁用企业网络”，并且组织树只看本机 ProductWorkspace。必须使用 v1.8.7 或更新客户端：交付版默认恢复真实登录；邀请 intent 会进入注册并显示目标企业服务器；真实企业账号始终读取 `/enterprise/organization/view`，即使本机 ProductWorkspace 尚未连接也能加载组织树。

### 想把本包覆盖到已有不同版本

不要修改安装脚本绕过检查。这个包是“新服务器迁入包”，不同版本升级需要单独的备份、canary、兼容矩阵和回滚计划。
