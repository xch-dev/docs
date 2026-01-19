---
slug: /sdk/actions
title: Action System
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Action System

The Action System is a high-level, declarative API for building Chia blockchain transactions. Instead of manually constructing coin spends, puzzles, and solutions, you declare *what* you want to do using actions, and the system generates the appropriate spend bundles.

## Overview

The action system solves several challenges in transaction construction:

- **Complexity reduction** - No need to understand CLVM puzzles, conditions, and solutions directly
- **Transaction composition** - Easily combine multiple operations in a single transaction
- **Asset tracking** - Automatic handling of coin IDs, amounts, and asset types
- **Delta calculation** - Automatic balancing of inputs and outputs across all assets

## Key Types

| Type | Description |
|------|-------------|
| `Action` | A declarative operation (send, mint, issue, etc.) |
| `Spends` | Orchestrates actions and manages coin selection |
| `Deltas` | Tracks input/output requirements per asset |
| `Id` | Identifies assets (XCH, existing CAT/NFT, or newly created) |
| `Outputs` | Results of a completed transaction |

## Asset Identification with Id

The `Id` type identifies assets in the action system:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Reference native XCH
let xch = Id::Xch;

// Reference an existing asset by its ID (CAT asset ID, NFT launcher ID, etc.)
let existing_cat = Id::Existing(asset_id);

// Reference a new asset created in the current transaction
// The index refers to the action that creates the asset
let new_asset = Id::New(0);  // First action that creates an asset
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Id } from "chia-wallet-sdk";

// Reference native XCH
const xch = Id.xch();

// Reference an existing asset by its ID
const existingCat = Id.existing(assetId);

// Reference a new asset created in the current transaction
const newAsset = Id.new(0n);  // First action that creates an asset

// Check asset type
if (xch.isXch()) { /* ... */ }
const assetBytes = existingCat.asExisting();  // Returns Uint8Array or null
const index = newAsset.asNew();  // Returns bigint or null
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Id

# Reference native XCH
xch = Id.xch()

# Reference an existing asset by its ID
existing_cat = Id.existing(asset_id)

# Reference a new asset created in the current transaction
new_asset = Id.new(0)  # First action that creates an asset

# Check asset type
if xch.is_xch():
    pass
asset_bytes = existing_cat.as_existing()  # Returns bytes or None
index = new_asset.as_new()  # Returns int or None
```

  </TabItem>
</Tabs>

## Creating Actions

Actions are created using static factory methods on the `Action` class/enum.

### Send Action

Send assets to a puzzle hash:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

// Send XCH
let send_xch = Action::send(Id::Xch, recipient_puzzle_hash, 1000, Memos::None);

// Send a CAT
let send_cat = Action::send(Id::Existing(asset_id), recipient_puzzle_hash, 500, memos);

// Send a newly created asset (from action at index 0)
let send_new = Action::send(Id::New(0), recipient_puzzle_hash, 100, memos);

// Burn assets (send to unspendable address)
let burn = Action::burn(Id::Xch, 1000, Memos::None);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Action, Id } from "chia-wallet-sdk";

// Send XCH
const sendXch = Action.send(Id.xch(), recipientPuzzleHash, 1000n);

// Send a CAT
const sendCat = Action.send(Id.existing(assetId), recipientPuzzleHash, 500n);

// Send a newly created asset (from action at index 0)
const sendNew = Action.send(Id.new(0n), recipientPuzzleHash, 100n);

// With memos for hints
const sendWithMemo = Action.send(Id.xch(), recipientPuzzleHash, 1000n, memoProgram);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Action, Id

# Send XCH
send_xch = Action.send(Id.xch(), recipient_puzzle_hash, 1000)

# Send a CAT
send_cat = Action.send(Id.existing(asset_id), recipient_puzzle_hash, 500)

# Send a newly created asset (from action at index 0)
send_new = Action.send(Id.new(0), recipient_puzzle_hash, 100)

# With memos for hints
send_with_memo = Action.send(Id.xch(), recipient_puzzle_hash, 1000, memo_program)
```

  </TabItem>
</Tabs>

### Fee Action

Reserve XCH for transaction fees:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let fee = Action::fee(1000);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const fee = Action.fee(1000n);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
fee = Action.fee(1000)
```

  </TabItem>
</Tabs>

### CAT Issuance Actions

Issue new Chia Asset Tokens:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Single issuance CAT (genesis by coin ID - can only mint once)
let issue = Action::single_issue_cat(hidden_puzzle_hash, 1_000_000);

// Multi-issuance CAT with custom TAIL
let issue_with_tail = Action::issue_cat(tail_spend, hidden_puzzle_hash, 1_000_000);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Single issuance CAT (genesis by coin ID - can only mint once)
const issue = Action.singleIssueCat(null, 1_000_000n);

// Multi-issuance CAT with custom TAIL
const issueWithTail = Action.issueCat(tailSpend, null, 1_000_000n);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Single issuance CAT (genesis by coin ID - can only mint once)
issue = Action.single_issue_cat(None, 1_000_000)

# Multi-issuance CAT with custom TAIL
issue_with_tail = Action.issue_cat(tail_spend, None, 1_000_000)
```

  </TabItem>
</Tabs>

### NFT Actions

Mint and update NFTs:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Mint an NFT
let mint = Action::mint_nft(
    metadata,                    // NFT metadata (HashedPtr)
    metadata_updater_puzzle,     // Puzzle hash for metadata updates
    royalty_puzzle_hash,         // Where royalties are paid
    royalty_basis_points,        // Royalty percentage (300 = 3%)
    amount,                      // Amount (usually 1)
);

// Mint an empty NFT with defaults
let mint_empty = Action::mint_empty_nft();

// Update an existing NFT's metadata
let update = Action::update_nft(
    Id::Existing(launcher_id),
    metadata_spends,             // Spends that update metadata
    transfer,                    // Optional transfer info
);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Action, NftMetadata, Constants, Spend } from "chia-wallet-sdk";

// Define metadata
const metadata = new NftMetadata(
  1n,                                    // edition number
  1n,                                    // edition total
  ["https://example.com/image.png"],     // data URIs
  null,                                  // data hash
  ["https://example.com/metadata.json"], // metadata URIs
  null,                                  // metadata hash
  [],                                    // license URIs
  null                                   // license hash
);

// Mint an NFT
const mint = Action.mintNft(
  clvm,
  clvm.nftMetadata(metadata),
  Constants.nftMetadataUpdaterDefaultHash(),
  royaltyPuzzleHash,
  300,   // 3% royalty
  1n,    // amount
  null   // parent ID (optional)
);

// Update NFT metadata
const metadataUpdate = new Spend(
  clvm.nftMetadataUpdaterDefault(),
  clvm.list([clvm.string("u"), clvm.string("https://example.com/new-uri")])
);
const update = Action.updateNft(Id.existing(launcherId), [metadataUpdate]);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Action, NftMetadata, Constants, Spend, Id

# Define metadata
metadata = NftMetadata(
    1,                                    # edition number
    1,                                    # edition total
    ["https://example.com/image.png"],    # data URIs
    None,                                 # data hash
    ["https://example.com/metadata.json"], # metadata URIs
    None,                                 # metadata hash
    [],                                   # license URIs
    None                                  # license hash
)

# Mint an NFT
mint = Action.mint_nft(
    clvm,
    clvm.nft_metadata(metadata),
    Constants.nft_metadata_updater_default_hash(),
    royalty_puzzle_hash,
    300,   # 3% royalty
    1,     # amount
    None   # parent ID (optional)
)

# Update NFT metadata
metadata_update = Spend(
    clvm.nft_metadata_updater_default(),
    clvm.list([clvm.string("u"), clvm.string("https://example.com/new-uri")])
)
update = Action.update_nft(Id.existing(launcher_id), [metadata_update])
```

  </TabItem>
</Tabs>

## Using the Spends Orchestrator

The `Spends` struct orchestrates actions and manages the transaction building process.

### Basic Workflow

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// 1. Create Spends with a change puzzle hash
let mut spends = Spends::new(change_puzzle_hash);

// 2. Add coins to spend
spends.add(xch_coin);
spends.add_cat(cat);

// 3. Apply actions and get deltas
let deltas = spends.apply(ctx, &[
    Action::send(Id::Xch, recipient, 500, Memos::None),
    Action::fee(100),
])?;

// 4. Finish with signing keys
let outputs = spends.finish_with_keys(
    ctx,
    &deltas,
    Relation::None,
    &indexmap! { puzzle_hash => public_key },
)?;

// 5. Extract coin spends
let coin_spends = ctx.take();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Action, Clvm, Id, Spends, Simulator, standardPuzzleHash, BlsPair } from "chia-wallet-sdk";

const sim = new Simulator();
const clvm = new Clvm();

// Create a wallet
const pair = BlsPair.fromSeed(0n);
const puzzleHash = standardPuzzleHash(pair.pk);
sim.newCoin(puzzleHash, 1000n);

// 1. Create Spends with a change puzzle hash
const spends = new Spends(clvm, puzzleHash);

// 2. Add coins to spend
const coins = sim.unspentCoins(puzzleHash, false);
for (const coin of coins) {
  spends.addXch(coin);
}

// 3. Apply actions and get deltas
const deltas = spends.apply([
  Action.send(Id.xch(), recipientPuzzleHash, 500n),
  Action.fee(100n),
]);

// 4. Prepare the spends
const finished = spends.prepare(deltas);

// 5. Insert p2 spends for each pending coin
for (const spend of finished.pendingSpends()) {
  finished.insert(
    spend.coin().coinId(),
    clvm.standardSpend(pair.pk, clvm.delegatedSpend(spend.conditions()))
  );
}

// 6. Execute and get outputs
const outputs = finished.spend();

// 7. Sign and broadcast
sim.spendCoins(clvm.coinSpends(), [pair.sk]);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Action, Clvm, Id, Spends, Simulator, standard_puzzle_hash, BlsPair

sim = Simulator()
clvm = Clvm()

# Create a wallet
pair = BlsPair.from_seed(0)
puzzle_hash = standard_puzzle_hash(pair.pk)
sim.new_coin(puzzle_hash, 1000)

# 1. Create Spends with a change puzzle hash
spends = Spends(clvm, puzzle_hash)

# 2. Add coins to spend
coins = sim.unspent_coins(puzzle_hash, False)
for coin in coins:
    spends.add_xch(coin)

# 3. Apply actions and get deltas
deltas = spends.apply([
    Action.send(Id.xch(), recipient_puzzle_hash, 500),
    Action.fee(100),
])

# 4. Prepare the spends
finished = spends.prepare(deltas)

# 5. Insert p2 spends for each pending coin
for spend in finished.pending_spends():
    finished.insert(
        spend.coin().coin_id(),
        clvm.standard_spend(pair.pk, clvm.delegated_spend(spend.conditions()))
    )

# 6. Execute and get outputs
outputs = finished.spend()

# 7. Sign and broadcast
sim.spend_coins(clvm.coin_spends(), [pair.sk])
```

  </TabItem>
</Tabs>

## Understanding Deltas

Deltas track the input/output requirements for each asset type in a transaction. This enables automatic coin selection and change calculation.

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Calculate deltas from actions
let deltas = Deltas::from_actions(&actions);

// Check requirements for a specific asset
if let Some(delta) = deltas.get(&Id::Xch) {
    println!("XCH input needed: {}", delta.input);
    println!("XCH output created: {}", delta.output);
}

// Check which assets are needed
for id in deltas.needed() {
    println!("Need to provide: {:?}", id);
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Deltas, Delta, Id } from "chia-wallet-sdk";

// Calculate deltas from actions
const deltas = Deltas.fromActions(actions);

// Iterate over all assets
for (const id of deltas.ids()) {
  const delta = deltas.get(id) ?? new Delta(0n, 0n);
  console.log(`Asset ${id}: input=${delta.input}, output=${delta.output}`);
}

// Check if an asset needs to be provided
if (deltas.isNeeded(Id.xch())) {
  console.log("Need to provide XCH");
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Deltas, Delta, Id

# Calculate deltas from actions
deltas = Deltas.from_actions(actions)

# Iterate over all assets
for id in deltas.ids():
    delta = deltas.get(id) or Delta(0, 0)
    print(f"Asset {id}: input={delta.input}, output={delta.output}")

# Check if an asset needs to be provided
if deltas.is_needed(Id.xch()):
    print("Need to provide XCH")
```

  </TabItem>
</Tabs>

## Working with Outputs

After completing a transaction, the `Outputs` struct provides access to the created assets:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// Get created XCH coins
for coin in &outputs.xch {
    println!("Created XCH coin: {} mojos", coin.amount);
}

// Get created CATs by asset ID
for (id, cats) in &outputs.cats {
    for cat in cats {
        println!("Created CAT: {} of {:?}", cat.coin.amount, id);
    }
}

// Access fee amount
println!("Fee: {} mojos", outputs.fee);
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Get all CAT asset IDs in the outputs
const catIds = outputs.cats();

// Get CATs for a specific asset
const cats = outputs.cat(catIds[0]);
for (const cat of cats) {
  console.log(`Created CAT: ${cat.coin.amount}`);
}

// Get all NFT IDs in the outputs
const nftIds = outputs.nfts();

// Get a specific NFT
const nft = outputs.nft(nftIds[0]);
console.log(`NFT launcher ID: ${Buffer.from(nft.info.launcherId).toString("hex")}`);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Get all CAT asset IDs in the outputs
cat_ids = outputs.cats()

# Get CATs for a specific asset
cats = outputs.cat(cat_ids[0])
for cat in cats:
    print(f"Created CAT: {cat.coin.amount}")

# Get all NFT IDs in the outputs
nft_ids = outputs.nfts()

# Get a specific NFT
nft = outputs.nft(nft_ids[0])
print(f"NFT launcher ID: {nft.info.launcher_id.hex()}")
```

  </TabItem>
</Tabs>

## Complete Examples

### Send XCH

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

fn send_xch(
    coin: Coin,
    sender_pk: PublicKey,
    recipient: Bytes32,
    amount: u64,
    fee: u64,
) -> Result<Vec<CoinSpend>, DriverError> {
    let ctx = &mut SpendContext::new();
    let sender_ph = StandardLayer::puzzle_hash(sender_pk);

    let mut spends = Spends::new(sender_ph);
    spends.add(coin);

    let deltas = spends.apply(ctx, &[
        Action::send(Id::Xch, recipient, amount, Memos::None),
        Action::fee(fee),
    ])?;

    let _outputs = spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::None,
        &indexmap! { sender_ph => sender_pk },
    )?;

    Ok(ctx.take())
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import {
  Action, BlsPair, Clvm, Id, Simulator, Spends, standardPuzzleHash
} from "chia-wallet-sdk";

function sendXch(recipientPuzzleHash: Uint8Array, amount: bigint, fee: bigint) {
  const sim = new Simulator();
  const clvm = new Clvm();

  // Setup sender wallet
  const sender = BlsPair.fromSeed(0n);
  const senderPh = standardPuzzleHash(sender.pk);
  sim.newCoin(senderPh, 1000n);

  // Create spends
  const spends = new Spends(clvm, senderPh);
  for (const coin of sim.unspentCoins(senderPh, false)) {
    spends.addXch(coin);
  }

  // Apply actions
  const deltas = spends.apply([
    Action.send(Id.xch(), recipientPuzzleHash, amount),
    Action.fee(fee),
  ]);

  // Prepare and insert p2 spends
  const finished = spends.prepare(deltas);
  for (const spend of finished.pendingSpends()) {
    finished.insert(
      spend.coin().coinId(),
      clvm.standardSpend(sender.pk, clvm.delegatedSpend(spend.conditions()))
    );
  }

  // Execute
  const outputs = finished.spend();
  sim.spendCoins(clvm.coinSpends(), [sender.sk]);

  return outputs;
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import (
    Action, BlsPair, Clvm, Id, Simulator, Spends, standard_puzzle_hash
)

def send_xch(recipient_puzzle_hash: bytes, amount: int, fee: int):
    sim = Simulator()
    clvm = Clvm()

    # Setup sender wallet
    sender = BlsPair.from_seed(0)
    sender_ph = standard_puzzle_hash(sender.pk)
    sim.new_coin(sender_ph, 1000)

    # Create spends
    spends = Spends(clvm, sender_ph)
    for coin in sim.unspent_coins(sender_ph, False):
        spends.add_xch(coin)

    # Apply actions
    deltas = spends.apply([
        Action.send(Id.xch(), recipient_puzzle_hash, amount),
        Action.fee(fee),
    ])

    # Prepare and insert p2 spends
    finished = spends.prepare(deltas)
    for spend in finished.pending_spends():
        finished.insert(
            spend.coin().coin_id(),
            clvm.standard_spend(sender.pk, clvm.delegated_spend(spend.conditions()))
        )

    # Execute
    outputs = finished.spend()
    sim.spend_coins(clvm.coin_spends(), [sender.sk])

    return outputs
```

  </TabItem>
</Tabs>

### Issue and Send a CAT

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

fn issue_and_send_cat(
    coin: Coin,
    sender_pk: PublicKey,
    recipient: Bytes32,
    issuance_amount: u64,
    send_amount: u64,
) -> Result<(Bytes32, Vec<CoinSpend>), DriverError> {
    let ctx = &mut SpendContext::new();
    let sender_ph = StandardLayer::puzzle_hash(sender_pk);

    let mut spends = Spends::new(sender_ph);
    spends.add(coin);

    // Issue CAT at index 0, then send from it
    let deltas = spends.apply(ctx, &[
        Action::single_issue_cat(None, issuance_amount),
        Action::send(Id::New(0), recipient, send_amount, Memos::None),
    ])?;

    let outputs = spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::None,
        &indexmap! { sender_ph => sender_pk },
    )?;

    // Get the asset ID of the newly created CAT
    let asset_id = outputs.cats.keys().next()
        .and_then(|id| if let Id::New(0) = id { Some(*id) } else { None })
        .expect("CAT should be created");

    Ok((asset_id.into(), ctx.take()))
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import {
  Action, BlsPair, Clvm, Id, Simulator, Spends, standardPuzzleHash
} from "chia-wallet-sdk";

function issueAndSendCat(
  recipientPuzzleHash: Uint8Array,
  issuanceAmount: bigint,
  sendAmount: bigint
) {
  const sim = new Simulator();
  const clvm = new Clvm();

  // Setup wallet
  const alice = BlsPair.fromSeed(0n);
  const alicePh = standardPuzzleHash(alice.pk);
  sim.newCoin(alicePh, 1n);  // Just need 1 mojo for CAT issuance

  // Create spends
  const spends = new Spends(clvm, alicePh);
  for (const coin of sim.unspentCoins(alicePh, false)) {
    spends.addXch(coin);
  }

  // Issue CAT at index 0, then send from it
  const deltas = spends.apply([
    Action.singleIssueCat(null, issuanceAmount),
    Action.send(Id.new(0n), recipientPuzzleHash, sendAmount),
  ]);

  // Prepare and insert p2 spends
  const finished = spends.prepare(deltas);
  for (const spend of finished.pendingSpends()) {
    finished.insert(
      spend.coin().coinId(),
      clvm.standardSpend(alice.pk, clvm.delegatedSpend(spend.conditions()))
    );
  }

  // Execute
  const outputs = finished.spend();
  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  // Get the CAT asset ID
  const catIds = outputs.cats();
  const assetId = outputs.cat(catIds[0])[0].info.assetId;

  return { assetId, outputs };
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import (
    Action, BlsPair, Clvm, Id, Simulator, Spends, standard_puzzle_hash
)

def issue_and_send_cat(
    recipient_puzzle_hash: bytes,
    issuance_amount: int,
    send_amount: int
):
    sim = Simulator()
    clvm = Clvm()

    # Setup wallet
    alice = BlsPair.from_seed(0)
    alice_ph = standard_puzzle_hash(alice.pk)
    sim.new_coin(alice_ph, 1)  # Just need 1 mojo for CAT issuance

    # Create spends
    spends = Spends(clvm, alice_ph)
    for coin in sim.unspent_coins(alice_ph, False):
        spends.add_xch(coin)

    # Issue CAT at index 0, then send from it
    deltas = spends.apply([
        Action.single_issue_cat(None, issuance_amount),
        Action.send(Id.new(0), recipient_puzzle_hash, send_amount),
    ])

    # Prepare and insert p2 spends
    finished = spends.prepare(deltas)
    for spend in finished.pending_spends():
        finished.insert(
            spend.coin().coin_id(),
            clvm.standard_spend(alice.pk, clvm.delegated_spend(spend.conditions()))
        )

    # Execute
    outputs = finished.spend()
    sim.spend_coins(clvm.coin_spends(), [alice.sk])

    # Get the CAT asset ID
    cat_ids = outputs.cats()
    asset_id = outputs.cat(cat_ids[0])[0].info.asset_id

    return asset_id, outputs
```

  </TabItem>
</Tabs>

### Mint and Update NFT

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

fn mint_nft(
    coin: Coin,
    minter_pk: PublicKey,
    metadata: NftMetadata,
    royalty_puzzle_hash: Bytes32,
    royalty_basis_points: u16,
) -> Result<(Bytes32, Vec<CoinSpend>), DriverError> {
    let ctx = &mut SpendContext::new();
    let minter_ph = StandardLayer::puzzle_hash(minter_pk);

    let mut spends = Spends::new(minter_ph);
    spends.add(coin);

    let deltas = spends.apply(ctx, &[
        Action::mint_nft(
            ctx.alloc(&metadata)?.into(),
            NFT_METADATA_UPDATER_PUZZLE_HASH.into(),
            royalty_puzzle_hash,
            royalty_basis_points,
            1,
        ),
    ])?;

    let outputs = spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::None,
        &indexmap! { minter_ph => minter_pk },
    )?;

    let launcher_id = outputs.nfts.keys().next()
        .and_then(|id| outputs.nfts.get(id))
        .map(|nft| nft.info.launcher_id)
        .expect("NFT should be created");

    Ok((launcher_id, ctx.take()))
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import {
  Action, BlsPair, Clvm, Constants, Id, NftMetadata,
  Simulator, Spend, Spends, standardPuzzleHash
} from "chia-wallet-sdk";

function mintAndUpdateNft() {
  const sim = new Simulator();
  const clvm = new Clvm();

  // Setup wallet
  const alice = BlsPair.fromSeed(0n);
  const alicePh = standardPuzzleHash(alice.pk);
  sim.newCoin(alicePh, 2n);

  // Define metadata
  const metadata = new NftMetadata(
    1n, 1n,
    ["https://example.com/image.png"],
    null, [], null, [], null
  );

  // Create spends
  const spends = new Spends(clvm, alicePh);
  for (const coin of sim.unspentCoins(alicePh, false)) {
    spends.addXch(coin);
  }

  // Mint NFT and update metadata in one transaction
  const metadataUpdate = new Spend(
    clvm.nftMetadataUpdaterDefault(),
    clvm.list([clvm.string("u"), clvm.string("https://example.com/updated.png")])
  );

  const deltas = spends.apply([
    Action.mintNft(
      clvm,
      clvm.nftMetadata(metadata),
      Constants.nftMetadataUpdaterDefaultHash(),
      alicePh,
      300,  // 3% royalty
      1n,
      null
    ),
    Action.updateNft(Id.new(0n), [metadataUpdate]),
  ]);

  // Prepare and insert p2 spends
  const finished = spends.prepare(deltas);
  for (const spend of finished.pendingSpends()) {
    finished.insert(
      spend.coin().coinId(),
      clvm.standardSpend(alice.pk, clvm.delegatedSpend(spend.conditions()))
    );
  }

  // Execute
  const outputs = finished.spend();
  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  const nftId = outputs.nfts()[0];
  const nft = outputs.nft(nftId);

  return { launcherId: nft.info.launcherId, outputs };
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import (
    Action, BlsPair, Clvm, Constants, Id, NftMetadata,
    Simulator, Spend, Spends, standard_puzzle_hash
)

def mint_and_update_nft():
    sim = Simulator()
    clvm = Clvm()

    # Setup wallet
    alice = BlsPair.from_seed(0)
    alice_ph = standard_puzzle_hash(alice.pk)
    sim.new_coin(alice_ph, 2)

    # Define metadata
    metadata = NftMetadata(
        1, 1,
        ["https://example.com/image.png"],
        None, [], None, [], None
    )

    # Create spends
    spends = Spends(clvm, alice_ph)
    for coin in sim.unspent_coins(alice_ph, False):
        spends.add_xch(coin)

    # Mint NFT and update metadata in one transaction
    metadata_update = Spend(
        clvm.nft_metadata_updater_default(),
        clvm.list([clvm.string("u"), clvm.string("https://example.com/updated.png")])
    )

    deltas = spends.apply([
        Action.mint_nft(
            clvm,
            clvm.nft_metadata(metadata),
            Constants.nft_metadata_updater_default_hash(),
            alice_ph,
            300,  # 3% royalty
            1,
            None
        ),
        Action.update_nft(Id.new(0), [metadata_update]),
    ])

    # Prepare and insert p2 spends
    finished = spends.prepare(deltas)
    for spend in finished.pending_spends():
        finished.insert(
            spend.coin().coin_id(),
            clvm.standard_spend(alice.pk, clvm.delegated_spend(spend.conditions()))
        )

    # Execute
    outputs = finished.spend()
    sim.spend_coins(clvm.coin_spends(), [alice.sk])

    nft_id = outputs.nfts()[0]
    nft = outputs.nft(nft_id)

    return nft.info.launcher_id, outputs
```

  </TabItem>
</Tabs>

## Action Types Reference

| Action | Description | Creates Asset |
|--------|-------------|---------------|
| `send` | Transfer assets to a puzzle hash | No |
| `burn` | Send assets to unspendable address | No |
| `fee` | Reserve XCH for transaction fees | No |
| `single_issue_cat` | Issue a single-issuance CAT | Yes (`Id::New`) |
| `issue_cat` | Issue a multi-issuance CAT with TAIL | Yes (`Id::New`) |
| `run_tail` | Execute CAT TAIL logic | No |
| `mint_nft` | Mint a new NFT | Yes (`Id::New`) |
| `update_nft` | Update NFT metadata or transfer | No |
| `create_did` | Create a DID | Yes (`Id::New`) |
| `update_did` | Update DID metadata | No |
| `settle` | Settle a payment with notarized payments | No |
| `melt_singleton` | Destroy a singleton | No |

## Best Practices

1. **Use `Id::New(index)` for chained operations** - When one action creates an asset and another action uses it, reference it by its action index
2. **Check deltas before applying** - Use `Deltas::from_actions()` to verify you have sufficient coins before committing
3. **Handle change automatically** - The action system calculates and creates change coins for you
4. **Batch related operations** - Combine multiple actions in a single transaction to reduce fees
5. **Test with Simulator** - Always validate transactions in the simulator before mainnet

## Comparison with Low-Level API

| Feature | Action System | Low-Level (SpendContext) |
|---------|--------------|--------------------------|
| Complexity | Declarative, high-level | Imperative, detailed |
| Flexibility | Covers common patterns | Full control |
| Coin management | Automatic | Manual |
| Change handling | Automatic | Manual |
| Learning curve | Lower | Higher |

Choose the action system for standard operations and the low-level API when you need precise control over puzzle construction.
