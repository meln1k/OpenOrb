# Linux runner installation

OpenOrb runners are native systemd services for glibc Linux on x86-64 and ARM64. Choose one launch
mode:

| Mode                | Use it when                                     | Runner-host requirements              |
| ------------------- | ----------------------------------------------- | ------------------------------------- |
| Standalone artifact | You want the smallest production dependency set | QEMU/KVM; no Deno, Node.js, or Git    |
| Source checkout     | You want to update by pulling the repository    | QEMU/KVM, Git, and Deno 2.9.5 exactly |

Both modes use the same hardened `openorb-runner.service`, persistent state directory, identity, and
session files. Switching modes does not require re-enrollment because state remains under
`/var/lib/openorb-runner`.

## 1. Prepare the host

Enable hardware virtualization and expose `/dev/kvm`. OpenOrb requires glibc 2.27 or newer; musl
distributions, including Alpine Linux, are unsupported. On Debian or Ubuntu:

```sh
sudo apt update
case "$(uname -m)" in
  x86_64) sudo apt install qemu-system-x86 qemu-utils ;;
  aarch64|arm64) sudo apt install qemu-system-arm qemu-utils ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sudo useradd --system --user-group --home-dir /var/lib/openorb-runner \
  --shell /usr/sbin/nologin openorb-runner
sudo usermod --append --groups kvm openorb-runner
sudo install -d -o openorb-runner -g openorb-runner -m 0700 /var/lib/openorb-runner
```

If the service account already exists, omit `useradd`. The runner needs outbound HTTP/HTTPS access
to the gateway, GitHub, provider APIs, and package registries used inside sessions. It opens no
inbound port and needs no VPN.

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

Install Git and Deno 2.9.5, with the Deno executable at `/usr/local/bin/deno`. Then clone OpenOrb to
the fixed, root-owned production path and prepare its frozen runner dependency graph:

```sh
/usr/local/bin/deno --version # first line must be: deno 2.9.5

sudo git clone https://github.com/meln1k/openorb.git /opt/openorb
sudo install -d -o root -g root -m 0755 /var/cache/openorb-runner/deno
sudo env DENO_DIR=/var/cache/openorb-runner/deno \
  /usr/local/bin/deno install --frozen \
  --config=/opt/openorb/deno.json \
  --lock=/opt/openorb/deno.lock \
  --entrypoint /opt/openorb/packages/runner/src/standalone.ts
sudo chmod -R a+rX /opt/openorb /var/cache/openorb-runner/deno
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

The override directly executes Deno with `--frozen` and `--cached-only`; it does not use a shell
wrapper. The checkout and dependency cache are root-owned and read-only to the service. Deno may
write only runner state, and may execute only `qemu-img` and the host architecture's QEMU system
binary.

Continue with [Doctor and enrollment](#3-doctor-and-enrollment).

### Updating a source installation

Stop the runner before changing its source or dependency graph:

```sh
sudo systemctl stop openorb-runner.service
sudo git -C /opt/openorb pull --ff-only
sudo env DENO_DIR=/var/cache/openorb-runner/deno \
  /usr/local/bin/deno install --frozen \
  --config=/opt/openorb/deno.json \
  --lock=/opt/openorb/deno.lock \
  --entrypoint /opt/openorb/packages/runner/src/standalone.ts
sudo chmod -R a+rX /opt/openorb /var/cache/openorb-runner/deno
sudo systemctl daemon-reload
sudo systemctl start openorb-runner.service
sudo systemctl status openorb-runner.service
```

For reproducible deployments, check out a reviewed tag or commit instead of pulling a moving branch.
If that revision changes the required Deno version in `.tool-versions`, install and review the new
runtime before restarting; the runner rejects an unreviewed version.

## 3. Doctor and enrollment

Set the gateway origin. On a fresh runner, `doctor` requires it explicitly:

```sh
gateway=https://openorb.example.com
```

For a standalone installation:

```sh
sudo --user=openorb-runner /usr/bin/env \
  --chdir=/var/lib/openorb-runner PWD=/var/lib/openorb-runner \
  /usr/local/bin/openorb-runner doctor --gateway "$gateway"
```

For a source installation, this Bash array invokes Deno directly with the same permission profile as
the systemd override:

```sh
case "$(uname -m)" in
  x86_64) qemu=/usr/bin/qemu-system-x86_64 ;;
  aarch64|arm64) qemu=/usr/bin/qemu-system-aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

source_runner=(
  sudo --user=openorb-runner
  /usr/bin/env --chdir=/var/lib/openorb-runner
  PATH=/usr/bin PWD=/var/lib/openorb-runner
  DENO_DIR=/var/cache/openorb-runner/deno
  /usr/local/bin/deno run --cached-only --frozen
  --config=/opt/openorb/deno.json --lock=/opt/openorb/deno.lock
  --allow-read=/opt/openorb,/var/cache/openorb-runner/deno,/var/lib/openorb-runner,/lib,/lib64,/usr/lib,/usr/lib64
  --allow-write=/var/lib/openorb-runner --allow-net
  --allow-env=PATH,PWD,NODE_V8_COVERAGE,TF_BUILD
  --allow-sys=cpus,gid,homedir,hostname,networkInterfaces,osRelease,statfs,systemMemoryInfo,uid
  "--allow-run=$qemu,/usr/bin/qemu-img"
  /opt/openorb/packages/runner/src/standalone.ts
)

"${source_runner[@]}" doctor --gateway "$gateway"
```

`doctor` checks architecture, kernel, the exact Deno/denort version, glibc, native QEMU/KVM
initialization, host resources, gateway health, data-directory ownership and free space, and the
pinned checkpoint-compatible guest image. QEMU—not Deno—opens `/dev/kvm`. Fix every reported error
before continuing.

Copy the enrollment PSK from **Settings → Runners**, read it without echo, and run the matching
foreground command:

```sh
read -rsp 'Enrollment PSK: ' enrollment_psk; printf '\n'

# Standalone installation:
sudo --user=openorb-runner /usr/bin/env \
  --chdir=/var/lib/openorb-runner PWD=/var/lib/openorb-runner \
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

The unit uses `WorkingDirectory=/var/lib/openorb-runner`, grants QEMU access only to `/dev/kvm`, and
makes the rest of the host filesystem read-only. It stores no credential, accepts no `--data-dir`,
and applies no default CPU, memory, or session-count ceiling.

Verify the effective unit and state ownership:

```sh
systemd-analyze verify /etc/systemd/system/openorb-runner.service
systemd-analyze security openorb-runner.service
sudo stat -c '%a %U %G %n' /var/lib/openorb-runner \
  /var/lib/openorb-runner/runner.json /var/lib/openorb-runner/token
```

The expected modes are `700` for the state directory and `600` for both identity files, all owned by
`openorb-runner:openorb-runner`. Restarting the service preserves identity, sessions, and completed
checkpoints in that directory regardless of which launch mode is active.
