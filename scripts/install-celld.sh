#!/usr/bin/env bash
set -euo pipefail

# Reviewed releases: https://github.com/denoland/celld/releases/tag/v0.6.2
# and https://github.com/evanw/esbuild/releases/tag/v0.28.2.
# Follow https://celld.dev/install.sh's versioned release layout, with pinned
# GitHub asset digests instead of executing a mutable remote installer.
# esbuild's official standalone install: https://esbuild.github.io/getting-started/#download-a-build
celld_version=0.6.2
esbuild_version=0.28.2

as_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo -n -- "$@"
  fi
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    celld_target=x86_64-unknown-linux-gnu
    celld_checksum=ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c
    esbuild_target=linux-x64
    esbuild_checksum=e314d9af5154992a105b85c85a68addedcd0ad44d933e3773f45d5f3144e298179d177c8ef178ef74fb56d9bcdc3122e7d0f610d0551247e588603d517c03f1d
    ;;
  Linux-aarch64 | Linux-arm64)
    celld_target=aarch64-unknown-linux-gnu
    celld_checksum=4eca87c6797590000a344c1b768364e9696e8817f5fbc16193f459d2edac7cd0
    esbuild_target=linux-arm64
    esbuild_checksum=a56e000b43f78adf1cedda3d315338a79d45cc7cdd33f4d9adeaeeae045c1c9d964dad55435088ab5f319dc7e9049c38a23922659aca5b6c8805604ff768fa52
    ;;
  *)
    echo 'celld setup requires Linux x86_64 or arm64.' >&2
    exit 1
    ;;
esac

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT
celld_release="/usr/local/lib/celld/releases/v$celld_version"

if [[ -x "$celld_release/celld" ]] &&
  [[ "$("$celld_release/celld" --version)" == "celld $celld_version" ]]; then
  echo "celld $celld_version already installed."
else
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    "https://github.com/denoland/celld/releases/download/v$celld_version/celld-$celld_target.gz" \
    --output "$temp_dir/celld.gz"
  echo "$celld_checksum  $temp_dir/celld.gz" | sha256sum --check
  gzip -dc "$temp_dir/celld.gz" >"$temp_dir/celld"
  chmod 0755 "$temp_dir/celld"
  [[ "$("$temp_dir/celld" --version)" == "celld $celld_version" ]]
  as_root install -d "$celld_release" /usr/local/bin
  as_root install -m 0755 "$temp_dir/celld" "$celld_release/celld"
fi
# /usr/local/bin is already available to orb login shells and supervised services.
as_root ln -sfn "$celld_release/celld" /usr/local/bin/celld

if [[ -x /usr/local/bin/esbuild ]] &&
  [[ "$(/usr/local/bin/esbuild --version)" == "$esbuild_version" ]]; then
  echo "esbuild $esbuild_version already installed."
else
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    "https://registry.npmjs.org/@esbuild/$esbuild_target/-/$esbuild_target-$esbuild_version.tgz" \
    --output "$temp_dir/esbuild.tgz"
  # SHA-512 from the pinned npm package's dist.integrity (converted to hex).
  echo "$esbuild_checksum  $temp_dir/esbuild.tgz" | sha512sum --check
  tar -xzf "$temp_dir/esbuild.tgz" -C "$temp_dir" package/bin/esbuild
  [[ "$("$temp_dir/package/bin/esbuild" --version)" == "$esbuild_version" ]]
  as_root install -m 0755 "$temp_dir/package/bin/esbuild" /usr/local/bin/esbuild
fi

[[ "$(/usr/local/bin/celld --version)" == "celld $celld_version" ]]
[[ "$(/usr/local/bin/esbuild --version)" == "$esbuild_version" ]]
/usr/local/bin/celld --help >/dev/null
echo "Installed celld $celld_version and esbuild $esbuild_version in /usr/local/bin."
