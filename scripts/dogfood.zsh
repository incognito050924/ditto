# ditto dogfood (zsh) — 터미널에서 `claude` 를 칠 때, 현재 위치가 ditto 플러그인
# repo(또는 그 하위 디렉토리)면 개발 중인 플러그인을 자동 로드한다.
#   - --plugin-dir 로 repo 를 직접 참조 → 캐시 없이 코드 즉시반영(dogfood)
#   - ditto repo 밖에서는 평범한 claude 그대로 (배포 설치본에는 영향 없음)
#
# 적용: ~/.zshrc 에 아래 한 줄을 추가(클론 경로에 맞게):
#   [ -f /path/to/ditto/scripts/dogfood.zsh ] && source /path/to/ditto/scripts/dogfood.zsh
claude() {
  local root
  root=$(command git rev-parse --show-toplevel 2>/dev/null)
  if [[ -n "$root" && -f "$root/.claude-plugin/plugin.json" ]] \
     && command grep -q '"name": *"ditto"' "$root/.claude-plugin/plugin.json" 2>/dev/null; then
    command claude --plugin-dir "$root" "$@"
  else
    command claude "$@"
  fi
}
