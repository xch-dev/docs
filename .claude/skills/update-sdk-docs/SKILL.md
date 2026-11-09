---
name: update-sdk-docs
description: Update the Wallet SDK docs (docs/sdk) for a new chia-wallet-sdk release or commit, based on the SDK diff since the commit the docs were last written against. Use when asked to update, sync or refresh the SDK docs for a release.
argument-hint: "<release tag or commit, default: latest release>"
---

# Update the Wallet SDK docs

The pages in `docs/sdk` document the public API of [chia-wallet-sdk](https://github.com/xch-dev/chia-wallet-sdk).
The SDK commit they're written against is the `rev` in `sdk-examples/Cargo.toml`. Your job is to bring
the docs up to date with a newer SDK commit (the argument, or the latest release tag if none is given),
and open a PR.

## 1. Get the diff

1. Clone or update the SDK somewhere outside this repo (or use an existing checkout, read only).
2. Resolve the target to a full commit hash, and diff it against the current `rev`:
   `git log --oneline <rev>..<target>` and `git diff <rev>..<target> -- src crates Cargo.toml`.
   Ignore the bindings' generated files, CI, and dependency bumps that don't change the public API.
3. Read the PR descriptions of the merged commits (`gh pr view <number> --repo xch-dev/chia-wallet-sdk`)
   for intent, especially for behaviour changes.

## 2. Plan the changes

Sort every relevant change into one of these, and map it to the pages it affects (`grep -rn` the docs
for the type and method names involved):

- **New public items** (types, methods, primitives, layers, actions, feature flags): add them to the
  relevant page, or write a new page for a new primitive or major feature.
- **Changed signatures or renames**: update the prose and examples. The example check finds most of these.
- **Behaviour changes**: rewrite the affected prose. The example check won't find these, so read the
  diff carefully and check every claim on the affected pages against the new source.
- **Removals**: remove or replace them.

Also check the lists that summarize the API: the feature flag table and crate table in
`docs/sdk/index.md`, the "All primitives" table in `docs/sdk/primitives/index.md`, the built-in
layers table in `docs/sdk/concepts/layers.md`, the action table in `docs/sdk/action-system/actions.md`,
the bindings page, and `sidebars.ts`.

For a large diff, split independent pages between subagents, giving each this skill's conventions and
its own copy of `sdk-examples` (cargo locks the target directory, so parallel runs in one crate block
each other).

## 3. Update the docs

Conventions:

- The docs describe the SDK as it is at the target commit, as if everything is released. Don't label
  anything as new or unreleased, don't mention SDK versions in prose, and don't describe old behaviour.
- Pages are conceptual: what something is, when to use it, how it fits with the rest of the SDK, then
  realistic examples, then gotchas. docs.rs is the exhaustive reference, so don't list every method.
- Rust only (the bindings have their own page). Every page needs realistic examples, preferably
  `#[test]`s that run against the `Simulator`. Networking examples can be compiled `async fn`s.
- Each ` ```rust ` block is compiled as its own module, so it needs its own `use` lines, using the
  `chia_wallet_sdk::...` re-export paths (the prelude plus specific modules). Only use
  ` ```rust ignore ` for excerpts such as struct definitions.
- Mention the feature flag for anything that's feature gated.
- Link other SDK pages with absolute paths (`/sdk/concepts/spend-context`). `pnpm build` fails on broken links.
- New pages get an entry in `sidebars.ts`. Category landing pages are regular items inside their
  category (for example an "Overview" item), not category links.
- If a page moves or is removed, add a redirect in `docusaurus.config.ts`.
- Plain, direct prose, matching the existing pages. No marketing language or emoji.

## 4. Verify

1. Update `rev` in `sdk-examples/Cargo.toml` (both dependencies) to the target commit's full hash.
2. Run `pnpm check:sdk-examples` until every example compiles and passes. Failures point at
   `sdk-examples/src/docs/<page>_<n>.rs`, whose first line names the markdown file and line.
3. Have a separate reviewer (a subagent given the changed pages and the SDK source, not your
   conclusions) check the prose, tables and comments against the source, and fix what it finds.
4. Run `pnpm format`, `pnpm typecheck` and `pnpm build`, and make sure the build has no broken links
   or anchors.

## 5. Open a PR

Work on a branch, commit, and open a PR against `main` that lists the SDK range
(`<old rev>..<new rev>`), what changed in the docs and why, and anything you couldn't cover. Follow the
user's branch naming and attribution preferences.
