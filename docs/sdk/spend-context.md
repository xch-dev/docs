---
slug: /sdk/spend-context
title: SpendContext
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# SpendContext

`SpendContext` is the central abstraction for building transactions in the Wallet SDK. It manages CLVM memory allocation, caches puzzle hashes for efficiency, and collects coin spends that will form your transaction.

:::info Language Bindings
In Node.js and Python, the equivalent functionality is provided by the `Clvm` class. While the API differs slightly, the core concepts remain the same: allocate CLVM values, build spends, and collect coin spends.
:::

## What SpendContext Does

SpendContext serves three primary purposes:

1. **CLVM Memory Management** - Wraps the CLVM `Allocator` to handle memory for puzzle and solution construction
2. **Puzzle Caching** - Caches compiled puzzles by their tree hash to avoid redundant serialization
3. **Spend Collection** - Accumulates `CoinSpend` objects that will be combined into a spend bundle

## Creating a SpendContext

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();
```

The `&mut` reference pattern is used throughout the SDK because most operations need to allocate CLVM nodes or add spends to the context.

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm } from "chia-wallet-sdk";

const clvm = new Clvm();
```

The `Clvm` class combines the functionality of `SpendContext` (memory management and spend collection) with direct methods for creating conditions and spending coins.

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm

clvm = Clvm()
```

The `Clvm` class combines the functionality of `SpendContext` (memory management and spend collection) with direct methods for creating conditions and spending coins.

  </TabItem>
</Tabs>

## Core Operations

### Adding Spends

The primary way to add spends is through the primitive APIs, which handle puzzle construction internally:

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// spendStandardCoin handles puzzle construction and collects spends internally
clvm.spendStandardCoin(coin, publicKey, clvm.delegatedSpend(conditions));

// For CATs and NFTs, use the dedicated methods
clvm.spendCats([catSpend]);
clvm.spendNft(nft, innerSpend);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# spend_standard_coin handles puzzle construction and collects spends internally
clvm.spend_standard_coin(coin, public_key, clvm.delegated_spend(conditions))

# For CATs and NFTs, use the dedicated methods
clvm.spend_cats([cat_spend])
clvm.spend_nft(nft, inner_spend)
```

  </TabItem>
</Tabs>

### Extracting Spends

When you're ready to sign and broadcast, extract the collected spends:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let coin_spends: Vec<CoinSpend> = ctx.take();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
coin_spends = clvm.coin_spends()
```

  </TabItem>
</Tabs>

The `take()` / `coinSpends()` / `coin_spends()` method removes all spends from the context, allowing you to reuse it for building another transaction.

### Allocating CLVM Values

When working with custom puzzles or conditions, you may need to allocate values directly:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Allocate a value to CLVM
let node_ptr = ctx.alloc(&my_value)?;

// Extract a value from CLVM
let value: MyType = ctx.extract(node_ptr)?;

// Compute tree hash of a node
let hash = ctx.tree_hash(node_ptr);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Allocate values to CLVM (returns a Program)
const program = clvm.alloc([puzzleHash, amount]);

// Get tree hash of a program
const hash = program.treeHash();

// Allocate nil (empty list)
const nil = clvm.nil();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Allocate values to CLVM (returns a Program)
program = clvm.alloc([puzzle_hash, amount])

# Get tree hash of a program
hash = program.tree_hash()

# Allocate nil (empty list)
nil = clvm.nil()
```

  </TabItem>
</Tabs>

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

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin, PublicKey, CoinSpend } from "chia-wallet-sdk";

function buildTransaction(
  coin: Coin,
  publicKey: PublicKey,
  recipient: Uint8Array,
  amount: bigint,
  fee: bigint
): CoinSpend[] {
  // 1. Create context
  const clvm = new Clvm();

  // 2. Build conditions with hints
  const conditions = [
    clvm.createCoin(recipient, amount, clvm.alloc([recipient])),
    clvm.reserveFee(fee),
  ];

  // 3. Spend the coin
  clvm.spendStandardCoin(coin, publicKey, clvm.delegatedSpend(conditions));

  // 4. Extract and return spends
  return clvm.coinSpends();
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin, PublicKey, CoinSpend
from typing import List

def build_transaction(
    coin: Coin,
    public_key: PublicKey,
    recipient: bytes,
    amount: int,
    fee: int
) -> List[CoinSpend]:
    # 1. Create context
    clvm = Clvm()

    # 2. Build conditions with hints
    conditions = [
        clvm.create_coin(recipient, amount, clvm.alloc([recipient])),
        clvm.reserve_fee(fee),
    ]

    # 3. Spend the coin
    clvm.spend_standard_coin(coin, public_key, clvm.delegated_spend(conditions))

    # 4. Extract and return spends
    return clvm.coin_spends()
```

  </TabItem>
</Tabs>

## API Reference

For the complete API, see [SpendContext in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.SpendContext.html).
