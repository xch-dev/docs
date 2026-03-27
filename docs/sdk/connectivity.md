---
slug: /sdk/connectivity
title: Connectivity
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Connectivity

The Wallet SDK provides client crates for connecting to the Chia network. This page covers the basics of establishing connections and querying blockchain state.

## Overview

The SDK includes two client approaches:

| Crate | Use Case |
|-------|----------|
| `chia-sdk-client` | Direct peer-to-peer connections using the Chia protocol |
| `chia-sdk-coinset` | HTTP/RPC client for querying coin state |

## Peer Connections

The `Peer` type provides direct connections to Chia full nodes using the native protocol:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Connect to a peer
let peer = Peer::connect(
    "node.example.com:8444",
    network_id,
    tls_connector,
).await?;

// Query coin state
let coin_states = peer.request_coin_state(
    coin_ids,
    None,  // previous_height
    genesis_challenge,
).await?;
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
import (
	"context"
	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

ctx := context.Background()

// Generate or load TLS certificate
cert, _ := sdk.NewCertificateGenerate()
defer cert.Close()

// Create a connector from the certificate
connector, _ := sdk.NewConnector(cert)
defer connector.Close()

// Configure peer options
options, _ := sdk.NewPeerOptions()
defer options.Close()

// Connect to a peer
peer, _ := sdk.NewPeerConnect(ctx, "mainnet", "node.example.com:8444", connector, options)
defer peer.Close()

// Query coin state
headerHash := []byte{...} // known header hash from a trusted source
coinStates, _ := peer.RequestCoinState(ctx, coinIds, nil, headerHash, false)
defer coinStates.Close()
```

  </TabItem>
</Tabs>

### Connection Requirements

Peer connections require:

- Network ID (mainnet, testnet, etc.)
- TLS configuration
- Knowledge of the genesis challenge for the network

## Coinset Client

For simpler HTTP-based queries, use `CoinsetClient`:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Create client for a coinset API endpoint
let client = CoinsetClient::new(
    "https://api.example.com",
    network_id,
);

// Query coins by puzzle hash
let coins = client.get_coins_by_puzzle_hash(puzzle_hash).await?;

// Get coin state
let states = client.get_coin_state(coin_ids).await?;
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
import (
	"context"
	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

ctx := context.Background()

// Create client for an RPC endpoint
client, _ := sdk.NewRpcClient("https://api.example.com")
defer client.Close()

// Query coins by puzzle hash
coins, _ := client.GetCoinRecordsByPuzzleHash(ctx, puzzleHash, nil, nil, nil)
defer coins.Close()

// Get blockchain state
state, _ := client.GetBlockchainState(ctx)
defer state.Close()
```

  </TabItem>
</Tabs>

## Full Node Client

For direct full node RPC access:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let client = FullNodeClient::new(
    "https://localhost:8555",
    cert_path,
    key_path,
)?;

// Use full node RPC methods
let blockchain_state = client.get_blockchain_state().await?;
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
import (
	"context"
	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

ctx := context.Background()

// The Go bindings use a single RPC client for full node access
client, _ := sdk.NewRpcClient("https://localhost:8555")
defer client.Close()

// Use full node RPC methods
state, _ := client.GetBlockchainState(ctx)
defer state.Close()
```

  </TabItem>
</Tabs>

## Broadcasting Transactions

After building a spend bundle, broadcast it to the network:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

```rust
// Build your transaction
let ctx = &mut SpendContext::new();
// ... add spends ...
let coin_spends = ctx.take();

// Sign the spend bundle
let spend_bundle = SpendBundle::new(coin_spends, aggregated_signature);

// Broadcast via peer
let response = peer.send_transaction(spend_bundle).await?;

// Or via full node client
let response = client.push_tx(spend_bundle).await?;
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
import (
	"context"
	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

ctx := context.Background()

// Build your transaction
clvm, _ := sdk.NewClvm()
defer clvm.Close()
// ... add spends ...
coinSpends, _ := clvm.CoinSpends()

// Sign the spend bundle
sb, _ := sdk.NewSpendBundle(coinSpends, aggregatedSignature)
defer sb.Close()

// Broadcast via RPC client
response, _ := client.PushTx(ctx, sb)
defer response.Close()
```

  </TabItem>
</Tabs>

## Network Configuration

Different networks require different configuration:

| Network | Default Port | Genesis Challenge |
|---------|--------------|-------------------|
| Mainnet | 8444 | See Chia docs |
| Testnet | 58444 | See Chia docs |

:::info
For production applications, consider connecting to multiple peers for redundancy and using the coinset API for efficient queries.
:::

## TLS Configuration

Peer connections require TLS. The SDK supports both `native-tls` and `rustls` backends via feature flags:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

```toml
# Use native TLS (default)
chia-wallet-sdk = { version = "0.32", features = ["native-tls"] }

# Or use rustls
chia-wallet-sdk = { version = "0.32", features = ["rustls"] }
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
// TLS is handled automatically by the Go bindings.
// Generate a new certificate:
cert, _ := sdk.NewCertificateGenerate()
defer cert.Close()

// Or load existing PEM files:
cert, _ := sdk.NewCertificateLoad("/path/to/cert.pem", "/path/to/key.pem")
defer cert.Close()
```

  </TabItem>
</Tabs>

## Beyond This Guide

Detailed network programming with the SDK is beyond the scope of this documentation. For:

- Production connection management
- Peer discovery
- Network protocol details

See the [chia-sdk-client rustdocs](https://docs.rs/chia-sdk-client) and [chia-sdk-coinset rustdocs](https://docs.rs/chia-sdk-coinset).
