# OpenOrb

![OpenOrb logo](logo.png)

OpenOrb runs coding-agent sessions on your own compute. The **gateway** serves the browser UI and
runs as a native celld Worker. Its **Workspace Durable Object** stores configuration in SQLite;
the **Runners Durable Object** owns live connections and routing. The **runner** executes sessions
in isolated QEMU virtual machines and connects outbound to the gateway.

## Developer quickstart

Use two Linux hosts: one for the gateway and one for the runner. They may be the same host while
developing.

You need:

- [Tailscale](https://tailscale.com/download) on every host and your development machine
- Deno 2.9.5 or newer and Git on the gateway and runner hosts
- celld 0.6.2 and esbuild 0.28.2 on the gateway host (installed below)
- QEMU on the runner host; `/dev/kvm` is recommended

### 1. Connect the hosts with Tailscale

Sign each machine into the same tailnet:

```sh
sudo tailscale up
tailscale status
```

The gateway listens on loopback port 44100. For development on one host, use
`http://localhost:44100`. For separate hosts, configure an HTTPS front end reachable by the browser
and runner, forwarding WebSocket upgrades and SSE to that loopback listener. Tailscale can provide
private host connectivity; joining the tailnet alone does not expose the loopback listener. See the
[operations guide](docs/operations.md#build-and-run-the-native-gateway-locally) for origin and cookie
requirements. In an Amp orb, use the gateway portal from `amp orb services ensure` instead.

### 2. Clone OpenOrb

The gateway and runner live in the same repository. Clone it on each host that will run a process:

```sh
git clone https://github.com/meln1k/OpenOrb.git
cd OpenOrb
deno install --frozen
```

If both processes run on one host, use one checkout.

### 3. Run the gateway and runner

On the gateway host, install the pinned Worker runtime and create local configuration only if it
does not already exist:

```sh
bash scripts/install-celld.sh
test -f packages/gateway/.env || cp packages/gateway/.env.example packages/gateway/.env
chmod 600 packages/gateway/.env
```

Edit `packages/gateway/.env`:

```dotenv
SESSION_SECRET=<long random value>
OPENORB_MASTER_KEY=<output of: openssl rand -hex 32>
```

Keep both secrets with existing state; never regenerate them during an upgrade. Gateway state lives
in `packages/gateway/.celld/dev` and persists across restarts. Relational Workspace SQLite uses Remix Data
schema definitions and native DO SQL. This is a clean break: existing PostgreSQL and Workspace KV
records are not imported or read, so repeat setup and recreate configuration in the new tables.
The former `packages/workspace/.celld/dev` and keys are left intact; the relocated dev config starts fresh.

Start the gateway (outside an Amp orb):

```sh
deno task dev:gateway
```

Open the gateway origin, create the administrator, and configure a model provider,
GitHub, and a project. Then open **Settings → Runners** and copy the enrollment command.

Run that command from the checkout on the runner host. It will look like:

```sh
deno task dev:runner \
  --gateway <gateway-origin> \
  --enrollment-token <enrollment-token> \
  --name "Development runner"
```

Enrollment is saved locally. Future starts need only:

```sh
deno task dev:runner
```

## Development commands

```sh
deno task check
deno task test
deno task test:gondolin
```

Always run tests through `deno task test`. Native runtime tests use isolated celld configuration and
state, not the development state directory. PostgreSQL is not a gateway or test prerequisite.

## More documentation

- [Production operations](docs/operations.md)
- [Runner installation](docs/runner-installation.md)
- [Security model](security.md)
- [Release acceptance](docs/release-acceptance.md)
