---
slug: /sdk
title: Quick Start
---

# Wallet SDK

The Chia Wallet SDK is a Rust library for building applications that interact with the Chia blockchain. It provides high-level abstractions for creating transactions, managing coins, and working with Chia primitives like CATs, NFTs, and Vaults.

:::info
This documentation assumes familiarity with Chia blockchain concepts such as coins, puzzles, conditions, and singletons. For background, see the [Chia Documentation](https://docs.chia.net) and [Chialisp Documentation](https://chialisp.com).
:::

## Installation

Add the SDK to your `Cargo.toml`:

```toml
[dependencies]
chia-wallet-sdk = "0.32"
```

For the latest version and detailed API reference, see [docs.rs/chia-wallet-sdk](https://docs.rs/chia-wallet-sdk).

## Quick Example

Here's a minimal example that creates and spends a standard XCH coin:

```rust
use chia_wallet_sdk::prelude::*;

// Create a spend context to build the transaction
let ctx = &mut SpendContext::new();

// Define the conditions for this spend:
// - Create a new coin with 900 mojos
// - Reserve 100 mojos as transaction fee
let conditions = Conditions::new()
    .create_coin(puzzle_hash, 900, Memos::None)
    .reserve_fee(100);

// Create the spend using StandardLayer (p2 puzzle)
StandardLayer::new(public_key).spend(ctx, coin, conditions)?;

// Extract the coin spends for signing and broadcast
let coin_spends = ctx.take();
```

This example demonstrates the core pattern you'll use throughout the SDK:

1. **Create a SpendContext** - The central builder that manages CLVM allocation and collects spends
2. **Build conditions** - Define what the transaction should do (create coins, fees, announcements)
3. **Spend coins** - Use primitives like `StandardLayer` to create the actual spends
4. **Extract and broadcast** - Take the collected spends, sign them, and submit to the network

## Core Concepts

The SDK is organized around these key abstractions:

| Concept | Description |
|---------|-------------|
| **SpendContext** | Transaction builder that manages memory and collects coin spends |
| **Conditions** | Builder for output conditions (create coin, fees, announcements) |
| **Primitives** | High-level APIs for CAT, NFT, Vault, and other Chia constructs |
| **Layers** | Composable puzzle components (internal, used by primitives) |

## Next Steps

- [SpendContext](/sdk/spend-context) - Understanding the core transaction builder
- [Standard (XCH)](/sdk/primitives/standard) - Working with basic XCH coins
- [CAT](/sdk/primitives/cat) - Issuing and spending custom asset tokens
- [NFT](/sdk/primitives/nft) - Minting and transferring NFTs
- [Vault](/sdk/primitives/vault) - Multi-signature custody

## Relationship to chia-rs

The Wallet SDK builds on top of the lower-level [chia-rs](https://github.com/Chia-Network/chia_rs) crates, providing ergonomic APIs for common operations. If you need lower-level control, the underlying types from `chia-protocol`, `clvm-traits`, and `clvmr` are re-exported through the SDK.
