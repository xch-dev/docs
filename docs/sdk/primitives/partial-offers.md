---
title: Partial Offers
---

# Partial Offers

A partial offer ([CHIP-0052](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0052.md)) sells one fungible asset for another at a fixed price, and lets takers fill as much or as little of it as they want. The maker locks the offered asset (XCH, a CAT or a revocable CAT) in a coin that anyone can spend, as long as they pay the maker the requested asset at the agreed price. Each fill releases part of the offered asset to the taker and recreates the coin with what's left, until it's fully filled or the maker claws it back.

Use a partial offer when you want order-book style trading of a single pair, for example "1000 CATs at 0.4 XCH each, in any amount". For trading several assets at once, NFTs or options, or anything that has to be taken all at once, use a normal [offer](/sdk/offers).

The driver types are in [`chia_wallet_sdk::driver`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/index.html) and the puzzle types in `chia_wallet_sdk::types::puzzles`. None of them are in the prelude.

## Partial offers and normal offers

|                     | [Offer](/sdk/offers)                                               | Partial offer                                                                                    |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Assets              | Any number of XCH, CATs, NFTs and options on each side             | Exactly one asset on each side: XCH, a CAT or a revocable CAT                                    |
| Filling             | All or nothing                                                     | Any amount at or above a minimum, any number of times                                            |
| Where the funds are | In the maker's coins, which are only spent when the offer is taken | In a partial offer coin, which is created by the maker's spends (on the first fill, or up front) |
| Cancelling          | Spend any of the offered coins                                     | Claw back the latest partial offer coin                                                          |
| Expiration          | Optional `ASSERT_BEFORE_SECONDS_ABSOLUTE` in the maker's spend     | Optional `ASSERT_BEFORE_SECONDS_ABSOLUTE` output on every fill                                   |
| Shared as           | `offer1...`                                                        | `partial1...`                                                                                    |

The two fit together: filling a partial offer produces an ordinary `Offer`, which the taker takes with the same action system code as any other offer.

## How it works

The partial offer coin's p2 puzzle is a 1-of-2 puzzle (`P2OneOfManyLayer`) with two leaves:

- **The partial offer puzzle**, which anyone can spend. Its solution says how much of the requested asset the taker pays (`other_asset_amount`). The puzzle then:
  - asserts a notarized payment of that amount to the maker from the requested asset's settlement payments puzzle, with the coin's parent coin id as the nonce,
  - releases `other_asset_amount * price_precision / precision` (rounded down) of the offered asset,
  - recreates itself with the remaining amount, and
  - outputs a fixed list of **persistent conditions**, which the SDK uses for an expiration (`ASSERT_BEFORE_SECONDS_ABSOLUTE`) and a minimum fee per fill (`RESERVE_FEE`).
- **The maker's puzzle hash**, so the maker can claw back whatever is left at any time, including after the offer expires.

For a CAT, the 1-of-2 puzzle is wrapped in the CAT layer (and the revocation layer for a revocable CAT). The partial offer puzzle uses a CAT maker (`CatMaker`) to compute the full puzzle hash of the offered asset, so the same puzzle works for all three kinds of asset.

The payout to the taker isn't signed by anyone, so the SDK always sends it to the settlement payments puzzle, as a settlement coin that the taker spends and asserts from their own signed spend. That's what makes a fill an ordinary offer.

## Types

| Type                                               | What it is                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PartialOfferAsset`                                | One side of the trade: `Xch`, or `Cat { asset_id, hidden_puzzle_hash }` (revocable if `hidden_puzzle_hash` is set).                                    |
| `PartialOfferInfo`                                 | The terms: offered and requested asset, `maker_puzzle_hash`, `price`, `min_requested_amount`, and optional `expiration` and `required_fee`.            |
| `PartialOffer`                                     | A partial offer coin on (or about to be on) chain: `coin`, `lineage_proof` (for CATs) and `info`. Fills, claws back and parses.                        |
| `PartialOfferFill`                                 | The result of a fill: the `Offer` to take, `requested_amount`, `offered_amount`, `required_fee`, and the recreated `child` coin (if anything is left). |
| `PartialOfferBundle`                               | A partial offer as it's shared: the `PartialOffer` plus the maker's spends that create it (none if it's already on chain).                             |
| `PartialOfferHint`                                 | The placeholder spend's puzzle reveal in an encoded partial offer, which describes the coin's terms and lineage proof.                                 |
| `PartialOfferPrice` (types)                        | `price_precision` and `precision` (both `NonZeroU64`): each unit of the requested asset releases `price_precision / precision` of the offered asset.   |
| `PartialOfferArgs`, `PartialOfferSolution` (types) | The curried arguments and solution of the partial offer puzzle (`PARTIAL_OFFER_PUZZLE`, `PARTIAL_OFFER_PUZZLE_HASH`).                                  |

`PartialOfferInfo::new` takes a `PartialOfferPrice` directly, and `PartialOfferInfo::from_amounts(offered, requested, maker_puzzle_hash, offered_amount, requested_amount)` reduces the two amounts to a price (1000 for 400 becomes 5 for every 2). The other terms are set with `with_min_requested_amount`, `with_expiration` (a timestamp in seconds) and `with_required_fee`. Given the terms, `p2_puzzle_hash()` is what the maker sends the offered asset to, and `puzzle_hash()` is the full puzzle hash of the coin.

## Making, sharing and taking a partial offer

To make a partial offer:

1. Build the `PartialOfferInfo`.
2. Send the offered amount to `info.p2_puzzle_hash()`, with `info.creation_memos(ctx)?` as the memos. The memos hint the coin to the maker and record the requested asset, so the coin can be found on chain. Sign the spend bundle, but don't broadcast it unless you want the coin to exist up front.
3. `PartialOfferBundle::from_maker_spend_bundle(ctx, spend_bundle, info)?` finds the partial offer coin in your spends and checks that the bundle is safe to share (see [Security considerations](#security-considerations)).
4. `bundle.to_spend_bundle(ctx)?` adds the placeholder spend that describes the coin, and `encode_partial_offer` turns it into a `partial1...` string (this needs the `offer-compression` feature as well).

To take it, decode it with `decode_partial_offer` and parse it with `PartialOfferBundle::from_spend_bundle(ctx, &spend_bundle)?`. Check the terms in `bundle.partial_offer().info`, then call `bundle.fill(ctx, requested_amount)?`. The fill's `offer` contains the maker's spends (so the first fill also creates the coin) and the spend of the partial offer coin, and requests the payment to the maker. Take it like any other offer, adding `fill.actions()`, which are the settle actions for the payment plus the required fee.

This example sells 1000 CAT mojos for 400 XCH mojos, with a minimum fill, an expiration and a required fee. Bob fills part of it, then takes the rest from the recreated coin:

```rust
use std::num::NonZeroU64;

use chia_wallet_sdk::driver::{
    PartialOfferAsset, PartialOfferBundle, PartialOfferInfo, decode_partial_offer,
    encode_partial_offer,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::sign_transaction;
use chia_wallet_sdk::types::puzzles::PartialOfferPrice;
use indexmap::indexmap;

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

fn balance(sim: &Simulator, puzzle_hash: Bytes32) -> u64 {
    sim.unspent_coins(puzzle_hash, false).iter().map(|coin| coin.amount).sum()
}

#[test]
fn partial_cat_for_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = sim.bls(500);
    let alice_keys = indexmap! { alice.puzzle_hash => alice.pk };
    let bob_keys = indexmap! { bob.puzzle_hash => bob.pk };

    // Alice issues 1000 mojos of a CAT
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(ctx, &[Action::single_issue_cat(None, 1_000)])?;
    let outputs = spends.finish_with_keys(ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;
    let cat = outputs.cats[&Id::New(0)][0];
    let asset_id = cat.info.asset_id;
    let offered_asset = PartialOfferAsset::Cat { asset_id, hidden_puzzle_hash: None };

    // Maker: 1000 of the CAT for 400 mojos, in fills of at least 50 mojos, for an hour,
    // with a fee of at least 10 mojos on every fill
    let info = PartialOfferInfo::from_amounts(
        offered_asset,
        PartialOfferAsset::Xch,
        alice.puzzle_hash,
        nz(1_000),
        nz(400),
    )
    .with_min_requested_amount(nz(50))
    .with_expiration(sim.next_timestamp() + 3_600)
    .with_required_fee(10);
    assert_eq!(info.price, PartialOfferPrice::new(nz(5), nz(2)));

    let memos = info.creation_memos(ctx)?;
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(cat);
    let deltas = spends.apply(
        ctx,
        &[Action::send(Id::Existing(asset_id), info.p2_puzzle_hash(), 1_000, memos)],
    )?;
    spends.finish_with_keys(ctx, &deltas, Relation::None, &alice_keys)?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk.clone()])?;

    let bundle = PartialOfferBundle::from_maker_spend_bundle(
        ctx,
        SpendBundle::new(coin_spends, signature),
        info,
    )?;
    let text = encode_partial_offer(&bundle.to_spend_bundle(ctx)?)?;
    assert!(text.starts_with("partial1"));

    // Taker: decode the partial offer and check its terms
    let bundle = PartialOfferBundle::from_spend_bundle(ctx, &decode_partial_offer(&text)?)?;
    let partial_offer = *bundle.partial_offer();
    assert_eq!(partial_offer.info, info);
    assert_eq!(partial_offer.coin.amount, 1_000);

    // Pay 100 mojos, which releases 250 of the CAT
    let fill = bundle.fill(ctx, 100)?;
    assert_eq!(fill.offered_amount, 250);
    assert_eq!(fill.required_fee, 10);

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(fill.offer.offered_coins().clone());
    spends.add(bob.coin);
    let deltas = spends.apply(ctx, &fill.actions())?;
    spends.finish_with_keys(ctx, &deltas, Relation::AssertConcurrent, &bob_keys)?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk.clone()])?;
    sim.new_transaction(fill.offer.take(SpendBundle::new(coin_spends, signature)))?;

    // The partial offer coin was recreated with the remaining 750
    let child = fill.child.expect("not fully filled");
    assert_eq!(child.coin.amount, 750);
    assert!(sim.coin_state(child.coin.coin_id()).is_some());

    // Bob takes the rest. The maker's spends are on chain now, so he fills the coin directly.
    let requested_amount = child.max_requested_amount().expect("fillable");
    assert_eq!(requested_amount, 300);
    let fill = PartialOfferBundle::from_coin(child).fill(ctx, requested_amount)?;
    assert!(fill.child.is_none());

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(fill.offer.offered_coins().clone());
    for coin in sim.unspent_coins(bob.puzzle_hash, false) {
        spends.add(coin);
    }
    let deltas = spends.apply(ctx, &fill.actions())?;
    spends.finish_with_keys(ctx, &deltas, Relation::AssertConcurrent, &bob_keys)?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk.clone()])?;
    sim.new_transaction(fill.offer.take(SpendBundle::new(coin_spends, signature)))?;

    // Alice received 400 mojos, and Bob has all of the CAT and paid 20 mojos in fees
    assert_eq!(balance(&sim, alice.puzzle_hash), 400);
    assert_eq!(balance(&sim, offered_asset.puzzle_hash(bob.puzzle_hash)), 1_000);
    assert_eq!(balance(&sim, bob.puzzle_hash), 500 - 400 - 20);

    Ok(())
}
```

A few things to note:

- `fill.actions()` doesn't reserve the required fee again, since the partial offer coin already outputs `RESERVE_FEE`. Add `Action::fee` for any fee on top of it. If the taker leaves the fee out, the spend bundle fails with `ReserveFeeConditionFailed`.
- The payout goes to the taker's change puzzle hash, like any offered asset. Send it elsewhere with an `Action::send` of the offered asset.
- A taker who requests a CAT has to add their CAT coins to the spends, since the payment to the maker is made in that CAT.
- After an expired offer's deadline, fills fail with `AssertBeforeSecondsAbsoluteFailed`, and the remaining funds stay in the coin until the maker claws them back.

## Fill amounts and rounding

Each fill pays `requested_amount` and releases `requested_amount * price_precision / precision`, rounded down. The SDK checks fill amounts before building anything:

- `PartialOfferInfo::offered_amount(requested)` and `requested_amount(offered)` convert between the two sides (the latter is the smallest payment that releases at least that much), returning `None` if the result doesn't fit in a `u64`.
- `PartialOffer::offered_amount(requested)` also checks the coin: it fails with `DriverError::InvalidPartialOfferFill` if the payment is below the minimum, releases nothing, or would release more than the coin has left. `fill` and `fill_spend` do the same check.
- `PartialOffer::max_requested_amount()` is the smallest payment that releases as much of the coin as possible. Because of rounding, a tiny remainder can be impossible to release, in which case only the maker can reclaim it.
- `PartialOffer::child(requested)` is the coin that a fill recreates, or `None` if it takes everything.

```rust
use std::num::NonZeroU64;

use chia_wallet_sdk::driver::{PartialOffer, PartialOfferAsset, PartialOfferInfo};
use chia_wallet_sdk::prelude::*;

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

#[test]
fn partial_offer_amounts() {
    // 1 XCH mojo for every 3 CAT mojos, in fills of at least 2 CAT mojos
    let info = PartialOfferInfo::from_amounts(
        PartialOfferAsset::Xch,
        PartialOfferAsset::Cat { asset_id: Bytes32::new([1; 32]), hidden_puzzle_hash: None },
        Bytes32::new([2; 32]),
        nz(1),
        nz(3),
    )
    .with_min_requested_amount(nz(2));

    let offer = PartialOffer::new(
        Coin::new(Bytes32::new([3; 32]), info.puzzle_hash(), 10),
        None,
        info,
    );

    // Below the minimum, and a fill that rounds down to nothing
    assert!(matches!(offer.offered_amount(1), Err(DriverError::InvalidPartialOfferFill)));
    assert!(matches!(offer.offered_amount(2), Err(DriverError::InvalidPartialOfferFill)));

    // Rounding down means paying 5 releases no more than paying 3
    assert_eq!(offer.offered_amount(3).ok(), Some(1));
    assert_eq!(offer.offered_amount(5).ok(), Some(1));
    assert_eq!(info.requested_amount(1), Some(3));

    // More than the coin has left
    assert!(matches!(offer.offered_amount(33), Err(DriverError::InvalidPartialOfferFill)));

    // Paying 30 takes everything, and smaller fills recreate the coin
    assert_eq!(offer.max_requested_amount(), Some(30));
    assert_eq!(offer.child(30), None);
    assert_eq!(offer.child(3).map(|child| child.coin.amount), Some(9));
}
```

## Tracking, parsing and cancelling

The partial offer coin changes on every fill, so to show a maker their open partial offers, or to fill one that has already been partially filled, you need its latest coin:

- The first coin is hinted to the maker, since the creation memos start with the maker's puzzle hash. `PartialOfferInfo::parse_creation_memos(allocator, memos)` reads the maker puzzle hash and requested asset back from the `CREATE_COIN` that created it. The price and other terms aren't in the memos, so the maker should keep the `PartialOfferInfo` they made.
- `PartialOffer::parse(allocator, coin, puzzle, solution, requested_asset)` parses the spend of a partial offer coin that filled it, returning the coin (with its full terms) and the amount paid. It returns `None` for a spend that isn't a fill, such as a claw back.
- `PartialOffer::parse_child(...)` returns the coin that the fill recreated, or `None` if nothing is left. Follow it from the first coin until you reach an unspent one.

The puzzle only commits to the hash of the requested asset's settlement puzzle, so for a CAT you need to pass the requested asset in (for example, from the creation memos). Without it, parsing a fill of an offer that requests a CAT fails with `DriverError::MissingAssetInfo`. For XCH, `None` is fine.

To cancel a partial offer, the maker claws back its latest coin with `partial_offer.claw_back(ctx, inner_spend)?`, where `inner_spend` is a spend of the maker's puzzle (for a standard wallet, `StandardLayer::spend_with_conditions`) that creates a coin with the full remaining amount. `claw_back_spend` returns the spend without adding it to the context. Clawing back works at any time, with or without an expiration. If the coin was never created on chain, the maker can instead spend the coins their partial offer spends, just like a normal offer.

This example creates the partial offer coin on chain right away, has Bob fill part of it, then has Alice find the latest coin from Bob's spend and claw it back:

```rust
use std::num::NonZeroU64;

use chia_wallet_sdk::driver::{
    PartialOffer, PartialOfferAsset, PartialOfferBundle, PartialOfferInfo,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::sign_transaction;
use indexmap::indexmap;

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

fn balance(sim: &Simulator, puzzle_hash: Bytes32) -> u64 {
    sim.unspent_coins(puzzle_hash, false).iter().map(|coin| coin.amount).sum()
}

#[test]
fn claw_back_partial_offer() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = sim.bls(200);
    let alice_keys = indexmap! { alice.puzzle_hash => alice.pk };

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(ctx, &[Action::single_issue_cat(None, 1_000)])?;
    let outputs = spends.finish_with_keys(ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;
    let cat = outputs.cats[&Id::New(0)][0];
    let asset_id = cat.info.asset_id;
    let offered_asset = PartialOfferAsset::Cat { asset_id, hidden_puzzle_hash: None };

    let info = PartialOfferInfo::from_amounts(
        offered_asset,
        PartialOfferAsset::Xch,
        alice.puzzle_hash,
        nz(1_000),
        nz(400),
    );

    // Alice creates the partial offer coin on chain up front
    let memos = info.creation_memos(ctx)?;
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(cat);
    let deltas = spends.apply(
        ctx,
        &[Action::send(Id::Existing(asset_id), info.p2_puzzle_hash(), 1_000, memos)],
    )?;
    spends.finish_with_keys(ctx, &deltas, Relation::None, &alice_keys)?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk.clone()])?;
    let bundle = PartialOfferBundle::from_maker_spend_bundle(
        ctx,
        SpendBundle::new(coin_spends, signature),
        info,
    )?;
    sim.new_transaction(bundle.spend_bundle().clone())?;
    let first = *bundle.partial_offer();
    assert!(sim.hinted_coins(alice.puzzle_hash).contains(&first.coin.coin_id()));

    // Bob pays 200 mojos for 500 of the CAT
    let fill = PartialOfferBundle::from_coin(first).fill(ctx, 200)?;
    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(fill.offer.offered_coins().clone());
    spends.add(bob.coin);
    let deltas = spends.apply(ctx, &fill.actions())?;
    spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { bob.puzzle_hash => bob.pk },
    )?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk.clone()])?;
    sim.new_transaction(fill.offer.take(SpendBundle::new(coin_spends, signature)))?;

    // Alice follows the fill from the coin she created to the latest coin
    let coin_spend = sim.coin_spend(first.coin.coin_id()).expect("spent");
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let solution = ctx.alloc(&coin_spend.solution)?;
    let puzzle = Puzzle::parse(ctx, puzzle);

    let (parsed, paid) = PartialOffer::parse(ctx, first.coin, puzzle, solution, None)?
        .expect("is a fill");
    assert_eq!(parsed.info, info);
    assert_eq!(paid, 200);

    let latest = PartialOffer::parse_child(ctx, first.coin, puzzle, solution, None)?
        .expect("not fully filled");
    assert_eq!(latest.coin.amount, 500);

    // She claws back the remaining 500
    let hint = ctx.hint(alice.puzzle_hash)?;
    let inner_spend = StandardLayer::new(alice.pk).spend_with_conditions(
        ctx,
        Conditions::new().create_coin(alice.puzzle_hash, 500, hint),
    )?;
    latest.claw_back(ctx, inner_spend)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    assert_eq!(balance(&sim, offered_asset.puzzle_hash(alice.puzzle_hash)), 500);
    assert_eq!(balance(&sim, offered_asset.puzzle_hash(bob.puzzle_hash)), 500);
    assert_eq!(balance(&sim, alice.puzzle_hash), 200);

    Ok(())
}
```

`PartialOffer::cat()` returns the coin as a `Cat` whose p2 puzzle hash is the 1-of-2 puzzle, if the offered asset is a CAT, which is useful for displaying it alongside the maker's other CAT coins.

## The encoded format

An encoded partial offer is the maker's spend bundle plus one placeholder coin spend, compressed like an offer and encoded as bech32m with the `partial` prefix. The placeholder coin has the puzzle hash `PARTIAL_OFFER_HINT_PUZZLE_HASH` (32 bytes of `0x01`), the partial offer coin's parent coin id and amount, and a puzzle reveal of `PartialOfferHint`: the lineage proof, both assets, the price, the maker puzzle hash, the quoted persistent conditions and the minimum amount minus one. `PartialOfferInfo::alloc_hint` and `parse_hint` convert between the two.

If the bundle contains the maker's spends, `from_spend_bundle` checks that they create the described coin and derives the lineage proof from them. If it doesn't, the coin is supposed to already be on chain, and the lineage proof comes from the hint. `PartialOfferBundle::from_coin` makes a bundle for a coin that's on chain, without any spends.

## Lower-level spends

`PartialOffer::fill_spend(ctx, requested_amount)` returns just the `Spend` of the partial offer coin, without the payment to the maker, so it's only valid alongside a matching notarized payment, which `notarized_payment(ctx, requested_amount)` builds. `PartialOfferInfo::construct_partial_puzzle`, `partial_puzzle_hash` and `merkle_tree` expose the pieces of the puzzle. Prefer `fill`, which builds both sides as an `Offer` and makes sure the payout is asserted.

## Security considerations

- **Only share bundles from `from_maker_spend_bundle`.** It rejects a bundle that creates the partial offer coin from a settlement payments coin (`DriverError::UnsignedPartialOfferCreation`), since anyone could change that spend's solution and take the funds. It also requires the creation memos (`DriverError::InvalidMemo`) and exactly one partial offer coin (`DriverError::PartialOfferNotCreated`, `DriverError::PartialOfferSiblings`).
- **One partial offer per parent coin.** The payment's nonce is the coin's parent id, so two partial offer coins with the same parent, maker and requested asset could both be filled by one payment, even if their prices differ. `from_maker_spend_bundle` rejects this with `DriverError::PartialOfferSiblings`; if you create partial offers some other way, give each its own parent.
- **Look up the latest coin before filling.** A shared partial offer describes the coin at the time it was shared. Once it's been filled or clawed back, the maker's spends in it can no longer be included, so check the coin on chain and follow `parse_child` to its latest descendant.
- **The payout must be asserted.** The partial offer solution isn't signed, so a payout that isn't asserted by the taker could be redirected by anyone who sees the transaction. `fill` sends it to a settlement coin that the taker's spends assert, and the CHIP-0052 puzzle's optional taker `CREATE_COIN` should not be used without an assertion.
- **Only known persistent conditions are accepted.** Parsing fails with `DriverError::UnsupportedPartialOfferConditions` if the persistent conditions contain anything other than an optional expiration followed by an optional fee, so that a wallet never hides a term it can't display.
- **Revocable CATs are a different asset.** As with normal offers, a CAT with a `hidden_puzzle_hash` can be clawed back by its issuer, and isn't interchangeable with a non-revocable CAT of the same asset id. Check `PartialOfferAsset` on both sides before filling.
