---
slug: /sdk/spend-context
title: SpendContext
---

# SpendContext

`SpendContext` is the central abstraction for building transactions in the Wallet SDK. It manages CLVM memory allocation, caches puzzle hashes for efficiency, and collects coin spends that will form your transaction.

## What SpendContext Does

SpendContext serves three primary purposes:

1. **CLVM Memory Management** - Wraps the CLVM `Allocator` to handle memory for puzzle and solution construction
2. **Puzzle Caching** - Caches compiled puzzles by their tree hash to avoid redundant serialization
3. **Spend Collection** - Accumulates `CoinSpend` objects that will be combined into a spend bundle

## Creating a SpendContext

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();
```

The `&mut` reference pattern is used throughout the SDK because most operations need to allocate CLVM nodes or add spends to the context.

## Core Operations

### Adding Spends

The primary way to add spends is through the primitive APIs, which handle puzzle construction internally:

```rust
// StandardLayer handles puzzle construction and calls ctx.spend() internally
StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

For lower-level control, you can add spends directly:

```rust
// Add a pre-constructed spend
ctx.spend(coin, Spend::new(puzzle_ptr, solution_ptr))?;

// Or insert a fully serialized CoinSpend
ctx.insert(coin_spend);
```

### Extracting Spends

When you're ready to sign and broadcast, extract the collected spends:

```rust
let coin_spends: Vec<CoinSpend> = ctx.take();
```

The `take()` method removes all spends from the context, allowing you to reuse it for building another transaction.

### Allocating CLVM Values

When working with custom puzzles or conditions, you may need to allocate values directly:

```rust
// Allocate a value to CLVM
let node_ptr = ctx.alloc(&my_value)?;

// Extract a value from CLVM
let value: MyType = ctx.extract(node_ptr)?;

// Compute tree hash of a node
let hash = ctx.tree_hash(node_ptr);
```

### Serialization

Convert CLVM values to `Program` for use in coin spends:

```rust
// Standard serialization
let program = ctx.serialize(&my_value)?;

// With back-references (smaller output for repeated structures)
let program = ctx.serialize_with_backrefs(&my_value)?;
```

### Memos and Hints

The SDK provides helpers for creating memos (used for coin hints/discovery):

```rust
// Create a hint memo from a puzzle hash
let memos = ctx.hint(puzzle_hash)?;

// Create custom memos from any serializable value
let memos = ctx.memos(&[puzzle_hash, other_data])?;
```

### Currying Puzzles

For constructing curried puzzles from known modules:

```rust
// Curry arguments into a module
let curried_ptr = ctx.curry(MyModArgs { arg1, arg2 })?;
```

## Lifecycle Pattern

The typical lifecycle of a SpendContext:

```
┌─────────────────────────────────────────────────────────────┐
│  1. Create SpendContext                                     │
│     let ctx = &mut SpendContext::new();                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Build Spends                                            │
│     - Use primitive APIs (StandardLayer, Cat, Nft, etc.)    │
│     - Each call adds CoinSpends to the context              │
│     - Puzzles are cached automatically                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Extract Spends                                          │
│     let coin_spends = ctx.take();                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Sign                                                    │
│     - Calculate required signatures                         │
│     - Sign with appropriate keys                            │
│     - Create SpendBundle                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Broadcast                                               │
│     - Submit SpendBundle to network                         │
│     - Or validate with Simulator for testing                │
└─────────────────────────────────────────────────────────────┘
```

## Mental Model

Think of SpendContext as a **transaction builder** that:

- Acts as a scratchpad for constructing CLVM data structures
- Remembers puzzles you've used so they don't need to be rebuilt
- Collects all the individual coin spends that will form your transaction

The mutable reference pattern (`&mut ctx`) reflects that building a transaction is an inherently stateful operation - each spend you add modifies the context.

## Complete Example

```rust
use chia_wallet_sdk::prelude::*;

fn build_transaction(
    coin: Coin,
    public_key: PublicKey,
    recipient: Bytes32,
    amount: u64,
    fee: u64,
) -> Result<Vec<CoinSpend>, DriverError> {
    // 1. Create context
    let ctx = &mut SpendContext::new();

    // 2. Build conditions
    let memos = ctx.hint(recipient)?;
    let conditions = Conditions::new()
        .create_coin(recipient, amount, memos)
        .reserve_fee(fee);

    // 3. Spend the coin
    StandardLayer::new(public_key).spend(ctx, coin, conditions)?;

    // 4. Extract and return spends
    Ok(ctx.take())
}
```

## API Reference

For the complete API, see [SpendContext in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.SpendContext.html).
