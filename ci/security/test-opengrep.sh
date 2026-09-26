#!/bin/sh
set -eu
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
mkdir -p "$temporary/src/projections"
cp ci/security/fixtures/rules.ts.txt "$temporary/src/projections/rules.ts"
cp ci/security/opengrep.yml "$temporary/src/projections/rules.yml"
opengrep scan --test "$temporary/src/projections"
