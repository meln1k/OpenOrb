# OpenOrb

![OpenOrb logo](logo.png)

OpenOrb runs coding-agent sessions on your own compute. The **gateway** serves the browser UI and
stores configuration in PostgreSQL. The **runner** executes sessions in isolated QEMU virtual
machines and connects outbound to the gateway.

## Developer quickstart

Use two Linux hosts: one for the gateway and one for the runner. They may be the same host while
developing.

You need:

- [Tailscale](https://tailscale.com/download) on every host and your development machine
- Deno 2.9.5 or newer and Git on the gateway and runner hosts
- PostgreSQL on the gateway host
- QEMU on the runner host; `/dev/kvm` is recommended

### 1. Connect the hosts with Tailscale

Sign each machine into the same tailnet:

```sh
sudo tailscale up
tailscale status
```

Note the gateway's Tailscale hostname. The browser and runner must be able to reach
`http://<gateway-hostname>:44100`.

### 2. Clone OpenOrb

The gateway and runner live in the same repository. Clone it on each host that will run a process:

```sh
git clone https://github.com/meln1k/OpenOrb.git
cd OpenOrb
deno install --frozen
```

If both processes run on one host, use one checkout.

### 3. Run the gateway and runner

On the gateway host, create the database and local configuration:

```sh
createdb openorb
cp packages/gateway/.env.example packages/gateway/.env
```

Edit `packages/gateway/.env`:

```dotenv
DATABASE_URL=postgres://localhost/openorb
SESSION_SECRET=<long random value>
OPENORB_MASTER_KEY=<output of: openssl rand -hex 32>
```

Start the gateway:

```sh
deno task dev:gateway
```

Open `http://<gateway-hostname>:44100`, create the administrator, and configure a model provider,
GitHub, and a project. Then open **Settings → Runners** and copy the enrollment command.

Run that command from the checkout on the runner host. It will look like:

```sh
deno task dev:runner \
  --gateway http://<gateway-hostname>:44100 \
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

Tests expect a PostgreSQL database named `openorb-test`. Always run tests through `deno task test`.

## More documentation

- [Production operations](docs/operations.md)
- [Runner installation](docs/runner-installation.md)
- [Security model](security.md)
- [Release acceptance](docs/release-acceptance.md)
