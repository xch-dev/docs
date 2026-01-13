---
slug: /sdk/primitives/standard
title: Standard (XCH)
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Standard (XCH)

The `StandardLayer` is the foundation for XCH ownership in Chia. It implements the "standard transaction" puzzle (`p2_delegated_puzzle_or_hidden_puzzle`), which allows coins to be spent by providing a signature from the owner's public key.

## Overview

Standard coins are the basic unit of XCH ownership. When you hold XCH in a wallet, your coins use the standard puzzle locked to your public key. The puzzle allows spending by:

1. Providing a valid BLS signature from the corresponding secret key
2. Outputting conditions that define what happens (create coins, fees, etc.)

## Creating a StandardLayer

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Create a layer from a public key
let p2 = StandardLayer::new(public_key);

// The puzzle hash can be computed from the public key
let puzzle_hash = StandardLayer::puzzle_hash(public_key);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { standardPuzzleHash, PublicKey } from "chia-wallet-sdk";

// The puzzle hash can be computed from a synthetic public key
const puzzleHash = standardPuzzleHash(publicKey);

// In Node.js/Python, spends are created directly via the Clvm class
// rather than through a separate layer object
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import standard_puzzle_hash, PublicKey

# The puzzle hash can be computed from a synthetic public key
puzzle_hash = standard_puzzle_hash(public_key)

# In Node.js/Python, spends are created directly via the Clvm class
# rather than through a separate layer object
```

  </TabItem>
</Tabs>

## Spending Standard Coins

### Basic Spend

The simplest spend creates a new coin and optionally pays a fee:

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin } from "chia-wallet-sdk";

const clvm = new Clvm();

// Build the conditions
const conditions = [
  clvm.createCoin(recipientPuzzleHash, 900n, null),
  clvm.reserveFee(100n),
];

// Create the spend
clvm.spendStandardCoin(coin, publicKey, clvm.delegatedSpend(conditions));

const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin

clvm = Clvm()

# Build the conditions
conditions = [
    clvm.create_coin(recipient_puzzle_hash, 900, None),
    clvm.reserve_fee(100),
]

# Create the spend
clvm.spend_standard_coin(coin, public_key, clvm.delegated_spend(conditions))

coin_spends = clvm.coin_spends()
```

  </TabItem>
</Tabs>

### Sending with Hints

Hints help wallets discover coins. Add the recipient's puzzle hash as a memo:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let ctx = &mut SpendContext::new();

let memos = ctx.hint(recipient_puzzle_hash)?;
let conditions = Conditions::new()
    .create_coin(recipient_puzzle_hash, amount, memos);

StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const clvm = new Clvm();

// Include puzzle hash as memo for coin discovery
const conditions = [
  clvm.createCoin(recipientPuzzleHash, amount, clvm.alloc([recipientPuzzleHash])),
];

clvm.spendStandardCoin(coin, publicKey, clvm.delegatedSpend(conditions));
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
clvm = Clvm()

# Include puzzle hash as memo for coin discovery
conditions = [
    clvm.create_coin(recipient_puzzle_hash, amount, clvm.alloc([recipient_puzzle_hash])),
]

clvm.spend_standard_coin(coin, public_key, clvm.delegated_spend(conditions))
```

  </TabItem>
</Tabs>

### Multiple Outputs

A single spend can create multiple output coins:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let conditions = Conditions::new()
    .create_coin(recipient_a, 500, ctx.hint(recipient_a)?)
    .create_coin(recipient_b, 400, ctx.hint(recipient_b)?)
    .reserve_fee(100);

StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const conditions = [
  clvm.createCoin(recipientA, 500n, clvm.alloc([recipientA])),
  clvm.createCoin(recipientB, 400n, clvm.alloc([recipientB])),
  clvm.reserveFee(100n),
];

clvm.spendStandardCoin(coin, publicKey, clvm.delegatedSpend(conditions));
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
conditions = [
    clvm.create_coin(recipient_a, 500, clvm.alloc([recipient_a])),
    clvm.create_coin(recipient_b, 400, clvm.alloc([recipient_b])),
    clvm.reserve_fee(100),
]

clvm.spend_standard_coin(coin, public_key, clvm.delegated_spend(conditions))
```

  </TabItem>
</Tabs>

### Spending Multiple Coins

When spending multiple coins in one transaction, you must link them using `assert_concurrent_spend` to ensure atomicity. This prevents malicious actors from separating your spends and executing them individually.

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const clvm = new Clvm();

// First coin - sends to recipient, asserts second coin is spent together
const conditions1 = [
  clvm.createCoin(recipient, 1000n, clvm.alloc([recipient])),
  clvm.assertConcurrentSpend(coin2.coinId()),
];
clvm.spendStandardCoin(coin1, pk1, clvm.delegatedSpend(conditions1));

// Second coin - pays fee, asserts first coin is spent together
const conditions2 = [
  clvm.reserveFee(100n),
  clvm.assertConcurrentSpend(coin1.coinId()),
];
clvm.spendStandardCoin(coin2, pk2, clvm.delegatedSpend(conditions2));

const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
clvm = Clvm()

# First coin - sends to recipient, asserts second coin is spent together
conditions1 = [
    clvm.create_coin(recipient, 1000, clvm.alloc([recipient])),
    clvm.assert_concurrent_spend(coin2.coin_id()),
]
clvm.spend_standard_coin(coin1, pk1, clvm.delegated_spend(conditions1))

# Second coin - pays fee, asserts first coin is spent together
conditions2 = [
    clvm.reserve_fee(100),
    clvm.assert_concurrent_spend(coin1.coin_id()),
]
clvm.spend_standard_coin(coin2, pk2, clvm.delegated_spend(conditions2))

coin_spends = clvm.coin_spends()
```

  </TabItem>
</Tabs>

:::warning
Always use `assert_concurrent_spend` when spending multiple coins together. Without it, an attacker could take your signed spend bundle and submit only some of the spends, potentially stealing funds.
:::

## Building Conditions

The `Conditions` builder provides methods for common operations:

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Conditions are built as an array of Program objects
const conditions = [
  // Create output coins
  clvm.createCoin(puzzleHash, amount, memos),

  // Transaction fee (goes to farmers)
  clvm.reserveFee(feeAmount),

  // Link multiple spends together (IMPORTANT for security)
  clvm.assertConcurrentSpend(otherCoinId),

  // Coin announcements for coordinating multi-spend transactions
  clvm.createCoinAnnouncement(message),
  clvm.assertCoinAnnouncement(announcementId),

  // Puzzle announcements
  clvm.createPuzzleAnnouncement(message),
  clvm.assertPuzzleAnnouncement(announcementId),

  // Time conditions
  clvm.assertSecondsAbsolute(timestamp),
  clvm.assertHeightAbsolute(blockHeight),
];
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Conditions are built as a list of Program objects
conditions = [
    # Create output coins
    clvm.create_coin(puzzle_hash, amount, memos),

    # Transaction fee (goes to farmers)
    clvm.reserve_fee(fee_amount),

    # Link multiple spends together (IMPORTANT for security)
    clvm.assert_concurrent_spend(other_coin_id),

    # Coin announcements for coordinating multi-spend transactions
    clvm.create_coin_announcement(message),
    clvm.assert_coin_announcement(announcement_id),

    # Puzzle announcements
    clvm.create_puzzle_announcement(message),
    clvm.assert_puzzle_announcement(announcement_id),

    # Time conditions
    clvm.assert_seconds_absolute(timestamp),
    clvm.assert_height_absolute(block_height),
]
```

  </TabItem>
</Tabs>

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

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Coin } from "chia-wallet-sdk";

// The parent coin
const parentCoin = coin;

// Conditions create a new coin
const conditions = [clvm.createCoin(recipientPuzzleHash, 900n, null)];

clvm.spendStandardCoin(parentCoin, publicKey, clvm.delegatedSpend(conditions));

// Calculate the new coin's ID
const newCoin = new Coin(parentCoin.coinId(), recipientPuzzleHash, 900n);
console.log("New coin ID:", newCoin.coinId());
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Coin

# The parent coin
parent_coin = coin

# Conditions create a new coin
conditions = [clvm.create_coin(recipient_puzzle_hash, 900, None)]

clvm.spend_standard_coin(parent_coin, public_key, clvm.delegated_spend(conditions))

# Calculate the new coin's ID
new_coin = Coin(parent_coin.coin_id(), recipient_puzzle_hash, 900)
print("New coin ID:", new_coin.coin_id())
```

  </TabItem>
</Tabs>

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

<Tabs>
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin, Simulator, standardPuzzleHash } from "chia-wallet-sdk";

function sendXch(
  sourceCoin: Coin,
  sourcePublicKey: PublicKey,
  recipientPuzzleHash: Uint8Array,
  amount: bigint,
  fee: bigint
) {
  const clvm = new Clvm();
  const sourcePuzzleHash = standardPuzzleHash(sourcePublicKey);

  // Calculate change (if any)
  const change = sourceCoin.amount - amount - fee;

  // Build conditions
  const conditions = [
    clvm.createCoin(recipientPuzzleHash, amount, clvm.alloc([recipientPuzzleHash])),
    clvm.reserveFee(fee),
  ];

  // Add change output if needed
  if (change > 0n) {
    conditions.push(
      clvm.createCoin(sourcePuzzleHash, change, clvm.alloc([sourcePuzzleHash]))
    );
  }

  // Create the spend
  clvm.spendStandardCoin(sourceCoin, sourcePublicKey, clvm.delegatedSpend(conditions));

  return clvm.coinSpends();
}

// Example usage with Simulator (handles signing automatically)
const sim = new Simulator();
const alice = sim.bls(1000n);  // Creates key pair with 1000 mojo coin

const coinSpends = sendXch(
  alice.coin,
  alice.pk,
  recipientPuzzleHash,
  900n,
  100n
);

// Simulator signs and validates the transaction
sim.spendCoins(coinSpends, [alice.sk]);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin, Simulator, standard_puzzle_hash

def send_xch(
    source_coin: Coin,
    source_public_key: PublicKey,
    recipient_puzzle_hash: bytes,
    amount: int,
    fee: int
):
    clvm = Clvm()
    source_puzzle_hash = standard_puzzle_hash(source_public_key)

    # Calculate change (if any)
    change = source_coin.amount - amount - fee

    # Build conditions
    conditions = [
        clvm.create_coin(recipient_puzzle_hash, amount, clvm.alloc([recipient_puzzle_hash])),
        clvm.reserve_fee(fee),
    ]

    # Add change output if needed
    if change > 0:
        conditions.append(
            clvm.create_coin(source_puzzle_hash, change, clvm.alloc([source_puzzle_hash]))
        )

    # Create the spend
    clvm.spend_standard_coin(source_coin, source_public_key, clvm.delegated_spend(conditions))

    return clvm.coin_spends()

# Example usage with Simulator (handles signing automatically)
sim = Simulator()
alice = sim.bls(1000)  # Creates key pair with 1000 mojo coin

coin_spends = send_xch(
    alice.coin,
    alice.pk,
    recipient_puzzle_hash,
    900,
    100
)

# Simulator signs and validates the transaction
sim.spend_coins(coin_spends, [alice.sk])
```

  </TabItem>
</Tabs>

## API Reference

For the complete `StandardLayer` API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.StandardLayer.html).
