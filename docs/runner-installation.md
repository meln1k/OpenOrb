# Linux runner installation

OpenOrb runners are native systemd services for glibc Linux on x86-64 and ARM64. Choose one launch
mode:

| Mode                | Use it when                                     | Runner-host requirements           |
| ------------------- | ----------------------------------------------- | ---------------------------------- |
| Standalone artifact | You want the smallest production dependency set | QEMU; no installed Node.js or Git  |
| Source checkout     | You want to update by pulling the repository    | QEMU, Git, Node.js 26.11.1 and npm |

Both modes use the same hardened `openorb-runner.service`, persistent state directory, identity, and
session files. Switching modes does not require re-enrollment because state remains under
`/var/lib/openorb-runner`.

## 1. Prepare the host

OpenOrb requires glibc 2.28 or newer; musl distributions, including Alpine Linux, are unsupported.
Install QEMU on Debian or Ubuntu:

```sh
sudo apt update
case "$(uname -m)" in
  x86_64) sudo apt install qemu-system-x86 qemu-utils ;;
  aarch64|arm64) sudo apt install qemu-system-arm qemu-utils ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sudo useradd --system --user-group --home-dir /var/lib/openorb-runner \
  --shell /usr/sbin/nologin openorb-runner
sudo install -d -o openorb-runner -g openorb-runner -m 0700 /var/lib/openorb-runner
```

If the service account already exists, omit `useradd`. The runner needs outbound HTTP/HTTPS access
to the gateway, GitHub, provider APIs, and package registries used inside sessions. It opens no
inbound port and needs no VPN.

KVM is recommended but optional. When `/dev/kvm` is unavailable or inaccessible, the runner logs a
startup warning and uses slower QEMU TCG software emulation. To enable acceleration when the host
supports it, expose `/dev/kvm` and add the service account to the host's KVM group:

```sh
sudo usermod --append --groups kvm openorb-runner
```

Nested KVM is optional. To expose `/dev/kvm` inside session VMs on x86-64, verify that the
applicable host setting reports `Y` or `1`:

```sh
cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || \
  cat /sys/module/kvm_amd/parameters/nested
```

If it is disabled, enable nested virtualization through the host distribution or upstream
hypervisor. Linux session startup passes the host CPU model to Gondolin and attempts to load the
matching KVM driver in the guest. If the guest cannot use its own `/dev/kvm`, the runner logs a
warning and continues without nested virtualization.

## 2A. Install the standalone artifact

Download the release's `openorb-runner-linux-x64`, `openorb-runner-linux-arm64`, `SHA256SUMS`, and
`openorb-runner.service` on a trusted administration machine. Verify the release source and
checksums, then install the native artifact:

```sh
sha256sum --check SHA256SUMS

case "$(uname -m)" in
  x86_64) runner_artifact=openorb-runner-linux-x64 ;;
  aarch64|arm64) runner_artifact=openorb-runner-linux-arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sudo install -o root -g root -m 0755 "$runner_artifact" /usr/local/bin/openorb-runner
sudo rm -f /etc/systemd/system/openorb-runner.service \
  /etc/systemd/system/openorb-runner.service.d/source.conf
sudo install -o root -g root -m 0644 openorb-runner.service \
  /etc/systemd/system/openorb-runner.service
sudo systemctl daemon-reload
```

Continue with [Doctor and enrollment](#3-doctor-and-enrollment).

## 2B. Install from a source checkout

Install Git and Node.js 26.11.1 from the official Node distribution, with Node at
`/usr/local/bin/node` and npm on PATH. Clone OpenOrb to the fixed, root-owned production path and
install its locked npm workspace graph (including Vite+ 1.1.0):

```sh
/usr/local/bin/node --version # v26.11.1

sudo git clone https://github.com/meln1k/openorb.git /opt/openorb
sudo npm --prefix /opt/openorb ci
sudo chmod -R a+rX /opt/openorb
```

Install the same base service plus the checked-in source override matching the host architecture:

```sh
case "$(uname -m)" in
  x86_64) source_override=openorb-runner-source-x64.conf ;;
  aarch64|arm64) source_override=openorb-runner-source-arm64.conf ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sudo install -d -o root -g root -m 0755 \
  /etc/systemd/system/openorb-runner.service.d
sudo rm -f /etc/systemd/system/openorb-runner.service \
  /etc/systemd/system/openorb-runner.service.d/source.conf
sudo ln -s /opt/openorb/packages/runner/systemd/openorb-runner.service \
  /etc/systemd/system/openorb-runner.service
sudo ln -s "/opt/openorb/packages/runner/systemd/$source_override" \
  /etc/systemd/system/openorb-runner.service.d/source.conf
sudo systemctl daemon-reload
```

The override directly executes Node's TypeScript entrypoint; it does not use a shell wrapper.
The checkout and dependencies are root-owned and read-only to the service. Host isolation comes
from the reviewed systemd/OS sandbox, not Node runtime permission flags. Untrusted code remains
inside Gondolin VMs. Do not put provider keys or unrelated host secrets in the service environment.

Continue with [Doctor and enrollment](#3-doctor-and-enrollment).

### Updating a source installation

Stop the runner before changing its source or dependency graph:

```sh
sudo systemctl stop openorb-runner.service
sudo git -C /opt/openorb pull --ff-only
sudo npm --prefix /opt/openorb ci
sudo chmod -R a+rX /opt/openorb
sudo systemctl daemon-reload
sudo systemctl start openorb-runner.service
sudo systemctl status openorb-runner.service
```

For reproducible deployments, check out a reviewed tag or commit instead of pulling a moving branch.
If that revision changes the required Node version in `.tool-versions`, install and review the new
runtime before restarting; the runner rejects an unreviewed version.

## 3. Doctor and enrollment

Set the gateway origin. On a fresh runner, `doctor` requires it explicitly:

```sh
gateway=https://openorb.example.com
```

For a standalone installation:

```sh
sudo --user=openorb-runner /usr/bin/env \
  --ignore-environment --chdir=/var/lib/openorb-runner PATH=/usr/bin PWD=/var/lib/openorb-runner \
  /usr/local/bin/openorb-runner doctor --gateway "$gateway"
```

For a source installation, this Bash array invokes Node directly. These foreground administration
commands do not reproduce the systemd filesystem/device sandbox; use only on a trusted host with
the service stopped, and start the hardened service after enrollment:

```sh
source_runner=(
  sudo --user=openorb-runner
  /usr/bin/env --ignore-environment --chdir=/var/lib/openorb-runner
  PATH=/usr/bin PWD=/var/lib/openorb-runner
  /usr/local/bin/node
  /opt/openorb/packages/runner/src/standalone.ts
)

"${source_runner[@]}" doctor --gateway "$gateway"
```

`doctor` checks architecture, kernel, the Node version, glibc, QEMU, optional KVM
initialization, host resources, gateway health, data-directory ownership and free space, and the
pinned guest image used by persistent session root disks. QEMU—not Node—opens `/dev/kvm`. Fix every
reported error before continuing; a KVM warning means sessions will use slower TCG software
emulation.

Copy the enrollment PSK from **Settings → Runners**, read it without echo, and run the matching
foreground command:

```sh
read -rsp 'Enrollment PSK: ' enrollment_psk; printf '\n'

# Standalone installation:
sudo --user=openorb-runner /usr/bin/env \
  --ignore-environment --chdir=/var/lib/openorb-runner PATH=/usr/bin PWD=/var/lib/openorb-runner \
  /usr/local/bin/openorb-runner \
  --gateway "$gateway" --enrollment-token "$enrollment_psk"

# Source installation (use the source_runner array defined above instead):
"${source_runner[@]}" \
  --gateway "$gateway" --enrollment-token "$enrollment_psk"

unset enrollment_psk
```

Run only the command for the installed mode. After enrollment succeeds, stop the foreground runner
with Ctrl-C. It stores `runner.json` and `token` with mode `0600`; the enrollment PSK is not
retained.

## 4. Start and verify the service

The remaining commands are identical for both modes:

```sh
sudo systemctl enable --now openorb-runner.service
sudo systemctl status openorb-runner.service
sudo journalctl --unit openorb-runner.service --follow
```

The unit uses `WorkingDirectory=/var/lib/openorb-runner`, grants QEMU access only to the optional
`/dev/kvm` device, and makes the rest of the host filesystem read-only. It stores no credential,
accepts no `--data-dir`, and applies no default CPU, memory, or session-count ceiling.

Verify the effective unit and state ownership:

```sh
systemd-analyze verify /etc/systemd/system/openorb-runner.service
systemd-analyze security openorb-runner.service
sudo stat -c '%a %U %G %n' /var/lib/openorb-runner \
  /var/lib/openorb-runner/runner.json /var/lib/openorb-runner/token
```

The expected modes are `700` for the state directory and `600` for both identity files, all owned by
`openorb-runner:openorb-runner`. Restarting the service preserves identity, Session Journals, and
each session's persistent `root-disk.qcow2` regardless of which launch mode is active. A wake opens
the same disk in a new VM and runs `.agents/resume`; RAM, processes, and tmpfs-backed guest paths do
not return.
