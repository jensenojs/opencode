#!/usr/bin/env bash
# 把 zom release tag 派生为语义版本号（唯一权威是 tag，不是 CI run number / 构建时间）。
#
#   zom-v2.4.0      -> 2.4.0-zom.1   （首次发版无修订号后缀）
#   zom-v2.4.0.3    -> 2.4.0-zom.3
#
# 输入也可直接给上游 tag（v2.4.0），等价于修订号 1。
# 格式非法时直接失败——宁可发布中断，也不要落一个漂移的版本号。
set -euo pipefail

tag="${1:-}"
raw="${tag#zom-v}"
raw="${raw#v}"

if [[ "$raw" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
  up="${BASH_REMATCH[1]}"
  rev="${BASH_REMATCH[2]}"
elif [[ "$raw" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # 首次发版无后缀（zom-v2.4.0）映射为 .0，避免与 zom-v2.4.0.1 派生出同一个版本号
  up="$raw"
  rev=0
else
  echo "zom-version: 无法从 '$tag' 派生语义版本（期望 zom-vX.Y.Z[.N]）" >&2
  exit 1
fi

echo "$up-zom.$rev"
