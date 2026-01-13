---
slug: /sdk/primitives/nft
title: NFT
---

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

## Transferring NFTs

To transfer an NFT to a new owner:

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

## API Reference

For the complete NFT API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Nft.html).
