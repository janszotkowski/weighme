# weighme

![weighme: What an npm package really costs your bundle](.github/banner.svg)

**What an npm package really costs your bundle, free and open source.** Search for a package and see its minified, gzip and brotli sizes, what it puts on disk and which packages make up its bundle, measured with a modern bundler. The package's code is never run.

**Not deployed yet:** for now it runs on your own machine. What is still required before a public release is in the [TODO](docs/TODO.md).

[![CI](https://github.com/janszotkowski/weighme/actions/workflows/ci.yml/badge.svg)](https://github.com/janszotkowski/weighme/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

weighme measures a package the first time someone asks for it, and keeps the result. A worker in a locked-down Docker container installs the package without running any of its scripts and bundles it with Rolldown. It needs no paid API and no account, and has no analytics.

## ✨ Features

- **Measured, not guessed**: minified, gzip and brotli sizes from a real bundler (Rolldown), the install size, and the time a package takes to download on slow 3G and 4G.
- **What is inside**: which packages make up the bundle, the size of each export on its own, and what the registry says about its health (deprecation, license, types, install scripts).
- **Over time and side by side**: how the size changed from release to release, and up to 4 packages compared by size or downloads, all kept in a shareable URL.
- **Take it with you**: a badge with the gzip size for a README, and a command line that prints what a package costs.
- **For programs and agents**: a public JSON API, an MCP server, and every measured package as Markdown, all with no key.
- **Its code never runs**: packages are installed without their scripts, in a container that reaches only the npm registry.
- **Accessible**: WCAG 2.2 AA, keyboard and screen reader friendly, light and dark themes.

The complete list is in [docs/FEATURES.md](docs/FEATURES.md).

## 🚀 Quick start

You need Node 24.22.3, pnpm 12 and Docker.

```bash
git clone https://github.com/janszotkowski/weighme.git
cd weighme
pnpm install
pnpm dev
```

The web app runs at http://localhost:3100 and the API at http://127.0.0.1:4100/v1/health. `pnpm dev` creates the local `.env` files and starts the worker in Docker; it downloads a package only when you look one up. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the details and every command.

## 📖 Use it

- **Website**: http://localhost:3100. Search for a package, compare a few, copy a badge; no account.
- **REST API**: public, 300 requests a minute. Full reference in [docs/API.md](docs/API.md), which the site shows at `/api`; OpenAPI 3.1 at `/v1/openapi.json`.

    ```bash
    curl "http://127.0.0.1:4100/v1/analyses?package=react"
    ```

- **MCP server**: connect an AI assistant to `http://127.0.0.1:4100/v1/mcp`, free and with no key. Setup for each client in [docs/MCP.md](docs/MCP.md), which the site shows at `/mcp`.

    ```bash
    claude mcp add --transport http weighme http://127.0.0.1:4100/v1/mcp
    ```

- **Command line**: prints what a package costs, or the whole answer with `--json`. It is not on npm yet, so build it first.

    ```bash
    pnpm --filter @weighme/cli build
    node apps/cli/dist/main.cli.mjs react
    ```

- **Badges**: `/badge/<name>.svg` shows a package's gzip size. Showing one never causes a download.

## 📚 Documentation

- [Features](docs/FEATURES.md): everything the site offers.
- [API reference](docs/API.md): every public endpoint and field, with examples.
- [MCP server](docs/MCP.md): how to connect an AI assistant, and its tools.
- [Architecture](docs/ARCHITECTURE.md): one analysis end to end, how packages are handled safely, the rate limit, the threat model and the security headers.
- [Configuration](docs/CONFIGURATION.md): every environment variable, and running it with Docker Compose.
- [Deployment guide](DEPLOY.md): a production deployment behind a Cloudflare Tunnel, step by step.
- [Development](docs/DEVELOPMENT.md): local setup, repository layout and commands.
- [Changelog](docs/CHANGELOG.md): every change to the API and the site.
- [Roadmap](docs/ROADMAP.md): the features that come next; the [TODO](docs/TODO.md) lists what must be done before the first public release.
- [AGENTS.md](AGENTS.md): the code style, dependency and architecture rules, for coding agents and people.

## 🤝 Contributing

Contributions are welcome: bug reports, wrong measurements, new measurements, new views. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Open an issue for a [bug](https://github.com/janszotkowski/weighme/issues/new?template=bug_report.yml), a [wrong measurement](https://github.com/janszotkowski/weighme/issues/new?template=wrong_measurement.yml), or a [feature request](https://github.com/janszotkowski/weighme/issues/new?template=feature_request.yml).

To report a security problem in weighme itself, follow the private reporting process in [SECURITY.md](SECURITY.md). A vulnerability in a package that weighme measured is not a weighme issue: report it to that package's maintainers.

## 📄 License and attribution

[MIT](LICENSE) © Jan Szotkowski. A package's own license stays its own. weighme measures packages as published on npm and shows public data as its sources give it, without warranty of any kind.

Packages, versions and what a version declares come from the [npm registry](https://registry.npmjs.org), download counts from [npm's statistics](https://api.npmjs.org), and stars from [GitHub](https://github.com).

Created and maintained by [Jan Szotkowski](https://github.com/janszotkowski). See the [contributor graph](https://github.com/janszotkowski/weighme/graphs/contributors) for everyone who has helped improve weighme.
