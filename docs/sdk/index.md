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

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="rust" label="Rust" default>

Add the SDK to your `Cargo.toml`:

```toml
[dependencies]
chia-wallet-sdk = "0.32"
```

For the latest version and detailed API reference, see [docs.rs/chia-wallet-sdk](https://docs.rs/chia-wallet-sdk).

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

Install via npm:

```bash
npm install chia-wallet-sdk
```

The Node.js bindings provide a similar API with JavaScript/TypeScript support. Full TypeScript type definitions are included.

  </TabItem>
  <TabItem value="python" label="Python">

Install via pip:

```bash
pip install chia-wallet-sdk
```

The Python bindings provide a Pythonic API with full type stub support for IDE autocompletion.

  </TabItem>
</Tabs>

## Quick Example

Here's a minimal example that creates and spends a standard XCH coin:

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin, Simulator } from "chia-wallet-sdk";

// Create a CLVM instance to build the transaction
const clvm = new Clvm();

// Create conditions:
// - Create a new coin with 900 mojos
// - Reserve 100 mojos as transaction fee
const conditions = [
  clvm.createCoin(puzzleHash, 900n, null),
  clvm.reserveFee(100n),
];

// Create and spend using delegated spend (p2 puzzle)
clvm.spendStandardCoin(
  coin,
  publicKey,
  clvm.delegatedSpend(conditions)
);

// Extract the coin spends for signing and broadcast
const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin, Simulator

# Create a CLVM instance to build the transaction
clvm = Clvm()

# Create conditions:
# - Create a new coin with 900 mojos
# - Reserve 100 mojos as transaction fee
conditions = [
    clvm.create_coin(puzzle_hash, 900, None),
    clvm.reserve_fee(100),
]

# Create and spend using delegated spend (p2 puzzle)
clvm.spend_standard_coin(
    coin,
    public_key,
    clvm.delegated_spend(conditions)
)

# Extract the coin spends for signing and broadcast
coin_spends = clvm.coin_spends()
```

  </TabItem>
</Tabs>

This example demonstrates the core pattern you'll use throughout the SDK:

1. **Create a context** - In Rust, use `SpendContext`; in Node.js/Python, use the `Clvm` class
2. **Build conditions** - Define what the transaction should do (create coins, fees, announcements)
3. **Spend coins** - Use primitives like `StandardLayer` (Rust) or `spendStandardCoin` (bindings)
4. **Extract and broadcast** - Take the collected spends, sign them, and submit to the network

## Core Concepts

The SDK is organized around these key abstractions:

| Concept | Rust | Node.js / Python | Description |
|---------|------|------------------|-------------|
| **Context** | `SpendContext` | `Clvm` | Transaction builder that manages memory and collects coin spends |
| **Conditions** | `Conditions` builder | Method calls (`createCoin`, etc.) | Output conditions (create coin, fees, announcements) |
| **Actions** | `Action`, `Spends` | `Action`, `Spends` | High-level declarative transaction API |
| **Primitives** | `Cat`, `Nft`, `Vault`, etc. | `spendCats`, `spendNft`, etc. | High-level APIs for Chia constructs |
| **Simulator** | `Simulator` | `Simulator` | Test transaction validation locally |

## Next Steps

- [SpendContext](/sdk/spend-context) - Understanding the core transaction builder
- [Action System](/sdk/actions) - High-level declarative transaction API
- [Standard (XCH)](/sdk/primitives/standard) - Working with basic XCH coins
- [CAT](/sdk/primitives/cat) - Issuing and spending custom asset tokens
- [NFT](/sdk/primitives/nft) - Minting and transferring NFTs
- [Vault](/sdk/primitives/vault) - Multi-signature custody

## Relationship to chia-rs

The Wallet SDK builds on top of the lower-level [chia-rs](https://github.com/Chia-Network/chia_rs) crates, providing ergonomic APIs for common operations. If you need lower-level control, the underlying types from `chia-protocol`, `clvm-traits`, and `clvmr` are re-exported through the SDK.
