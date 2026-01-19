---
slug: /sdk/connectivity
title: Connectivity
---

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

### Connection Requirements

Peer connections require:

- Network ID (mainnet, testnet, etc.)
- TLS configuration
- Knowledge of the genesis challenge for the network

## Coinset Client

For simpler HTTP-based queries, use `CoinsetClient`:

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

## Full Node Client

For direct full node RPC access:

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

## Broadcasting Transactions

After building a spend bundle, broadcast it to the network:

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

```toml
# Use native TLS (default)
chia-wallet-sdk = { version = "0.32", features = ["native-tls"] }

# Or use rustls
chia-wallet-sdk = { version = "0.32", features = ["rustls"] }
```

## Beyond This Guide

Detailed network programming with the SDK is beyond the scope of this documentation. For:

- Production connection management
- Peer discovery
- Network protocol details

See the [chia-sdk-client rustdocs](https://docs.rs/chia-sdk-client) and [chia-sdk-coinset rustdocs](https://docs.rs/chia-sdk-coinset).
