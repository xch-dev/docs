---
title: Offers
slug: /sdk/offers
---

# Offers

An offer is a partially complete transaction that trades assets without trusting the other party. The **maker** spends the assets they're giving up into settlement coins, and makes their spend conditional on receiving what they're asking for. They sign it and share it, usually as a bech32 `offer1...` string. A **taker** completes it by spending those settlement coins to themselves and paying the requested assets, and the combined spend bundle is either included in a block as a whole or not at all. See [Offers](https://chialisp.com/offers) on chialisp.com for background on the settlement payments puzzle and the offer format.

The SDK represents an offer as [`Offer`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/struct.Offer.html), and both sides are built with the [action system](/sdk/action-system), which is how the SDK's own tests make and take offers. The offer types are in the prelude; the royalty helpers and compression functions are in `chia_wallet_sdk::driver`.

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

To cancel an offer you made, spend any of the coins it spends. `offer.cancellable_coin_spends()` returns the maker's spends of coins that weren't created within the offer, which are the coins to spend. Several offers can be combined into one with `offer.extend(other)`, as long as they don't spend the same coins (`DriverError::ConflictingOfferInputs`).

## Royalties

NFTs with a royalty require a royalty payment whenever they're traded through an offer. The NFT's transfer program asserts that, for each trade price it's told about, the royalty was paid by a settlement coin, with the NFT's launcher id as the nonce. A trade price is an amount and the settlement puzzle hash of the asset it's paid in (`TradePrice`).

When several royalty NFTs are traded together, the price is split evenly between them:

| Function                                                          | What it does                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `calculate_nft_trade_price(amount, royalty_nft_count)`            | `amount / royalty_nft_count`, or zero if there are no royalty NFTs.                                 |
| `calculate_trade_price_amounts(&amounts, royalty_nft_count)`      | The per-NFT trade price of each asset in an `OfferAmounts`.                                         |
| `calculate_trade_prices(&trade_price_amounts, &asset_info)`       | Converts them into `TradePrice`s for `TransferNftById`. Needs `AssetInfo` for CATs.                 |
| `calculate_nft_royalty(trade_price, basis_points)`                | `trade_price * basis_points / 10000`.                                                               |
| `calculate_royalty_amounts(&trade_prices, &royalties)`            | The total royalty owed in each asset, for a list of `RoyaltyInfo`.                                  |
| `calculate_royalty_payments(&mut ctx, &trade_prices, &royalties)` | The royalty payments as `RequestedPayments`, whose `.actions()` are `settle` actions that pay them. |

There are two cases, depending on which side the NFT is on.

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

With several royalty NFTs, compute the royalty for each one separately (`calculate_nft_royalty(trade_price, royalty.basis_points)` with the per-NFT trade price), and pay one `settle_royalty` per NFT and asset.

### Requesting an NFT

When the maker requests an NFT, they pay its royalty up front, since the taker can't be trusted to. The maker adds `NftAssetInfo` for the NFT (which includes its royalty), and adds the royalty payments with `calculate_royalty_payments(...)?.actions()` alongside the offered XCH. The taker reveals the trade prices to the NFT when they spend it, with `update_nft`, computed from the offered amounts:

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

Decompression supports every version of the format the reference wallet has used, and output is capped at 6 MB (`DriverError::DecompressionTooLarge`), matching chia-blockchain. Encode the result of `offer.to_spend_bundle(&mut ctx)?`, not the maker's input spend bundle, since the offer file needs the requested payments.

## Security considerations

- **Treat offers from others as untrusted.** Parse them with `Offer::from_spend_bundle`, which rejects puzzle reveals that don't match their coin's puzzle hash (`DriverError::WrongPuzzleHash`). `from_input_spend_bundle` skips this check, so only use it for spends you built yourself.
- **Check what you're getting.** Compare `offered_coins()` and `requested_payments()` (or `arbitrage()`) with what the user agreed to, and check that the coins the maker's spends consume are still unspent on chain. An offer can reference coins that have already been spent, in which case it can't be taken.
- **Old offers are rejected.** Offers using the retired, insecure settlement payments puzzle (`OLD_SETTLEMENT_PAYMENT_HASH`) fail to parse with `DriverError::OldSettlementPayment`.
- **Revocable CATs are a different asset.** A revocable CAT can be clawed back by its issuer, and has a different settlement puzzle hash than a CAT with the same asset id but no revocation layer. Check `asset_info().cat(asset_id)?.hidden_puzzle_hash` before treating an offered CAT as the one you expect. Mixing both kinds under one asset id fails with `DriverError::IncompatibleAssetInfo`.
- **Settlement spends are asserted.** When taking an offer, every payment a settlement coin makes is asserted by one of your conditions spends, so a third party can't strip the settlement spends out of the bundle and claim the coins. Don't set `disable_settlement_assertions` unless something else ties them to your spend.
- **Amounts can overflow.** Offered and requested totals are `u128`. A malicious offer can have totals that don't fit in a coin, which fail with `DriverError::AmountOverflow` (or `InsufficientFunds`) rather than wrapping around. Use `coin_amount` to convert totals.
- **Royalties are enforced on chain.** An NFT's royalty must be paid for an offer involving it to succeed. Use `requested_royalty_amounts` and `offered_royalty_amounts` to show users the real cost. `offered_royalties` fails with `DriverError::MissingAssetInfo` if a requested NFT has no asset info, rather than silently skipping its royalty.
- **Verify option contracts.** An offered option only commits to hashes of its terms. Check it with `OptionInfo::is_backed_by` before paying for it. See [Option Contracts](/sdk/primitives/options).
- **Relate your spends.** Use `Relation::AssertConcurrent` for both sides, so neither the maker's nor the taker's spends can be split apart.
