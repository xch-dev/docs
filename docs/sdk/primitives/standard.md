---
slug: /sdk/primitives/standard
title: Standard (XCH)
---

# Standard (XCH)

The `StandardLayer` is the foundation for XCH ownership in Chia. It implements the "standard transaction" puzzle (`p2_delegated_puzzle_or_hidden_puzzle`), which allows coins to be spent by providing a signature from the owner's public key.

## Overview

Standard coins are the basic unit of XCH ownership. When you hold XCH in a wallet, your coins use the standard puzzle locked to your public key. The puzzle allows spending by:

1. Providing a valid BLS signature from the corresponding secret key
2. Outputting conditions that define what happens (create coins, fees, etc.)

## Creating a StandardLayer

```rust
use chia_wallet_sdk::prelude::*;

// Create a layer from a public key
let p2 = StandardLayer::new(public_key);

// The puzzle hash can be computed from the public key
let puzzle_hash = StandardLayer::puzzle_hash(public_key);
```

## Spending Standard Coins

### Basic Spend

The simplest spend creates a new coin and optionally pays a fee:

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Build the conditions
let conditions = Conditions::new()
    .create_coin(recipient_puzzle_hash, 900, Memos::None)
    .reserve_fee(100);

// Create the spend
let p2 = StandardLayer::new(public_key);
p2.spend(ctx, coin, conditions)?;

let coin_spends = ctx.take();
```

### Sending with Hints

Hints help wallets discover coins. Use `ctx.hint()` to create memos containing the recipient's puzzle hash:

```rust
let ctx = &mut SpendContext::new();

let memos = ctx.hint(recipient_puzzle_hash)?;
let conditions = Conditions::new()
    .create_coin(recipient_puzzle_hash, amount, memos);

StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

### Multiple Outputs

A single spend can create multiple output coins:

```rust
let conditions = Conditions::new()
    .create_coin(recipient_a, 500, ctx.hint(recipient_a)?)
    .create_coin(recipient_b, 400, ctx.hint(recipient_b)?)
    .reserve_fee(100);

StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

### Spending Multiple Coins

When spending multiple coins in one transaction, you must link them using `assert_concurrent_spend` to ensure atomicity. This prevents malicious actors from separating your spends and executing them individually.

```rust
let ctx = &mut SpendContext::new();

// First coin - sends to recipient, asserts second coin is spent together
let conditions1 = Conditions::new()
    .create_coin(recipient, 1000, ctx.hint(recipient)?)
    .assert_concurrent_spend(coin2.coin_id());
StandardLayer::new(pk1).spend(ctx, coin1, conditions1)?;

// Second coin - pays fee, asserts first coin is spent together
let conditions2 = Conditions::new()
    .reserve_fee(100)
    .assert_concurrent_spend(coin1.coin_id());
StandardLayer::new(pk2).spend(ctx, coin2, conditions2)?;

let coin_spends = ctx.take();
```

:::warning
Always use `assert_concurrent_spend` when spending multiple coins together. Without it, an attacker could take your signed spend bundle and submit only some of the spends, potentially stealing funds.
:::

## Building Conditions

The `Conditions` builder provides methods for common operations:

```rust
Conditions::new()
    // Create output coins
    .create_coin(puzzle_hash, amount, memos)

    // Transaction fee (goes to farmers)
    .reserve_fee(fee_amount)

    // Link multiple spends together (IMPORTANT for security)
    .assert_concurrent_spend(other_coin_id)

    // Coin announcements for coordinating multi-spend transactions
    .create_coin_announcement(message)
    .assert_coin_announcement(announcement_id)

    // Puzzle announcements
    .create_puzzle_announcement(message)
    .assert_puzzle_announcement(announcement_id)

    // Time conditions
    .assert_seconds_absolute(timestamp)
    .assert_height_absolute(block_height)
```

For the complete list of conditions, see the [Conditions API in docs.rs](https://docs.rs/chia-sdk-types/latest/chia_sdk_types/struct.Conditions.html).

## Using SpendWithConditions

For simpler cases, you can use `spend_with_conditions` to get a `Spend` object without immediately adding it to the context:

```rust
let p2 = StandardLayer::new(public_key);

// Get the inner spend (useful for wrapping in CAT, etc.)
let inner_spend = p2.spend_with_conditions(
    ctx,
    Conditions::new().create_coin(recipient, amount, memos),
)?;
```

This is particularly useful when the standard spend needs to be wrapped by another layer (like CAT or NFT).

## Calculating the New Coin

After spending, you often need to reference the newly created coin:

```rust
// The parent coin
let parent_coin = coin;

// Conditions create a new coin
let conditions = Conditions::new()
    .create_coin(recipient_puzzle_hash, 900, Memos::None);

StandardLayer::new(public_key).spend(ctx, parent_coin, conditions)?;

// Calculate the new coin's ID
let new_coin = Coin::new(parent_coin.coin_id(), recipient_puzzle_hash, 900);
println!("New coin ID: {}", new_coin.coin_id());
```

## Signing Transactions

After building spends, you need to sign them before broadcasting. The SDK calculates what signatures are required and you provide them.

### Basic Signing

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Build your spends
StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
let coin_spends = ctx.take();

// Calculate required signatures
let mut allocator = Allocator::new();
let required = RequiredSignature::from_coin_spends(
    &mut allocator,
    &coin_spends,
    &AggSigConstants::new(agg_sig_me_additional_data),
)?;

// Sign each requirement and aggregate
let mut aggregated_signature = Signature::default();
for req in required {
    let RequiredSignature::Bls(bls_req) = req else { continue };
    aggregated_signature += &sign(&secret_key, bls_req.message());
}

// Create the spend bundle
let spend_bundle = SpendBundle::new(coin_spends, aggregated_signature);
```

### Signing with Multiple Keys

When multiple coins are spent with different keys:

```rust
use std::collections::HashMap;

// Map public keys to secret keys for lookup
let key_pairs: HashMap<PublicKey, &SecretKey> = secret_keys
    .iter()
    .map(|sk| (sk.public_key(), sk))
    .collect();

// Sign each required signature with the correct key
let mut aggregated_signature = Signature::default();
for req in required {
    let RequiredSignature::Bls(bls_req) = req else { continue };
    let sk = key_pairs.get(&bls_req.public_key)
        .expect("missing key for signature");
    aggregated_signature += &sign(sk, bls_req.message());
}
```

### Network Constants

The `AggSigConstants` vary by network. Use the appropriate constants:

```rust
use chia_sdk_types::{MAINNET_CONSTANTS, TESTNET11_CONSTANTS};

// For mainnet
let constants = AggSigConstants::new(MAINNET_CONSTANTS.agg_sig_me_additional_data);

// For testnet11
let constants = AggSigConstants::new(TESTNET11_CONSTANTS.agg_sig_me_additional_data);
```

:::info
The signature message includes data specific to the coin being spent (coin ID, puzzle hash, etc.) combined with network-specific constants. This prevents signatures from being replayed across networks.
:::

## Complete Example

Here's a full example of building, signing, and creating a spend bundle for an XCH transfer:

```rust
use std::collections::HashMap;
use chia_wallet_sdk::prelude::*;

fn send_xch(
    source_coin: Coin,
    source_secret_key: &SecretKey,
    recipient_puzzle_hash: Bytes32,
    amount: u64,
    fee: u64,
    agg_sig_data: Bytes32,  // Network-specific (e.g., MAINNET_CONSTANTS.agg_sig_me_additional_data)
) -> Result<SpendBundle, DriverError> {
    let ctx = &mut SpendContext::new();
    let source_public_key = source_secret_key.public_key();

    // Calculate change (if any)
    let change = source_coin.amount - amount - fee;
    let source_puzzle_hash = StandardLayer::puzzle_hash(source_public_key);

    // Build conditions
    let mut conditions = Conditions::new()
        .create_coin(recipient_puzzle_hash, amount, ctx.hint(recipient_puzzle_hash)?)
        .reserve_fee(fee);

    // Add change output if needed
    if change > 0 {
        conditions = conditions.create_coin(
            source_puzzle_hash,
            change,
            ctx.hint(source_puzzle_hash)?
        );
    }

    // Create the spend
    StandardLayer::new(source_public_key).spend(ctx, source_coin, conditions)?;
    let coin_spends = ctx.take();

    // Calculate required signatures
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        &coin_spends,
        &AggSigConstants::new(agg_sig_data),
    )?;

    // Sign and aggregate
    let mut aggregated_signature = Signature::default();
    for req in required {
        let RequiredSignature::Bls(bls_req) = req else { continue };
        aggregated_signature += &sign(source_secret_key, bls_req.message());
    }

    // Return complete spend bundle
    Ok(SpendBundle::new(coin_spends, aggregated_signature))
}
```

## API Reference

For the complete `StandardLayer` API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.StandardLayer.html).
