#!/bin/bash
# Source only after the caller has pinned the gateway, SSH host, principal,
# signing key and source. No credentials are read or changed by this helper.
otto_upload_file() {
  local kind="$1" transaction="$2" role="$3" file="$4"
  local size digest state status offset prefix complete expected actual attempt
  local tag kind_field transaction_field role_field size_field sha_field extra
  [[ "$transaction" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+$ ]] || return 2
  case "$kind:$role" in
    mirror:mac-arm64-installer|mirror:mac-arm64-blockmap|mirror:mac-x64-installer|mirror:mac-x64-blockmap|mirror:windows-x64-installer|mirror:windows-x64-blockmap|mirror:latest-manifest|mirror:payload-checksums|mirror:payload-signature) ;;
    enterprise:archive-*|enterprise:checksum-*|enterprise:signature-*)
      [[ "${role#*-}" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] || return 2 ;;
    *) return 2 ;;
  esac
  [ -f "$file" ] && [ ! -L "$file" ] || return 2
  # POSIX wc accepts both GNU/Linux and BSD/macOS clients. Redirecting the
  # input avoids option/path interpretation; normalize wc's leading padding.
  size="$(wc -c < "$file" | tr -d '[:space:]')" || return 2
  digest="$(sha256sum -- "$file" | awk '{print $1}')" || return 2
  [[ "$size" =~ ^[1-9][0-9]{0,9}$ && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 2
  expected="uploaded kind=${kind} transaction=${transaction} role=${role} size=${size} sha256=${digest}"
  for attempt in 1 2 3; do
    if state="$(ssh "${SSH_OPTIONS[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" -- \
      /usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy \
      upload-status "$kind" "$transaction" "$role" "$size" "$digest")"; then
      :
    else
      status="$?"
      # A gateway rejection is not a transient SSH disconnect.
      [ "$status" -eq 255 ] || return "$status"
      printf 'upload_retry kind=%s transaction=%s role=%s attempt=%s status=%s\n' \
        "$kind" "$transaction" "$role" "$attempt" "$status" >&2
      sleep "$((attempt * 2))"
      continue
    fi
    IFS=' ' read -r tag kind_field transaction_field role_field size_field sha_field offset prefix complete extra <<< "$state"
    offset="${offset#offset=}"
    complete="${complete#complete=}"
    [[ "$offset" =~ ^(0|[1-9][0-9]{0,9})$ ]] && [ "$offset" -le "$size" ] || return 2
    [ "$complete" = true ] || [ "$complete" = false ] || return 2
    # Recheck the complete local identity after status: a changed local file
    # must not be mistaken for an approved resume or a lost-receipt success.
    [ "$(wc -c < "$file" | tr -d '[:space:]')" = "$size" ] \
      && [ "$(sha256sum -- "$file" | awk '{print $1}')" = "$digest" ] || return 2
    prefix="$(head -c "$offset" -- "$file" | sha256sum | awk '{print $1}')" || return 2
    [ "$state" = "upload_state kind=${kind} transaction=${transaction} role=${role} size=${size} sha256=${digest} offset=${offset} prefix_sha256=${prefix} complete=${complete}" ] || {
      printf 'upload state does not match the locked local prefix\n' >&2
      return 2
    }
    if [ "$complete" = true ]; then
      [ "$offset" = "$size" ] && [ "$prefix" = "$digest" ] || return 2
      printf 'upload_complete kind=%s transaction=%s role=%s size=%s sha256=%s verified_by=status\n' \
        "$kind" "$transaction" "$role" "$size" "$digest" >&2
      return 0
    fi
    printf 'upload_attempt kind=%s transaction=%s role=%s attempt=%s offset=%s size=%s\n' \
      "$kind" "$transaction" "$role" "$attempt" "$offset" "$size" >&2
    if actual="$(tail -c "+$((offset + 1))" -- "$file" | \
      ssh "${SSH_OPTIONS[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" -- \
        /usr/bin/sudo -n -- /usr/local/sbin/otto-enterprise-ci-deploy \
        upload-file "$kind" "$transaction" "$role" "$size" "$digest" "$offset")"; then
      [ "$actual" = "$expected" ] || {
        printf 'upload success receipt does not match the locked identity\n' >&2
        return 2
      }
      printf '%s\n' "$actual" >&2
      return 0
    else
      status="$?"
      # Prefixes are never published; each bounded retry must re-read state and
      # prove its local hash. Validation/auth errors remain terminal.
      [ "$status" -eq 1 ] || [ "$status" -eq 255 ] || return "$status"
      printf 'upload_retry kind=%s transaction=%s role=%s attempt=%s status=%s\n' \
        "$kind" "$transaction" "$role" "$attempt" "$status" >&2
      sleep "$((attempt * 2))"
    fi
  done
  printf 'upload recovery exhausted its three-attempt bound\n' >&2
  return 1
}
