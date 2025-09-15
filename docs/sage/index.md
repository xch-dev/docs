---
slug: /sage
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Sage Wallet

:::info
If you are looking for download instructions for the sage app, visit the [Sage Website](https://sagewallet.net).
:::

## Source Installation

Sage is built with [Tauri v2](https://tauri.app/), a framework for building efficient cross-platform applications that work on both desktop and mobile devices. You will need to follow the [Prerequisites](https://tauri.app/start/prerequisites/) section of the Tauri docs before proceeding with a source installation.

You will also need to have both [Rustup](https://rustup.rs/) and [PNPM](https://pnpm.io/installation) installed.

Clone the repo and run the following command to install the frontend dependencies:

```bash
pnpm install
```

This is how you can compile and start the app in debug mode, for development or testing purposes:

<Tabs groupId="tauri-builds">
  <TabItem value="desktop" label="Desktop">
  ```bash
  pnpm tauri dev
  ```
  </TabItem>
  <TabItem value="ios" label="iOS">
  ```bash
  pnpm tauri ios dev
  ```
  </TabItem>
  <TabItem value="android" label="Android">
  ```bash
  pnpm tauri android dev
  ```
  </TabItem>
</Tabs>

:::note
This will create an unoptimized build of the app, which can result in some performance issues. If needed, you can use the `--release` flag to run a release optimized version instead.
:::

### Production Build

If you need to compile the app into a production binary, you can do that as well:

<Tabs groupId="tauri-builds">
  <TabItem value="desktop" label="Desktop">
  ```bash
  pnpm tauri build
  ```
  </TabItem>
  <TabItem value="ios" label="iOS">
  ```bash
  pnpm tauri ios build
  ```
  </TabItem>
  <TabItem value="android" label="Android">
  ```bash
  pnpm tauri android build
  ```
  </TabItem>
</Tabs>
