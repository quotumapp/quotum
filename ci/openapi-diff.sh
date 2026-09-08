#!/bin/sh
# Compare committed contracts at the exact merge-request or pull-request base (or the preceding
# main commit). Works on GitLab CI variables or with OPENAPI_DIFF_BASE_SHA set explicitly; set
# OASDIFF to override the oasdiff command (for example a `docker run` invocation).
set -eu
mkdir -p contract-reports
base=${OPENAPI_DIFF_BASE_SHA:-${CI_MERGE_REQUEST_DIFF_BASE_SHA:-${CI_COMMIT_BEFORE_SHA:-}}}
oasdiff=${OASDIFF:-oasdiff}
if [ -z "$base" ] || [ "$base" = 0000000000000000000000000000000000000000 ]; then
  printf '%s\n' 'No preceding revision: initial contract baseline.' > contract-reports/breaking.txt
  exit 0
fi
git cat-file -e "$base^{commit}" 2>/dev/null || git fetch origin "$base"
if ! git cat-file -e "$base:contracts/v1/openapi.json" 2>/dev/null; then
  printf '%s\n' 'Base revision predates the OpenAPI contract: establishing initial baseline.' > contract-reports/breaking.txt
  exit 0
fi
git show "$base:contracts/v1/openapi.json" > contract-reports/base.json
$oasdiff breaking contract-reports/base.json contracts/v1/openapi.json --format text > contract-reports/breaking.txt
cat contract-reports/breaking.txt
# Pre-GA: publish the review report; runtime/browser and generation checks remain hard gates.
