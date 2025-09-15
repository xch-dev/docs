---
slug: /config
---

# Config

The config files are used to control the app's backend, rather than UI specific things (such as the default fee).

:::note
If the app is open, any changes you make to the config will not be reflected until restarted. Additionally, changes may be overwritten if an action is taken in the UI or RPC to modify the config.
:::

## config.toml

An example config looks like this:

```toml
version = 2

[global]
log_level = "DEBUG"
fingerprint = 1239439275

[network]
default_network = "mainnet"
target_peers = 5
discover_peers = true

[rpc]
enabled = true
port = 9257
```

### version

The version specified at the top level of the config indicates the schema being used. Prior to 0.10.0, an old schema was used for the config file, so the schema version is 2 to indicate an automatic migration to the new schema has taken place. Do not change this value yourself.

```toml
version = 2
```

### global.log_level

This decides what the minimum severity of logs to output to the console or log file should be. It defaults to `INFO`, which provides a good balance between relevant information and frequency. If you're trying to diagnose a problem in the app, or like having more information as to what's going on, you can set it to `DEBUG`.

```toml
[global]
log_level = "INFO"
```

### global.fingerprint

If specified, this is the fingerprint of the wallet you are currently logged into. This can be changed in the UI, via the RPC, or manually if the app is not running.

```toml
[global]
fingerprint = 1239439275
```

### network.default_network

The name of the network you want to connect to by default. This can be overridden on a per-wallet basis, but while you are logged out or in a wallet that doesn't have such an override, this network will be used. The network itself is configured in the networks.toml file. Since 0.8.3, mainnet is the default network.

```toml
[network]
default_network = "mainnet"
```

### network.target_peers

The maximum number of peers you want to connect to, if `discover_peers` is turned on. Being connected to more peers does not increase security, but it does make syncing faster since it's parallelized. The default of 5 peers provides a good balance between system resources and syncing speed for small to medium sized wallets. However, you may want to increase this to something like 15 for larger wallets. Setting it to an excessive value may cause instability, drain battery, or use a lot of network bandwidth.

```toml
[network]
target_peers = 5
```

### network.discover_peers

Whether or not to discover peers automatically. If this is enabled, the wallet will use various methods to find and connect to peers on the current network. If you're running your own full node, you likely want to disable this setting and add the node's ip address yourself.

```toml
[network]
discover_peers = true
```

### rpc.enabled

Whether the RPC should be started automatically when the app is opened. This is not on by default, because the RPC gives full control over the wallet and should be used with caution.

```toml
[rpc]
enabled = false
```

### rpc.port

The port that the RPC server should be served on.

```toml
[rpc]
port = 9257
```

## networks.toml

This file provides a list of network objects, each prefixed with `[[networks]]`.

For example:

```toml
[[networks]]
name = "mainnet"
ticker = "XCH"
default_port = 8444
genesis_challenge = "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb"
inherit = "mainnet"
```

### name

A unique name for the network. For example, even though there may be multiple networks whose id is `mainnet`, they must be disambiguated with this name.

```toml
[[networks]]
name = "mainnet"
```

### ticker

The currency symbol displayed after amounts.

```toml
[[networks]]
ticker = "XCH"
```

### prefix

A bech32m prefix used for encoding puzzle hashes into addresses for display purposes. This is optional, and defaults to the ticker in lower case.

```toml
[[networks]]
prefix = "xch"
```

### precision

The number of decimals of precision there are in formatted amounts, when measured in the currency of the network. This is optional, since it defaults to Chia's precision of 12.

```toml
[[networks]]
precision = 12
```

### network_id

The network id used when handshaking to peers on this network. For example, `mainnet`, `testnet11`, or `simulator0`. Multiple networks may have the same network id, especially if you're connecting to a fork of Chia.

```toml
[[networks]]
network_id = "mainnet"
```

### default_port

This is the port that will be used when connecting to peers, whether they are found by an introducer or received from an existing peer. It's possible for full nodes on the network to use a different port, although it's not common if they are exposed to the internet.

```toml
[[networks]]
default_port = 8444
```

### genesis_challenge

This is a value used to represent the genesis of the chain, or the placeholder header hash before the first block. It's necessary when requesting coin information from a peer using the light wallet protocol.

```toml
[[networks]]
genesis_challenge = "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb"
```

### agg_sig_me

Signed messages usually use this value or a derivative of it as a way to prevent replay attacks across different networks running the same codebase but a different `agg_sig_me` value. This is optional and should almost always be omitted, as it defaults to the `genesis_challenge`. However, on `simulator0` the `agg_sig_me` differs from `genesis_challenge` and the following value is used instead.

```toml
[[networks]]
agg_sig_me = "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb"
```

### dns_introducers

A DNS introducer (also known as a seeder) provides the ability to perform a DNS host lookup to find a list of reliable full node peers to connect to with the light wallet protocol.

```toml
[[networks]]
dns_introducers = ["dns-introducer.chia.net"]
```

### peer_introducers

With some DNS servers, the DNS introducers may be blocked or otherwise unreliable, so there's a backup introducer system provided where you can connect directly to a single peer and request other peers from it with the peer protocol.

```toml
[[networks]]
dns_introducers = ["introducer.chia.net"]
```

### inherit

You can inherit from either `mainnet` or `testnet11`, which are the default networks provided by Sage. This will automatically manage `dns_introducers` and `peer_introducers` for you, so you don't have to specify them manually. Any items you add to the list will be appended to the defaults rather than replace them. If you wish you override the defaults, you can simply remove `inherit`.

```toml
[[networks]]
inherit = "mainnet"
```

## wallets.toml

This file provides a list of wallet objects, each prefixed with `[[wallets]]`. There are also a few defaults, which are used unless overridden.

For example:

```toml
[defaults]
delta_sync = true

[defaults.change]
mode = "same"

[defaults.derivation]
mode = "auto"
derivation_batch_size = 1000

[[wallets]]
name = "Main"
fingerprint = 1239439275
network = "mainnet"
```

### defaults.delta_sync

Delta sync is enabled by default. During initial sync, the wallet will use a peer to subscribe to each of its p2 puzzle hashes (addresses) and coin ids. If delta sync is enabled, it will start from the previous peak height instead of downloading all of the coins every time. This is an optimization, but it can lead to data loss if a race condition occurs - for example, if a p2 puzzle hash or coin id is inserted into the database but the app is restarted before it finishes syncing it. In the case of lost data, a resync is required.

### defaults.change

The mode can be one of the following:

- `default` - is currently set to `same`, but may change in the future unless manually set
- `same` - reuses the first address among coins you are spending as the change address
- `new` - uses the next unused address to increase transaction privacy

```toml
[defaults.change]
mode = "same"
```

### defaults.derivation

The mode can be one of the following:

- `default` - is currently set to `auto`, but may change in the future unless manually set
- `auto` - when the number of unused unhardened addresses is running low, a new batch will be generated
- `static` - only existing addresses will be used, no new ones will be generated automatically

```toml
[defaults.derivation]
mode = "auto"
derivation_batch_size = 1000
```

### name

The name is used for display purposes only.

```toml
[[wallets]]
name = "Main"
```

### fingerprint

The process for calculating a fingerprint is as follows:

1. Convert the master public key to bytes
2. Calculate the sha256 hash
3. Convert the first 4 bytes of the hash to a 32 bit unsigned integer

This fingerprint is used for internal identification purposes, and is not considered sensitive information, nor enough to securely prove authenticity. The chance of a collision with this amount of entropy is low in practice but possible, especially by brute force.

```toml
[[wallets]]
fingerprint = 1239439275
```

### delta_sync

This is a per-wallet override for `defaults.delta_sync`, although it's not currently exposed to the UI to reduce complexity:

```toml
[[wallets]]
delta_sync = false
```

### change

The same as `defaults.change`, although it would take the following form (after the initial `[[wallets]]` settings):

```toml
[wallets.change]
mode = "same"
```

### derivation

The same as `defaults.derivation`, although it would take the following form (after the initial `[[wallets]]` settings):

```toml
[wallets.derivation]
mode = "auto"
derivation_batch_size = 1000
```

### network

A network override, for when you want the wallet to use a different network than the `default_network` automatically. When you log into the wallet, the network you're connected to will switch, and when you log out it will switch back to the default. This is especially useful if you have a wallet that is dedicated to testing, but you want your other wallets to use mainnet.

```toml
[[wallets]]
network = "testnet11"
```
