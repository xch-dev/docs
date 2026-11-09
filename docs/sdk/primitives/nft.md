---
title: NFT
---

# NFT

An NFT is a [singleton](/sdk/primitives/singletons) whose inner puzzle stores metadata, an optional
assigned owner (usually a [DID](/sdk/primitives/did)), and royalty information. The launcher ID is the
NFT's permanent identifier (encoded as an `nft1...` address). The on-chain NFT1 standard is
[CHIP-0005](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0005.md), and the off-chain
metadata JSON format is [CHIP-0007](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0007.md).

In the SDK, `Nft` is `Singleton<NftInfo>`. This page covers minting (single and bulk), transfers, DID
assignment, metadata updates, royalties and parsing.

:::tip
The [Action System](/sdk/action-system) can mint (`Action::mint_nft`, `Action::mint_nft_from_did`),
update (`Action::update_nft`) and send NFTs alongside other assets, and the [Offers](/sdk/offers) page
covers trading them with royalties. This page describes the low-level `Nft` API those are built on.
:::

## Puzzle structure and `NftInfo`

An NFT coin's puzzle is a stack of layers:

```text
SingletonLayer                     launcher_id
└─ NftStateLayer                   metadata, metadata_updater_puzzle_hash
   └─ NftOwnershipLayer            current_owner
      ├─ RoyaltyTransferLayer      launcher_id, royalty_puzzle_hash, royalty_basis_points
      └─ p2 puzzle                 (e.g. the owner's standard puzzle)
```

`NftInfo` holds the values curried into these layers. The SDK calls the full stack `StandardNftLayers`.

```rust ignore
pub struct NftInfo {
    pub launcher_id: Bytes32,
    pub metadata: HashedPtr,
    pub metadata_updater_puzzle_hash: Bytes32,
    pub current_owner: Option<Bytes32>,
    pub royalty_puzzle_hash: Bytes32,
    pub royalty_basis_points: u16,
    pub p2_puzzle_hash: Bytes32,
}
```

- `metadata` is a `HashedPtr` into the allocator. For standard NFTs it's an `NftMetadata` value.
- `metadata_updater_puzzle_hash` is the program allowed to change the metadata. The default updater
  (`NFT_METADATA_UPDATER_DEFAULT_HASH`) only allows prepending new URIs.
- `current_owner` is the launcher ID of the singleton the NFT is assigned to, typically a DID.
- `royalty_basis_points` is in hundredths of a percent (300 is 3%), paid to `royalty_puzzle_hash` when the
  NFT is traded in an offer.

## Minting

Minting launches a singleton and immediately spends the eve NFT to its first owner. The parameters are
collected in `NftMint`:

```rust ignore
pub struct NftMint {
    pub metadata: HashedPtr,
    pub metadata_updater_puzzle_hash: Bytes32, // default updater
    pub royalty_puzzle_hash: Bytes32,          // defaults to p2_puzzle_hash
    pub royalty_basis_points: u16,
    pub p2_puzzle_hash: Bytes32,
    pub transfer_condition: Option<TransferNft>, // assign to a DID on mint
}
```

`NftMint::new(metadata, p2_puzzle_hash, royalty_basis_points, transfer_condition)` fills in the default
metadata updater and pays royalties to the recipient. Set the fields directly to change them.

### Minting a single NFT

`Launcher::mint_nft` returns the conditions for the parent coin and the minted `Nft`. Here the parent is
an XCH coin and the NFT has no assigned owner:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::prelude::*;

#[test]
fn mint_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let creator = sim.bls(0);

    let metadata = ctx.alloc_hashed(&NftMetadata {
        data_uris: vec!["https://example.com/image.png".to_string()],
        data_hash: Some(Bytes32::new([1; 32])),
        ..Default::default()
    })?;

    let mut mint = NftMint::new(metadata, alice.puzzle_hash, 250, None);
    // Pay the 2.5% royalty to someone other than the first owner.
    mint.royalty_puzzle_hash = creator.puzzle_hash;

    let (mint_nft, nft) = Launcher::new(alice.coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, alice.coin, mint_nft)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(nft.info.p2_puzzle_hash, alice.puzzle_hash);
    assert_eq!(nft.info.royalty_puzzle_hash, creator.puzzle_hash);
    assert_eq!(nft.info.current_owner, None);
    assert!(sim.coin_state(nft.coin.coin_id()).is_some());

    Ok(())
}
```

`mint_eve_nft` is the lower-level step: it creates the eve NFT with a p2 puzzle hash you choose and
returns it unspent, with an `EveProof`.

### Bulk minting

A parent coin can only create one launcher of a given amount, so minting many NFTs at once uses
[`IntermediateLauncher`](/sdk/primitives/singletons#creating-many-launchers-from-one-parent-intermediatelauncher).
Each index gives a distinct launcher ID:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::driver::IntermediateLauncher;
use chia_wallet_sdk::prelude::*;

#[test]
fn bulk_mint() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let total = 5;
    let alice = sim.bls(total as u64);
    let alice_p2 = StandardLayer::new(alice.pk);

    let mut conditions = Conditions::new();
    let mut nfts = Vec::new();

    for i in 0..total {
        let metadata = ctx.alloc_hashed(&NftMetadata {
            edition_number: i as u64 + 1,
            edition_total: total as u64,
            data_uris: vec![format!("https://example.com/{i}.png")],
            ..Default::default()
        })?;
        let mint = NftMint::new(metadata, alice.puzzle_hash, 300, None);

        let (mint_nft, nft) = IntermediateLauncher::new(alice.coin.coin_id(), i, total)
            .create(ctx)?
            .mint_nft(ctx, &mint)?;
        conditions = conditions.extend(mint_nft);
        nfts.push(nft);
    }

    alice_p2.spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(nfts.len(), total);

    Ok(())
}
```

Every launcher needs 1 mojo, so the parent must provide `total` mojos. For large collections, split the
mint over several transactions to stay under the block cost limit.

### Minting from a DID

To mint NFTs owned by a DID, create the intermediate launchers from the DID coin, set `transfer_condition`
to a `TransferNft` naming the DID, and emit the mint conditions from a DID update spend. This is covered
with a full example on the [DID page](/sdk/primitives/did#minting-nfts-from-a-did).

## Transferring

`Nft::transfer` spends the NFT with a `SpendWithConditions` inner layer and recreates it at a new p2
puzzle hash, hinted to the recipient:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::prelude::*;

#[test]
fn transfer_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, alice.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(alice.coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, alice.coin, mint_nft)?;

    // Mint and transfer can happen in the same transaction.
    let nft = nft.transfer(ctx, &alice_p2, bob.puzzle_hash, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(nft.info.p2_puzzle_hash, bob.puzzle_hash);
    assert!(sim.coin_state(nft.coin.coin_id()).is_some());

    Ok(())
}
```

Unlike DIDs and other singletons, NFT `CREATE_COIN` conditions use the new **p2** puzzle hash. The
ownership and state layers rewrap the output with the full NFT puzzle, so you send to the recipient's
address directly. Every spend method returns the child `Nft`, which you can spend again in the same
transaction.

For other spends, use `spend_with(ctx, &p2, conditions)` or `spend(ctx, inner_spend)` with any p2
`Spend`. Both require the conditions to create the odd-amount child (at its p2 puzzle hash) and return
`DriverError::MissingChild` otherwise.

:::note
NFTs can't be melted. A p2 spend that outputs `melt_singleton()` fails when the NFT layers run it, and
`spend_with` returns `MissingChild` (after it has already added the coin spend to the context). To get rid of an NFT, transfer it to an unspendable puzzle hash (a burn
address) instead.
:::

## Assigning an owner (DID)

The `current_owner` field is changed by a `TransferNft` condition from the NFT's p2 spend. To assign an
NFT to a DID, the DID must approve in the same transaction, which `Nft::assign_owner` arranges: it returns
the conditions the DID spend has to emit, along with the child NFT.

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::prelude::*;

#[test]
fn assign_to_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(2);
    let alice_p2 = StandardLayer::new(alice.pk);

    // A DID and an unassigned NFT, both owned by Alice.
    let intermediate = Coin::new(alice.coin.coin_id(), alice.puzzle_hash, 1);
    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;
    alice_p2.spend(
        ctx,
        alice.coin,
        create_did.create_coin(alice.puzzle_hash, 1, Memos::None),
    )?;

    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, alice.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(intermediate.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, intermediate, mint_nft)?;

    // Assign the NFT to the DID. The DID's current inner puzzle hash is required.
    let (did_conditions, nft) = nft.assign_owner(
        ctx,
        &alice_p2,
        alice.puzzle_hash,
        TransferNft::new(
            Some(did.info.launcher_id),
            Vec::new(),
            Some(did.info.inner_puzzle_hash().into()),
        ),
        Conditions::new(),
    )?;
    let did = did.update(ctx, &alice_p2, did_conditions)?;
    assert_eq!(nft.info.current_owner, Some(did.info.launcher_id));

    // Unassigning doesn't need the DID, so the returned conditions are empty.
    let (did_conditions, nft) = nft.assign_owner(
        ctx,
        &alice_p2,
        alice.puzzle_hash,
        TransferNft::new(None, Vec::new(), None),
        Conditions::new(),
    )?;
    assert!(did_conditions.is_empty());
    assert_eq!(nft.info.current_owner, None);

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

Plain `transfer` keeps `current_owner` unchanged. Wallets typically unassign the DID when an NFT leaves
the owner's wallet; do that with `assign_owner` and `TransferNft::new(None, Vec::new(), None)` while
transferring to the new p2 puzzle hash.

The owner doesn't have to be a DID: any singleton that can emit the returned conditions works, such as a
[vault](/sdk/primitives/vaults).

## Updating metadata

Metadata changes go through the NFT's metadata updater, invoked by an `UPDATE_NFT_METADATA` condition in
the p2 spend. With the default updater you can only **prepend** a data, metadata or license URI; the hashes
and edition fields are immutable. `MetadataUpdate` builds the updater spend:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::driver::{MetadataUpdate, UriKind};
use chia_wallet_sdk::prelude::*;

#[test]
fn add_nft_uri() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    let metadata = ctx.alloc_hashed(&NftMetadata {
        data_uris: vec!["https://example.com/a.png".to_string()],
        data_hash: Some(Bytes32::new([1; 32])),
        ..Default::default()
    })?;
    let mint = NftMint::new(metadata, alice.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(alice.coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, alice.coin, mint_nft)?;

    // Add a mirror for the image.
    let update = MetadataUpdate {
        kind: UriKind::Data,
        uri: "https://mirror.example.com/a.png".to_string(),
    }
    .spend(ctx)?;

    // Keep the NFT with Alice while running the update.
    let nft = nft.transfer_with_metadata(ctx, &alice_p2, alice.puzzle_hash, update, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let metadata: NftMetadata = ctx.extract(nft.info.metadata.ptr())?;
    assert_eq!(
        metadata.data_uris,
        vec![
            "https://mirror.example.com/a.png".to_string(),
            "https://example.com/a.png".to_string(),
        ]
    );

    Ok(())
}
```

The returned `Nft` already has the new metadata, computed by running the updater locally
(`run_metadata_updater`). `UriKind::Metadata` and `UriKind::License` update the other URI lists. A
custom metadata updater can allow other changes, but wallets and indexers may not support it.

## Royalties

Royalties are enforced when an NFT is traded through an [offer](/sdk/offers), not on plain transfers. The
`RoyaltyTransferLayer` is the NFT's transfer program: when the p2 spend outputs a `TransferNft` condition
with **trade prices**, it requires a payment of `royalty_basis_points` of each price to
`royalty_puzzle_hash`, through the settlement puzzle, in the same transaction.

The relevant methods are:

- `Nft::lock_settlement(ctx, &p2, trade_prices, conditions)` moves the NFT to the settlement puzzle and
  reveals the trade prices, unassigning the owner. This is the maker's side of an offer.
- `Nft::unlock_settlement(ctx, notarized_payments)` spends an NFT that is locked in the settlement puzzle,
  on the taker's side.

The royalty amounts themselves (and the payments that satisfy them) are calculated by the offer code; see
[Offers](/sdk/offers) for the full flow, including `RoyaltyInfo` and how royalties combine for multiple
NFTs and assets.

## Parsing NFTs

To spend an NFT you received, fetch the parent coin's spend and call `Nft::parse_child`. It runs the
parent's p2 spend, applying any `TransferNft` and metadata update it contains, so the returned `Nft` has
the correct owner and metadata:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::prelude::*;

#[test]
fn parse_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, alice.puzzle_hash, 300, None);
    let (mint_nft, nft) = Launcher::new(alice.coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, alice.coin, mint_nft)?;
    let expected = nft.transfer(ctx, &alice_p2, bob.puzzle_hash, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob finds the coin by its hint, then looks up the parent spend.
    let coin_id = sim.hinted_coins(bob.puzzle_hash)[0];
    let coin = sim.coin_state(coin_id).unwrap().coin;
    let parent_spend = sim.coin_spend(coin.parent_coin_info).unwrap();

    let parent_puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let parent_puzzle = Puzzle::parse(ctx, parent_puzzle);
    let parent_solution = ctx.alloc(&parent_spend.solution)?;

    let nft = Nft::parse_child(ctx, parent_spend.coin, parent_puzzle, parent_solution)?
        .expect("parent is not an NFT");

    // `parse_child` doesn't know which coin you have, so check it.
    assert_eq!(nft.coin, coin);
    assert_eq!(nft, expected);

    Ok(())
}
```

Unlike `Did::parse_child`, `Nft::parse_child` doesn't take the child coin and doesn't rely on a hint, because
the NFT child's p2 puzzle hash is visible in the parent's `CREATE_COIN`. It returns `Ok(None)` if the
parent isn't an NFT and `DriverError::MissingChild` if the parent was melted.

The other parsers:

- `Nft::parse(allocator, coin, puzzle, solution)` parses an NFT coin's own spend into the `Nft`, its p2
  puzzle and its p2 solution.
- `NftInfo::parse(allocator, puzzle)` parses just a puzzle into `NftInfo` and the p2 puzzle.
- `NftInfo::child_from_p2_spend` computes the next `NftInfo` from a p2 spend.

To read the metadata, extract it as `NftMetadata` with `ctx.extract(nft.info.metadata.ptr())`, as in the
metadata update example.

## Gotchas

- `metadata` is a `HashedPtr`, so an `Nft` is tied to the allocator it was parsed or created in. Persist
  the metadata separately if you store NFTs.
- The `TransferNft` used to assign a DID must contain the DID's inner puzzle hash at the time of the DID
  spend. If you spend the DID earlier in the same transaction, use the updated `Did`.
- `NftMint::new` sets `royalty_puzzle_hash` to the first owner. Override it if royalties should go to the
  creator rather than the recipient.
