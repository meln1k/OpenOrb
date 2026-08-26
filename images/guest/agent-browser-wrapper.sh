#!/usr/bin/env bash

set -euo pipefail

readonly native_agent_browser=/usr/local/libexec/agent-browser
readonly chromium_version="@CHROMIUM_VERSION@"
readonly browser_lock="${TMPDIR:-/tmp}/openorb-agent-browser-install.lock"
export AGENT_BROWSER_SKILLS_DIR="${AGENT_BROWSER_SKILLS_DIR:-/usr/local/share/agent-browser/skills}"
if [[ -f /etc/gondolin/mitm/ca.crt ]]; then
  export AGENT_BROWSER_CA_CERT="${AGENT_BROWSER_CA_CERT:-/etc/gondolin/mitm/ca.crt}"
fi

browser_is_available() {
  if [[ -n "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ]]; then
    return 0
  fi

  if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 ||
    command -v google-chrome >/dev/null 2>&1; then
    return 0
  fi

  local browser_cache="${HOME:-/root}/.agent-browser/browsers"
  [[ -n "$(find "$browser_cache" -type f -name chrome -perm /111 -print -quit 2>/dev/null)" ]]
}

clean_apt_cache() {
  apt-get clean
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
}

provision_chrome() (
  local metadata_url='https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
  local browser_root="${HOME:-/root}/.agent-browser/browsers"
  local download_dir staging version download_url destination

  download_dir=$(mktemp -d "${TMPDIR:-/tmp}/openorb-agent-browser.XXXXXX")
  mkdir -p "$browser_root"
  staging=$(mktemp -d "${browser_root}/.installing.XXXXXX")
  cleanup_chrome_install() {
    rm -rf "$download_dir" "$staging"
  }
  trap cleanup_chrome_install EXIT

  curl --fail --location --show-error --silent \
    --connect-timeout 30 --max-time 60 \
    "$metadata_url" --output "$download_dir/versions.json"
  version=$(jq -er '.channels.Stable.version | select(type == "string")' \
    "$download_dir/versions.json")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
  download_url=$(jq -er \
    '.channels.Stable.downloads.chrome[] | select(.platform == "linux64") | .url' \
    "$download_dir/versions.json")
  [[ $download_url == \
    "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip" ]]
  destination="${browser_root}/chrome-${version}"

  if [[ -x "${destination}/chrome" ]]; then
    return
  fi

  printf 'Installing Chrome for Testing %s...\n' "$version" >&2
  curl --fail --location --show-error --silent \
    --connect-timeout 30 --max-time 300 --retry 3 --retry-all-errors \
    "$download_url" --output "$download_dir/chrome.zip"
  unzip -q "$download_dir/chrome.zip" -d "$staging"
  test -x "$staging/chrome-linux64/chrome"
  rm -rf "$destination"
  mv "$staging/chrome-linux64" "$destination"
  printf 'Chrome for Testing installed at %s.\n' "$destination" >&2
)

provision_browser() {
  if browser_is_available; then
    return
  fi

  case "$(uname -m)" in
    x86_64 | amd64)
      provision_chrome
      ;;
    aarch64 | arm64)
      if [[ $EUID -ne 0 ]]; then
        printf '%s\n' \
          'agent-browser needs root privileges to install Chromium on ARM64.' \
          >&2
        return 1
      fi
      (
        trap clean_apt_cache EXIT
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
          "chromium=${chromium_version}"
      )
      ;;
    *)
      printf 'agent-browser cannot install a browser for architecture %s.\n' "$(uname -m)" >&2
      return 1
      ;;
  esac
}

skip_provisioning=false
if (($# == 0)); then
  skip_provisioning=true
fi
explicit_install=false
if [[ ${1:-} == install ]]; then
  explicit_install=true
fi
case "${1:-}" in
  close | connect | dashboard | doctor | help | profiles | session | skills | upgrade)
    skip_provisioning=true
    ;;
esac
for argument in "$@"; do
  case "$argument" in
    close | help | -h | --help | -V | --version | --auto-connect | --cdp | --cdp=* | \
      --executable-path | --executable-path=* | --provider | --provider=*)
      skip_provisioning=true
      ;;
  esac
done

if $explicit_install && ! $skip_provisioning; then
  (
    flock 9
    provision_browser
  ) 9>"$browser_lock"
  exit
fi

if ! $skip_provisioning && ! browser_is_available; then
  (
    flock 9
    provision_browser
  ) 9>"$browser_lock"
fi

exec "$native_agent_browser" "$@"
