# xch.dev

Source for [xch.dev](https://xch.dev), the documentation for Sage and the Chia Wallet SDK. It's built with [Docusaurus](https://docusaurus.io/).

## Requirements

- Node.js 24 (see `.nvmrc`; 20 or newer works)
- pnpm, at the version pinned in `package.json`'s `packageManager` field. Running `corepack enable` picks it up automatically.

## Development

```sh
pnpm install
pnpm start
```

`pnpm start` and `pnpm build` both generate the RPC reference pages first. The generated pages go to `docs/sage/rpc`, which is gitignored. To regenerate them on their own, run `pnpm gen-api-docs`.

Before opening a PR, run:

```sh
pnpm format:check   # or `pnpm format` to fix
pnpm typecheck
pnpm build
```

CI runs the same checks on every pull request.

## RPC reference

The RPC pages are generated from `src/openapi.json`, which comes from Sage. To update it to a Sage release (this needs git and a Rust toolchain):

```sh
pnpm sync-openapi v0.13.1   # omit the tag to use the latest release
```

To use a local Sage checkout instead, set `SAGE_DIR=/path/to/sage`.

## Deployment

Every push to `main` builds the site and deploys it to GitHub Pages through `.github/workflows/ci.yml`.
