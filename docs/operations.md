# Production operations

This is the supported MVP deployment shape: one password-protected gateway from a pinned source
checkout, PostgreSQL, an HTTPS reverse proxy, and one or more outbound-only Linux runners. It is not
a container or high-availability design.

## Release pins

Treat the gateway, runner, and protocol as one release unit. Check out the same reviewed full commit
SHA on the gateway and every source-installed runner; do not mix independently updated checkouts.
Record it before deployment with `git rev-parse HEAD`, and use that value (not a branch name) as
`OPENORB_REVISION` below. A standalone runner must come from the release for that same source
revision. Protocol version **15** is source-owned and is not a separately upgradeable public API.

The exact runtime and application pins in this release graph are:

| Component                              | Pin                                          |
| -------------------------------------- | -------------------------------------------- |
| Deno / standalone runner denort        | 2.9.5                                        |
| Gondolin                               | 0.12.0                                       |
| OpenOrb guest image                    | `mvp-5` (Debian snapshot `20260803T000000Z`) |
| Pi AI / Pi coding-agent direct imports | 0.84.2                                       |
| Remix                                  | 3.0.0-beta.10                                |
| Runner protocol                        | 14                                           |

The lockfile is authoritative for the complete transitive graph. The image's architecture-specific
build IDs, hashes, sizes, and immutable URLs are in
`packages/runner/src/environment/gondolin/guest-image/release.ts`; follow the
[guest image release process](guest-image.md), rather than rebuilding an asset under an existing
release ID.

## Deploy the gateway behind Caddy

Install Deno 2.9.5, Git, PostgreSQL client tools, Caddy, and systemd on the gateway host. Create a
database and role using the normal policy of the PostgreSQL installation. PostgreSQL may be local or
managed, but it is the **only** durable gateway data store. The gateway needs no persistent local
application volume and must not be given Redis, a filesystem data volume, or another secondary
persistence service. The checkout and Deno cache are replaceable program files, not application
state.

Install a reviewed revision and its frozen graph:

```sh
OPENORB_REVISION=<reviewed-full-commit-sha>
sudo useradd --system --user-group --home-dir /nonexistent \
  --shell /usr/sbin/nologin openorb-gateway
sudo git clone https://github.com/meln1k/openorb.git /opt/openorb
sudo git -C /opt/openorb checkout --detach "$OPENORB_REVISION"
test "$(git -C /opt/openorb rev-parse HEAD)" = "$OPENORB_REVISION"
sudo install -d -o openorb-gateway -g openorb-gateway -m 0750 /var/cache/openorb-gateway/deno
sudo install -d -o root -g root -m 0755 /etc/openorb
sudo env DENO_DIR=/var/cache/openorb-gateway/deno /usr/local/bin/deno install --frozen \
  --config=/opt/openorb/deno.json --lock=/opt/openorb/deno.lock \
  --entrypoint /opt/openorb/packages/gateway/server.ts
sudo chown -R openorb-gateway:openorb-gateway /var/cache/openorb-gateway/deno
sudo chmod -R a+rX /opt/openorb
```

Keep secrets outside the checkout. For example, create root-readable `/etc/openorb/gateway.env` with
mode `0600` (values shown here are placeholders; generate the two secrets independently):

```dotenv
DATABASE_URL=postgres://openorb:REDACTED@db.example.internal/openorb
OPENORB_MASTER_KEY=<64-hex-character-key-generated-with-openssl-rand-hex-32>
SESSION_SECRET=<independently-generated-long-random-value>
PUBLIC_URL=https://openorb.example.com
PORT=44100
```

After writing the file, enforce its ownership and mode with
`sudo chown root:root /etc/openorb/gateway.env && sudo chmod 0600 /etc/openorb/gateway.env`.

Install `/etc/systemd/system/openorb-gateway.service`:

```ini
[Unit]
Description=OpenOrb gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openorb-gateway
Group=openorb-gateway
WorkingDirectory=/opt/openorb/packages/gateway
Environment=DENO_DIR=/var/cache/openorb-gateway/deno
Environment=NODE_ENV=production
EnvironmentFile=/etc/openorb/gateway.env
ExecStart=/usr/local/bin/deno run --frozen --allow-env --allow-ffi --allow-net --allow-read server.ts
Restart=on-failure
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

The gateway currently listens on all interfaces. Restrict TCP 44100 to loopback with the host
firewall; expose only Caddy's ports 80/443. Configure `/etc/caddy/Caddyfile` (Caddy obtains and
renews the certificate):

```caddyfile
openorb.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:44100
}
```

Then start both services and verify HTTPS, including the WebSocket path used by runners:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now openorb-gateway caddy
curl --fail --show-error https://openorb.example.com/healthz
```

Open the HTTPS origin and complete first-run setup, which atomically creates one Workspace and the
single administrator. Retain a strong administrator password. Credentials, projects, runners, and
enrollment PSKs belong to the Workspace; passwords and Git author identity belong to the user. There
is no Workspace-selection UI. In **Settings**, add the credentials and project:

- For OpenCode Go, obtain an API key from your OpenCode Go account and save it as provider ID
  `opencode-go`. The default model is `opencode-go/deepseek-v4-flash`; never put the key in the
  runner environment or guest.
- Prefer a fine-grained GitHub personal access token restricted to the one selected private
  repository. Grant **Contents: Read and write** (metadata read access is implicit); grant no
  organization, administration, Actions, Packages, or account permissions. This supports clone,
  fetch, commit, and branch push. Add further permissions only if a separately reviewed workflow
  actually requires them. Store the repository's HTTPS `.git` URL in the project.

Create an enrollment PSK in **Settings → Runners**, then follow the complete
[Linux runner installation and enrollment guide](runner-installation.md). Give a NATed runner the
public `https://openorb.example.com` origin. It makes one outbound HTTPS/WebSocket connection and
requires no inbound port.

## Gateway backup and restore

A recoverable gateway backup consists of all three items from the same deployment:

1. a consistent PostgreSQL dump;
2. the externally managed `OPENORB_MASTER_KEY`;
3. the externally managed `SESSION_SECRET`.

Store the two secrets in a secrets manager and back them up separately from the database. Do not
commit them or include them in ordinary logs. For example:

```sh
pg_dump --format=custom --file=openorb.dump "$DATABASE_URL"
# Restore into an empty database:
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" openorb.dump
```

Restore the database, inject the **original** two secrets, check out the recorded source revision,
and only then start the gateway. Startup applies committed migrations. Test restoration in an
isolated environment without allowing its runners to connect to production.

Losing or changing `OPENORB_MASTER_KEY` permanently makes the encrypted OpenCode and GitHub
credentials in PostgreSQL unreadable; replacing the credentials manually is then required. Losing or
changing `SESSION_SECRET` invalidates existing browser cookies and signs new cookies with a
different key, so every user must log in again. It does not decrypt stored credentials. Database
loss removes Workspaces, users, projects, encrypted credentials, runner enrollment records, and the
gateway's session catalog. There are no durable gateway files or secondary service to restore.

## Runner session-file backups

Runner identity and session state live only under `/var/lib/openorb-runner`. For a consistent
file-level backup, stop the runner, copy or snapshot the **entire directory as one unit**, then
start it again. Restore it only to the same trusted runner identity and the matching pinned OpenOrb
and guest-asset release, preserving owner `openorb-runner`, directory mode `0700`, and identity-file
mode `0600`.

Do not claim a crash-consistent copy of a running directory is a session backup. Journals, Pi
`session.jsonl`, workspace files, deletion markers, and checkpoint publication can change
independently while a session runs. In particular, Gondolin/QEMU checkpoints are non-self-contained
qcow2 overlays: they require the exact matching pinned kernel, initramfs, rootfs, and backing
assets. A checkpoint file may be **mutated in place** while Gondolin rebases its backing file during
resume. Copying it concurrently can therefore produce a corrupt or internally inconsistent backup.
Stop the service first; filesystem snapshots alone do not coordinate with an active rebase.

Even a consistent runner backup is not a gateway backup and does not make sessions portable or
provide migration/HA. Keep the matching guest assets or allow the same immutable release assets to
be downloaded and verified. After restore, run `doctor` before starting the service. A missing or
incompatible checkpoint may require the UI's explicit **Start clean VM** recovery; the separately
stored Project Checkout and Pi conversation can remain available, but guest root-disk-only changes
are lost.

## Troubleshooting

- **Gateway will not start:** inspect `journalctl -u openorb-gateway`; verify Deno is exactly 2.9.5,
  all three environment values are present, PostgreSQL is reachable, and migrations can run. An
  invalid master key fails startup; do not generate a replacement over an existing database.
- **HTTPS or runner connection fails:** check `curl https://…/healthz`, Caddy's certificate and
  logs, DNS, that `PUBLIC_URL` is the public HTTPS origin, and that the proxy supports WebSocket
  upgrades. The runner must use that public origin, while port 44100 remains private.
- **Runner is offline:** run the installation guide's `doctor`, then inspect
  `journalctl -u openorb-runner`. Check outbound DNS/HTTPS, system time, `/dev/kvm`, QEMU, free
  disk, and that its identity has not been revoked.
- **Image verification fails:** stop the runner and follow the narrowly scoped removal/re-download
  procedure in [guest image recovery](guest-image.md#runner-installation-and-recovery). Never edit
  an installed image or pair a checkpoint with a different image release.
- **Private clone/push gets 403:** confirm the token is restricted to the selected repository with
  Contents read/write, has not expired, and is approved for any organization SSO policy. Rotate it
  in gateway Settings, not on the runner.
- **Provider authentication fails:** confirm the provider ID is `opencode-go`, the key is active,
  and the selected `provider/model` is available to that account.

## Intentional upgrades

Never upgrade a production host by following a moving branch. Back up PostgreSQL and runner state,
review the candidate commit and lockfile diff, and review every Deno, Gondolin, guest image, Pi,
Remix, protocol, migration, and systemd change. Follow the Gondolin TLS compatibility gate in the
[runner release process](runner-release.md) and the separate guest-image publication process. Run
`deno install --frozen`, `deno task check`, `deno task test`, `deno task test:gondolin`, and native
x86-64/ARM64 release smoke checks as applicable. Exercise backup restoration and the complete
private-repository stop/resume/delete path in the [release acceptance guide](release-acceptance.md)
before promotion.

Stop gateway and runners, deploy the same approved source revision/release artifacts, prepare the
frozen graph, then restart and run gateway health and runner `doctor` checks. Do not change either
external secret as part of a software upgrade. Rollback is only safe when the database migrations,
protocol, runner state, and guest/checkpoint assets are compatible with the reviewed older release;
there is no general downgrade guarantee.
