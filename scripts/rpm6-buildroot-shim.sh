#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  rpmbuild 兼容层：rpm 6 + electron-builder 自带的 fpm 1.9.3
# ---------------------------------------------------------------------------
#  症状：
#    ⨯ cannot execute  cause=exit status 1
#    error: File not found: .../BUILD/<name>-<version>-build/BUILDROOT/opt/...
#
#  原因（两处 rpm 6 的行为变化）：
#    1. buildroot 不再认 `--define buildroot X`，固定算成
#         %{_topdir}/BUILD/<name>-<version>-build/BUILDROOT
#    2. %mkbuilddir 会在 %install 之前把这个目录清空
#   而 fpm 1.9.3（2018 年，electron-builder 25 内置）的做法是：自己把文件平铺到
#   buildroot 里、spec 的 %install 留空。两步叠加，%files 里每个路径都 File not found。
#
#  做法：
#    把 fpm 铺好的文件挪到 buildroot 之外的暂存目录，并在 spec 的 %install 里插入
#    一条 cp，让 rpm 在它清空 buildroot 之后再把文件放回去。
#    暂存目录为空（= 将来 fpm 改对了）时，本脚本什么也不做，直接透传给真 rpmbuild。
# ---------------------------------------------------------------------------

set -uo pipefail

REAL_RPMBUILD=/usr/bin/rpmbuild

spec=""
topdir=""
buildroot=""
args=("$@")

for ((i = 0; i < ${#args[@]}; i++)); do
  a="${args[i]}"
  case "$a" in
    *.spec) spec="$a" ;;
  esac
  if [ "$a" = "--define" ] && [ $((i + 1)) -lt ${#args[@]} ]; then
    case "${args[i + 1]}" in
      _topdir\ *) topdir="${args[i + 1]#_topdir }" ;;
      buildroot\ *) buildroot="${args[i + 1]#buildroot }" ;;
    esac
  fi
done

[ -n "$buildroot" ] || buildroot="${topdir%/}/BUILD"

# 只处理「fpm 提前铺好文件」这一种情况
if [ -n "$spec" ] && [ -f "$spec" ] && [ -d "$buildroot" ]; then
  shopt -s dotglob nullglob
  staged=("$buildroot"/*)
  if [ ${#staged[@]} -gt 0 ]; then
    stage="$topdir/.fpm-stage"
    rm -rf "$stage"
    mkdir -p "$stage"
    for entry in "${staged[@]}"; do
      mv -f "$entry" "$stage"/
    done

    patched="$topdir/SPECS/.fpm-patched.spec"
    awk -v stage="$stage" '
      { print }
      !patched && /^%install[ \t]*$/ {
        printf "cp -a \047%s/.\047 %%{buildroot}/\n", stage
        patched = 1
      }
    ' "$spec" > "$patched"

    if grep -q "^cp -a " "$patched"; then
      newargs=()
      for a in "${args[@]}"; do
        if [ "$a" = "$spec" ]; then newargs+=("$patched"); else newargs+=("$a"); fi
      done
      exec "$REAL_RPMBUILD" "${newargs[@]}"
    fi
    # spec 里没有独立的 %install 行：把文件放回去，交给真 rpmbuild，至少不丢东西
    cp -a "$stage/." "$buildroot"/
  fi
fi

exec "$REAL_RPMBUILD" "$@"
