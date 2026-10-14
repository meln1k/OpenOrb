# OpenOrb

![OpenOrb logo](logo.png)

Run coding-agent sessions on your own compute. OpenOrb includes a browser UI, persistent
conversations, and a built-in Sandbox. Add a runner for isolated Linux VMs and repository work.

## Quickstart

Use a **Linux x86_64 or ARM64 machine** with [Node.js 26.11.1](https://nodejs.org/), npm, Git,
curl and OpenSSL. Run these commands on the machine where you'll open the browser.
No S3 bucket, Tailscale, or QEMU is needed for this local setup.

### 1. Install

Choose an [official celld installation option](https://github.com/denoland/celld#install).
OpenOrb uses celld 0.6.2.

**Native binary:**

```sh
curl -fsSL https://celld.dev/install.sh | CELLD_VERSION=v0.6.2 sh
export PATH="$HOME/.local/bin:$PATH"
celld --version
```

**Or Docker** (requires Docker):

```sh
docker run --rm ghcr.io/denoland/celld:0.6.2 --version
```

Then clone OpenOrb:

```sh
git clone https://github.com/meln1k/OpenOrb.git
cd OpenOrb
npm ci
```

### 2. Create secrets and start

```sh
if [ ! -f packages/gateway/.env ]; then
  (umask 077
    printf 'SESSION_SECRET=%s\nOPENORB_MASTER_KEY=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > packages/gateway/.env
  )
fi
chmod 600 packages/gateway/.env
```

**Native binary:**

```sh
npm run dev:gateway
```

**Or Docker:**

```sh
npm run prepare:dev --workspace @openorb/gateway
npm run build --workspace @openorb/gateway
docker run --rm --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:44100:44100 \
  -v "$(pwd)/packages/gateway:/app" -w /app \
  ghcr.io/denoland/celld:0.6.2 \
  dev wrangler.jsonc --no-watch --host 0.0.0.0 --port 44100 --logs
```

Keep this terminal running. Vite+ 1.1.0 and Rolldown build OpenOrb; celld serves the app.
For later starts, rerun your chosen startup block. Both options keep secrets and local state in
`packages/gateway/.celld/dev` on the host. Keep the `.env` file and that state directory;
do not delete the state or regenerate the secrets when upgrading.

### 3. Open OpenOrb

Open **http://localhost:44100**, create your administrator account, and add a model provider in
**Settings**. Start a session with **Sandbox** to begin chatting with the agent.

The Sandbox has a scratch filesystem but no repository, Git, network access, or package managers.
For repository work and a full Linux toolchain, [install and enroll a runner](docs/runner-installation.md),
then configure GitHub, your Git author, and a project in Settings. A runner needs QEMU;
hardware KVM is recommended.

In an Amp orb, use `amp orb services ensure` instead of `npm run dev:gateway` and open the
returned gateway portal instead of localhost.

## Hosting on a server

The quickstart runs locally, not as a production service. Hosting with celld uses an AWS S3 or
Cloudflare R2 fleet bucket: build and deploy the gateway, then start celld against that bucket.
It also needs deployment secrets, persistent local storage, and HTTPS with WebSocket and SSE support.
`celld deploy` does not read the quickstart's `.env` or `.dev.vars`.

See the [operations guide](docs/operations.md) for security and recovery requirements. A complete
production installation recipe is not yet provided; do not expose celld's internal listener publicly.

## Development

```sh
npm run check
npm test
npm run test:gondolin
```

## Documentation

- [Runner installation](docs/runner-installation.md)
- [Operations and upgrades](docs/operations.md)
- [Security model](security.md)
- [Release acceptance](docs/release-acceptance.md)
