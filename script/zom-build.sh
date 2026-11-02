#!/usr/bin/env bash
# 本地构建 zom 二进制并原子安装到 ~/.local/bin/opencode-zom。
#
# 唯一必须钉死的事实：OPENCODE_CHANNEL=zom。数据面库名由 channel 派生
# （packages/cli/src/database-path.ts:5-14），不钉时 channel 回落到 git 分支名，
# 每种构建来源各建一个库，会话历史被切碎。同一条规则写在
# .github/workflows/zom-release.yml 的 build 步骤上。
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

OPENCODE_CHANNEL=zom bun run --cwd packages/cli build --single --skip-web-ui --skip-install

cp "$built" "$staged"
codesign --verify --strict "$staged"
mv -f "$staged" "$dest"

version="$("$dest" --version)"
case "$version" in
  *-zom-*) ;;
  *)
    echo "channel 不是 zom，装上去会读到别的会话库：$version" >&2
    exit 1
    ;;
esac

echo "$dest: $version"
echo "sessions: ~/.local/share/opencode/opencode-zom.db"
