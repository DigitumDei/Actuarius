#!/bin/sh
# Install the pinned upstream GitHub CLI; distro packages may query retired APIs.
set -eu
version=2.101.0
case "$(dpkg --print-architecture)" in
  amd64) arch=amd64; checksum=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8 ;;
  arm64) arch=arm64; checksum=b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f ;;
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
