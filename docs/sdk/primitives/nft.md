---
slug: /sdk/primitives/nft
title: NFT
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# NFT

NFTs (Non-Fungible Tokens) in Chia are singleton-based assets that can hold metadata, have ownership controls, and support royalties. Each NFT has a unique launcher ID that serves as its permanent identifier.

## Overview

Chia NFTs are built on the singleton pattern, meaning:

- Each NFT has a unique identity that persists across spends
- Only one instance of an NFT can exist at any time
- The NFT's launcher ID remains constant even as the coin ID changes

NFTs consist of multiple layers:

| Layer | Purpose |
|-------|---------|
| Singleton | Ensures uniqueness and provides the launcher ID |
| NFT State | Holds metadata URIs and hash |
| NFT Ownership | Controls transfer and royalty logic |
| Inner (p2) | Defines who can spend the NFT |

## Key Types

| Type | Description |
|------|-------------|
| `Nft<T>` | An NFT with its metadata and inner puzzle info |
| `NftInfo` | Launcher ID, metadata, owner info, royalties |
| `NftMetadata` | URIs for data, metadata, and license |
| `Proof` | Singleton lineage proof for validation |

## Minting NFTs

To mint a new NFT, use the `Nft::mint` function:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();
let p2 = StandardLayer::new(public_key);

// Define the NFT metadata
let metadata = NftMetadata {
    data_uris: vec!["https://example.com/image.png".to_string()],
    data_hash: Some(image_hash),
    metadata_uris: vec!["https://example.com/metadata.json".to_string()],
    metadata_hash: Some(metadata_hash),
    license_uris: vec![],
    license_hash: None,
    edition_number: Some(1),
    edition_total: Some(100),
};

// Mint the NFT
let (mint_conditions, nft) = Nft::mint(
    ctx,
    parent_coin_id,           // Coin being spent to mint
    owner_puzzle_hash,        // Initial owner
    Some(royalty_puzzle_hash), // Royalty recipient (or None)
    royalty_percentage,       // Royalty in basis points (e.g., 300 = 3%)
    metadata,
    owner_puzzle_hash,        // Hint for discovery
)?;

// Spend the parent coin with mint conditions
p2.spend(ctx, parent_coin, mint_conditions)?;

// The NFT's permanent identifier
let launcher_id = nft.info.launcher_id;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, NftMetadata, NftMint, Constants, Simulator } from "chia-wallet-sdk";

const clvm = new Clvm();
const sim = new Simulator();
const alice = sim.bls(1n);

// Define the NFT metadata
const metadata = new NftMetadata(
  1n,  // edition number
  1n,  // edition total
  ["https://example.com/image.png"],     // data URIs
  null,                                   // data hash (optional)
  ["https://example.com/metadata.json"], // metadata URIs
  null,                                   // metadata hash (optional)
  [],                                     // license URIs
  null                                    // license hash (optional)
);

// Mint the NFT
const { nfts, parentConditions } = clvm.mintNfts(alice.coin.coinId(), [
  new NftMint(
    clvm.nftMetadata(metadata),
    Constants.nftMetadataUpdaterDefaultHash(),
    alice.puzzleHash,     // Royalty puzzle hash
    alice.puzzleHash,     // Owner p2 puzzle hash
    300                   // Royalty in basis points (3%)
  ),
]);

// Spend the parent coin with mint conditions
clvm.spendStandardCoin(
  alice.coin,
  alice.pk,
  clvm.delegatedSpend(parentConditions)
);

// The NFT's permanent identifier
const launcherId = nfts[0].info.launcherId;
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, NftMetadata, NftMint, Constants, Simulator

clvm = Clvm()
sim = Simulator()
alice = sim.bls(1)

# Define the NFT metadata
metadata = NftMetadata(
    1,  # edition number
    1,  # edition total
    ["https://example.com/image.png"],     # data URIs
    None,                                   # data hash (optional)
    ["https://example.com/metadata.json"], # metadata URIs
    None,                                   # metadata hash (optional)
    [],                                     # license URIs
    None                                    # license hash (optional)
)

# Mint the NFT
result = clvm.mint_nfts(alice.coin.coin_id(), [
    NftMint(
        clvm.nft_metadata(metadata),
        Constants.nft_metadata_updater_default_hash(),
        alice.puzzle_hash,     # Royalty puzzle hash
        alice.puzzle_hash,     # Owner p2 puzzle hash
        300                    # Royalty in basis points (3%)
    ),
])

# Spend the parent coin with mint conditions
clvm.spend_standard_coin(
    alice.coin,
    alice.pk,
    clvm.delegated_spend(result.parent_conditions)
)

# The NFT's permanent identifier
launcher_id = result.nfts[0].info.launcher_id
```

  </TabItem>
</Tabs>

## Transferring NFTs

To transfer an NFT to a new owner:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Transfer to a new owner
let new_nft = nft.transfer(
    ctx,
    &p2,                      // Current owner's p2 layer
    new_owner_puzzle_hash,    // New owner
    Conditions::new(),        // Additional conditions (fees, etc.)
)?;

let coin_spends = ctx.take();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Transfer the NFT to a new owner
const innerSpend = clvm.standardSpend(
  alice.pk,
  clvm.delegatedSpend([
    clvm.createCoin(newOwnerPuzzleHash, 1n, clvm.alloc([newOwnerPuzzleHash])),
  ])
);

const newNft = clvm.spendNft(nft, innerSpend);

const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Transfer the NFT to a new owner
inner_spend = clvm.standard_spend(
    alice.pk,
    clvm.delegated_spend([
        clvm.create_coin(new_owner_puzzle_hash, 1, clvm.alloc([new_owner_puzzle_hash])),
    ])
)

new_nft = clvm.spend_nft(nft, inner_spend)

coin_spends = clvm.coin_spends()
```

  </TabItem>
</Tabs>

For more control over the transfer, use `transfer_with_metadata`:

```rust
let new_nft = nft.transfer_with_metadata(
    ctx,
    &p2,
    new_owner_puzzle_hash,
    updated_metadata,         // Can update metadata during transfer
    Conditions::new(),
)?;
```

## Spending NFTs with Custom Conditions

For complex operations beyond simple transfers:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let ctx = &mut SpendContext::new();

// Build conditions for the NFT spend
let conditions = Conditions::new()
    .create_coin_announcement(b"nft_action")
    .reserve_fee(fee_amount);

// Spend with custom conditions
let new_nft = nft.spend(
    ctx,
    p2.spend_with_conditions(ctx, conditions)?,
)?;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Build conditions for the NFT spend
const innerSpend = clvm.standardSpend(
  alice.pk,
  clvm.delegatedSpend([
    clvm.createCoinAnnouncement(Buffer.from("nft_action")),
    clvm.reserveFee(feeAmount),
    clvm.createCoin(newOwnerPuzzleHash, 1n, clvm.alloc([newOwnerPuzzleHash])),
  ])
);

// Spend with custom conditions
const newNft = clvm.spendNft(nft, innerSpend);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Build conditions for the NFT spend
inner_spend = clvm.standard_spend(
    alice.pk,
    clvm.delegated_spend([
        clvm.create_coin_announcement(b"nft_action"),
        clvm.reserve_fee(fee_amount),
        clvm.create_coin(new_owner_puzzle_hash, 1, clvm.alloc([new_owner_puzzle_hash])),
    ])
)

# Spend with custom conditions
new_nft = clvm.spend_nft(nft, inner_spend)
```

  </TabItem>
</Tabs>

## Royalties

NFTs support royalties that are enforced during trades. The royalty is specified as a percentage in basis points (1/100th of a percent):

| Basis Points | Percentage |
|--------------|------------|
| 100 | 1% |
| 250 | 2.5% |
| 500 | 5% |
| 1000 | 10% |

```rust
// 5% royalty
let royalty_basis_points = 500;

let (mint_conditions, nft) = Nft::mint(
    ctx,
    parent_coin_id,
    owner_puzzle_hash,
    Some(royalty_puzzle_hash),  // Where royalties are paid
    royalty_basis_points,
    metadata,
    owner_puzzle_hash,
)?;
```

:::info
Royalties are enforced through the offer system. Direct transfers don't automatically pay royalties - they're applied when NFTs are traded via offers.
:::

## Parsing NFTs

When you need to reconstruct an NFT from blockchain data:

```rust
// Parse an NFT from a parent coin spend
let nft = Nft::parse_child(
    ctx,
    parent_coin_spend,
    child_coin,
)?;

// Or parse directly from puzzle/solution
let parsed = Nft::<NftMetadata>::parse(
    &ctx.allocator(),
    puzzle_ptr,
    solution_ptr,
)?;
```

## NFT Ownership Layer

The ownership layer tracks:

- Current owner (puzzle hash)
- Transfer program (for trading/offers)
- Royalty information

When building custom NFT interactions, be aware that the ownership layer requires proper handling for the NFT to remain valid.

## Complete Example

Here's a full example of minting and transferring an NFT:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

fn mint_and_transfer_nft(
    minter_coin: Coin,
    minter_public_key: PublicKey,
    recipient_puzzle_hash: Bytes32,
    metadata: NftMetadata,
) -> Result<(Bytes32, Vec<CoinSpend>), DriverError> {
    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(minter_public_key);
    let minter_puzzle_hash = StandardLayer::puzzle_hash(minter_public_key);

    // Step 1: Mint the NFT
    let (mint_conditions, nft) = Nft::mint(
        ctx,
        minter_coin.coin_id(),
        minter_puzzle_hash,
        None,    // No royalties for this example
        0,
        metadata,
        minter_puzzle_hash,
    )?;

    p2.spend(ctx, minter_coin, mint_conditions)?;
    let launcher_id = nft.info.launcher_id;

    // Step 2: Transfer to recipient
    let _new_nft = nft.transfer(
        ctx,
        &p2,
        recipient_puzzle_hash,
        Conditions::new(),
    )?;

    Ok((launcher_id, ctx.take()))
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, NftMetadata, NftMint, Constants, Simulator } from "chia-wallet-sdk";

function mintAndTransferNft(recipientPuzzleHash: Uint8Array) {
  const clvm = new Clvm();
  const sim = new Simulator();
  const alice = sim.bls(2n);

  // Step 1: Mint the NFT
  const metadata = new NftMetadata(
    1n, 1n,
    ["https://example.com/image.png"],
    null, [], null, [], null
  );

  const { nfts, parentConditions } = clvm.mintNfts(alice.coin.coinId(), [
    new NftMint(
      clvm.nftMetadata(metadata),
      Constants.nftMetadataUpdaterDefaultHash(),
      alice.puzzleHash,
      alice.puzzleHash,
      0  // No royalties
    ),
  ]);

  clvm.spendStandardCoin(
    alice.coin,
    alice.pk,
    clvm.delegatedSpend(parentConditions)
  );

  const launcherId = nfts[0].info.launcherId;

  // Step 2: Transfer to recipient
  clvm.spendNft(
    nfts[0],
    clvm.standardSpend(
      alice.pk,
      clvm.delegatedSpend([
        clvm.createCoin(recipientPuzzleHash, 1n, clvm.alloc([recipientPuzzleHash])),
      ])
    )
  );

  // Sign and validate
  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  return launcherId;
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, NftMetadata, NftMint, Constants, Simulator

def mint_and_transfer_nft(recipient_puzzle_hash: bytes):
    clvm = Clvm()
    sim = Simulator()
    alice = sim.bls(2)

    # Step 1: Mint the NFT
    metadata = NftMetadata(
        1, 1,
        ["https://example.com/image.png"],
        None, [], None, [], None
    )

    result = clvm.mint_nfts(alice.coin.coin_id(), [
        NftMint(
            clvm.nft_metadata(metadata),
            Constants.nft_metadata_updater_default_hash(),
            alice.puzzle_hash,
            alice.puzzle_hash,
            0  # No royalties
        ),
    ])

    clvm.spend_standard_coin(
        alice.coin,
        alice.pk,
        clvm.delegated_spend(result.parent_conditions)
    )

    launcher_id = result.nfts[0].info.launcher_id

    # Step 2: Transfer to recipient
    clvm.spend_nft(
        result.nfts[0],
        clvm.standard_spend(
            alice.pk,
            clvm.delegated_spend([
                clvm.create_coin(recipient_puzzle_hash, 1, clvm.alloc([recipient_puzzle_hash])),
            ])
        )
    )

    # Sign and validate
    sim.spend_coins(clvm.coin_spends(), [alice.sk])

    return launcher_id
```

  </TabItem>
</Tabs>

## API Reference

For the complete NFT API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Nft.html).
