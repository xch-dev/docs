---
slug: /sage/files
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Files

All files used by Sage are stored in a single location, inside of the system's default [data dir](https://docs.rs/dirs/latest/dirs/fn.data_dir.html).

<Tabs groupId="operating-systems">
  <TabItem value="win" label="Windows">`C:\Users\Alice\AppData\Roaming\com.rigidnetwork.sage`</TabItem>
  <TabItem value="mac" label="MacOS">`/Users/Alice/Library/Application Support/com.rigidnetwork.sage`</TabItem>
  <TabItem value="linux" label="Linux">`/home/alice/.local/share/com.rigidnetwork.sage`</TabItem>
</Tabs>

:::note
The username `Alice` is a placeholder, and must be replaced by your actual username.
:::

## Files

| Name                | Description                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `apps`              | Files for each installed Sage app.                                                                  |
| `config.toml`       | The main configuration file used by the app. See [Config](/sage/config).                            |
| `keys.bin`          | A binary encoding of all imported keys.                                                             |
| `log`               | Logs emitted by the backend of the app.                                                             |
| `networks.toml`     | Information about blockchain networks (ie mainnet or testnet11). See [Config](/sage/config).        |
| `peers`             | Binary files that store previous peer connections.                                                  |
| `sage-apps.sqlite3` | A SQLite database of installed Sage apps and their settings.                                        |
| `ssl`               | The SSL certificate used for full node connections and the RPC.                                     |
| `themes`            | User themes, each in its own directory with a `theme.json` file.                                    |
| `wallets`           | SQLite databases for each key pair and network, stored as `wallets/<fingerprint>/<network>.sqlite`. |
| `wallets.toml`      | Configuration for each imported wallet. See [Config](/sage/config).                                 |
