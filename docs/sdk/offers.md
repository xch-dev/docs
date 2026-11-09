---
title: Offers
slug: /sdk/offers
---

# Offers

An offer is a partially complete transaction that trades assets without trusting the other party. The **maker** spends the assets they're giving up into settlement coins, and makes their spend conditional on receiving what they're asking for. They sign it and share it, usually as a bech32 `offer1...` string. A **taker** completes it by spending those settlement coins to themselves and paying the requested assets, and the combined spend bundle is either included in a block as a whole or not at all. See [Offers](https://chialisp.com/offers) on chialisp.com for background on the settlement payments puzzle and the offer format.

The SDK represents an offer as [`Offer`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/struct.Offer.html), and both sides are built with the [action system](/sdk/action-system), which is how the SDK's own tests make and take offers. The offer types are in the prelude; the royalty helpers and compression functions are in `chia_wallet_sdk::driver`.

For selling one fungible asset for another in any amount at a fixed price, see [Partial Offers](/sdk/primitives/partial-offers) (CHIP-0052, unreleased), which can be filled many times and are taken as ordinary offers.

## How offers work

- **Settlement payments puzzle.** `SETTLEMENT_PAYMENT_HASH` (in `chia_wallet_sdk::puzzles`) is a puzzle that anyone can spend, but that can only make notarized payments. For each notarized payment it makes, it creates a puzzle announcement of the payment's hash. Offered assets are sent to this puzzle (inside their CAT, NFT or option layers), and requested payments are made by it.
- **Notarized payments.** A `NotarizedPayment` is a nonce and a list of `Payment`s (puzzle hash, amount, memos). The maker asserts the puzzle announcement for each payment they request, from the settlement puzzle of the requested asset, so their spend is only valid if the taker makes exactly those payments.
- **The nonce.** `Offer::nonce(coin_ids)` is the tree hash of the sorted ids of the coins the maker is spending. Each coin can only be spent once, so no two offers that can both be taken share a nonce, and a taker can't satisfy two offers with one payment.
- **The offer file.** The offer's spend bundle contains the maker's coin spends, plus one spend per requested asset of a placeholder settlement coin with a parent coin id of zero, whose solution lists the requested notarized payments. The placeholder spends are how a taker learns what's requested, and they're removed when the offer is taken.

| Type                | What it is                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Offer`             | The maker's spend bundle, the parsed `OfferCoins`, `RequestedPayments` and `AssetInfo`.                                                  |
| `OfferCoins`        | The settlement coins the maker created: `xch`, `cats` (by asset id), `nfts` and `options` (by launcher id), and the `fee` they reserved. |
| `RequestedPayments` | The notarized payments the maker asks for: `xch`, `cats`, `nfts` and `options`.                                                          |
| `AssetInfo`         | What's needed to build the settlement puzzle hash of each CAT (`CatAssetInfo`), NFT (`NftAssetInfo`) and option (`OptionAssetInfo`).     |
| `OfferAmounts`      | Total XCH and CAT amounts, as `u128`.                                                                                                    |
| `Arbitrage`         | The difference between what's offered and requested, from the taker's point of view.                                                     |
| `RoyaltyInfo`       | An NFT's launcher id, royalty puzzle hash and basis points.                                                                              |

## Making an offer

To make an offer with the action system:

1. Build the `RequestedPayments`, with payments to your own puzzle hash, notarized with `Offer::nonce` of the coins you're offering. Hint CAT and NFT payments with `ctx.hint(puzzle_hash)?`.
2. Build the `AssetInfo` for every requested CAT, NFT or option, since the settlement puzzle hash of a requested asset depends on it (for example, whether a CAT is revocable).
3. Add your coins to `Spends`, and add `requested_payments.assertions(&mut ctx, &asset_info)?` to `spends.conditions.required`.
4. Apply actions that send the offered assets to `SETTLEMENT_PAYMENT_HASH`, finish, and sign.
5. `Offer::from_input_spend_bundle(&mut ctx, spend_bundle, requested_payments, asset_info)` parses the settlement coins you created, and `offer.to_spend_bundle(&mut ctx)?` produces the offer spend bundle, which you can encode with `encode_offer`.

## Taking an offer

To take an offer:

1. Decode it with `decode_offer`, and parse it with `Offer::from_spend_bundle(&mut ctx, &spend_bundle)?`. This checks every puzzle reveal against its coin, and separates the maker's spends from the requested payments.
2. Inspect what's offered and requested (see [Inspecting offers](#inspecting-offers)) before going any further.
3. Add `offer.offered_coins().clone()` and your own coins to `Spends`. The settlement coins are spent as settlement spends automatically.
4. Apply `offer.requested_payments().actions()`, which is an `Action::settle` for each requested notarized payment, plus anything else you want (a fee, royalties). The offered assets go to your change puzzle hash, unless you send them elsewhere.
5. Finish and sign, then combine your spend bundle with the maker's with `offer.take(spend_bundle)`.

:::note Unreleased
On the SDK's `main` branch, change is split by who has value left over when you take an offer. Settlement coins return whatever they have left after their payments, and the rest of the change is created by one of your own coins' conditions spends, rather than by the first settlement coin. Usually that means a single change coin, from your own coin, while the offered amount is still paid and asserted by the settlement coins.

`main` also adds `ConditionConfig::return_unplaced_conditions` (`spends.conditions.return_unplaced_conditions = true`). When none of the spends can emit the transaction-wide conditions (for example, a vault taking a one-sided offer without spending any of its own coins), they're returned in `Spends::unplaced_conditions` instead of being emitted by an intermediate coin, so the caller can emit them from its own spend, such as a vault's delegated spend. `finish_with_keys` fails with `DriverError::CannotEmitConditions` if any are left. Together these make a vault's offer take something [clear signing](/sdk/clear-signing) can verify.
:::

Here's a complete trade of a CAT for XCH, including encoding the offer as a string and parsing it on the taker's side:

```rust
use chia_wallet_sdk::chia::puzzle_types::{
    Memos,
    offer::{NotarizedPayment, Payment},
};
use chia_wallet_sdk::driver::{decode_offer, encode_offer};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::test::sign_transaction;
use indexmap::indexmap;

#[test]
fn cat_for_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(100);
    let bob = sim.bls(51);
    let alice_keys = indexmap! { alice.puzzle_hash => alice.pk };
    let alice_hint = ctx.hint(alice.puzzle_hash)?;

    // Alice issues a CAT to offer
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(&mut ctx, &[Action::single_issue_cat(None, 100)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let cat = outputs.cats[&Id::New(0)][0];
    let asset_id = cat.info.asset_id;

    // Maker: offer 100 of the CAT for 50 mojos of XCH
    let mut requested_payments = RequestedPayments::new();
    requested_payments.xch.push(NotarizedPayment::new(
        Offer::nonce(vec![cat.coin.coin_id()]),
        vec![Payment::new(alice.puzzle_hash, 50, alice_hint)],
    ));
    let asset_info = AssetInfo::new();

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(cat);
    spends.conditions.required = spends
        .conditions
        .required
        .extend(requested_payments.assertions(&mut ctx, &asset_info)?);

    let deltas = spends.apply(
        &mut ctx,
        &[Action::send(
            Id::Existing(asset_id),
            SETTLEMENT_PAYMENT_HASH.into(),
            100,
            Memos::None,
        )],
    )?;
    spends.finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &alice_keys)?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;
    let offer = Offer::from_input_spend_bundle(
        &mut ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?;

    let offer_text = encode_offer(&offer.to_spend_bundle(&mut ctx)?)?;
    assert!(offer_text.starts_with("offer1"));

    // Taker: parse the untrusted offer and check what it does
    let offer = Offer::from_spend_bundle(&mut ctx, &decode_offer(&offer_text)?)?;
    assert_eq!(offer.offered_coins().amounts().cats[&asset_id], 100);
    assert_eq!(offer.requested_payments().amounts().xch, 50);

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(offer.offered_coins().clone());
    spends.add(bob.coin);

    let mut actions = offer.requested_payments().actions();
    actions.push(Action::fee(1));

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { bob.puzzle_hash => bob.pk },
    )?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk])?;
    sim.new_transaction(offer.take(SpendBundle::new(coin_spends, signature)))?;

    // Bob received the CAT, and Alice received the XCH
    let bob_cat = outputs.cats[&Id::Existing(asset_id)][0];
    assert_eq!(bob_cat.info.p2_puzzle_hash, bob.puzzle_hash);
    assert_eq!(bob_cat.coin.amount, 100);
    assert_eq!(sim.unspent_coins(alice.puzzle_hash, false)[0].amount, 50);

    Ok(())
}
```

Requesting a CAT works the same way, with the payment in `requested_payments.cats` and `asset_info.insert_cat(asset_id, CatAssetInfo::new(hidden_puzzle_hash))?`. Requesting an NFT uses `requested_payments.nfts` and `NftAssetInfo` (the NFT's metadata, metadata updater puzzle hash and royalty), since the NFT's settlement puzzle hash commits to them. When taking an offer that requests an asset, add your coins of that asset to the spends: the settle actions pay from an intermediate settlement coin, and the rest comes back to you as change.

## Inspecting offers

Before taking an offer (or showing it to a user), look at what it does:

- `offer.offered_coins()`: the settlement coins you'll receive. `.amounts()` totals XCH and each CAT, and `.nfts` and `.options` are the singletons.
- `offer.requested_payments()`: what you'll pay. `.amounts()` totals XCH and CATs, and `.nfts` and `.options` are keyed by launcher id.
- `offer.asset_info()`: the CAT, NFT and option info for every asset involved, including whether each CAT is revocable (`CatAssetInfo::hidden_puzzle_hash`).
- `offer.arbitrage()`: an `Arbitrage` with `offered` and `requested` sides, each an `ArbitrageSide` with `xch`, `cats`, `nfts` and `options`. `requested` is what the offer gives you beyond what it asks for of the same asset, and `offered` is what you need to supply.
- `offer.fee()`: the fee the maker's spends leave for the farmer, as an `i128` (negative if the spends create more than they spend). `offered_coins().fee` is the fee they asserted with `RESERVE_FEE`.
- `offer.offered_royalties()` and `offer.requested_royalties()`: the `RoyaltyInfo` of requested and offered NFTs (see below).
- On `main` (unreleased), `offered_coins().nft_trade_prices` has the trade prices each offered NFT revealed when it was spent into settlement, and `offered_coins().prepaid_royalties` has the royalty payments the maker's settlement spends made up front for requested NFTs.

To cancel an offer you made, spend any of the coins it spends. `offer.cancellable_coin_spends()` returns the maker's spends of coins that weren't created within the offer, which are the coins to spend. Several offers can be combined into one with `offer.extend(other)`, as long as they don't spend the same coins (`DriverError::ConflictingOfferInputs`).

## Royalties

NFTs with a royalty require a royalty payment whenever they're traded through an offer. The NFT's transfer program asserts that, for each trade price it's told about, the royalty was paid by a settlement coin, with the NFT's launcher id as the nonce. A trade price is an amount and the settlement puzzle hash of the asset it's paid in (`TradePrice`).

The maker of an offer that sells royalty NFTs splits the requested price evenly between them when it commits to trade prices, and a maker bidding for royalty NFTs splits the offered price the same way when it pays their royalties up front. These helpers do the math:

| Function                                                          | What it does                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `calculate_nft_trade_price(amount, royalty_nft_count)`            | `amount / royalty_nft_count`, or zero if there are no royalty NFTs.                                 |
| `calculate_trade_price_amounts(&amounts, royalty_nft_count)`      | The per-NFT trade price of each asset in an `OfferAmounts`.                                         |
| `calculate_trade_prices(&trade_price_amounts, &asset_info)`       | Converts them into `TradePrice`s for `TransferNftById`. Needs `AssetInfo` for CATs.                 |
| `calculate_nft_royalty(trade_price, basis_points)`                | `trade_price * basis_points / 10000`.                                                               |
| `calculate_royalty_amounts(&trade_prices, &royalties)`            | The total royalty owed in each asset, for a list of `RoyaltyInfo`.                                  |
| `calculate_royalty_payments(&mut ctx, &trade_prices, &royalties)` | The royalty payments as `RequestedPayments`, whose `.actions()` are `settle` actions that pay them. |

There are two cases, depending on which side the NFT is on.

In 0.37.1, `offer.requested_royalty_amounts()` and `offer.offered_royalty_amounts()` are computed the same way, by splitting the offer's requested (or offered) totals evenly between its royalty NFTs. That's correct for a single maker's offer, but not for aggregated offers whose makers committed to different trade prices.

:::note Unreleased
On the SDK's `main` branch, royalties come from what's actually in the offer rather than an even split:

- **Offered NFTs.** `OfferCoins::nft_trade_prices` records the trade prices each offered NFT revealed when its maker spent it into settlement. `offer.requested_royalty_payments(&mut ctx)?` returns the royalty payment each NFT asserts for each of its trade prices, as `RequestedPayments` whose `.actions()` pay them, and `requested_royalty_amounts()` is their total. Identical royalties are only paid once, since one payment satisfies every identical assertion, and royalties the offer already prepaid are left out. Both fail with `DriverError::ZeroRoyaltyPayment(launcher_id)` if a trade price's royalty rounds down to zero (settlement can never pay it, so the offer can't be taken), `DriverError::UnknownSettlementAsset` if a trade price is in an asset the offer doesn't know, or `DriverError::AmountOverflow`.
- **Requested NFTs.** `OfferCoins::prepaid_royalties` holds the royalty payments the maker made up front, in the form an NFT's royalty assertion accepts (a single payment whose memos are exactly the royalty puzzle hash, notarized with the launcher id). `offered_royalty_amounts()` totals them, and `offer.requested_nft_trade_prices(launcher_id)` returns the trade prices the taker should reveal on the NFT they supply so that it asserts exactly those payments.
- **New helpers.** `payable_trade_prices(&trade_prices, royalty_basis_points)` drops trade prices whose royalty would round down to zero, so a maker never commits to an unpayable trade price (a small sale with only zero royalties can be taken without any royalty payment). `AssetInfo::settlement_puzzle_hash(asset_id)` and `settlement_asset_id(puzzle_hash)` convert between a CAT asset id (`None` for XCH) and its settlement puzzle hash, `OfferAmounts::add_amount(asset_id, amount)` adds to a total, and `RequestedPayments::fungible()`/`fungible_mut(asset_id)` iterate over or extend the XCH and CAT payments together.
  :::

### Offering an NFT

The maker offering an NFT tells it the trade prices with `Action::update_nft(nft_id, vec![], Some(TransferNftById::new(None, trade_prices)))`, computed from the requested amounts. The taker pays the royalty from what they're paying anyway: `offer.requested_royalty_amounts()?` is the total, and `Action::settle_royalty` pays each NFT's royalty. If the taker doesn't pay it, the NFT's spend fails and the offer can't be taken.

```rust
use chia_wallet_sdk::chia::puzzle_types::{
    Memos,
    offer::{NotarizedPayment, Payment},
};
use chia_wallet_sdk::driver::{
    TransferNftById, calculate_trade_price_amounts, calculate_trade_prices, coin_amount,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::test::sign_transaction;
use indexmap::indexmap;

#[test]
fn nft_for_xch_with_royalty() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let bob = sim.bls(1_030);
    let carol = BlsPair::new(2);
    let alice_keys = indexmap! { alice.puzzle_hash => alice.pk };
    let alice_hint = ctx.hint(alice.puzzle_hash)?;

    // Alice mints an NFT with a 3% royalty to Carol
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(&mut ctx, &[Action::mint_empty_royalty_nft(carol.puzzle_hash, 300)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let nft = outputs.nfts[&Id::New(0)];
    let nft_id = Id::Existing(nft.info.launcher_id);

    // Maker: offer the NFT for 1000 mojos, telling the NFT its trade price
    let mut requested_payments = RequestedPayments::new();
    requested_payments.xch.push(NotarizedPayment::new(
        Offer::nonce(vec![nft.coin.coin_id()]),
        vec![Payment::new(alice.puzzle_hash, 1_000, alice_hint)],
    ));
    let asset_info = AssetInfo::new();

    let trade_prices = calculate_trade_prices(
        &calculate_trade_price_amounts(&requested_payments.amounts(), 1),
        &asset_info,
    )?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(nft);
    spends.conditions.required = spends
        .conditions
        .required
        .extend(requested_payments.assertions(&mut ctx, &asset_info)?);

    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::update_nft(nft_id, vec![], Some(TransferNftById::new(None, trade_prices))),
            Action::send(nft_id, SETTLEMENT_PAYMENT_HASH.into(), 1, Memos::None),
        ],
    )?;
    spends.finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &alice_keys)?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;
    let offer = Offer::from_input_spend_bundle(
        &mut ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?;

    // Taker: pay the price and the 30 mojo royalty
    let royalties = offer.requested_royalty_amounts()?;
    assert_eq!(royalties.xch, 30);

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(offer.offered_coins().clone());
    spends.add(bob.coin);

    let mut actions = offer.requested_payments().actions();
    for royalty in offer.requested_royalties() {
        actions.push(Action::settle_royalty(
            &mut ctx,
            Id::Xch,
            royalty.launcher_id,
            royalty.puzzle_hash,
            coin_amount(royalties.xch)?,
        )?);
    }

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { bob.puzzle_hash => bob.pk },
    )?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk])?;
    sim.new_transaction(offer.take(SpendBundle::new(coin_spends, signature)))?;

    assert_eq!(outputs.nfts[&nft_id].info.p2_puzzle_hash, bob.puzzle_hash);
    assert_eq!(sim.unspent_coins(carol.puzzle_hash, false)[0].amount, 30);

    Ok(())
}
```

With several royalty NFTs on 0.37.1, compute the royalty for each one separately (`calculate_nft_royalty(trade_price, royalty.basis_points)` with the per-NFT trade price), and pay one `settle_royalty` per NFT and asset.

On `main` (unreleased), the maker should filter each NFT's trade prices with `payable_trade_prices`, and the taker should pay `offer.requested_royalty_payments(&mut ctx)?.actions()` instead of computing royalties itself. That's what makes aggregated offers work: here two makers sell NFTs with different royalties at different prices, and the taker of the combined offer pays each royalty on the price its NFT committed to, rather than on half of the total:

```rust unreleased
use chia_wallet_sdk::chia::puzzle_types::{
    Memos,
    offer::{NotarizedPayment, Payment},
};
use chia_wallet_sdk::driver::{
    TransferNftById, calculate_trade_price_amounts, calculate_trade_prices, payable_trade_prices,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::test::sign_transaction;
use indexmap::indexmap;

/// Mints an NFT with a royalty, and returns the offer spend bundle that sells it for `price` mojos.
fn sell_nft(
    sim: &mut Simulator,
    ctx: &mut SpendContext,
    royalty_puzzle_hash: Bytes32,
    basis_points: u16,
    price: u64,
) -> anyhow::Result<SpendBundle> {
    let maker = sim.bls(1);
    let keys = indexmap! { maker.puzzle_hash => maker.pk };
    let hint = ctx.hint(maker.puzzle_hash)?;

    let mut spends = Spends::new(maker.puzzle_hash);
    spends.add(maker.coin);
    let deltas =
        spends.apply(ctx, &[Action::mint_empty_royalty_nft(royalty_puzzle_hash, basis_points)])?;
    let outputs = spends.finish_with_keys(ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&maker.sk))?;
    let nft = outputs.nfts[&Id::New(0)];
    let nft_id = Id::Existing(nft.info.launcher_id);

    let mut requested_payments = RequestedPayments::new();
    requested_payments.xch.push(NotarizedPayment::new(
        Offer::nonce(vec![nft.coin.coin_id()]),
        vec![Payment::new(maker.puzzle_hash, price, hint)],
    ));
    let asset_info = AssetInfo::new();

    // Commit to the trade price, leaving out any whose royalty would round down to zero
    let trade_prices = calculate_trade_prices(
        &calculate_trade_price_amounts(&requested_payments.amounts(), 1),
        &asset_info,
    )?;
    let trade_prices = payable_trade_prices(&trade_prices, basis_points);

    let mut spends = Spends::new(maker.puzzle_hash);
    spends.add(nft);
    spends.conditions.required = spends
        .conditions
        .required
        .extend(requested_payments.assertions(ctx, &asset_info)?);
    let deltas = spends.apply(
        ctx,
        &[
            Action::update_nft(nft_id, vec![], Some(TransferNftById::new(None, trade_prices))),
            Action::send(nft_id, SETTLEMENT_PAYMENT_HASH.into(), 1, Memos::None),
        ],
    )?;
    spends.finish_with_keys(ctx, &deltas, Relation::AssertConcurrent, &keys)?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[maker.sk])?;
    let offer = Offer::from_input_spend_bundle(
        ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?;
    Ok(offer.to_spend_bundle(ctx)?)
}

#[test]
fn aggregated_royalties() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let royalty_a = Bytes32::new([1; 32]);
    let royalty_b = Bytes32::new([2; 32]);

    // A 5% royalty NFT for 10,000 mojos, and a 10% royalty NFT for 30,000 mojos
    let first = sell_nft(&mut sim, ctx, royalty_a, 500, 10_000)?;
    let second = sell_nft(&mut sim, ctx, royalty_b, 1_000, 30_000)?;
    let offer = Offer::from_spend_bundle(ctx, &SpendBundle::aggregate(&[first, second]))?;

    // 5% of 10,000 plus 10% of 30,000, rather than royalties on 20,000 each
    assert_eq!(offer.requested_royalty_amounts()?.xch, 500 + 3_000);

    let taker = sim.bls(43_500);
    let mut spends = Spends::new(taker.puzzle_hash);
    spends.add(offer.offered_coins().clone());
    spends.add(taker.coin);

    let mut actions = offer.requested_payments().actions();
    actions.extend(offer.requested_royalty_payments(ctx)?.actions());

    let deltas = spends.apply(ctx, &actions)?;
    spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { taker.puzzle_hash => taker.pk },
    )?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[taker.sk])?;
    sim.new_transaction(offer.take(SpendBundle::new(coin_spends, signature)))?;

    assert_eq!(sim.unspent_coins(royalty_a, false)[0].amount, 500);
    assert_eq!(sim.unspent_coins(royalty_b, false)[0].amount, 3_000);
    assert!(sim.unspent_coins(taker.puzzle_hash, false).is_empty());

    Ok(())
}
```

### Requesting an NFT

When the maker requests an NFT, they pay its royalty up front, since the taker can't be trusted to. The maker adds `NftAssetInfo` for the NFT (which includes its royalty), and adds the royalty payments with `calculate_royalty_payments(...)?.actions()` alongside the offered XCH. The taker reveals the trade prices to the NFT when they spend it, with `update_nft`. On 0.37.1, compute them from the offered amounts as below. On `main` (unreleased), use `offer.requested_nft_trade_prices(launcher_id)` instead, which derives them from the royalties the maker actually prepaid, so they match even when bids are aggregated or a bid requests several NFTs:

```rust
use chia_wallet_sdk::chia::puzzle_types::{
    Memos,
    offer::{NotarizedPayment, Payment},
};
use chia_wallet_sdk::driver::{
    TransferNftById, calculate_royalty_payments, calculate_trade_price_amounts,
    calculate_trade_prices,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::test::sign_transaction;
use indexmap::{IndexMap, indexmap};

#[test]
fn xch_for_royalty_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1_030);
    let bob = sim.bls(1);
    let carol = BlsPair::new(2);
    let bob_keys = indexmap! { bob.puzzle_hash => bob.pk };
    let alice_hint = ctx.hint(alice.puzzle_hash)?;

    // Bob owns an NFT with a 3% royalty to Carol
    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(bob.coin);
    let deltas = spends.apply(&mut ctx, &[Action::mint_empty_royalty_nft(carol.puzzle_hash, 300)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &bob_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&bob.sk))?;

    let nft = outputs.nfts[&Id::New(0)];
    let launcher_id = nft.info.launcher_id;

    // Maker: offer 1000 mojos for the NFT, and pay the royalty up front
    let royalties = [RoyaltyInfo::new(launcher_id, carol.puzzle_hash, 300)];
    let offered = OfferAmounts { xch: 1_000, cats: IndexMap::new() };
    let royalty_payments = calculate_royalty_payments(
        &mut ctx,
        &calculate_trade_price_amounts(&offered, royalties.len()),
        &royalties,
    )?;

    let mut actions = vec![Action::send(Id::Xch, SETTLEMENT_PAYMENT_HASH.into(), 1_000, Memos::None)];
    actions.extend(royalty_payments.actions());

    let mut requested_payments = RequestedPayments::new();
    requested_payments.nfts.insert(
        launcher_id,
        vec![NotarizedPayment::new(
            Offer::nonce(vec![alice.coin.coin_id()]),
            vec![Payment::new(alice.puzzle_hash, 1, alice_hint)],
        )],
    );
    let mut asset_info = AssetInfo::new();
    asset_info.insert_nft(
        launcher_id,
        NftAssetInfo::new(
            nft.info.metadata,
            nft.info.metadata_updater_puzzle_hash,
            nft.info.royalty_puzzle_hash,
            nft.info.royalty_basis_points,
        ),
    )?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    spends.conditions.required = spends
        .conditions
        .required
        .extend(requested_payments.assertions(&mut ctx, &asset_info)?);

    let deltas = spends.apply(&mut ctx, &actions)?;
    spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;
    let offer = Offer::from_input_spend_bundle(
        &mut ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?;
    assert_eq!(offer.offered_royalty_amounts()?.xch, 30);

    // Taker: reveal the trade price to the NFT, and send it to Alice
    let trade_prices = calculate_trade_prices(
        &calculate_trade_price_amounts(&offer.offered_coins().amounts(), 1),
        offer.asset_info(),
    )?;

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(offer.offered_coins().clone());
    spends.add(nft);

    let mut actions = vec![Action::update_nft(
        Id::Existing(launcher_id),
        vec![],
        Some(TransferNftById::new(None, trade_prices)),
    )];
    actions.extend(offer.requested_payments().actions());

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &bob_keys)?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[bob.sk])?;
    sim.new_transaction(offer.take(SpendBundle::new(coin_spends, signature)))?;

    assert_eq!(outputs.nfts[&Id::Existing(launcher_id)].info.p2_puzzle_hash, alice.puzzle_hash);
    assert_eq!(sim.unspent_coins(bob.puzzle_hash, false)[0].amount, 1_000);
    assert_eq!(sim.unspent_coins(carol.puzzle_hash, false)[0].amount, 30);

    Ok(())
}
```

On `main`, `offer.offered_royalty_amounts()` in this example is the 30 mojos the maker prepaid, read from its settlement spend, rather than a recomputed even split, and the taker could replace its `calculate_trade_prices(...)` call with `offer.requested_nft_trade_prices(launcher_id)` (which returns the same 1000 mojo trade price here).

The royalty math on its own:

```rust
use chia_wallet_sdk::driver::{
    calculate_nft_royalty, calculate_nft_trade_price, calculate_royalty_amounts,
    calculate_trade_price_amounts,
};
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn royalty_math() -> anyhow::Result<()> {
    let cat = Bytes32::new([1; 32]);

    // Two royalty NFTs are traded for 1000 XCH mojos and 200 CAT mojos
    let amounts = OfferAmounts { xch: 1_000, cats: indexmap! { cat => 200 } };
    let trade_prices = calculate_trade_price_amounts(&amounts, 2);
    assert_eq!(trade_prices.xch, calculate_nft_trade_price(1_000, 2));
    assert_eq!(trade_prices.cats[&cat], 100);

    // 3% and 5% royalties
    let royalties = [
        RoyaltyInfo::new(Bytes32::new([2; 32]), Bytes32::new([3; 32]), 300),
        RoyaltyInfo::new(Bytes32::new([4; 32]), Bytes32::new([5; 32]), 500),
    ];
    let owed = calculate_royalty_amounts(&trade_prices, &royalties)?;
    assert_eq!(owed.xch, calculate_nft_royalty(500, 300) + calculate_nft_royalty(500, 500));
    assert_eq!(owed.xch, 15 + 25);
    assert_eq!(owed.cats[&cat], 3 + 5);

    Ok(())
}
```

## Compression

Offers are shared as bech32m strings with the `offer` prefix, containing a zlib-compressed spend bundle. The compression uses a dictionary of common puzzles (the standard puzzle, CAT, settlement payments, singleton and NFT puzzles), with a two byte version prefix. These functions require the `offer-compression` feature:

| Function                                          | Converts                              |
| ------------------------------------------------- | ------------------------------------- |
| `encode_offer(&spend_bundle)`                     | `SpendBundle` to `offer1...` string   |
| `decode_offer(&text)`                             | `offer1...` string to `SpendBundle`   |
| `compress_offer(&spend_bundle)`                   | `SpendBundle` to compressed bytes     |
| `decompress_offer(&bytes)`                        | Compressed bytes to `SpendBundle`     |
| `compress_offer_bytes` / `decompress_offer_bytes` | Raw serialized bytes, without parsing |

On `main` (unreleased), the `chip-0052` feature adds `encode_partial_offer` and `decode_partial_offer`, which use the same compression with the `partial` prefix (see [Partial Offers](/sdk/primitives/partial-offers)).

Decompression supports every version of the format the reference wallet has used, and output is capped at 6 MB (`DriverError::DecompressionTooLarge`), matching chia-blockchain. Encode the result of `offer.to_spend_bundle(&mut ctx)?`, not the maker's input spend bundle, since the offer file needs the requested payments.

## Security considerations

- **Treat offers from others as untrusted.** Parse them with `Offer::from_spend_bundle`, which rejects puzzle reveals that don't match their coin's puzzle hash (`DriverError::WrongPuzzleHash`). `from_input_spend_bundle` skips this check, so only use it for spends you built yourself.
- **Check what you're getting.** Compare `offered_coins()` and `requested_payments()` (or `arbitrage()`) with what the user agreed to, and check that the coins the maker's spends consume are still unspent on chain. An offer can reference coins that have already been spent, in which case it can't be taken.
- **Old offers are rejected.** Offers using the retired, insecure settlement payments puzzle (`OLD_SETTLEMENT_PAYMENT_HASH`) fail to parse with `DriverError::OldSettlementPayment`.
- **Revocable CATs are a different asset.** A revocable CAT can be clawed back by its issuer, and has a different settlement puzzle hash than a CAT with the same asset id but no revocation layer. Check the offered CAT's `hidden_puzzle_hash` in `asset_info().cat(asset_id)` before treating an offered CAT as the one you expect. Mixing both kinds under one asset id fails with `DriverError::IncompatibleAssetInfo`.
- **Settlement spends are asserted.** When taking an offer, every payment a settlement coin makes is asserted by one of your conditions spends, so a third party can't strip the settlement spends out of the bundle and claim the coins. Don't set `disable_settlement_assertions` unless something else ties them to your spend.
- **Amounts can overflow.** Offered and requested totals are `u128`. A malicious offer can have totals that don't fit in a coin, which fail with `DriverError::AmountOverflow` (or `InsufficientFunds`) rather than wrapping around. Use `coin_amount` to convert totals.
- **Royalties are enforced on chain.** An NFT's royalty must be paid for an offer involving it to succeed. Use `requested_royalty_amounts` and `offered_royalty_amounts` to show users the real cost. `offered_royalties` fails with `DriverError::MissingAssetInfo` if a requested NFT has no asset info, rather than silently skipping its royalty.
- **Verify option contracts.** An offered option only commits to hashes of its terms. Check it with `OptionInfo::is_backed_by` before paying for it. See [Option Contracts](/sdk/primitives/options).
- **Relate your spends.** Use `Relation::AssertConcurrent` for both sides, so neither the maker's nor the taker's spends can be split apart.
