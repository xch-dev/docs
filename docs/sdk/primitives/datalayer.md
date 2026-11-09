---
title: DataLayer Stores
---

# DataLayer Stores

A **DataLayer store** is a singleton that commits to the root hash of an off-chain key-value store,
used by [Chia DataLayer](https://docs.chia.net/datalayer/). The store's owner (and optionally a set of
delegated admins, writers and oracles) can publish a new root hash, label, description and size by
spending the singleton. Anyone who has the data can then prove it matches what's on chain.

The SDK's `Datastore` primitive implements the DataLayer singleton format described in
[CHIP-0035](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0035.md). It requires the
`chip-0035` feature (also enabled by `action-layer`):

```toml
chia-wallet-sdk = { version = "...", features = ["chip-0035"] }
```

## Structure

A store is built like an NFT without the ownership layer:

```text
SingletonLayer
  NftStateLayer (metadata = DatastoreMetadata, updater = DL metadata updater)
    DelegationLayer (only if there are delegated puzzles)
      owner puzzle, or one of the delegated puzzles
```

| Type                                            | Purpose                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `Datastore<M>`                                  | The store coin, its lineage proof, and its `DatastoreInfo`                      |
| `DatastoreInfo<M>`                              | Launcher id, metadata, owner puzzle hash and delegated puzzles                  |
| `DatastoreMetadata`                             | `root_hash`, plus optional `label`, `description`, `bytes` and `size_proof`     |
| `DelegatedPuzzle`                               | `Admin(puzzle_hash)`, `Writer(inner_puzzle_hash)` or `Oracle(puzzle_hash, fee)` |
| `DelegationLayer`, `WriterLayer`, `OracleLayer` | The layers that implement delegation                                            |

The metadata type is generic: `DatastoreMetadata` is the standard format, but any type that implements
`ToClvm`, `FromClvm` and `MetadataWithRootHash` works.

### Delegated puzzles

When a store has delegated puzzles, its inner puzzle is a `DelegationLayer` that can be spent either by
the owner or by any delegated puzzle in a merkle tree:

| Role   | Can do                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | Anything: update metadata, change the delegated puzzles, transfer ownership, melt                                                                                                                        |
| Admin  | Update metadata and replace the set of delegated puzzles (`UpdateDatastoreMerkleRoot`)                                                                                                                   |
| Writer | Only update metadata. The `WriterLayer` filters out every other condition                                                                                                                                |
| Oracle | Anyone can spend it, as long as they pay `fee` mojos to the oracle puzzle hash. The spend makes an announcement that the payer can assert, so it can be used to prove the store's current state on chain |

## Launching and updating a store

`Launcher::mint_datastore(ctx, metadata, owner_puzzle_hash, delegated_puzzles)` returns the conditions to
spend from the parent coin and the eve `Datastore`. To update a store, have the owner's inner puzzle
output a new metadata condition (`Datastore::new_metadata_condition`) and recreate the store
(`Datastore::owner_create_coin_condition`), then call `Datastore::spend`, which returns the
`CoinSpend` for you to insert.

`Datastore::from_spend(ctx, &coin_spend, &parent_delegated_puzzles)` parses the child store from a coin
spend, whether it's the launcher spend or a store spend. It reads the new metadata and, from the
`CREATE_COIN` memos, any new owner and delegated puzzles.

```rust
use chia_wallet_sdk::driver::{Datastore, DatastoreMetadata, MetadataWithRootHash};
use chia_wallet_sdk::prelude::*;

#[test]
fn launch_and_update_store() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    let (launch, datastore) = Launcher::new(alice.coin.coin_id(), 1).mint_datastore(
        ctx,
        DatastoreMetadata::root_hash_only(Bytes32::default()),
        alice.puzzle_hash.into(),
        vec![],
    )?;
    alice_p2.spend(ctx, alice.coin, launch)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Parse the store from the launcher spend, as a wallet syncing from chain would.
    let launcher_spend = sim.coin_spend(datastore.info.launcher_id).unwrap();
    let parsed = Datastore::<DatastoreMetadata>::from_spend(ctx, &launcher_spend, &[])?.unwrap();
    assert_eq!(parsed, datastore);

    // Publish a new root hash, and recreate the store with the same owner.
    let new_metadata = DatastoreMetadata {
        root_hash: Bytes32::new([1; 32]),
        label: Some("my store".to_string()),
        description: Some("An example DataLayer store".to_string()),
        bytes: Some(1024),
        size_proof: None,
    };
    let conditions = Conditions::new()
        .with(Datastore::new_metadata_condition(ctx, new_metadata.clone())?)
        .with(Datastore::<DatastoreMetadata>::owner_create_coin_condition(
            ctx,
            datastore.info.launcher_id,
            alice.puzzle_hash,
            vec![],
            false,
        )?);
    let inner_spend = alice_p2.spend_with_conditions(ctx, conditions)?;
    let coin_spend = datastore.spend(ctx, inner_spend)?;

    let updated = Datastore::<DatastoreMetadata>::from_spend(ctx, &coin_spend, &[])?.unwrap();
    assert_eq!(updated.info.metadata, new_metadata);

    ctx.insert(coin_spend);
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

## Using delegated puzzles

This example (adapted from the SDK's tests) launches a store with an admin, a writer and an oracle,
and then exercises each role before transferring ownership:

```rust
use chia_wallet_sdk::chia::puzzle_types::standard::StandardArgs;
use chia_wallet_sdk::chia::sha2::Sha256;
use chia_wallet_sdk::driver::{
    Datastore, DatastoreMetadata, DelegatedPuzzle, MetadataWithRootHash, OracleLayer, WriterLayer,
    get_merkle_tree,
};
use chia_wallet_sdk::prelude::*;

#[test]
fn delegated_store() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let [owner, new_owner, admin, writer] = BlsPair::range();
    let owner_puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(owner.pk).into();
    let new_owner_puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(new_owner.pk).into();

    let admin_puzzle = DelegatedPuzzle::Admin(StandardArgs::curry_tree_hash(admin.pk));
    let writer_puzzle = DelegatedPuzzle::Writer(StandardArgs::curry_tree_hash(writer.pk));
    let oracle_puzzle_hash = Bytes32::new([7; 32]);
    let oracle_fee = 1000;
    let oracle_puzzle = DelegatedPuzzle::Oracle(oracle_puzzle_hash, oracle_fee);

    let coin = sim.new_coin(owner_puzzle_hash, 1);
    let (launch, datastore) = Launcher::new(coin.coin_id(), 1).mint_datastore(
        ctx,
        DatastoreMetadata::default(),
        owner_puzzle_hash.into(),
        vec![admin_puzzle, writer_puzzle, oracle_puzzle],
    )?;
    StandardLayer::new(owner.pk).spend(ctx, coin, launch)?;

    // Writer: update the metadata. The writer layer only allows metadata updates.
    let new_metadata = DatastoreMetadata::root_hash_only(Bytes32::new([1; 32]));
    let condition = Datastore::new_metadata_condition(ctx, new_metadata.clone())?;
    let inner_spend =
        WriterLayer::new(StandardLayer::new(writer.pk)).spend(ctx, Conditions::new().with(condition))?;
    let coin_spend = datastore.clone().spend(ctx, inner_spend)?;
    let datastore = Datastore::<DatastoreMetadata>::from_spend(
        ctx,
        &coin_spend,
        &datastore.info.delegated_puzzles,
    )?
    .unwrap();
    ctx.insert(coin_spend);
    assert_eq!(datastore.info.metadata, new_metadata);

    // Admin: remove the writer, keeping the admin and oracle.
    let delegated_puzzles = vec![admin_puzzle, oracle_puzzle];
    let new_merkle_root = get_merkle_tree(ctx, delegated_puzzles.clone())?.root();
    let condition = ctx.alloc(&UpdateDatastoreMerkleRoot {
        new_merkle_root,
        memos: Datastore::<DatastoreMetadata>::get_recreation_memos(
            datastore.info.launcher_id,
            owner_puzzle_hash.into(),
            delegated_puzzles.clone(),
        ),
    })?;
    let inner_spend = StandardLayer::new(admin.pk)
        .spend_with_conditions(ctx, Conditions::new().with(Condition::Other(condition)))?;
    let coin_spend = datastore.clone().spend(ctx, inner_spend)?;
    let datastore = Datastore::<DatastoreMetadata>::from_spend(
        ctx,
        &coin_spend,
        &datastore.info.delegated_puzzles,
    )?
    .unwrap();
    ctx.insert(coin_spend);
    assert_eq!(datastore.info.delegated_puzzles, delegated_puzzles);

    // Oracle: anyone can spend the store by paying the oracle fee.
    let inner_spend = OracleLayer::new(oracle_puzzle_hash, oracle_fee)
        .unwrap()
        .construct_spend(ctx, ())?;
    let coin_spend = datastore.clone().spend(ctx, inner_spend)?;
    let oracle_store = datastore.clone();
    let datastore = Datastore::<DatastoreMetadata>::from_spend(
        ctx,
        &coin_spend,
        &datastore.info.delegated_puzzles,
    )?
    .unwrap();
    ctx.insert(coin_spend);

    // The payer funds the fee and asserts the oracle's announcement.
    let mut hasher = Sha256::new();
    hasher.update(oracle_store.coin.puzzle_hash);
    hasher.update(b"$");
    let payer = sim.new_coin(owner_puzzle_hash, oracle_fee);
    StandardLayer::new(owner.pk).spend(
        ctx,
        payer,
        Conditions::new().assert_puzzle_announcement(Bytes32::new(hasher.finalize())),
    )?;

    // Owner: transfer the store to a new owner, keeping the delegated puzzles.
    let condition = Datastore::<DatastoreMetadata>::owner_create_coin_condition(
        ctx,
        datastore.info.launcher_id,
        new_owner_puzzle_hash,
        delegated_puzzles.clone(),
        true,
    )?;
    let inner_spend =
        StandardLayer::new(owner.pk).spend_with_conditions(ctx, Conditions::new().with(condition))?;
    let coin_spend = datastore.clone().spend(ctx, inner_spend)?;
    let datastore = Datastore::<DatastoreMetadata>::from_spend(
        ctx,
        &coin_spend,
        &datastore.info.delegated_puzzles,
    )?
    .unwrap();
    ctx.insert(coin_spend);
    assert_eq!(datastore.info.owner_puzzle_hash, new_owner_puzzle_hash);
    assert_eq!(datastore.info.delegated_puzzles, delegated_puzzles);

    // All of the spends above happen in a single block.
    sim.spend_coins(ctx.take(), &[owner.sk, admin.sk, writer.sk])?;
    assert!(sim.coin_state(datastore.coin.coin_id()).is_some());

    Ok(())
}
```

## Hints and memos

Store children are found and decoded using the memos on their `CREATE_COIN`:

- The first memo is the launcher id, so a wallet can look up all coins for a store by hint.
- If the owner or delegated puzzles change, the next memos are the new owner puzzle hash followed by a
  `(type, puzzle_hash[, fee])` group per delegated puzzle (`HintType::AdminPuzzle`, `WriterPuzzle`,
  `OraclePuzzle`). `Datastore::get_recreation_memos` builds these.

That's why `owner_create_coin_condition` has a `hint_delegated_puzzles` flag: when recreating the store
with the same owner and delegated puzzles, you can pass `false` and only the launcher id is written. When
anything changes, pass `true` so `from_spend` (and other wallets) can recover the new configuration.

Because the memos only describe changes, `from_spend` needs the parent's delegated puzzles as its last
argument to know the current set when they aren't re-hinted.

## Melting

The owner can melt the store by outputting `Conditions::new().melt_singleton()` from the owner puzzle,
which destroys the singleton. Admins and writers can't melt it.

## Gotchas

- `Datastore::spend` consumes the store and returns a `CoinSpend`. It doesn't insert it into the
  `SpendContext`; call `ctx.insert(coin_spend)` yourself.
- A writer spend can only update metadata, and an admin spend can't change the owner. Conditions they
  aren't allowed to output make the spend fail.
- `Datastore::from_spend` verifies that the memos are consistent with the created puzzle hash, so you
  can't be tricked into tracking a different owner than the one actually on chain.
- For NFT metadata in general (which uses the same state layer), see [NFT](/sdk/primitives/nft).
