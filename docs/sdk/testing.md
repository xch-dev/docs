---
slug: /sdk/testing
title: Testing
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Testing

The SDK includes a built-in simulator for testing transactions without connecting to a real network. This enables fast, deterministic testing of your Chia applications.

## Overview

The `chia-sdk-test` crate provides:

- **Simulator** - An in-memory blockchain for validation
- **Test utilities** - Helpers for creating keys and coins
- **Spend validation** - Verify transactions before broadcast

## Setting Up the Simulator

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Create a new simulator instance
let mut sim = Simulator::new();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Simulator } from "chia-wallet-sdk";

// Create a new simulator instance
const sim = new Simulator();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Simulator

# Create a new simulator instance
sim = Simulator()
```

  </TabItem>
</Tabs>

The simulator starts with an empty state. You'll need to create coins before you can spend them.

## Creating Test Keys and Coins

The simulator provides helpers for creating BLS key pairs with funded coins:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Create a key pair with a coin worth 1000 mojos
let alice = sim.bls(1_000);

// alice contains:
// - alice.pk: PublicKey
// - alice.sk: SecretKey
// - alice.puzzle_hash: Bytes32
// - alice.coin: Coin

// Create multiple test identities
let alice = sim.bls(1_000_000);
let bob = sim.bls(500_000);
let charlie = sim.bls(0);  // No initial funds
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Create a key pair with a coin worth 1000 mojos
const alice = sim.bls(1000n);

// alice contains:
// - alice.pk: PublicKey
// - alice.sk: SecretKey
// - alice.puzzleHash: Uint8Array
// - alice.coin: Coin

// Create multiple test identities
const alice = sim.bls(1_000_000n);
const bob = sim.bls(500_000n);
const charlie = sim.bls(0n);  // No initial funds
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Create a key pair with a coin worth 1000 mojos
alice = sim.bls(1000)

# alice contains:
# - alice.pk: PublicKey
# - alice.sk: SecretKey
# - alice.puzzle_hash: bytes
# - alice.coin: Coin

# Create multiple test identities
alice = sim.bls(1_000_000)
bob = sim.bls(500_000)
charlie = sim.bls(0)  # No initial funds
```

  </TabItem>
</Tabs>

## Validating Transactions

After building a transaction, validate it with the simulator:

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const clvm = new Clvm();

// Build your transaction
const conditions = [
  clvm.createCoin(bob.puzzleHash, 900n, null),
  clvm.reserveFee(100n),
];

clvm.spendStandardCoin(alice.coin, alice.pk, clvm.delegatedSpend(conditions));

// Extract spends and validate
const coinSpends = clvm.coinSpends();
sim.spendCoins(coinSpends, [alice.sk]);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
clvm = Clvm()

# Build your transaction
conditions = [
    clvm.create_coin(bob.puzzle_hash, 900, None),
    clvm.reserve_fee(100),
]

clvm.spend_standard_coin(alice.coin, alice.pk, clvm.delegated_spend(conditions))

# Extract spends and validate
coin_spends = clvm.coin_spends()
sim.spend_coins(coin_spends, [alice.sk])
```

  </TabItem>
</Tabs>

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

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import test from "ava";
import { Clvm, Simulator } from "chia-wallet-sdk";

test("simple transfer", (t) => {
  const sim = new Simulator();
  const clvm = new Clvm();

  const alice = sim.bls(1000n);
  const bobPuzzleHash = sim.bls(0n).puzzleHash;

  const conditions = [
    clvm.createCoin(bobPuzzleHash, 900n, null),
    clvm.reserveFee(100n),
  ];

  clvm.spendStandardCoin(alice.coin, alice.pk, clvm.delegatedSpend(conditions));
  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  t.pass();
});
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
import pytest
from chia_wallet_sdk import Clvm, Simulator

def test_simple_transfer():
    sim = Simulator()
    clvm = Clvm()

    alice = sim.bls(1000)
    bob_puzzle_hash = sim.bls(0).puzzle_hash

    conditions = [
        clvm.create_coin(bob_puzzle_hash, 900, None),
        clvm.reserve_fee(100),
    ]

    clvm.spend_standard_coin(alice.coin, alice.pk, clvm.delegated_spend(conditions))
    sim.spend_coins(clvm.coin_spends(), [alice.sk])
```

  </TabItem>
</Tabs>

### Testing CAT Operations

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import test from "ava";
import { Cat, CatInfo, CatSpend, Clvm, Coin, Simulator } from "chia-wallet-sdk";

test("issues and spends a cat", (t) => {
  const sim = new Simulator();
  const clvm = new Clvm();

  const alice = sim.bls(1n);

  const tail = clvm.nil();
  const assetId = tail.treeHash();
  const catInfo = new CatInfo(assetId, null, alice.puzzleHash);

  // Issue a CAT
  clvm.spendStandardCoin(
    alice.coin,
    alice.pk,
    clvm.delegatedSpend([clvm.createCoin(catInfo.puzzleHash(), 1n)])
  );

  const eve = new Cat(
    new Coin(alice.coin.coinId(), catInfo.puzzleHash(), 1n),
    null,
    catInfo
  );

  clvm.spendCats([
    new CatSpend(
      eve,
      clvm.standardSpend(
        alice.pk,
        clvm.delegatedSpend([
          clvm.createCoin(alice.puzzleHash, 1n, clvm.alloc([alice.puzzleHash])),
          clvm.runCatTail(tail, clvm.nil()),
        ])
      )
    ),
  ]);

  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  t.pass();
});
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Cat, CatInfo, CatSpend, Clvm, Coin, Simulator

def test_issues_and_spends_a_cat():
    sim = Simulator()
    clvm = Clvm()

    alice = sim.bls(1)

    tail = clvm.nil()
    asset_id = tail.tree_hash()
    cat_info = CatInfo(asset_id, None, alice.puzzle_hash)

    # Issue a CAT
    clvm.spend_standard_coin(
        alice.coin,
        alice.pk,
        clvm.delegated_spend([clvm.create_coin(cat_info.puzzle_hash(), 1)])
    )

    eve = Cat(
        Coin(alice.coin.coin_id(), cat_info.puzzle_hash(), 1),
        None,
        cat_info
    )

    clvm.spend_cats([
        CatSpend(
            eve,
            clvm.standard_spend(
                alice.pk,
                clvm.delegated_spend([
                    clvm.create_coin(alice.puzzle_hash, 1, clvm.alloc([alice.puzzle_hash])),
                    clvm.run_cat_tail(tail, clvm.nil()),
                ])
            )
        ),
    ])

    sim.spend_coins(clvm.coin_spends(), [alice.sk])
```

  </TabItem>
</Tabs>

### Testing Invalid Transactions

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
test("insufficient funds fails", (t) => {
  const sim = new Simulator();
  const clvm = new Clvm();

  const alice = sim.bls(1000n);

  // Try to create more than we have
  const conditions = [clvm.createCoin(alice.puzzleHash, 2000n, null)];

  clvm.spendStandardCoin(alice.coin, alice.pk, clvm.delegatedSpend(conditions));

  // This should throw an error
  t.throws(() => {
    sim.spendCoins(clvm.coinSpends(), [alice.sk]);
  });
});
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
def test_insufficient_funds_fails():
    sim = Simulator()
    clvm = Clvm()

    alice = sim.bls(1000)

    # Try to create more than we have
    conditions = [clvm.create_coin(alice.puzzle_hash, 2000, None)]

    clvm.spend_standard_coin(alice.coin, alice.pk, clvm.delegated_spend(conditions))

    # This should raise an exception
    with pytest.raises(Exception):
        sim.spend_coins(clvm.coin_spends(), [alice.sk])
```

  </TabItem>
</Tabs>

### Testing Multi-Spend Transactions

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
test("multi spend", (t) => {
  const sim = new Simulator();
  const clvm = new Clvm();

  const alice = sim.bls(1000n);
  const bob = sim.bls(500n);
  const charliePh = sim.bls(0n).puzzleHash;

  // Alice sends 900
  clvm.spendStandardCoin(
    alice.coin,
    alice.pk,
    clvm.delegatedSpend([clvm.createCoin(charliePh, 900n, null)])
  );

  // Bob pays the fee
  clvm.spendStandardCoin(
    bob.coin,
    bob.pk,
    clvm.delegatedSpend([
      clvm.createCoin(bob.puzzleHash, 400n, null),
      clvm.reserveFee(100n),
    ])
  );

  sim.spendCoins(clvm.coinSpends(), [alice.sk, bob.sk]);

  t.pass();
});
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
def test_multi_spend():
    sim = Simulator()
    clvm = Clvm()

    alice = sim.bls(1000)
    bob = sim.bls(500)
    charlie_ph = sim.bls(0).puzzle_hash

    # Alice sends 900
    clvm.spend_standard_coin(
        alice.coin,
        alice.pk,
        clvm.delegated_spend([clvm.create_coin(charlie_ph, 900, None)])
    )

    # Bob pays the fee
    clvm.spend_standard_coin(
        bob.coin,
        bob.pk,
        clvm.delegated_spend([
            clvm.create_coin(bob.puzzle_hash, 400, None),
            clvm.reserve_fee(100),
        ])
    )

    sim.spend_coins(clvm.coin_spends(), [alice.sk, bob.sk])
```

  </TabItem>
</Tabs>

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
