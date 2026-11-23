#!/usr/bin/env bash
# 本地构建 zom 二进制并原子安装到 ~/.local/bin/opencode-zom。
#
# 必须钉死的常量：OPENCODE_CHANNEL=zom。它决定版本字符串和后台 service 的注册
# 文件（~/.local/state/opencode/service-zom.json），不钉时 channel 回落到 git 分支名，
# 每次换分支就换一个 service、换一份客户端状态。会话库不受它影响：
# packages/cli/src/database-path.ts 把库名钉死成 opencode.db。
# 同一条规则写在 .github/workflows/zom-release.yml 的 build 步骤上。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
esac
built="packages/cli/dist/cli-$os-$arch/bin/opencode"
dest="${ZOM_BIN:-$HOME/.local/bin/opencode-zom}"
staged="$(dirname "$dest")/.$(basename "$dest").new"

# 版本号必须由 zom tag 派生，不能让上游的 previewBuildNumber 用 CI run number /
# 构建时间填充——那会让同一份 commit 在每台机器上报出不同版本，失去核对能力。
# ZOM_VERSION 供开发中的非 tag 构建显式指定；正常发版不要设它。
if [ -n "${ZOM_VERSION:-}" ]; then
  zom_version="$ZOM_VERSION"
else
  tag="$(git describe --tags --exact-match --match 'zom-v*' HEAD 2>/dev/null || true)"
  if [ -z "$tag" ]; then
    echo "HEAD 不在任何 zom-v* tag 上，无法确定版本号；请 git fetch --tags 后 checkout 到 tag，或显式设 ZOM_VERSION" >&2
    exit 1
  fi
  zom_version="$(bash script/zom-version.sh "$tag")"
fi

OPENCODE_CHANNEL=zom OPENCODE_VERSION="$zom_version" \
  bun run --cwd packages/cli build --single --skip-web-ui --skip-install

cp "$built" "$staged"
codesign --verify --strict "$staged"
mv -f "$staged" "$dest"

version="$("$dest" --version)"
case "$version" in
  *-zom-*|*-zom.*) ;;
  *)
    echo "channel 不是 zom，装上去会注册成另一个 service：$version" >&2
    exit 1
    ;;
esac

echo "$dest: $version"
echo "sessions: ~/.local/share/opencode/opencode.db"
