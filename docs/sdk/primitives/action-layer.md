---
title: Action Layer Singletons
---

# Action Layer Singletons

The **action layer** is a pattern for building on-chain applications as singletons that anyone can
interact with. Instead of a single owner deciding how the singleton is spent, the singleton's inner
puzzle commits to a merkle tree of **actions**. Each spend runs one or more actions, which update the
singleton's **state**, and a **finalizer** recreates the singleton with the new state. Data that doesn't
fit in the state is stored in **slots**: 0-amount coins created by the singleton that commit to a value
and can only be spent by the singleton.

The SDK includes drivers for several applications built this way: the CATalog and XCHandles registries,
the reward distributor, plus supporting pieces such as the medieval vault, state scheduler, precommit
coins and reserves. All of it is behind the `action-layer` feature, which also enables `chip-0035`:

```toml
chia-wallet-sdk = { version = "...", features = ["action-layer"] }
```

On `main` (unreleased), the SDK also has an NFT [auction](/sdk/primitives/auctions) built on the action
layer, behind the `auction` feature (which implies `action-layer`).

:::note
This is unrelated to the SDK's [action system](/sdk/action-system) (`Action`, `Spends`), which is a
transaction builder. The action layer is an on-chain puzzle pattern.
:::

## Architecture

```text
SingletonLayer
  ActionLayer { merkle_root, state, finalizer }
    action 1 puzzle (revealed with a merkle proof)
    action 2 puzzle
    ...
```

| Concept        | SDK type                                    | Description                                                                                             |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Action layer   | `ActionLayer<S, P>`, `ActionLayerSolution`  | Inner puzzle that runs a list of action spends, each proven to be in the merkle tree of allowed actions |
| State          | e.g. `CatalogRegistryState`                 | Curried into the action layer. Each action receives the current state and returns the new one           |
| Finalizer      | `Finalizer::Default` / `Finalizer::Reserve` | Recreates the singleton with the new state. The reserve finalizer also manages a reserve coin           |
| Actions        | `SingletonAction<AS>`                       | Each action is its own puzzle, curried with the singleton's constants                                   |
| Slots          | `Slot<V>`, `SlotInfo<V>`                    | 0-amount coins that store values (for example a sorted linked list of registered CATs)                  |
| Precommit coin | `PrecommitCoin<V>`                          | A CAT coin that commits to a value and payment before an action can use it, to prevent front running    |
| Reserve        | `Reserve`                                   | A CAT coin controlled by the singleton through the finalizer, which holds funds (such as rewards)       |

Because anyone can run actions, an action spend often returns **secure conditions** (usually announcement
assertions). These must be included in some other spend in the same transaction, which ties that spend
to the singleton spend so that the action can't be stripped out or reused.

### Lifecycle of a spend

Each application singleton (`CatalogRegistry`, `XchandlesRegistry`, `RewardDistributor`) follows the
same pattern:

1. Get an action with `registry.new_action::<SomeAction>()`. Actions are built from the singleton's
   constants, so the SDK can compute their puzzle hashes.
2. Call the action's `spend(...)` method. This creates any coin spends the action needs (precommit
   coins, slots, NFT launchers), appends the action spend to `registry.pending_spend`, and returns the
   conditions that must be asserted elsewhere.
3. Repeat for more actions. `pending_spend` tracks the latest state, created and spent slots, and logs.
4. Call `registry.finish_spend(ctx)`, which spends the singleton with all pending actions and returns
   the child singleton.

To follow a singleton on chain, use `from_parent_spend` / `from_spend` on its coin spends, and
`from_mempool_item` to apply actions that are pending in the mempool.

## Applications

| Application                             | Types                                                                                                | What it does                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATalog                                 | `CatalogRegistry`, `CatalogRegistryInfo`, `CatalogRegistryState`, `CatalogRegistryConstants`         | A registry of CATs. Registering a CAT (by TAIL hash) mints an NFT that holds its metadata (`CatNftMetadata`). Each TAIL can only be registered once, enforced by slots                                                           |
| XCHandles                               | `XchandlesRegistry`, `XchandlesRegistryInfo`, `XchandlesRegistryState`, `XchandlesConstants`         | A registry of handles (names) with expiration, priced by a pricing puzzle. Handles can be registered, extended, expired and re-registered, and updated                                                                           |
| Reward distributor                      | `RewardDistributor`, `RewardDistributorInfo`, `RewardDistributorState`, `RewardDistributorConstants` | Distributes rewards (a CAT held in a `Reserve`) to entries over epochs. Entries are managed by a manager singleton, or are NFTs from a collection, NFTs from a curated DataLayer store, or staked CATs (`RewardDistributorType`) |
| Medieval vault                          | `MedievalVault`, `MedievalVaultInfo`                                                                 | A plain m-of-n BLS multisig singleton, used to administer other singletons                                                                                                                                                       |
| State scheduler                         | `StateScheduler`, `StateSchedulerInfo`                                                               | A singleton that sends a pre-committed sequence of state updates to another singleton at given times (for example to schedule price changes)                                                                                     |
| Auction (unreleased, `auction` feature) | `Auction`, `AuctionInfo`, `AuctionSettings`, `AuctionState`, `AuctionReserve`                        | An English auction for an NFT, with bids in XCH or a CAT held in a reserve coin. It has its own driver (`Auction::spend`) rather than the `pending_spend` flow below. See [Auctions](/sdk/primitives/auctions)                   |

Each registry's actions are separate types:

- CATalog: `CatalogRegisterAction`, `CatalogRefundAction`, `DelegatedStateAction`.
- XCHandles: `XchandlesRegisterAction`, `XchandlesExtendAction`, `XchandlesExpireAction`,
  `XchandlesOracleAction`, `XchandlesRefundAction`, `XchandlesInitiateUpdateAction`,
  `XchandlesExecuteUpdateAction`, `DelegatedStateAction`.
- Reward distributor: `RewardDistributorAddEntryAction`, `RewardDistributorRemoveEntryAction`,
  `RewardDistributorStakeAction`, `RewardDistributorUnstakeAction`, `RewardDistributorAddIncentivesAction`,
  `RewardDistributorCommitIncentivesAction`, `RewardDistributorWithdrawIncentivesAction`,
  `RewardDistributorNewEpochAction`, `RewardDistributorSyncAction`, `RewardDistributorInitiatePayoutAction`,
  `RewardDistributorRefreshAction`.

`DelegatedStateAction` lets another singleton (the "price singleton", whose launcher id is in the
registry's constants) replace the registry's state by sending it a message. This is how registration
prices are updated.

### Launching

Launching an action layer singleton involves several coins (a launcher, the eve spend that creates the
initial slots, and a "security coin" that ties it together), so the SDK provides launch helpers:
`launch_catalog_registry`, `launch_xchandles_registry` and `launch_reward_distributor`. They take an
[offer](/sdk/offers) that provides the funds, and return the new singleton, its initial slots, and the
secret key of a freshly generated security coin that you need to sign with.

## Example: registering a CAT in a CATalog

This example (adapted from the SDK's `test_catalog`) launches a CATalog registry, then registers a CAT
in it. Registration is a two-step process:

1. The registrant creates a **precommit coin**: a CAT coin of the payment asset, holding the
   registration price, that commits to the TAIL being registered and the inner puzzle of the NFT that
   will be minted for it. It must wait `relative_block_height` blocks, so nobody can see the registration
   in the mempool and front run it.
2. Anyone spends the registry with `CatalogRegisterAction`, which spends the precommit coin (paying the
   registration fee), inserts the TAIL hash between its neighbors in the sorted list of slots, and mints
   the CAT's NFT.

```rust
use chia_wallet_sdk::chia::puzzle_types::{cat::GenesisByCoinIdTailArgs, singleton::SingletonStruct};
use chia_wallet_sdk::clvm_traits::clvm_quote;
use chia_wallet_sdk::driver::{
    CatalogPrecommitValue, CatalogRegisterAction, CatalogRegistryConstants, PrecommitCoin,
    launch_catalog_registry, sign_standard_transaction,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;

#[test]
fn register_cat_in_catalog() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // The launcher id is filled in when the registry is launched.
    let constants = CatalogRegistryConstants {
        launcher_id: Bytes32::default(),
        royalty_address: Bytes32::new([7; 32]),
        royalty_basis_points: 100,
        precommit_payout_puzzle_hash: Bytes32::new([8; 32]),
        relative_block_height: 1,
        price_singleton_launcher_id: Bytes32::new([9; 32]),
    };
    let registration_price = 2000;

    // Issue the CAT that registrations are paid with.
    let minter = sim.bls(10_000);
    let minter_p2 = StandardLayer::new(minter.pk);
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        minter.coin.coin_id(),
        None,
        10_000,
        Conditions::new().create_coin(minter.puzzle_hash, 10_000, Memos::None),
    )?;
    minter_p2.spend(ctx, minter.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[minter.sk.clone()])?;
    let payment_cat = cats[0];

    // The launch is funded by an offer of 1 mojo.
    let funder = sim.bls(1);
    let offer_spend = StandardLayer::new(funder.pk).spend_with_conditions(
        ctx,
        Conditions::new().create_coin(SETTLEMENT_PAYMENT_HASH.into(), 1, Memos::None),
    )?;
    let puzzle_reveal = ctx.serialize(&offer_spend.puzzle)?;
    let solution = ctx.serialize(&offer_spend.solution)?;
    let signature =
        sign_standard_transaction(ctx, funder.coin, offer_spend, &funder.sk, &TESTNET11_CONSTANTS)?;
    let offer = Offer::from_spend_bundle(
        ctx,
        &SpendBundle::new(
            vec![CoinSpend::new(funder.coin, puzzle_reveal, solution)],
            signature,
        ),
    )?;

    // Launch the registry, which starts with two slots: the left and right ends of the list.
    let (_signature, security_sk, mut catalog, slots, _security_coin) = launch_catalog_registry(
        ctx,
        &offer,
        registration_price,
        |_ctx, _launcher_id, _security_coin, (constants, payment_asset_id)| {
            Ok((Conditions::new(), constants, payment_asset_id))
        },
        &TESTNET11_CONSTANTS,
        (constants, payment_cat.info.asset_id),
    )?;
    sim.spend_coins(ctx.take(), &[funder.sk, security_sk])?;
    assert_eq!(catalog.info.state.registration_price, registration_price);

    // Step 1: create a precommit coin for the CAT being registered.
    let tail = ctx.curry(GenesisByCoinIdTailArgs::new(Bytes32::new([1; 32])))?;
    let tail_hash = ctx.tree_hash(tail);
    let eve_nft_inner_puzzle = clvm_quote!(Conditions::new().create_coin(
        minter.puzzle_hash,
        1,
        Memos::None,
    ))
    .to_clvm(ctx)?;
    let eve_nft_inner_puzzle_hash = ctx.tree_hash(eve_nft_inner_puzzle);

    let value = CatalogPrecommitValue::with_default_cat_maker(
        payment_cat.info.asset_id.tree_hash(),
        eve_nft_inner_puzzle_hash.into(),
        tail,
    );
    let precommit_coin = PrecommitCoin::new(
        ctx,
        payment_cat.coin.coin_id(),
        payment_cat.child_lineage_proof(),
        payment_cat.info.asset_id,
        SingletonStruct::new(catalog.info.constants.launcher_id)
            .tree_hash()
            .into(),
        constants.relative_block_height,
        constants.precommit_payout_puzzle_hash,
        minter.puzzle_hash, // refund puzzle hash, if the registration can't go through
        value,
        registration_price,
    )?;

    let inner_spend = minter_p2.spend_with_conditions(
        ctx,
        Conditions::new()
            .create_coin(precommit_coin.inner_puzzle_hash, registration_price, Memos::None)
            .create_coin(minter.puzzle_hash, 10_000 - registration_price, Memos::None),
    )?;
    Cat::spend_all(ctx, &[CatSpend::new(payment_cat, inner_spend)])?;
    sim.spend_coins(ctx.take(), &[minter.sk])?;

    // Step 2: register. The new TAIL goes between the two end slots.
    let mut slots = slots.to_vec();
    slots.sort_unstable_by_key(|slot| slot.info.value);
    let (left_slot, right_slot) = (slots[0].clone(), slots[1].clone());

    let secure_conditions = catalog.new_action::<CatalogRegisterAction>().spend(
        ctx,
        &mut catalog,
        tail_hash.into(),
        left_slot,
        right_slot,
        &precommit_coin,
        Spend::new(eve_nft_inner_puzzle, NodePtr::NIL),
    )?;
    assert_eq!(catalog.pending_spend.spent_slots.len(), 2);

    let (catalog, _signature) = catalog.finish_spend(ctx)?;

    // Another spend in the transaction must assert the secure conditions. Here a coin with a
    // quoted conditions puzzle does it; in practice it's one of the registrant's coins.
    let puzzle = clvm_quote!(secure_conditions).to_clvm(ctx)?;
    let coin = sim.new_coin(ctx.tree_hash(puzzle).into(), 1);
    ctx.spend(coin, Spend::new(puzzle, NodePtr::NIL))?;

    sim.spend_coins(ctx.take(), &[])?;
    assert!(sim.coin_state(catalog.coin.coin_id()).is_some());

    Ok(())
}
```

If the precommit coin can't be used (the price changed, the payment CAT is wrong, or the TAIL is
already registered), `CatalogRefundAction` spends it back to its refund puzzle hash instead.

## Slots

A slot is a 0-amount coin whose puzzle is curried with the singleton's launcher id, a nonce (which
distinguishes slot types) and the hash of its value. Only the singleton can spend it, by revealing its
own inner puzzle hash. `Slot::new(lineage_proof, SlotInfo::from_value(...))` describes a slot created
by a singleton spend; drivers create these for you (`created_slot_value_to_slot`).

Registries use slots as a sorted linked list: each `CatalogSlotValue` (or XCHandles handle slot)
records its neighbors, so inserting a new value means spending the two neighboring slots and creating
three new ones. This proves on chain that a value isn't already registered, without the singleton
having to store the whole list. Keep track of the current slots (for example by indexing slot coins
created by the singleton) so you can supply the right neighbors; `actual_neigbors` and `actual_slot`
adjust for slots that were already spent and recreated earlier in the same pending spend.

## Medieval vault

`MedievalVault` is a singleton with a simple m-of-n BLS multisig inner puzzle
(`P2MOfNDelegateDirectArgs`). It's used as the administrator of action layer singletons, for example as
a price singleton or a reward distributor manager. Its info can be recovered from the launcher's
`MedievalVaultHint` and from the memos of rekey spends.

```rust
use chia_wallet_sdk::driver::{MedievalVault, MedievalVaultHint, MedievalVaultInfo};
use chia_wallet_sdk::prelude::*;

#[test]
fn medieval_vault_rekey() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let funder = sim.bls(1);
    let [alice, bob] = BlsPair::range();

    // Launch a 1-of-2 vault. The hint lets wallets recover its configuration.
    let launcher = Launcher::new(funder.coin.coin_id(), 1);
    let launcher_id = launcher.coin().coin_id();
    let info = MedievalVaultInfo::new(launcher_id, 1, vec![alice.pk, bob.pk]);
    let (conditions, _) = launcher.spend(ctx, info.inner_puzzle_hash().into(), info.to_hint())?;
    StandardLayer::new(funder.pk).spend(ctx, funder.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[funder.sk])?;

    let launcher_spend = sim.coin_spend(launcher_id).unwrap();
    let vault = MedievalVault::from_parent_spend(ctx, &launcher_spend)?.unwrap();
    assert_eq!(vault.info, info);

    // Rekey to 2-of-2, signed by Alice alone.
    let memos = ctx.alloc(&MedievalVaultHint {
        my_launcher_id: launcher_id,
        m: 2,
        public_key_list: vec![alice.pk, bob.pk],
    })?;
    let new_info = MedievalVaultInfo::new(launcher_id, 2, vec![alice.pk, bob.pk]);
    let conditions =
        Conditions::new().create_coin(new_info.inner_puzzle_hash().into(), 1, Memos::Some(memos));
    vault
        .clone()
        .spend(ctx, &[alice.pk], conditions, TESTNET11_CONSTANTS.genesis_challenge)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // The child is parsed from the rekey spend.
    let vault_spend = sim.coin_spend(vault.coin.coin_id()).unwrap();
    let vault = MedievalVault::from_parent_spend(ctx, &vault_spend)?.unwrap();
    assert_eq!(vault.info, new_info);

    Ok(())
}
```

`MedievalVault::spend` makes the delegated puzzle non-replayable by asserting the coin id (unless the
conditions already assert the coin or parent id) and adding the network's genesis challenge as a
`REMARK` (`delegated_conditions`), so pass the genesis challenge of the network you are on. `spend_sunsafe` skips that, and `delegated_puzzle_for_rekey` /
`delegated_puzzle_for_flexible_send_message` build delegated puzzles for signers that sign offline.

## State scheduler

A `StateScheduler<S>` is a singleton launched with a strictly increasing list of `(timestamp, state)`
pairs (`StateSchedulerInfo::state_schedule`) and a receiver singleton. Each spend asserts that the next
timestamp has passed and sends the next state to the receiver as a message, advancing its `generation`.
After the last state, the singleton becomes `final_puzzle_hash`. Pair it with a registry's
`DelegatedStateAction` (using the scheduler as the price singleton) to schedule price changes in
advance. `StateScheduler::from_launcher_spend` parses one from its launcher spend, and `child()`
computes the next generation.

## Supporting primitives

- **`PrecommitCoin<V>`**: a CAT coin locked by the `PrecommitLayer`. It commits to a value (such as
  `CatalogPrecommitValue` or `XchandlesPrecommitValue`), a payout puzzle hash, a refund puzzle hash and
  the controlling singleton, and must be at least `relative_block_height` blocks old before it can be
  used. The singleton spends it in either register or refund mode.
- **`Reserve`**: a CAT coin locked by `P2DelegatedBySingletonLayer`, spent by the singleton through the
  reserve finalizer. The reward distributor keeps its rewards here; `Reserveful` is implemented by
  states that track a reserve amount.
- **`UniquenessPrelauncher<V>`**: a coin whose puzzle hash commits to a value and which creates a
  singleton launcher. Since there's only one possible prelauncher coin per parent and value, it
  guarantees that only one launcher (and so one NFT) exists per registration.
- **`CatMaker`** and `DefaultCatMakerArgs`: small puzzles that compute a CAT puzzle hash from an inner
  puzzle hash, so actions can verify payments in a CAT chosen by the registry's state. `CatMaker` has
  `Default`, `Revocable` and `Xch` variants (with `DefaultCatMakerArgs`, `RevocableCatMakerArgs` and
  `XchCatMaker` in `chia_wallet_sdk::types::puzzles`). In 0.37.1 they're part of the action layer and
  need the `action-layer` feature. On `main` (unreleased), they moved out of the action layer (to the
  driver's `cat_maker` module and the types crate's `cat_makers` module) and are no longer
  feature-gated, so other primitives such as [partial offers](/sdk/primitives/partial-offers) can use
  them. The public paths (`chia_wallet_sdk::driver::CatMaker`,
  `chia_wallet_sdk::types::puzzles::DefaultCatMakerArgs`, ...) are the same in both.
- **`P2ParentCoin`**: a coin (XCH or CAT) that can be spent by whoever controls its parent's inner
  puzzle. Its solution reveals the parent's inner puzzle with a new solution, the puzzle checks it
  against the parent coin id, and the conditions it outputs become the coin's conditions.

```rust
use chia_wallet_sdk::driver::P2ParentCoin;
use chia_wallet_sdk::prelude::*;

#[test]
fn p2_parent_coin() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1000);
    let alice_p2 = StandardLayer::new(alice.pk);

    // Alice creates a p2 parent coin.
    let conditions =
        Conditions::new().create_coin(P2ParentCoin::puzzle_hash(None).into(), 1000, Memos::None);
    alice_p2.spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    let parent_spend = sim.coin_spend(alice.coin.coin_id()).unwrap();
    let puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&parent_spend.solution)?;
    let (coin, _memos) = P2ParentCoin::parse_child(ctx, alice.coin, puzzle, solution)?.unwrap();

    // Spending it requires Alice's puzzle (and so Alice's signature) again.
    let bob = Bytes32::new([1; 32]);
    let delegated_spend = alice_p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(bob, 1000, Memos::None),
    )?;
    coin.spend(ctx, delegated_spend, ())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(sim.unspent_coins(bob, false).len(), 1);

    Ok(())
}
```

## Gotchas

- The SDK doesn't ship production constants for these registries yet (`CatalogRegistryConstants::get`
  panics with `todo!`). Construct the constants for the deployment you're targeting yourself.
- Action spends add coin spends to the `SpendContext` immediately, but the singleton itself is only spent
  by `finish_spend`. Don't forget to call it, and don't run two pending spends of the same singleton
  at once.
- Always include the returned secure conditions in another spend of the same transaction.
- Keep your slot index up to date. Using a slot that was already spent (or the wrong neighbors) makes
  the spend invalid.
- Precommit coins can't be used until `relative_block_height` blocks after they're created.
