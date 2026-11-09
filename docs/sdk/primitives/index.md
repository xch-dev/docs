---
title: Primitives
slug: /sdk/primitives
---

# Primitives

A **primitive** is a Rust type that represents a spendable on-chain asset: a CAT coin, an NFT, a DID, a
vault, and so on. Each one knows how to compute its puzzle hash, build a spend, compute the children that
spend creates, and parse itself back out of the blockchain. Primitives are the main low-level API of the
SDK. The [Action System](/sdk/action-system) is built on top of them, and you use them directly when you
need exact control over a spend or are working with an asset the action system doesn't cover.

## Primitives and layers

A [layer](/sdk/concepts/layers) is a single puzzle building block, such as `CatLayer`, `SingletonLayer` or
`NftOwnershipLayer`. It knows how to construct and parse one curried puzzle and its solution, and nothing
else: it doesn't know which coin it belongs to or how that coin came to exist.

A primitive combines one or more layers with the coin and the proof that it's legitimate:

| Primitive | Coin   | Proof                                 | Info (curried values)                                   | Layers                                                                         |
| --------- | ------ | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Cat`     | `coin` | `lineage_proof: Option<LineageProof>` | `CatInfo`: asset ID, hidden puzzle hash, p2 puzzle hash | `CatLayer`, optionally `RevocationLayer`                                       |
| `Nft`     | `coin` | `proof: Proof`                        | `NftInfo`: metadata, owner, royalty, p2 puzzle hash     | `SingletonLayer`, `NftStateLayer`, `NftOwnershipLayer`, `RoyaltyTransferLayer` |
| `Did`     | `coin` | `proof: Proof`                        | `DidInfo`: metadata, recovery settings, p2 puzzle hash  | `SingletonLayer`, `DidLayer`                                                   |

`Nft` and `Did` are aliases for the generic `Singleton<I>` with `NftInfo` and `DidInfo`. Vaults, option
contracts and the action layer singletons follow the same pattern (see
[Singletons & Launchers](/sdk/primitives/singletons)).

### The p2 puzzle is separate

Most primitives store only the **hash** of their innermost puzzle, the p2 ("pay to") puzzle that decides
who can spend it. When you spend the primitive you pass the p2 spend in, usually as a `Spend` or as any
type implementing `SpendWithConditions`, like `StandardLayer`:

```rust ignore
cat_spend = CatSpend::new(cat, alice_p2.spend_with_conditions(ctx, conditions)?);
nft.transfer(ctx, &alice_p2, bob_puzzle_hash, Conditions::new())?;
```

This is what makes the same `Cat` or `Nft` type work regardless of whether it's owned by a standard
wallet, a [vault](/sdk/primitives/vaults), a [clawback](/sdk/primitives/clawback) or your own puzzle. It
also means the primitive value (plus a way to spend its `p2_puzzle_hash`) is exactly what a wallet needs
to persist.

## Lifecycle

Every primitive goes through the same steps:

1. **Create** it, with a constructor that returns the conditions the funding coin must output (for
   example `Cat::single_issuance` or `Launcher::mint_nft`) together with the new primitive.
2. **Spend** it. Spend methods add the coin spends to the [SpendContext](/sdk/concepts/spend-context) and
   return the children, already carrying the right lineage, so you can keep spending them in the same
   transaction or store them.
3. **Parse** it, when you didn't create it yourself, from the spend of its parent coin.

## Parsing from the parent coin spend

A wallet usually discovers coins by their hint (with the [Peer Protocol](/sdk/networking/peer) or an
[RPC client](/sdk/networking/rpc)), so all it has is a `Coin`. The coin's puzzle hash alone doesn't tell
you what it is, and a coin's puzzle isn't revealed until it's spent. But the **parent** coin has been
spent, and its puzzle reveal and solution contain everything needed: the parent's layers tell you the
asset type and its curried values, and running the parent's p2 spend tells you what children it created.

So the pattern is:

1. Look up the parent's coin spend (puzzle reveal and solution).
2. Allocate the puzzle and solution, and wrap the puzzle with `Puzzle::parse`.
3. Try the parsers for the asset types you support. Each returns `Ok(None)` if the parent isn't that
   type, and an error only if it looks like that type but is malformed.
4. Make sure the parsed child is the coin you have.

| Parser                                                         | Returns            | Notes                                                                                                 |
| -------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `Cat::parse_children(alloc, parent_coin, puzzle, solution)`    | `Option<Vec<Cat>>` | every CAT child of the parent; find yours                                                             |
| `Nft::parse_child(alloc, parent_coin, puzzle, solution)`       | `Option<Nft>`      | applies ownership and metadata changes from the spend                                                 |
| `Did::parse_child(alloc, parent_coin, puzzle, solution, coin)` | `Option<Did>`      | takes your coin and the p2 puzzle hash from the hint; check `did.info.puzzle_hash()` against the coin |

The same functions work whether the spend data comes from the `Simulator`, a peer
(`request_puzzle_and_solution`) or a full node RPC (`get_puzzle_and_solution`). This example identifies
two received coins:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::prelude::*;

#[derive(Debug)]
enum Asset {
    Cat(Cat),
    Nft(Nft),
    Did(Did),
    Unknown,
}

/// Works out what `coin` is from its parent's coin spend.
fn identify(ctx: &mut SpendContext, parent_spend: &CoinSpend, coin: Coin) -> anyhow::Result<Asset> {
    let puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&parent_spend.solution)?;

    if let Some(cats) = Cat::parse_children(ctx, parent_spend.coin, puzzle, solution)? {
        if let Some(cat) = cats.into_iter().find(|cat| cat.coin == coin) {
            return Ok(Asset::Cat(cat));
        }
    }

    if let Some(nft) = Nft::parse_child(ctx, parent_spend.coin, puzzle, solution)? {
        if nft.coin == coin {
            return Ok(Asset::Nft(nft));
        }
    }

    if let Some(did) = Did::parse_child(ctx, parent_spend.coin, puzzle, solution, coin)? {
        // The p2 puzzle hash comes from the hint, so make sure it produces this coin.
        if Bytes32::from(did.info.puzzle_hash()) == coin.puzzle_hash {
            return Ok(Asset::Did(did));
        }
    }

    Ok(Asset::Unknown)
}

#[test]
fn identify_received_coins() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(101);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);
    let bob_memos = ctx.hint(bob.puzzle_hash)?;

    // Alice issues a CAT directly to Bob...
    let (issue_cat, _cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        100,
        Conditions::new().create_coin(bob.puzzle_hash, 100, bob_memos),
    )?;

    // ...and mints an NFT from an intermediate coin, then sends it to Bob.
    let intermediate = Coin::new(alice.coin.coin_id(), alice.puzzle_hash, 1);
    alice_p2.spend(
        ctx,
        alice.coin,
        issue_cat.create_coin(alice.puzzle_hash, 1, Memos::None),
    )?;
    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, alice.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(intermediate.coin_id(), 1).mint_nft(ctx, &mint)?;
    alice_p2.spend(ctx, intermediate, mint_nft)?;
    let _nft = nft.transfer(ctx, &alice_p2, bob.puzzle_hash, Conditions::new())?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob syncs his hinted coins and identifies each one.
    let mut found = Vec::new();
    for coin_id in sim.hinted_coins(bob.puzzle_hash) {
        let coin = sim.coin_state(coin_id).unwrap().coin;
        let parent_spend = sim.coin_spend(coin.parent_coin_info).unwrap();
        found.push(identify(ctx, &parent_spend, coin)?);
    }

    assert!(found.iter().any(|asset| matches!(asset, Asset::Cat(cat) if cat.coin.amount == 100)));
    assert!(found.iter().any(|asset| matches!(asset, Asset::Nft(_))));

    Ok(())
}
```

A few things to keep in mind:

- Parsing from the parent trusts the parent's spend, not the hint. Hints are just memos and anyone can
  hint anything to your puzzle hash, so always check that the parsed child's `p2_puzzle_hash` is one you
  can spend before treating it as yours.
- `Cat::parse_children` and `Nft::parse_child` don't take your coin, so compare the result with it, as
  above. `Did::parse_child` takes your coin but trusts the hint for the p2 puzzle hash, so check that the
  parsed DID's puzzle hash matches the coin.
- Some primitives can't be fully reconstructed from the parent alone. For example DID metadata is assumed
  unchanged from the parent, and revocable CAT children of a revocation spend rely on a hint (see
  [DID](/sdk/primitives/did#updating-metadata) and [CAT](/sdk/primitives/cat#revocable-cats)).
- If you need to inspect a coin's **own** spend instead (for example to see what a transaction did), use
  `Cat::parse`, `Nft::parse` or `Did::parse`, which also return the p2 puzzle and solution, or the
  `*Info::parse` functions for a bare puzzle.

## Lineage proofs

Anyone can create a coin with any puzzle hash, so an outer puzzle like the CAT or singleton layer has to
prove the coin was created by a legitimate parent of the same kind. It does this with a proof of the
parent, passed in the solution:

```rust ignore
pub struct LineageProof {
    pub parent_parent_coin_info: Bytes32,
    pub parent_inner_puzzle_hash: Bytes32,
    pub parent_amount: u64,
}
```

The outer puzzle rebuilds the parent's full puzzle hash from `parent_inner_puzzle_hash` and its own
curried values (asset ID or launcher ID), hashes it with the other two fields to get the parent's coin
ID, and checks that against its own parent coin ID. Note that the inner puzzle hash is the hash of
everything inside the outer layer, which is not always the p2 puzzle hash (the NFT, DID and revocable CAT
layers sit in between). The `child_lineage_proof` methods and the `*Info::inner_puzzle_hash` methods get
this right for you.

Singletons use `Proof`, which is either a `LineageProof` or, for the first coin after the launcher, an
`EveProof` (the launcher's parent coin ID and amount). CATs use `Option<LineageProof>`, where `None` is
only valid for a spend that runs the TAIL.

In practice you rarely build proofs by hand:

- Spend methods return children with the proof filled in.
- `child_lineage_proof()`, `Cat::child` and `Singleton::child_with` compute them from the parent
  primitive.
- The parsing functions above compute them from the parent spend.

## All primitives

| Page                                                 | Types                                                                                                  | Feature        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| [Standard (XCH)](/sdk/primitives/standard)           | `StandardLayer`                                                                                        |                |
| [CAT](/sdk/primitives/cat)                           | `Cat`, `CatInfo`, `CatSpend`                                                                           |                |
| [Singletons & Launchers](/sdk/primitives/singletons) | `Launcher`, `IntermediateLauncher`, `Singleton<I>`, `SingletonInfo`                                    |                |
| [NFT](/sdk/primitives/nft)                           | `Nft`, `NftInfo`, `NftMint`, `MetadataUpdate`                                                          |                |
| [DID](/sdk/primitives/did)                           | `Did`, `DidInfo`                                                                                       |                |
| [Option Contracts](/sdk/primitives/options)          | `OptionContract`, `OptionLauncher`, `OptionUnderlying`                                                 |                |
| [Vaults & MIPS](/sdk/primitives/vaults)              | `Vault`, `VaultInfo`, `MipsSpend`, `MofN`, `P2Singleton`                                               |                |
| [Clawback](/sdk/primitives/clawback)                 | `Clawback`, `ClawbackV2`                                                                               |                |
| [Streamed Assets](/sdk/primitives/streaming)         | `StreamedAsset`, `StreamingPuzzleInfo`                                                                 |                |
| [Bulletins](/sdk/primitives/bulletin)                | `Bulletin`, `BulletinMessage`                                                                          |                |
| [DataLayer](/sdk/primitives/datalayer)               | `Datastore`, `DatastoreInfo`                                                                           | `chip-0035`    |
| [Action Layer](/sdk/primitives/action-layer)         | `CatalogRegistry`, `XchandlesRegistry`, `RewardDistributor`, `MedievalVault`, `StateScheduler`, `Slot` | `action-layer` |

All primitive types live in `chia_wallet_sdk::driver`, and the most common ones are re-exported from
`chia_wallet_sdk::prelude`. See the
[driver rustdoc](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/) for the full API.
