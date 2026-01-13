---
slug: /sdk/testing
title: Testing
---

# Testing

The SDK includes a built-in simulator for testing transactions without connecting to a real network. This enables fast, deterministic testing of your Chia applications.

## Overview

The `chia-sdk-test` crate provides:

- **Simulator** - An in-memory blockchain for validation
- **Test utilities** - Helpers for creating keys and coins
- **Spend validation** - Verify transactions before broadcast

## Setting Up the Simulator

```rust
use chia_wallet_sdk::prelude::*;

// Create a new simulator instance
let mut sim = Simulator::new();
```

The simulator starts with an empty state. You'll need to create coins before you can spend them.

## Creating Test Keys and Coins

The simulator provides helpers for creating BLS key pairs with funded coins:

```rust
// Create a key pair with a coin worth 1000 mojos
let alice = sim.bls(1_000);

// alice contains:
// - alice.pk: PublicKey
// - alice.sk: SecretKey
// - alice.puzzle_hash: Bytes32
// - alice.coin: Coin
```

You can create multiple test identities:

```rust
let alice = sim.bls(1_000_000);
let bob = sim.bls(500_000);
let charlie = sim.bls(0);  // No initial funds
```

## Validating Transactions

After building a transaction, validate it with the simulator:

```rust
let ctx = &mut SpendContext::new();

// Build your transaction
let conditions = Conditions::new()
    .create_coin(bob.puzzle_hash, 900, Memos::None)
    .reserve_fee(100);

StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;

// Extract spends and validate
let coin_spends = ctx.take();
sim.spend_coins(coin_spends, &[alice.sk])?;
```

If the transaction is invalid, `spend_coins` returns an error describing the failure.

## Simulator State

The simulator maintains blockchain state:

```rust
// Check if a coin exists and is unspent
let coin_state = sim.coin_state(coin_id);

// The simulator tracks:
// - Created coins
// - Spent coins
// - Current block height
```

## Testing Patterns

### Basic Transaction Test

```rust
#[test]
fn test_simple_transfer() -> Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob_puzzle_hash = sim.bls(0).puzzle_hash;

    let conditions = Conditions::new()
        .create_coin(bob_puzzle_hash, 900, Memos::None)
        .reserve_fee(100);

    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

### Testing CAT Operations

```rust
#[test]
fn test_cat_issuance() -> Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let p2 = StandardLayer::new(alice.pk);
    let memos = ctx.hint(alice.puzzle_hash)?;

    // Issue CAT
    let conditions = Conditions::new()
        .create_coin(alice.puzzle_hash, 1_000, memos);

    let (issue_cat, cats) = Cat::issue_with_coin(
        ctx,
        alice.coin.coin_id(),
        1_000,
        conditions,
    )?;

    p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Verify CAT was created
    assert_eq!(cats.len(), 1);
    assert_eq!(cats[0].coin.amount, 1_000);

    Ok(())
}
```

### Testing Invalid Transactions

```rust
#[test]
fn test_insufficient_funds_fails() {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);

    // Try to create more than we have
    let conditions = Conditions::new()
        .create_coin(alice.puzzle_hash, 2_000, Memos::None);

    StandardLayer::new(alice.pk)
        .spend(ctx, alice.coin, conditions)
        .unwrap();

    // This should fail
    let result = sim.spend_coins(ctx.take(), &[alice.sk]);
    assert!(result.is_err());
}
```

### Testing Multi-Spend Transactions

```rust
#[test]
fn test_multi_spend() -> Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = sim.bls(500);
    let charlie_ph = sim.bls(0).puzzle_hash;

    // Alice sends 900
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(charlie_ph, 900, Memos::None),
    )?;

    // Bob pays the fee
    StandardLayer::new(bob.pk).spend(
        ctx,
        bob.coin,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 400, Memos::None)
            .reserve_fee(100),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk, bob.sk])?;

    Ok(())
}
```

## Organizing Test Code

### Test Module Structure

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chia_wallet_sdk::prelude::*;

    #[test]
    fn test_feature_a() -> Result<()> {
        // ...
    }

    #[test]
    fn test_feature_b() -> Result<()> {
        // ...
    }
}
```

### Reusable Test Helpers

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test() -> (Simulator, SpendContext, BlsPairWithCoin) {
        let sim = Simulator::new();
        let ctx = SpendContext::new();
        let alice = sim.bls(1_000_000);
        (sim, ctx, alice)
    }

    #[test]
    fn test_with_helper() -> Result<()> {
        let (mut sim, ctx, alice) = setup_test();
        let ctx = &mut ctx;
        // ...
    }
}
```

## Limitations

The simulator is designed for transaction validation, not full blockchain simulation:

- No mempool simulation
- No block timing
- No network latency
- Simplified fee handling

For integration testing against real network behavior, use testnet.

## API Reference

For the complete testing API, see [chia-sdk-test on docs.rs](https://docs.rs/chia-sdk-test).
