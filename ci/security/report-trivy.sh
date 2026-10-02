#!/bin/sh
# Render the completed scan even when findings failed its workflow step.
set -eu

report=${1:?Usage: report-trivy.sh report.json scanners}
scanners=${2:?Usage: report-trivy.sh report.json scanners}
table=${report%.json}.txt

# Reporting must not reapply the findings gate; the original scan owns its exit code.
trivy convert --format table --scanners "$scanners" --exit-code 0 \
  --output "$table" "$report"
cat "$table"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### Trivy findings\n\n```text\n'
    cat "$table"
    printf '\n```\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi
