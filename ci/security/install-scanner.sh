#!/bin/sh
# Official release assets, pinned independently of mutable release tags.
set -eu

scanner=${1:?Usage: install-scanner.sh opengrep|trivy [destination]}
destination=${2:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/quotum-scanners}
platform="$(uname -s)-$(uname -m)"
case "$scanner:$platform" in
  opengrep:Linux-x86_64)
    asset=opengrep_manylinux_x86
    checksum=35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c ;;
  opengrep:Darwin-arm64)
    asset=opengrep_osx_arm64
    checksum=0f5bc3dec09d995c61331a4017b856ede508f90d95b018d95f1dc6166be89fdd ;;
  trivy:Linux-x86_64)
    asset=trivy_0.74.0_Linux-64bit.tar.gz
    checksum=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a ;;
  trivy:Darwin-arm64)
    asset=trivy_0.74.0_macOS-ARM64.tar.gz
    checksum=1caada5e0e2091909357c7525d3aa76f4b660b13821bc143b190c7483e31cc11 ;;
  *) echo "Unsupported scanner/platform: $scanner:$platform" >&2; exit 2 ;;
esac
case "$scanner" in
  opengrep) repository=opengrep/opengrep; version=v1.30.0 ;;
  trivy) repository=aquasecurity/trivy; version=v0.74.0 ;;
esac

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/$repository/releases/download/$version/$asset" -o "$temporary/$asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$temporary/$asset" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$checksum" ]; then
  echo "Checksum mismatch for $scanner $version" >&2
  exit 1
fi
mkdir -p "$destination"
if [ "$scanner" = trivy ]; then
  tar -xzf "$temporary/$asset" -C "$temporary" trivy
  install -m 755 "$temporary/trivy" "$destination/trivy"
else
  install -m 755 "$temporary/$asset" "$destination/opengrep"
fi
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$destination" >> "$GITHUB_PATH"
fi
echo "Installed $scanner $version in $destination"
