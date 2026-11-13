# Deploying on your own server

The whole site runs on one small server: a Hetzner Cloud CX23 (2 vCPU, 4 GB RAM, 40 GB disk), about 7 € a month, with Cloudflare's free plan in front. No server experience is needed; every command is here to copy.

> weighme has not been deployed yet. This guide and its scripts follow the ones CVE Tracker runs on, and the containers have been run together locally, but they have not been tried on a real server. The repository must be public for the setup script to download the code.

How the pieces fit:

```
visitor ──https──▶ Cloudflare (TLS, cache) ◀──tunnel── server: cloudflared ──▶ frontend :3100
                                                                          └──▶ api      :4100 ──▶ SQLite on a volume
                                                                                    ▲
                                                 npm registry ◀── gateway ◀── worker┘ (its own network, no other way out)
```

The server opens no port to the internet except SSH. `cloudflared` connects out to Cloudflare and receives the site's traffic over that connection, so there are no certificates to manage, the server's address stays hidden, and nobody can reach the API around Cloudflare (which also means the rate limit counts real visitors by `CF-Connecting-IP`).

## What you need

- A domain on Cloudflare. Buy one there (Domain Registration), or add one you have elsewhere and switch its nameservers to Cloudflare as it explains.
- A Hetzner Cloud account.
- An SSH key on your computer: the server is reached with it, and the setup script turns password logins off.
- About half an hour.

Below, `example.com` stands for your domain. The site can live on the domain itself or on a subdomain (`pkg.example.com`); the API gets its own name next to it: `api.example.com`, or `pkg-api.example.com` for a subdomain (Cloudflare's free certificate covers one level of subdomains, so not `api.pkg.example.com`).

## 1. Create the server (Hetzner)

First make an SSH key, if you have none yet. On a Mac, open the Terminal app and run:

```bash
ssh-keygen -t ed25519
```

Press Enter to keep the suggested file (`~/.ssh/id_ed25519`), then choose a passphrase. It writes two files: the private key, which never leaves your computer, and the public key, `~/.ssh/id_ed25519.pub`. Copy the public one:

```bash
pbcopy < ~/.ssh/id_ed25519.pub
```

In the [Hetzner Console](https://console.hetzner.com): **Servers → Add server**.

1. **Type:** Cost-Optimized, x86, **CX23** (4 GB RAM). The worker alone may use up to 3 GB while it bundles a large package; less is not enough.
2. **Location:** any in the EU; if CX23 is sold out in one, pick another.
3. **Image:** Ubuntu (the newest LTS).
4. **Networking:** IPv4 and IPv6 on.
5. **SSH keys:** **Add SSH key**, paste the public key you copied, give it a name, and make sure it is selected. Leave volumes, firewalls and backups empty.
6. **Create & Buy now**. Note the server's **IPv4 address** from the server list.

## 2. Create the tunnel (Cloudflare)

In the [Cloudflare dashboard](https://dash.cloudflare.com): **Zero Trust → Networks → Tunnels → Create a tunnel**.

1. Choose **Cloudflared**, name it (`weighme`), save.
2. On the install page choose **Docker**. It shows a command like `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJh…`. Copy the **token**: the long text after `--token`. Do not run the command; the setup script runs `cloudflared` for you.
3. Next, add two **public hostnames** (also called _published application routes_):

    | Subdomain / domain | Service type | URL             |
    | ------------------ | ------------ | --------------- |
    | `example.com`      | HTTP         | `frontend:3100` |
    | `api.example.com`  | HTTP         | `api:4100`      |

    Cloudflare creates the DNS records for both. The tunnel shows as down until the server is set up.

## 3. Set up the server

On your computer, open a terminal (on a Mac: the Terminal app) and log in to the server with the address from step 1. The first time, answer `yes` to trust the server; your SSH key logs you in (enter its passphrase if you set one). No password is needed.

```bash
ssh root@203.0.113.10
```

Now you are on the server. Download the setup script and run it:

```bash
curl -fsSL https://raw.githubusercontent.com/janszotkowski/weighme/main/deploy/setup.sh -o setup.sh
```

```bash
bash setup.sh
```

It updates the system; installs Docker, a firewall (only SSH in), fail2ban and automatic security updates; turns off SSH password logins (only keys get in; without a key on the server it warns and leaves them on); adds swap; downloads the code to `/opt/weighme`; and asks for:

- the **domain** of the site (`example.com`),
- the **API address** (Enter takes the suggested one; it must match the second public hostname),
- the **tunnel token** from step 2 (pasting it shows nothing; that is on purpose),

The answers and two generated secrets go into `/opt/weighme/.env`. Then it builds and starts everything; the first build takes a few minutes.

Open `https://example.com` and look up a package. The first measurement of each takes a few seconds; what the worker downloads stays on its own Docker volume.

## 4. Let Cloudflare cache the pages

Cloudflare caches images and scripts by default, but not HTML or the API's JSON. Both send `Cache-Control` headers for it, so one rule lets Cloudflare answer most visits without reaching the server:

**Your domain → Caching → Cache Rules → Create rule**

- **When:** Hostname equals `example.com`, _or_ Hostname equals `api.example.com`.
- **Then:** Cache eligibility: **Eligible for cache**. Edge TTL: **Use cache-control header if present**.

Agents that send `Accept: text/markdown` get Markdown at a page's own address. Cloudflare keeps one copy per address whatever the `Accept`, so add a second rule **below** the first one, or agents get the cached HTML:

- **When:** Edit expression: `any(http.request.headers["accept"][*] contains "text/markdown")`
- **Then:** Cache eligibility: **Bypass cache**.

Under **SSL/TLS → Edge Certificates**, turn on **Always Use HTTPS**.

The worker's routes (`/internal/*`) are not for the internet. The API already answers 404 there to anything that came through Cloudflare (it carries `cf-connecting-ip`, the `CLIENT_IP_HEADER` the setup script wrote); a rule keeps such requests from reaching the server at all:

**Your domain → Security → WAF → Custom rules → Create rule**

- **When:** Hostname equals `api.example.com` _and_ URI Path starts with `/internal`.
- **Then:** **Block**.

## Everyday commands

Log in with `ssh root@<address>`, then `cd /opt/weighme`:

| Command                                          | What it does                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `docker compose ps`                              | What is running and whether it is healthy                        |
| `docker compose logs -f api worker`              | The API and the worker as they work (Ctrl+C stops watching only) |
| `docker compose logs --tail 100 tunnel`          | The tunnel, when the site does not answer                        |
| `bash deploy/update.sh`                          | Installs the newest version from GitHub; the database is kept    |
| `docker compose restart`                         | Restarts everything                                              |
| `nano .env`, then `docker compose up -d --build` | Changes a setting                                                |

To install only commits signed by a key you trust, run updates as `REQUIRE_SIGNED=1 bash deploy/update.sh`: it runs `git verify-commit` on the pulled commit and stops before running any of it when the signature is missing or unknown. The signer's key must be known to git on the server first (imported with `gpg --import`, or for SSH signatures listed in the file that `git config gpg.ssh.allowedSignersFile` names).

The database lives in a Docker volume (`api-data`) and survives updates and restarts. If it is ever lost, each package is measured again the next time someone asks for it. The worker's downloads are on `worker-data`, and it empties them itself past its limit (`STORE_MAX_BYTES`).

## When something is wrong

- **The site shows a Cloudflare error 1033 or 502:** the tunnel or a service is down. `docker compose ps` shows which; `docker compose logs --tail 100 <service>` shows why.
- **The page loads, but the data does not:** the API address in `.env` (`API_URL`) and the tunnel's second hostname must be the same name.
- **Packages stay "queued":** the worker cannot reach the API. `docker compose logs --tail 100 worker` shows why; `BACKEND_URL` in `.env` must be `http://api:4100`, and `WORKER_TOKEN` is shared by both.
- **Packages fail to install:** the worker reaches the registry only through its gateway. `docker compose logs --tail 100 registry-gateway` shows why.
- **A wrong answer to the setup script:** edit `/opt/weighme/.env` with `nano`, then `docker compose up -d --build` (the domains are built into the frontend, so it must be built again).
