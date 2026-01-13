---
slug: /sdk/primitives/cat
title: CAT
---

# CAT (Chia Asset Tokens)

CATs (Chia Asset Tokens) are fungible tokens on the Chia blockchain. Each CAT has a unique asset ID derived from its TAIL (Token and Asset Issuance Limiter) program, which controls how the token can be minted.

## Overview

CATs work by wrapping an inner puzzle (typically a standard p2 puzzle) with the CAT layer. The CAT layer:

- Enforces that the total CAT amount is preserved across spends (no creation/destruction)
- Identifies the token by its asset ID
- Requires lineage proofs to verify the CAT's history

## Key Types

| Type | Description |
|------|-------------|
| `Cat` | A CAT coin with its info and optional lineage proof |
| `CatInfo` | Asset ID and inner puzzle hash |
| `CatSpend` | Combines a CAT with an inner spend |
| `LineageProof` | Proof of the CAT's parent for validation |

## Issuing CATs

The simplest way to issue a new CAT is using the single-issuance TAIL (genesis by coin ID):

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// The p2 layer for ownership
let p2 = StandardLayer::new(public_key);

// Create hint memos for coin discovery
let memos = ctx.hint(puzzle_hash)?;

// Conditions for the newly created CAT coins
let conditions = Conditions::new()
    .create_coin(puzzle_hash, 1_000, memos);

// Issue the CAT - this returns:
// - issue_cat: Conditions to add to the parent spend
// - cats: Vector of created Cat objects
let (issue_cat, cats) = Cat::issue_with_coin(
    ctx,
    parent_coin_id,  // The coin ID that will be spent to issue
    1_000,           // Total amount to issue
    conditions,      // Output conditions
)?;

// Spend the parent coin with the issuance conditions
p2.spend(ctx, parent_coin, issue_cat)?;

// The asset ID is derived from the parent coin ID
let asset_id = cats[0].info.asset_id;
```

:::info
The asset ID for single-issuance CATs is deterministically derived from the parent coin ID. This means you can calculate the asset ID before issuing.
:::

## Spending CATs

CAT spends require creating a `CatSpend` that combines the CAT with its inner puzzle spend:

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Setup
let p2 = StandardLayer::new(public_key);
let memos = ctx.hint(recipient_puzzle_hash)?;

// Create the inner spend (what the standard layer would do)
let inner_spend = p2.spend_with_conditions(
    ctx,
    Conditions::new().create_coin(recipient_puzzle_hash, 1_000, memos),
)?;

// Wrap it in a CatSpend
let cat_spends = [CatSpend::new(cat, inner_spend)];

// Execute all CAT spends
Cat::spend_all(ctx, &cat_spends)?;

let coin_spends = ctx.take();
```

### Why `spend_all`?

CAT spends must be validated together because the CAT layer verifies that the total amount in equals the total amount out. The `Cat::spend_all` function handles:

- Linking CAT spends via announcements
- Ensuring amount conservation
- Validating lineage proofs

## Computing Child Coins

After spending a CAT, you can compute the child CAT:

```rust
// After spending, compute the new CAT
let child_cat = cat.child(recipient_puzzle_hash, 1_000);

// Access the underlying coin
let child_coin = child_cat.coin;
```

## Multi-Input CAT Spends

When spending multiple CATs of the same asset type together:

```rust
let ctx = &mut SpendContext::new();
let p2 = StandardLayer::new(public_key);

// Build spends for multiple CAT coins
let cat_spends = [
    CatSpend::new(
        cat1,
        p2.spend_with_conditions(ctx, Conditions::new())?,
    ),
    CatSpend::new(
        cat2,
        p2.spend_with_conditions(
            ctx,
            Conditions::new()
                .create_coin(recipient, combined_amount, ctx.hint(recipient)?),
        )?,
    ),
];

Cat::spend_all(ctx, &cat_spends)?;
```

## Paying Fees

CATs cannot pay transaction fees directly. To pay fees when spending CATs, you must include an XCH spend in the same transaction and use `assert_concurrent_spend` to link them together:

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();
let p2 = StandardLayer::new(public_key);

// Spend the CAT
let memos = ctx.hint(recipient_puzzle_hash)?;
let inner_spend = p2.spend_with_conditions(
    ctx,
    Conditions::new()
        .create_coin(recipient_puzzle_hash, cat.coin.amount, memos)
        .assert_concurrent_spend(xch_coin.coin_id()),  // Link to XCH spend
)?;

Cat::spend_all(ctx, &[CatSpend::new(cat, inner_spend)])?;

// Spend XCH to pay the fee
let fee = 100_000_000;  // 0.0001 XCH
let change = xch_coin.amount - fee;

let mut xch_conditions = Conditions::new()
    .reserve_fee(fee)
    .assert_concurrent_spend(cat.coin.coin_id());  // Link to CAT spend

if change > 0 {
    xch_conditions = xch_conditions.create_coin(
        my_puzzle_hash,
        change,
        ctx.hint(my_puzzle_hash)?,
    );
}

p2.spend(ctx, xch_coin, xch_conditions)?;

let coin_spends = ctx.take();
```

:::warning
Always use `assert_concurrent_spend` to link CAT and XCH spends together. Without this, an attacker could extract and submit only the XCH spend (with the fee) while discarding your CAT spend.
:::

## Lineage Proofs

CATs require lineage proofs to verify their authenticity. When parsing CATs from the blockchain, you'll need to track the parent information:

```rust
// A CAT with its lineage proof
let cat = Cat {
    coin,
    info: CatInfo {
        asset_id,
        inner_puzzle_hash,
    },
    lineage_proof: Some(LineageProof {
        parent_parent_coin_info: parent_coin.parent_coin_info,
        parent_inner_puzzle_hash: parent_inner_puzzle_hash,
        parent_amount: parent_coin.amount,
    }),
};
```

When issuing new CATs, the lineage proof is handled automatically by the SDK.

## Complete Example

Here's a full example of issuing a CAT and then spending it:

```rust
use chia_wallet_sdk::prelude::*;

fn issue_and_spend_cat(
    issuer_coin: Coin,
    issuer_public_key: PublicKey,
    recipient_puzzle_hash: Bytes32,
    amount: u64,
) -> Result<(Bytes32, Vec<CoinSpend>), DriverError> {
    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(issuer_public_key);
    let issuer_puzzle_hash = StandardLayer::puzzle_hash(issuer_public_key);

    // Step 1: Issue the CAT
    let memos = ctx.hint(issuer_puzzle_hash)?;
    let issue_conditions = Conditions::new()
        .create_coin(issuer_puzzle_hash, amount, memos);

    let (issue_cat, cats) = Cat::issue_with_coin(
        ctx,
        issuer_coin.coin_id(),
        amount,
        issue_conditions,
    )?;

    p2.spend(ctx, issuer_coin, issue_cat)?;

    let asset_id = cats[0].info.asset_id;
    let cat = cats[0];

    // Step 2: Immediately spend the CAT to the recipient
    let transfer_memos = ctx.hint(recipient_puzzle_hash)?;
    let inner_spend = p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(recipient_puzzle_hash, amount, transfer_memos),
    )?;

    Cat::spend_all(ctx, &[CatSpend::new(cat, inner_spend)])?;

    Ok((asset_id, ctx.take()))
}
```

## API Reference

For the complete CAT API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Cat.html).
