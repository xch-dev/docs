---
title: DID
---

# DID

A DID (decentralized identifier) is a [singleton](/sdk/primitives/singletons) that represents an
on-chain identity. Its launcher ID is the identifier (encoded as a `did:chia:1...` address), and its
inner puzzle is the DID layer around the owner's p2 puzzle. DIDs are mostly used as the creator and
assigned owner of [NFTs](/sdk/primitives/nft), but because a DID can output arbitrary conditions it can
also authorize other spends. The DID standard is
[CHIP-0004](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0004.md).

In the SDK, `Did` is `Singleton<DidInfo>`.

:::tip
The [Action System](/sdk/action-system) can create and update DIDs (`Action::create_did`,
`Action::create_empty_did`, `Action::update_did`) and mint NFTs from them (`Action::mint_nft_from_did`)
as part of a larger transaction. This page covers the low-level `Did` API.
:::

## The `DidInfo` type

```rust ignore
pub struct DidInfo {
    pub launcher_id: Bytes32,
    pub recovery_list_hash: Option<Bytes32>,
    pub num_verifications_required: u64,
    pub metadata: HashedPtr,
    pub p2_puzzle_hash: Bytes32,
}
```

- `metadata` is an arbitrary CLVM value stored in the puzzle, held as a `HashedPtr` (a `NodePtr` plus its
  tree hash). Allocate it with `ctx.alloc_hashed(&value)`. `HashedPtr::NIL` means no metadata.
- `recovery_list_hash` and `num_verifications_required` belong to the DID recovery feature, which is
  rarely used and not fully supported. Use `None` and `1` unless you need compatibility with a specific
  wallet; `create_simple_did` does this for you.
- `p2_puzzle_hash` is the owner's puzzle hash, typically a [standard](/sdk/primitives/standard) puzzle.

Because `metadata` points into an `Allocator`, a `Did` is only meaningful together with the
`SpendContext` (or `Allocator`) it was created in. To store a DID long term, store the metadata
separately (for example as a serialized `Program`) and allocate it again when you load it.

## Creating a DID

DIDs are created from a [`Launcher`](/sdk/primitives/singletons#how-a-singleton-is-launched).
`create_simple_did` creates a DID with no metadata and no recovery list; `create_did` lets you choose
both. They return the conditions the parent coin must output, plus the new `Did`.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn create_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(2);
    let alice_p2 = StandardLayer::new(alice.pk);

    // A DID with no metadata.
    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;

    // A second DID with custom metadata, from an intermediate coin of the same parent
    // (each parent can only create one launcher of a given amount).
    let intermediate = Coin::new(alice.coin.coin_id(), alice.puzzle_hash, 1);
    let metadata = ctx.alloc_hashed(&("name", "Alice"))?;
    let (create_named_did, named_did) = Launcher::new(intermediate.coin_id(), 1)
        .create_did(ctx, None, 1, metadata, &alice_p2)?;

    alice_p2.spend(
        ctx,
        alice.coin,
        create_did.create_coin(alice.puzzle_hash, 1, Memos::None),
    )?;
    alice_p2.spend(ctx, intermediate, create_named_did)?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(did.info.p2_puzzle_hash, alice.puzzle_hash);
    assert_eq!(named_did.info.metadata, metadata);
    assert!(sim.coin_state(named_did.coin.coin_id()).is_some());

    Ok(())
}
```

The `inner` argument must implement both `SpendWithConditions` and `ToTreeHash`, because the DID's p2
puzzle hash is taken from it and it's used to spend the eve coin.

`create_did` actually performs two singleton spends: the launcher creates the eve DID, and the eve DID is
immediately spent once (an "update" with no changes) to create the DID you get back. That extra spend
puts a DID spend with a hint in the parent position, which is what wallets need to discover and parse the
DID. `create_eve_did` creates only the eve coin and returns it with an `EveProof`, if you want to spend it
yourself.

## Spending a DID

All DID spends go through a p2 spend, like other primitives. The convenience methods take any
`SpendWithConditions` inner layer and extra conditions to emit from the DID spend:

| Method                                                     | Effect                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `did.update(ctx, &p2, conditions)`                         | recreate the DID unchanged, emitting `conditions`              |
| `did.update_with_metadata(ctx, &p2, metadata, conditions)` | recreate it with new metadata                                  |
| `did.transfer(ctx, &p2, new_p2_puzzle_hash, conditions)`   | recreate it owned by a new puzzle hash (and hinted to it)      |
| `did.spend_with(ctx, &p2, conditions)`                     | spend with exactly the given conditions; returns `Option<Did>` |
| `did.spend(ctx, inner_spend)`                              | spend with an arbitrary p2 `Spend`; returns `Option<Did>`      |

`update`, `update_with_metadata` and `transfer` return the child `Did`. `spend` and `spend_with` don't
know what you intended, so they try to work out the child from your conditions: they return the child if
there's an odd-amount `CREATE_COIN` that is hinted with a p2 puzzle hash matching its puzzle hash, and
`None` otherwise (for example when the DID is melted).

`update` is the usual way to make a DID "sign off" on something in the same transaction: for example to
assert or create announcements and messages, or to authorize NFT minting and assignment.

### Transferring

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn transfer_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);
    let bob_p2 = StandardLayer::new(bob.pk);

    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;
    alice_p2.spend(ctx, alice.coin, create_did)?;

    // Spends can be chained in the same transaction.
    let did = did.transfer(ctx, &alice_p2, bob.puzzle_hash, Conditions::new())?;
    assert_eq!(did.info.p2_puzzle_hash, bob.puzzle_hash);

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob can now spend it.
    let _did = did.update(ctx, &bob_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    Ok(())
}
```

### Updating metadata

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn update_did_metadata() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;
    alice_p2.spend(ctx, alice.coin, create_did)?;

    let metadata = ctx.alloc_hashed(&("name", "Alice"))?;
    let did = did.update_with_metadata(ctx, &alice_p2, metadata, Conditions::new())?;

    // Settle the new metadata with one more update spend (see below).
    let did = did.update(ctx, &alice_p2, Conditions::new())?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;
    assert_eq!(did.info.metadata, metadata);

    Ok(())
}
```

:::warning
A DID's metadata is part of its puzzle, but it isn't revealed by the spend that creates it. Anyone
parsing a DID from its parent spend (including `Did::parse_child`) assumes the child has the **same**
metadata as the parent. After `update_with_metadata`, do one more `update` (in the same or a later
transaction) so the coin that wallets see has a parent whose puzzle already contains the new metadata.
Until then, wallets can't sync the DID.
:::

### Melting

Melt a DID with `did.spend_with(ctx, &p2, Conditions::new().melt_singleton())`. This permanently destroys
the identity. NFTs that reference it as their creator or owner keep the launcher ID, but no one can prove
ownership of it anymore.

## Minting NFTs from a DID

NFTs minted by a DID record the DID as their owner, which is how wallets and marketplaces attribute them
to a creator. The NFT launchers are created from the DID coin itself, and the DID spend must emit the
conditions returned by the mint so it approves the assignment. Use
[`IntermediateLauncher`](/sdk/primitives/singletons#creating-many-launchers-from-one-parent-intermediatelauncher)
so a single DID spend can create any number of launchers:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::driver::IntermediateLauncher;
use chia_wallet_sdk::prelude::*;

#[test]
fn mint_from_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(3);
    let alice_p2 = StandardLayer::new(alice.pk);

    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;
    // The extra 2 mojos fund the two NFT launchers created from the DID spend below.
    alice_p2.spend(ctx, alice.coin, create_did)?;

    // Assign the NFTs to the DID as they are minted.
    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(
        metadata,
        alice.puzzle_hash,
        300, // 3% royalty
        Some(TransferNft::new(
            Some(did.info.launcher_id),
            Vec::new(),
            Some(did.info.inner_puzzle_hash().into()),
        )),
    );

    let mut did_conditions = Conditions::new();
    let mut nfts = Vec::new();
    for i in 0..2 {
        let (conditions, nft) = IntermediateLauncher::new(did.coin.coin_id(), i, 2)
            .create(ctx)?
            .mint_nft(ctx, &mint)?;
        did_conditions = did_conditions.extend(conditions);
        nfts.push(nft);
    }

    // The DID's spend creates the intermediate coins and approves the assignments.
    let _did = did.update(ctx, &alice_p2, did_conditions)?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    for nft in nfts {
        assert_eq!(nft.info.current_owner, Some(did.info.launcher_id));
    }

    Ok(())
}
```

Two things make this work:

- The `TransferNft` condition names the DID's launcher ID and its **current** inner puzzle hash
  (`did.info.inner_puzzle_hash()` of the DID coin being spent). The NFT ownership layer uses them to
  check that the DID approved the assignment.
- The mint conditions include an announcement assertion and the creation of the intermediate coins.
  They have to be emitted by the DID spend, which is why they're passed to `did.update`.

The value of the launchers comes from the transaction (the DID itself keeps its 1 mojo), so the bundle
must contain enough spare XCH, here the 2 extra mojos left over by Alice's coin. See
[NFT](/sdk/primitives/nft) for minting without a DID, assigning existing NFTs to a DID, and metadata.

## Parsing DIDs

When a wallet sees a hinted coin that might be a DID, it fetches the parent spend and calls
`Did::parse_child`. Unlike `Cat::parse_children`, it takes the child coin you are trying to parse. The
child's p2 puzzle hash isn't visible in the parent spend (only the DID's full inner puzzle hash is), so
`parse_child` takes it from the hint. Anyone can choose a hint, so check that the parsed DID actually
produces the coin before trusting it:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn parse_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let (create_did, did) =
        Launcher::new(alice.coin.coin_id(), 1).create_simple_did(ctx, &alice_p2)?;
    alice_p2.spend(ctx, alice.coin, create_did)?;
    let expected = did.transfer(ctx, &alice_p2, bob.puzzle_hash, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob finds the coin by its hint.
    let coin_id = sim.hinted_coins(bob.puzzle_hash)[0];
    let coin = sim.coin_state(coin_id).unwrap().coin;

    let parent_spend = sim.coin_spend(coin.parent_coin_info).unwrap();
    let parent_puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let parent_puzzle = Puzzle::parse(ctx, parent_puzzle);
    let parent_solution = ctx.alloc(&parent_spend.solution)?;

    let did = Did::parse_child(ctx, parent_spend.coin, parent_puzzle, parent_solution, coin)?
        .expect("not a DID child");

    // The p2 puzzle hash came from the hint, so verify it against the coin.
    assert_eq!(Bytes32::from(did.info.puzzle_hash()), coin.puzzle_hash);
    assert_eq!(did, expected);
    assert_eq!(did.info.p2_puzzle_hash, bob.puzzle_hash);

    Ok(())
}
```

`parse_child` returns `Ok(None)` if the parent isn't a DID or if the DID was melted. It relies on two
assumptions: the child is hinted with its p2 puzzle hash, and its metadata is unchanged from the parent
(hence the settle spend above). Neither is verified, which is why you compare `did.info.puzzle_hash()`
with the coin's puzzle hash, and why you should also make sure `coin` really is a child of
`parent_coin`.

The hint isn't always the p2 puzzle hash. A DID sent with a [ClawbackV2](/sdk/primitives/clawback) is
hinted to the receiver, but its p2 puzzle is the clawback. In that case, decode the clawback from the
memos and replace `did.info.p2_puzzle_hash` with the clawback's puzzle hash if that produces the coin.

The other parsers:

- `Did::parse(allocator, coin, puzzle, solution)` parses a DID coin's own spend, returning the `Did` and
  its p2 puzzle and solution (or `None` for the p2 spend if the spend used the recovery path).
- `DidInfo::parse(allocator, puzzle)` parses only a puzzle into `DidInfo` and the p2 puzzle.

See the [Primitives overview](/sdk/primitives) for the general parsing pattern and
[Peer Protocol](/sdk/networking/peer) for looking up spends on a real node.

## Gotchas

- `metadata` is a `HashedPtr` into the current allocator. Don't mix `Did` values between different
  `SpendContext`s.
- Always hint DID outputs with the p2 puzzle hash. The convenience methods do; if you build `CREATE_COIN`
  conditions yourself with `spend_with`, use `ctx.hint(p2_puzzle_hash)`, and remember that the
  `CREATE_COIN` puzzle hash is the DID inner puzzle hash (`DidInfo::inner_puzzle_hash`), not the p2
  puzzle hash.
- When you chain several DID spends in one transaction, each spend must use the `Did` returned by the
  previous one, since the coin and lineage proof change each time.
