#!/bin/sh
# Install the pinned upstream GitHub CLI; distro packages may query retired APIs.
set -eu
version=2.105.0
case "$(dpkg --print-architecture)" in
  amd64) arch=amd64; checksum=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f ;;
  arm64) arch=arm64; checksum=b1278c75107423d818f1937fd92cafc9e5e9b606631568f68d7fb816f5885a02 ;;
  *) echo 'Unsupported GitHub CLI architecture' >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
archive="gh_${version}_linux_${arch}.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/cli/cli/releases/download/v${version}/${archive}" -o "$tmp/$archive"
printf '%s  %s\n' "$checksum" "$tmp/$archive" | sha256sum -c -
tar -xzf "$tmp/$archive" -C "$tmp"
install -m 0755 "$tmp/gh_${version}_linux_${arch}/bin/gh" /usr/local/bin/gh.new
mv -f /usr/local/bin/gh.new /usr/local/bin/gh
gh --version
gh pr checks --help | grep -q -- '--json'
