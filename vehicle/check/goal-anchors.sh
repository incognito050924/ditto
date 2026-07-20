#!/bin/sh
# ac-4 oracle — 정적 체크: goal 프롬프트에 세 앵커가 각각 존재하는가.
# 순수 환경(무-ditto)에서 도는 POSIX 셸 grep. 외부 도구·ditto 의존 없음.
# 앵커는 산문 편집에 견디도록 안정 토큰 [ANCHOR:*]으로 박아둔다.
set -eu

GOAL="$(dirname "$0")/../goal.md"

fail=0
check() {
  # $1 = anchor token, $2 = human label
  if grep -qF "$1" "$GOAL"; then
    echo "PASS  $2  ($1)"
  else
    echo "FAIL  $2  ($1) — 앵커 없음"
    fail=1
  fi
}

check "[ANCHOR:dispatcher-delegation]" "디스패처-위임 규율"
check "[ANCHOR:frozen-goal]"           "목표 봉인 (frozen goal/AC)"
check "[ANCHOR:bounded-escape]"        "유계+escape"

if [ "$fail" -ne 0 ]; then
  echo "ac-4 FAIL: 앵커 누락"
  exit 1
fi
echo "ac-4 PASS: 세 앵커 모두 존재"
