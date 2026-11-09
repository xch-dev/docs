---
title: Custom Spends
---

# Custom Spends

`Spends::finish_with_keys` assumes that every coin you add is locked by the [standard puzzle](/sdk/primitives/standard), or is a settlement coin. When your coins are controlled by anything else (a [vault](/sdk/primitives/vaults), a custom Chialisp puzzle, a hardware wallet that signs differently), finish the transaction yourself in two steps: `prepare` tells you what each coin's p2 puzzle has to output, and `spend` wraps the p2 spends you provide in the outer layers (CAT, singleton, NFT, and so on).

This page also covers the parts of the action system that sit between the actions and the coin spends: `SpendKind`, transaction-wide conditions (`ConditionConfig`), settlement coins, and revoking CATs.

## `prepare`, `unspent` and `spend`

After applying actions:

1. `spends.prepare(&mut ctx, &deltas, relation)` creates change, attaches transaction-wide conditions, and adds the relation. It returns a `Spends<Finished>`, which can no longer have actions applied to it.
2. `prepared.unspent()` returns a `Vec<(SpendableAsset, SpendKind)>`: every coin you need to provide a p2 spend for, and what that p2 puzzle must output.
3. Build a `Spend` (puzzle and solution) for each one, and collect them into a `HashMap<Bytes32, Spend>` keyed by the coin id (`asset.coin().coin_id()`).
4. `prepared.spend(&mut ctx, coin_spends)` spends every coin, adding the outer layers, and returns the `Outputs`. A missing p2 spend fails with `DriverError::MissingSpend`.

The list includes coins you never added yourself: intermediate coins (created and spent in the same transaction), and extra spends of a singleton, such as an NFT that's updated twice. Their p2 puzzle hash is one you control (the intermediate or change puzzle hash, or the singleton's own p2 puzzle hash), so handle them the same way as the coins you added. `spends.p2_puzzle_hashes()` returns every p2 puzzle hash the transaction will need.

### `SpendableAsset`

`SpendableAsset` is the coin being spent: `Xch(Coin)`, `Cat(Cat)`, `RevokedCat(Cat)`, `Did(Did)`, `Nft(Nft)` or `Option(OptionContract)`. Use `asset.coin()` for the full coin, and `asset.p2_puzzle_hash()` to find out which of your puzzles controls it. For a `RevokedCat`, `p2_puzzle_hash()` is the CAT's hidden puzzle hash, since that's the puzzle authorizing the spend (see [Revocation](#revocation)).

### `SpendKind`

`SpendKind` is what the p2 puzzle must output:

- `SpendKind::Conditions(spend)`: the p2 puzzle outputs arbitrary conditions. `spend.finish()` returns the `Conditions` to output, which you pass to your puzzle (for example, as the delegated puzzle of the standard puzzle, or through `SpendWithConditions`).
- `SpendKind::Settlement(spend)`: the coin is locked by the settlement payments puzzle. `spend.finish()` returns the `Vec<NotarizedPayment>` for its solution. Spend it with `SettlementLayer`.

You only decide how to authorize conditions spends. Settlement spends always look the same.

### Example: a custom p2 puzzle

This wallet has one coin with the standard puzzle and one locked by the `p2_delegated_conditions` puzzle, which is signed directly by a key. Both are spent in one transaction, with each spend built by its own layer.

```rust
use std::collections::HashMap;

use chia_wallet_sdk::chia::puzzle_types::{Memos, offer::SettlementPaymentsSolution};
use chia_wallet_sdk::driver::{P2DelegatedConditionsLayer, SpendKind};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::P2DelegatedConditionsSolution;

#[test]
fn custom_p2_puzzle() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(5);
    let bob = BlsPair::new(1);

    // A second coin, locked by a different puzzle that Alice can also spend
    let custom = P2DelegatedConditionsLayer::new(alice.pk);
    let custom_puzzle_hash: Bytes32 = custom.tree_hash().into();
    let custom_coin = sim.new_coin(custom_puzzle_hash, 10);

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    spends.add(custom_coin);

    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::send(Id::Xch, bob.puzzle_hash, 12, Memos::None),
            Action::fee(1),
        ],
    )?;

    let prepared = spends.prepare(&mut ctx, &deltas, Relation::AssertConcurrent)?;
    let mut coin_spends = HashMap::new();

    for (asset, kind) in prepared.unspent() {
        let spend = match kind {
            SpendKind::Conditions(spend) => {
                let conditions = spend.finish();

                if asset.p2_puzzle_hash() == alice.puzzle_hash {
                    StandardLayer::new(alice.pk).spend_with_conditions(&mut ctx, conditions)?
                } else if asset.p2_puzzle_hash() == custom_puzzle_hash {
                    let solution = P2DelegatedConditionsSolution::new(conditions.into_iter().collect());
                    custom.construct_spend(&mut ctx, solution)?
                } else {
                    anyhow::bail!("unknown p2 puzzle hash {}", asset.p2_puzzle_hash());
                }
            }
            SpendKind::Settlement(spend) => SettlementLayer
                .construct_spend(&mut ctx, SettlementPaymentsSolution::new(spend.finish()))?,
        };

        coin_spends.insert(asset.coin().coin_id(), spend);
    }

    let outputs = prepared.spend(&mut ctx, coin_spends)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // 15 in total, 12 to Bob, 1 fee, and 2 change back to Alice's standard puzzle
    let change: u64 = outputs
        .xch
        .iter()
        .filter(|coin| coin.puzzle_hash == alice.puzzle_hash)
        .map(|coin| coin.amount)
        .sum();
    assert_eq!(change, 2);

    Ok(())
}
```

The same pattern works for CATs, NFTs, DIDs and options with a custom p2 puzzle: `spend` adds the outer layers, so the `Spend` you provide is always just the p2 spend. For [vaults](/sdk/primitives/vaults), the p2 spend is built from a MIPS spend instead of a layer.

## Transaction-wide conditions

Some conditions aren't tied to a particular coin, such as the assertions that an offer's requested payments were made. Put them in `spends.conditions`, a `ConditionConfig`, before calling `prepare`:

- `conditions.required`: always included. If no spend can emit conditions (for example, only settlement coins are being spent), an intermediate coin is created with the intermediate puzzle hash to emit them. If even that isn't possible, `prepare` fails with `DriverError::CannotEmitConditions`.
- `conditions.optional`: only included if there's already a spend that can emit conditions.
- `conditions.disable_settlement_assertions`: skips the assertions of payments made by settlement coins (see below). Only set this when something else ties the settlement spends to the transaction.

`prepare` attaches all of these (and the `RESERVE_FEE` for `Action::fee`) to the first conditions spend, so they're emitted exactly once.

You can inspect what each spend will output without consuming the spends by preparing a clone:

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::driver::SpendKind;
use chia_wallet_sdk::prelude::*;

#[test]
fn required_conditions() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(10);

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    spends.add(sim.new_coin(alice.puzzle_hash, 10));

    // The transaction is only valid before timestamp 1000
    spends.conditions.required = Conditions::new().assert_before_seconds_absolute(1000);

    let deltas = spends.apply(
        &mut ctx,
        &[Action::send(Id::Xch, alice.puzzle_hash, 15, Memos::None)],
    )?;

    let prepared = spends.clone().prepare(&mut ctx, &deltas, Relation::None)?;

    let mut count = 0;
    for (_, kind) in prepared.unspent() {
        if let SpendKind::Conditions(spend) = kind {
            count += spend
                .finish()
                .iter()
                .filter(|condition| matches!(condition, Condition::AssertBeforeSecondsAbsolute(_)))
                .count();
        }
    }

    // Two coins are spent, but the condition is only emitted once
    assert_eq!(count, 1);

    Ok(())
}
```

## Settlement coins

A coin whose p2 puzzle is the settlement payments puzzle (`SETTLEMENT_PAYMENT_HASH`) is spent as a settlement spend automatically when you add it. That's how you take an offer: add `offer.offered_coins().clone()` to the spends, apply `offer.requested_payments().actions()`, and add your own coins to pay for them. See [Offers](/sdk/offers).

Anyone can spend a settlement coin. If the transaction only spent it, someone could remove that spend from the bundle and spend the coin themselves, taking whatever it was going to pay you. To prevent this, every payment a settlement coin makes (including change created from it) is notarized, and a conditions spend in the transaction asserts its puzzle announcement. Change and other coins created by a settlement coin use the settlement coin's id as the nonce, so they're unique. `Action::settle` uses the nonce you give it, so if two settlement coins with the same puzzle hash would make an identical notarized payment, `apply` and `prepare` fail with `DriverError::DuplicateSettlementPayment`, since a single assertion would be satisfied by either of them.

When the only coins in the transaction are settlement coins, there's no spend that can emit the assertions, so an intermediate coin with the intermediate puzzle hash is created from a settlement coin to emit them. You need to be able to spend it (with `finish_with_keys`, its key must be in the map).

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use indexmap::indexmap;

#[test]
fn settlement_only() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = BlsPair::new(0);
    let settlement = sim.new_coin(SETTLEMENT_PAYMENT_HASH.into(), 10);

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(settlement);

    // Claim the settlement coin as change, paying a fee
    let deltas = spends.apply(&mut ctx, &[Action::fee(1)])?;
    spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::None,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    // The settlement spend, and an intermediate coin owned by Alice that asserts its payments
    let coin_spends = ctx.take();
    assert_eq!(coin_spends.len(), 2);

    sim.spend_coins(coin_spends, &[alice.sk])?;
    assert_eq!(sim.unspent_coins(alice.puzzle_hash, false)[0].amount, 9);

    Ok(())
}
```

`spends.non_settlement_coin_ids()` returns the ids of the coins that are spent with conditions, which are the ones you need to authorize.

## Revocation

A [revocable CAT](/sdk/primitives/cat) has a hidden puzzle hash, chosen by the issuer, that can spend the CAT instead of its owner's p2 puzzle. To revoke CATs with the action system, add them with `spends.add_for_revocation(cat)?` instead of `spends.add(cat)`. Adding a CAT without a hidden puzzle fails with `DriverError::NotRevocable`.

Actions apply to revoked CATs like any other CAT, so you can send them, melt them with `Action::run_tail`, or do nothing, in which case the value goes to the change puzzle hash. In `unspent()`, they appear as `SpendableAsset::RevokedCat`, whose `p2_puzzle_hash()` is the hidden puzzle hash. Spend them with the hidden puzzle: when the hidden puzzle hash is a standard puzzle hash, `finish_with_keys` handles this for you.

When the hidden puzzle spends the CAT, the revocation layer passes its outputs through as-is. To keep the issuer's power to revoke, every coin created by a revocation spend is wrapped in the same revocation layer and hinted with its p2 puzzle hash, so the revoked value stays revocable and wallets can still find it. Revoked and normal spends of the same CAT can be mixed in one transaction, since they're all part of the same CAT ring.

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn revoke_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let issuer = sim.bls(10);
    let bob = BlsPair::new(1);
    let carol = BlsPair::new(2);
    let keys = indexmap! { issuer.puzzle_hash => issuer.pk };

    // Issue a revocable CAT with the issuer's puzzle hash as the hidden puzzle hash, and give it to Bob
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(issuer.puzzle_hash);
    spends.add(issuer.coin);
    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::single_issue_cat(Some(issuer.puzzle_hash), 10),
            Action::send(Id::New(0), bob.puzzle_hash, 10, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&issuer.sk))?;

    let bob_cat = outputs.cats[&Id::New(0)][0];
    let id = Id::Existing(bob_cat.info.asset_id);

    // The issuer revokes Bob's CAT and sends part of it to Carol, without Bob's signature
    let carol_hint = ctx.hint(carol.puzzle_hash)?;

    let mut spends = Spends::new(issuer.puzzle_hash);
    spends.add_for_revocation(bob_cat)?;
    let deltas = spends.apply(&mut ctx, &[Action::send(id, carol.puzzle_hash, 4, carol_hint)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), &[issuer.sk])?;

    // Carol's coin and the issuer's change are both still revocable
    for cat in &outputs.cats[&id] {
        assert_eq!(cat.info.hidden_puzzle_hash, Some(issuer.puzzle_hash));
    }
    assert!(
        outputs.cats[&id]
            .iter()
            .any(|cat| cat.info.p2_puzzle_hash == carol.puzzle_hash && cat.coin.amount == 4)
    );

    Ok(())
}
```

## Coin selection with deltas

The deltas tell you how much of each asset to select (see [Coin selection with deltas](/sdk/action-system#coin-selection-with-deltas)). A few rules matter when you build transactions yourself:

- Select at least `output - input` of each fungible asset. The SDK computes change from what you actually added, so overshooting is fine, and undershooting fails with `DriverError::InsufficientFunds` in `prepare`.
- If `deltas.is_needed(&id)` is true, select at least one coin, even when the difference is zero. Minting needs an XCH coin to create the launcher from, melting needs an XCH coin to receive the value, and updating a singleton needs the singleton.
- Any id in `deltas.ids()` that's a singleton (an NFT, DID or option launcher id) must have that singleton added.
- The amounts are `u128`. Convert a total to a coin amount with `coin_amount`, which fails with `DriverError::AmountOverflow` instead of truncating.
- If an action needs to emit conditions (creating a launcher, running a TAIL, asserting settlement payments) and every coin of the asset is a settlement coin, add an XCH coin you own. Even a coin with an amount of zero works.
