---
title: Setup
slug: /rpc-setup
---

# RPC Setup

## GUI

You can run the RPC in the background while the Sage app is open. It runs in the same process as the app rather than as a separate daemon service, so if the app is closed the RPC server will be as well.

The RPC server is off by default. You will need to start it in Settings => Advanced. Optionally, it can also be set to start automatically when the GUI is opened.

![Sage RPC settings](/img/screenshots/rpc.png)

## CLI

The RPC server can be run directly from the command line as well, which is preferable for backend applications running on headless hosts.

You will need to follow the [Prerequisites](https://tauri.app/start/prerequisites/) section of the Tauri docs, and install [Rustup](https://rustup.rs/).

Run the following command, using whichever version number you want to install (it should be the same version as the GUI, if you were running it previously):

```bash
cargo install --git https://github.com/xch-dev/sage --tag v0.11.1 sage-cli
```

Now you can run `sage rpc start` to start the Sage process in the foreground. You can also run RPC commands by passing in their request body like so:

```bash
sage rpc login '{"fingerprint": 2417281}'
```

:::warning
Do not run the command line RPC server at the same time as the GUI. They may overwrite each other's data.
:::

## SSL Certificate

The CLI will load the certificate automatically, but if you want to connect to the RPC server from your own client (for example, in a Node.js app), you can find the SSL certificate on the [Files](/files) page.

Here is an example of how you need to connect:

```js
import axios from "axios";
import { Agent } from "https";
import fs from "fs";

const sageDir = "...";

const agent = new Agent({
  rejectUnauthorized: false,
  cert: fs.readFileSync(`${sageDir}/ssl/wallet.crt`),
  key: fs.readFileSync(`${sageDir}/ssl/wallet.key`),
});

axios
  .post("https://localhost:9257/get_sync_status", {}, { httpsAgent: agent })
  .then(console.log.bind(console))
  .catch(console.error.bind(console));
```

You need to disable server verification with `rejectUnauthorized` and connect using the wallet's certificate and key files. All requests use the `POST` method, and accept and return JSON payloads. The default port is 9257, but it can be configured.
