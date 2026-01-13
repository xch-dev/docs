---
slug: /sdk/offers
title: Offers
---

# Offers

Offers enable trustless, atomic swaps of assets on the Chia blockchain. Both parties' transactions execute together or not at all.

## Overview

Chia offers work by:

1. **Maker** creates an offer specifying what they give and what they want
2. Offer is shared off-chain (file, URL, marketplace)
3. **Taker** accepts by completing the transaction with their assets
4. Both sides execute atomically - either both succeed or neither does

## Key Concepts

### Settlement Layer

The settlement layer is a special puzzle (`SETTLEMENT_PAYMENT_HASH`) that locks assets until the offer is completed. Assets sent to this puzzle hash can only be claimed by satisfying the offer's requirements.

```rust
use chia_wallet_sdk::prelude::*;
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;

// Assets locked to settlement can only be spent when
// the corresponding requested payments are satisfied
let settlement_puzzle_hash: Bytes32 = SETTLEMENT_PAYMENT_HASH.into();
```

### Offer Structure

An offer contains:

| Component | Description |
|-----------|-------------|
| `spend_bundle` | Maker's pre-signed spends |
| `offered_coins` | Assets being given (locked to settlement) |
| `requested_payments` | What the maker wants in return |
| `asset_info` | Metadata about the assets involved |

### Notarized Payments

Requested payments use a nonce (derived from offered coin IDs) to link the maker's and taker's spends:

```rust
use chia_puzzle_types::offer::{NotarizedPayment, Payment};

// The nonce links this payment request to specific offered coins
let nonce = Offer::nonce(vec![offered_coin.coin_id()]);

let notarized_payment = NotarizedPayment::new(
    nonce,
    vec![Payment::new(recipient_puzzle_hash, amount, memos)],
);
```

## XCH for CAT Offer

### Maker: Offering XCH for CAT

```rust
use chia_wallet_sdk::prelude::*;
use chia_puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_puzzle_types::offer::{NotarizedPayment, Payment};

fn create_xch_for_cat_offer(
    xch_coin: Coin,
    maker_pk: PublicKey,
    maker_sk: &SecretKey,
    cat_asset_id: Bytes32,
    xch_amount: u64,       // XCH to offer
    cat_amount: u64,       // CAT to receive
    maker_puzzle_hash: Bytes32,
    agg_sig_data: Bytes32,
) -> Result<Offer, DriverError> {
    let ctx = &mut SpendContext::new();

    // Step 1: Lock XCH to the settlement puzzle
    let conditions = Conditions::new()
        .create_coin(SETTLEMENT_PAYMENT_HASH.into(), xch_amount, Memos::None);

    StandardLayer::new(maker_pk).spend(ctx, xch_coin, conditions)?;

    // Step 2: Define what we want in return (CAT tokens)
    let nonce = Offer::nonce(vec![xch_coin.coin_id()]);
    let memos = ctx.hint(maker_puzzle_hash)?;

    let mut requested_payments = RequestedPayments::new();
    requested_payments.cats.insert(
        cat_asset_id,
        vec![NotarizedPayment::new(
            nonce,
            vec![Payment::new(maker_puzzle_hash, cat_amount, memos)],
        )],
    );

    // Step 3: Sign the maker's spends
    let coin_spends = ctx.take();
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        &coin_spends,
        &AggSigConstants::new(agg_sig_data),
    )?;

    let mut signature = Signature::default();
    for req in required {
        let RequiredSignature::Bls(bls_req) = req else { continue };
        signature += &sign(maker_sk, bls_req.message());
    }

    // Step 4: Create the offer
    let spend_bundle = SpendBundle::new(coin_spends, signature);
    let offer = Offer::from_input_spend_bundle(
        &mut ctx,
        spend_bundle,
        requested_payments,
        AssetInfo::new(),  // No special asset info needed for simple CAT
    )?;

    Ok(offer)
}
```

### Taker: Accepting with CAT

```rust
use chia_wallet_sdk::prelude::*;

fn accept_xch_for_cat_offer(
    offer: Offer,
    cat: Cat,
    taker_pk: PublicKey,
    taker_sk: &SecretKey,
    taker_puzzle_hash: Bytes32,
    agg_sig_data: Bytes32,
) -> Result<SpendBundle, DriverError> {
    let ctx = &mut SpendContext::new();

    // Step 1: Get the offered XCH coins from the offer
    let offered_xch = &offer.offered_coins().xch;

    // Step 2: Spend the offered XCH to ourselves
    // (The settlement puzzle allows this once we provide the CAT)
    for xch_coin in offered_xch {
        let conditions = Conditions::new()
            .create_coin(taker_puzzle_hash, xch_coin.amount, ctx.hint(taker_puzzle_hash)?);

        // Spend using SettlementLayer
        let spend = SettlementLayer.construct_spend(
            ctx,
            SettlementPaymentsSolution::new(vec![]),
        )?;
        ctx.spend(*xch_coin, spend)?;
    }

    // Step 3: Send CAT to satisfy the maker's request
    let requested = offer.requested_payments();
    let p2 = StandardLayer::new(taker_pk);

    for (asset_id, payments) in &requested.cats {
        // Create inner spend that outputs to maker's requested destination
        let mut conditions = Conditions::new();
        for notarized in payments {
            for payment in &notarized.payments {
                conditions = conditions.create_coin(
                    payment.puzzle_hash,
                    payment.amount,
                    Memos::from(payment.memos.clone()),
                );
            }
        }

        let inner_spend = p2.spend_with_conditions(ctx, conditions)?;
        let cat_spends = [CatSpend::new(cat, inner_spend)];
        Cat::spend_all(ctx, &cat_spends)?;
    }

    // Step 4: Sign taker's spends
    let coin_spends = ctx.take();
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        &coin_spends,
        &AggSigConstants::new(agg_sig_data),
    )?;

    let mut signature = Signature::default();
    for req in required {
        let RequiredSignature::Bls(bls_req) = req else { continue };
        signature += &sign(taker_sk, bls_req.message());
    }

    // Step 5: Combine with maker's spend bundle
    let taker_bundle = SpendBundle::new(coin_spends, signature);
    let final_bundle = offer.take(taker_bundle);

    Ok(final_bundle)
}
```

## NFT Offers

NFTs have built-in methods for offer settlement that handle royalties.

### Maker: Offering NFT

```rust
use chia_wallet_sdk::prelude::*;
use chia_puzzle_types::offer::{NotarizedPayment, Payment};

fn create_nft_offer(
    nft: Nft,
    maker_pk: PublicKey,
    maker_sk: &SecretKey,
    requested_xch: u64,
    maker_puzzle_hash: Bytes32,
    agg_sig_data: Bytes32,
) -> Result<Offer, DriverError> {
    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(maker_pk);

    // Step 1: Lock NFT to settlement with trade prices (for royalty calculation)
    let trade_prices = vec![TradePrice {
        amount: requested_xch,
        puzzle_hash: SETTLEMENT_PAYMENT_HASH.into(),  // XCH
    }];

    let locked_nft = nft.lock_settlement(
        ctx,
        &p2,
        trade_prices,
        Conditions::new(),
    )?;

    // Step 2: Define requested payment (XCH)
    let nonce = Offer::nonce(vec![nft.coin.coin_id()]);
    let memos = ctx.hint(maker_puzzle_hash)?;

    let mut requested_payments = RequestedPayments::new();
    requested_payments.xch.push(NotarizedPayment::new(
        nonce,
        vec![Payment::new(maker_puzzle_hash, requested_xch, memos)],
    ));

    // Step 3: Build asset info for the NFT
    let mut asset_info = AssetInfo::new();
    asset_info.insert_nft(
        nft.info.launcher_id,
        NftAssetInfo::new(
            nft.info.metadata,
            nft.info.metadata_updater_puzzle_hash,
            nft.info.royalty_puzzle_hash,
            nft.info.royalty_basis_points,
        ),
    )?;

    // Step 4: Sign and create offer
    let coin_spends = ctx.take();
    let signature = sign_spends(&coin_spends, maker_sk, agg_sig_data)?;

    let offer = Offer::from_input_spend_bundle(
        &mut ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?;

    Ok(offer)
}
```

### Taker: Accepting NFT Offer

```rust
use chia_wallet_sdk::prelude::*;

fn accept_nft_offer(
    offer: Offer,
    xch_coin: Coin,
    taker_pk: PublicKey,
    taker_sk: &SecretKey,
    taker_puzzle_hash: Bytes32,
    agg_sig_data: Bytes32,
) -> Result<SpendBundle, DriverError> {
    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(taker_pk);

    // Step 1: Get the locked NFT from the offer
    let offered_nfts = &offer.offered_coins().nfts;
    let (launcher_id, locked_nft) = offered_nfts.iter().next()
        .ok_or(DriverError::MissingChild)?;

    // Step 2: Calculate royalties
    let royalty_amounts = offer.requested_royalty_amounts();
    let royalty_info = offer.requested_royalties();

    // Step 3: Unlock the NFT to ourselves
    let nonce = Offer::nonce(vec![locked_nft.coin.coin_id()]);
    let memos = ctx.hint(taker_puzzle_hash)?;

    let notarized_payments = vec![NotarizedPayment::new(
        nonce,
        vec![Payment::new(taker_puzzle_hash, 1, memos)],
    )];

    locked_nft.unlock_settlement(ctx, notarized_payments)?;

    // Step 4: Pay the maker (XCH) plus royalties
    let requested_xch = offer.requested_payments().amounts().xch;
    let royalty_xch = royalty_amounts.xch;
    let total_needed = requested_xch + royalty_xch;

    let mut conditions = Conditions::new();

    // Pay the maker
    for notarized in &offer.requested_payments().xch {
        for payment in &notarized.payments {
            conditions = conditions.create_coin(
                payment.puzzle_hash,
                payment.amount,
                Memos::from(payment.memos.clone()),
            );
        }
    }

    // Pay royalties
    for royalty in &royalty_info {
        let amount = royalty_amounts.xch / royalty_info.len() as u64;
        if amount > 0 {
            conditions = conditions.create_coin(
                royalty.puzzle_hash,
                amount,
                Memos::None,
            );
        }
    }

    // Change back to taker
    let change = xch_coin.amount - total_needed;
    if change > 0 {
        conditions = conditions.create_coin(
            taker_puzzle_hash,
            change,
            ctx.hint(taker_puzzle_hash)?,
        );
    }

    p2.spend(ctx, xch_coin, conditions)?;

    // Step 5: Combine and sign
    let coin_spends = ctx.take();
    let signature = sign_spends(&coin_spends, taker_sk, agg_sig_data)?;

    let final_bundle = offer.take(SpendBundle::new(coin_spends, signature));

    Ok(final_bundle)
}
```

## Parsing Existing Offers

To parse an offer received from elsewhere:

```rust
use chia_wallet_sdk::prelude::*;

fn parse_offer(spend_bundle: &SpendBundle) -> Result<Offer, DriverError> {
    let mut allocator = Allocator::new();

    // Parse the offer from a complete spend bundle
    let offer = Offer::from_spend_bundle(&mut allocator, spend_bundle)?;

    // Inspect what's being offered
    let offered = offer.offered_coins();
    println!("Offered XCH: {} mojos", offered.amounts().xch);
    for (asset_id, amount) in &offered.amounts().cats {
        println!("Offered CAT {}: {} mojos", asset_id, amount);
    }
    for launcher_id in offered.nfts.keys() {
        println!("Offered NFT: {}", launcher_id);
    }

    // Inspect what's requested
    let requested = offer.requested_payments();
    println!("Requested XCH: {} mojos", requested.amounts().xch);
    for (asset_id, amount) in &requested.amounts().cats {
        println!("Requested CAT {}: {} mojos", asset_id, amount);
    }

    Ok(offer)
}
```

## Royalties

NFT royalties are automatically calculated based on trade prices:

```rust
// Get royalty info from an offer
let royalties = offer.requested_royalties();  // For NFTs being offered
let royalty_amounts = offer.requested_royalty_amounts();

for royalty in &royalties {
    println!(
        "NFT {} requires {}% royalty to {}",
        royalty.launcher_id,
        royalty.basis_points as f64 / 100.0,
        royalty.puzzle_hash
    );
}

println!("Total royalty XCH: {} mojos", royalty_amounts.xch);
```

## Offer Compression

For sharing offers efficiently, enable compression:

```toml
chia-wallet-sdk = { version = "0.32", features = ["offer-compression"] }
```

```rust
use chia_wallet_sdk::driver::{compress_offer, decompress_offer};

// Compress for sharing
let compressed = compress_offer(&offer_bytes)?;

// Decompress when receiving
let decompressed = decompress_offer(&compressed)?;
```

## Helper Function

A utility for signing spends used in the examples above:

```rust
fn sign_spends(
    coin_spends: &[CoinSpend],
    secret_key: &SecretKey,
    agg_sig_data: Bytes32,
) -> Result<Signature, DriverError> {
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        coin_spends,
        &AggSigConstants::new(agg_sig_data),
    )?;

    let mut signature = Signature::default();
    for req in required {
        let RequiredSignature::Bls(bls_req) = req else { continue };
        signature += &sign(secret_key, bls_req.message());
    }

    Ok(signature)
}
```

## Security Considerations

:::warning
Always verify offer terms before accepting:
- Confirm the assets being offered match expectations
- Verify the requested amounts are acceptable
- Check NFT royalty terms and amounts
- Ensure you understand the full transaction
- Validate with the simulator before mainnet
:::

## API Reference

For offer-related APIs, see:

- [Offer](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Offer.html)
- [OfferCoins](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.OfferCoins.html)
- [RequestedPayments](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.RequestedPayments.html)
- [SettlementLayer](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.SettlementLayer.html)
