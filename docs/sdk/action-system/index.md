---
title: Action System
slug: /sdk/action-system
---

# Action System

The action system is a declarative way to build transactions. Instead of writing the spend of every coin yourself, you describe what the transaction should do as a list of [`Action`](/sdk/action-system/actions)s ("send 5 XCH to Bob", "mint an NFT", "pay a fee"), add the coins you want to spend, and the SDK works out which coins create which outputs, creates change, links the spends together, and spends every coin.

Use it whenever a transaction is made of ordinary wallet operations on XCH, CATs, NFTs, DIDs and option contracts, especially when several assets are involved at once, or when you're making or taking an [offer](/sdk/offers). Drop down to the primitives (such as [`Cat`](/sdk/primitives/cat) or [`Nft`](/sdk/primitives/nft)) when you need full control over a single spend, or when you're working with an asset the action system doesn't know about.

Everything on this page lives in [`chia_wallet_sdk::driver`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/index.html), and the most common types (`Spends`, `Action`, `Id`, `Deltas`, `Delta`, `Relation`, `Outputs`) are in the prelude.

## A first transaction

This sends 5 mojos to Bob and pays a 1 mojo fee, from a coin owned by Alice's standard puzzle. The change goes back to Alice.

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn send_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(10);
    let bob = BlsPair::new(1);

    // Coins are added to the spends, and change is sent to Alice's puzzle hash
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    let actions = [
        Action::send(Id::Xch, bob.puzzle_hash, 5, Memos::None),
        Action::fee(1),
    ];

    let deltas = spends.apply(&mut ctx, &actions)?;

    // Spends every coin with the standard puzzle, using the key for its puzzle hash
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob's payment and Alice's change
    assert_eq!(outputs.xch.len(), 2);
    assert_eq!(outputs.fee, 1);
    assert_eq!(
        sim.unspent_coins(alice.puzzle_hash, false)[0].amount,
        4
    );

    Ok(())
}
```

## The pieces

| Type                                                              | What it is                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`Action`](/sdk/action-system/actions)                            | A high level operation, created with constructors like `Action::send` or `Action::mint_nft`.                               |
| `Id`                                                              | Identifies the asset an action applies to: `Id::Xch`, `Id::Existing(asset_id_or_launcher_id)`, or `Id::New(action_index)`. |
| `Spends`                                                          | The coins being spent and what each of them will output. Actions are applied to it, and it's finished into coin spends.    |
| `Deltas` / `Delta`                                                | How much of each asset the actions consume (`output`) and produce (`input`), used for coin selection.                      |
| `Relation`                                                        | How the spends are tied together so the transaction can't be split apart.                                                  |
| `Outputs`                                                         | The coins (and singletons) the transaction created, returned when it's finished.                                           |
| [`SpendKind`](/sdk/action-system/custom-spends), `SpendableAsset` | What a coin's p2 puzzle must output, for when you spend coins with something other than the standard puzzle.               |

## Lifecycle

A transaction goes through the same steps every time:

1. **Calculate deltas.** `Deltas::from_actions(&actions)` tells you how much of each asset the actions need, so you can select coins before building anything.
2. **Create `Spends` and add coins.** `Spends::new(change_puzzle_hash)` and `spends.add(coin)` for every selected coin. `add` accepts XCH `Coin`s, `Cat`s, `Nft`s, `Did`s, `OptionContract`s, and an offer's `OfferCoins`.
3. **Apply the actions.** `spends.apply(&mut ctx, &actions)` applies each action in order and returns the `Deltas` (the same as step 1).
4. **Prepare.** `spends.prepare(&mut ctx, &deltas, relation)` creates change for every asset, attaches transaction-wide conditions (the reserved fee, offer assertions, settlement payment assertions) to a single spend, and adds the `Relation` conditions.
5. **Spend.** Provide the p2 spend for every coin in `prepared.unspent()` and call `prepared.spend(&mut ctx, coin_spends)`, which returns the `Outputs`.

Steps 4 and 5 are combined by `finish_with_keys`, which spends every coin with the [standard puzzle](/sdk/primitives/standard) (looking up the synthetic key by p2 puzzle hash) and every settlement coin with the settlement payments puzzle. If a key is missing, it returns `DriverError::MissingKey`. When you need any other p2 puzzle, such as a [vault](/sdk/primitives/vaults), use `prepare`/`unspent`/`spend` directly, as described in [Custom Spends](/sdk/action-system/custom-spends).

The coin spends end up in the `SpendContext`. Take them with `ctx.take()`, then sign them (see [Keys & Signing](/sdk/concepts/signing)) to build a `SpendBundle`.

## Referring to assets with `Id`

Every action that touches an asset takes an `Id`:

- `Id::Xch` is XCH.
- `Id::Existing(id)` is a CAT (by asset id) or singleton (by launcher id) whose coins were added to the `Spends`.
- `Id::New(index)` is an asset created in the same transaction by the action at `index` in the list passed to `apply`. Issuing a CAT, minting an NFT, creating a DID and minting an option all create new assets.

Because `Id::New` is positional, the list you pass to `Deltas::from_actions` and `Spends::apply` must be the same list in the same order. An `Id::Existing` that doesn't match anything added to the spends fails with `DriverError::InvalidAssetId`.

This issues a CAT and immediately splits it into two coins for different people:

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn issue_and_send() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = BlsPair::new(1);
    let alice_hint = ctx.hint(alice.puzzle_hash)?;
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    let actions = [
        // Action 0 creates the CAT, so it's referred to as `Id::New(0)`
        Action::single_issue_cat(None, 1_000),
        Action::send(Id::New(0), bob.puzzle_hash, 300, bob_hint),
        Action::send(Id::New(0), alice.puzzle_hash, 700, alice_hint),
    ];

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Outputs are keyed by the same id the actions used
    let cats = &outputs.cats[&Id::New(0)];
    assert_eq!(cats.len(), 2);

    // In later transactions, the CAT is an existing asset
    let asset_id = cats[0].info.asset_id;
    let _id = Id::Existing(asset_id);

    Ok(())
}
```

## Coin selection with deltas

The action system doesn't select coins for you, since it doesn't know what your wallet owns. Instead, calculate the deltas first. For each id, `Delta { input, output }` is the amount the actions add to the transaction (issuing a CAT, melting a singleton into XCH) and remove from it (sending, paying fees, locking in an option). Select at least `output - input` worth of coins, and at least one coin if `deltas.is_needed(&id)` is true, even when the difference is zero (for example, the NFT being updated, or an XCH coin to create a launcher from).

The amounts are `u128`, since totals of many coins can exceed `u64::MAX`. Change is computed from what you actually added, so selecting more than needed is fine. Selecting less fails with `DriverError::InsufficientFunds` when the spends are prepared, rather than producing a transaction the mempool would reject.

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::driver::coin_amount;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn select_coins_for_actions() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = BlsPair::new(0);
    let bob = BlsPair::new(1);

    // Alice's wallet has several coins
    let wallet: Vec<Coin> = [5, 10, 20, 50]
        .into_iter()
        .map(|amount| sim.new_coin(alice.puzzle_hash, amount))
        .collect();

    let actions = [
        Action::send(Id::Xch, bob.puzzle_hash, 25, Memos::None),
        Action::fee(2),
    ];

    // Work out how much XCH the actions need before building anything
    let deltas = Deltas::from_actions(&actions);
    let xch = deltas.get(&Id::Xch).copied().unwrap_or_default();
    let needed = coin_amount(xch.output.saturating_sub(xch.input))?;
    assert_eq!(needed, 27);

    let selected = select_coins(wallet, needed)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    for coin in selected {
        spends.add(coin);
    }

    let deltas = spends.apply(&mut ctx, &actions)?;
    spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let bob_balance: u64 = sim
        .unspent_coins(bob.puzzle_hash, false)
        .iter()
        .map(|coin| coin.amount)
        .sum();
    assert_eq!(bob_balance, 25);

    Ok(())
}
```

For CATs, do the same with `Id::Existing(asset_id)` and your wallet's `Cat`s. For singletons, add the singleton itself whenever its id appears in the deltas.

## Change and intermediate coins

`Spends::new(puzzle_hash)` uses one puzzle hash for two things:

- The **change puzzle hash**, which receives leftover value of every fungible asset, and every singleton that an action didn't send elsewhere.
- The **intermediate puzzle hash**, for ephemeral coins the SDK creates and spends within the same transaction. A coin can't create two identical children (they'd have the same coin id), so if two payments (or a payment and the change) would be identical, one of them is made from an intermediate coin instead. Intermediate coins are also used to emit conditions when no other spend can, for example when only settlement coins are being spent.

Use `Spends::with_separate_change_puzzle_hash(intermediate_puzzle_hash, change_puzzle_hash)` to send change somewhere else. You must be able to spend the intermediate puzzle hash, since its coins are spent in the same transaction; `spends.p2_puzzle_hashes()` lists every puzzle hash you'll need to sign for.

## Relations

Without anything tying them together, the spends of a transaction could be split up by a farmer or a third party, and only some of them included in a block. A `Relation` adds conditions to every spend that emits conditions so that this can't happen:

| Relation                         | Conditions added                                                                   | Splittable?                                    |
| -------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| `Relation::None`                 | Nothing.                                                                           | Yes, unless something else ties them together. |
| `Relation::AssertConcurrent`     | Each spend asserts `ASSERT_CONCURRENT_SPEND` of the previous one, wrapping around. | No.                                            |
| `Relation::CoinAnnouncementRing` | Each spend creates an empty coin announcement and asserts the next spend's.        | No.                                            |
| `Relation::CoinAnnouncementHub`  | The first spend creates an announcement, and every other spend asserts it.         | The first spend can be included on its own.    |

`Relation::AssertConcurrent` is the usual choice. If there's only one conditions spend, no relation conditions are added. Settlement spends never get relation conditions (they can only make payments), but the payments they make are always asserted by a conditions spend, regardless of the relation (see [Custom Spends](/sdk/action-system/custom-spends#settlement-coins)).

## Outputs

`finish_with_keys` and `spend` return `Outputs`, which describes what the transaction created:

- `outputs.xch`: XCH coins created by actions, plus change. Intermediate coins aren't included.
- `outputs.cats[&id]`: CAT coins created by actions, plus change, keyed by the `Id` used in the actions.
- `outputs.dids[&id]`, `outputs.nfts[&id]`, `outputs.options[&id]`: the final coin of each singleton, unless it was melted or exercised.
- `outputs.fee` and `outputs.reserved_fee`: the total fee, and the part of it asserted with `RESERVE_FEE`.

Singleton outputs are complete `Nft`, `Did` and `OptionContract` values with lineage proofs, so you can add them to a new `Spends` in the next transaction without fetching anything from the chain, as long as the previous transaction confirms first.

## Guarantees

- **Exact change.** Change is calculated from the selected coins and the deltas. Insufficient funds are an error, and value is never silently left over as a fee.
- **No stripped settlement spends.** Payments made by settlement coins are asserted by a conditions spend, so nobody can remove a settlement spend from the bundle and claim the coin. Two settlement coins with the same puzzle hash making the same notarized payment would make identical announcements, so this is rejected with `DriverError::DuplicateSettlementPayment`.
- **Determinism.** Building the same actions against the same coins always produces the same coin spends.
- **Amounts are checked.** Sending a singleton with the wrong amount fails with `DriverError::SingletonAmountMismatch`, and totals that overflow a coin amount fail with `DriverError::AmountOverflow`.

## Common errors

| Error                         | Usual cause                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `InsufficientFunds`           | The coins you added don't cover the deltas.                                                                                    |
| `InvalidAssetId`              | An `Id` refers to an asset that wasn't added (or an action that doesn't create one), or the action doesn't support that asset. |
| `NoSourceForOutput`           | No coin can create the output, for example an action on a singleton that has already been locked in an option.                 |
| `CannotEmitConditions`        | An action needs to emit conditions, but the only coins it could use are settlement coins. Add an XCH coin.                     |
| `SingletonAmountMismatch`     | `Action::send` or `Action::melt_singleton` used an amount other than the singleton's amount.                                   |
| `MissingKey` / `MissingSpend` | `finish_with_keys` had no key for a p2 puzzle hash, or `spend` was missing a coin spend from `unspent()`.                      |

## Next steps

- [Action Reference](/sdk/action-system/actions): every action, with examples.
- [Custom Spends](/sdk/action-system/custom-spends): spending coins with non-standard p2 puzzles, settlement coins and revocation.
- [Offers](/sdk/offers): making and taking offers with the action system.
