---
title: Option Contracts
---

# Option Contracts

An option contract gives its owner the right, but not the obligation, to buy an asset at a fixed price before a deadline. On Chia, the option is a [singleton](/sdk/primitives/singletons) that can be traded like an NFT, and the asset it's for (the **underlying**) is locked in a separate coin that the option controls. Until the expiration timestamp, whoever owns the option can exercise it by paying the **strike** to the option's creator, which releases the underlying to them. After expiration, the creator can take the underlying back.

Use options for covered calls, for selling the right to buy an asset later, or anywhere one party wants to lock up an asset at a price without committing the other party to buy it. The underlying can be XCH, a CAT (including a revocable CAT) or an NFT, and the strike can be any of those as well.

The types live in [`chia_wallet_sdk::driver`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/index.html), and are in the prelude.

## How it works

An option involves two coins:

- The **option contract** (`OptionContract`, which is `Singleton<OptionInfo>`). Its inner puzzle is the option contract layer, which commits to the id of the underlying coin and the hash of the delegated puzzle used to exercise it, and wraps the owner's p2 puzzle. The owner can transfer it freely.
- The **underlying coin**, locked by a 1-of-2 puzzle (`OptionUnderlying`, built on `P2OneOfManyLayer`) with two paths:
  - **Exercise**: requires a message from the option singleton, which it only sends when it's melted. The delegated puzzle for this path asserts that the timestamp is before the expiration, asserts that the strike was paid to the creator (as a notarized payment from a settlement coin, with the option's launcher id as the nonce), and sends the underlying to the settlement payments puzzle, where the exerciser can claim it in the same transaction.
  - **Clawback**: the creator's puzzle, with an `ASSERT_SECONDS_ABSOLUTE` of the expiration, so the creator can only reclaim the underlying after it expires.

Exercising is therefore atomic: the option is melted, the strike is paid, and the underlying is released in one spend bundle, or none of it happens. The strike payment is the same kind of notarized payment an [offer](/sdk/offers) uses, so options can be exercised with the action system's settlement machinery.

| Type                 | What it is                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OptionContract`     | The option singleton: `coin`, `proof` and `info`. Has `parse_child`, `parse`, `spend`, `transfer`, `exercise`.                                                               |
| `OptionInfo`         | `launcher_id`, `underlying_coin_id`, `underlying_delegated_puzzle_hash` and the owner's `p2_puzzle_hash`. Has `is_backed_by`.                                                |
| `OptionUnderlying`   | The terms of the underlying coin's puzzle: launcher id, creator puzzle hash, expiration `seconds`, underlying `amount`, and strike type.                                     |
| `OptionType`         | The strike: `Xch { amount }`, `Cat { asset_id, amount }`, `RevocableCat { asset_id, hidden_puzzle_hash, amount }`, or `Nft { launcher_id, settlement_puzzle_hash, amount }`. |
| `OptionLauncher`     | Builds a new option, in two states: before and after the underlying coin is known.                                                                                           |
| `OptionLauncherInfo` | The terms passed to `OptionLauncher`: creator, owner, expiration, underlying amount and strike type.                                                                         |
| `OptionMetadata`     | The expiration and strike type, stored in the launcher's solution so wallets can display the option's terms.                                                                 |

## Minting with the action system

The simplest way to mint an option is `Action::mint_option`, which creates the launcher, locks the underlying asset, and mints the option in one transaction. The underlying can be XCH (`Id::Xch`), a CAT or an NFT in the spends, including one created by an earlier action in the same list. See the [Action Reference](/sdk/action-system/actions#options).

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn mint_xch_option() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1_001);
    let bob = BlsPair::new(1);
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    // Lock 1000 mojos, which Bob can buy for 600 mojos of XCH until timestamp 500
    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::mint_option(
                alice.puzzle_hash,
                500,
                Id::Xch,
                1_000,
                OptionType::Xch { amount: 600 },
                1,
            ),
            Action::send(Id::New(0), bob.puzzle_hash, 1, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::None,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let option = outputs.options[&Id::New(0)];
    assert_eq!(option.info.p2_puzzle_hash, bob.puzzle_hash);
    assert!(
        outputs
            .xch
            .iter()
            .any(|coin| coin.coin_id() == option.info.underlying_coin_id && coin.amount == 1_000)
    );

    Ok(())
}
```

## Exercising

Exercising takes three things in the same spend bundle:

1. **Melt the option**, which sends the message that authorizes the underlying coin's exercise path. With the action system, that's `Action::melt_singleton(option_id, amount)`. At a low level, it's `option.exercise(ctx, &p2, extra_conditions)`. Melting without the message, or sending the message without melting, fails.
2. **Spend the underlying coin** with `underlying.exercise_spend(ctx, option.info.inner_puzzle_hash().into(), option.coin.amount)`, wrapping it in the asset's layers (`Cat::spend_all` for a CAT, `nft.spend` for an NFT, or `exercise_coin_spend` for XCH). This sends the underlying to a settlement coin.
3. **Pay the strike** with a notarized payment from a settlement coin: `underlying.requested_payment(ctx)` returns it. With the action system, that's `Action::settle(strike_id, payment)`, and the settlement child of the underlying can be added to the spends, so it's claimed as change.

You need the option's terms (the `OptionUnderlying`) to build the exercise spend. The expiration and strike type are in the launcher's solution (`OptionContract::parse_metadata`), the creator's puzzle hash is the launcher's hint, and the underlying amount is the underlying coin's amount. **Always check them with `option.info.is_backed_by(&underlying, underlying_coin, underlying_p2_puzzle_hash)`** before paying for or exercising an option you didn't mint, since the option singleton only commits to hashes and anyone can mint an option with misleading metadata.

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn exercise_cat_option() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(101);
    let bob = sim.bls(50);
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    // Alice issues 100 of a CAT and sells Bob an option to buy it for 50 mojos of XCH
    let strike_type = OptionType::Xch { amount: 50 };

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::single_issue_cat(None, 100),
            Action::mint_option(alice.puzzle_hash, 1_000, Id::New(0), 100, strike_type, 1),
            Action::send(Id::New(1), bob.puzzle_hash, 1, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::None,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let option = outputs.options[&Id::New(1)];
    let underlying_cat = outputs.cats[&Id::New(0)]
        .iter()
        .copied()
        .find(|cat| cat.coin.coin_id() == option.info.underlying_coin_id)
        .expect("missing underlying");

    // Bob reconstructs the terms and checks that the option is backed by the CAT
    let underlying = OptionUnderlying::new(
        option.info.launcher_id,
        alice.puzzle_hash,
        1_000,
        100,
        strike_type,
    );
    assert!(option.info.is_backed_by(
        &underlying,
        underlying_cat.coin,
        underlying_cat.info.p2_puzzle_hash,
    ));

    // Spend the underlying CAT with the exercise path, which moves it to a settlement coin
    let exercise_spend =
        underlying.exercise_spend(&mut ctx, option.info.inner_puzzle_hash().into(), option.coin.amount)?;
    let settlement_cats = Cat::spend_all(&mut ctx, &[CatSpend::new(underlying_cat, exercise_spend)])?;

    // Melt the option, pay the strike, and claim the released CAT as change
    let strike_payment = underlying.requested_payment(&mut *ctx)?;

    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(bob.coin);
    spends.add(option);
    spends.add(settlement_cats[0]);

    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::melt_singleton(Id::Existing(option.info.launcher_id), 1),
            Action::settle(Id::Xch, strike_payment),
        ],
    )?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { bob.puzzle_hash => bob.pk },
    )?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    // Bob has the CAT, and Alice was paid the strike
    let bob_cat = &outputs.cats[&Id::Existing(underlying_cat.info.asset_id)][0];
    assert_eq!(bob_cat.info.p2_puzzle_hash, bob.puzzle_hash);
    assert_eq!(bob_cat.coin.amount, 100);
    assert_eq!(sim.unspent_coins(alice.puzzle_hash, false)[0].amount, 50);
    assert!(outputs.options.is_empty());

    Ok(())
}
```

For a CAT strike, pay it with `Action::settle(Id::Existing(asset_id), payment)` from your CAT coins, and for an NFT strike, `Action::settle(Id::Existing(launcher_id), payment)` with the NFT in the spends. The payment is hinted to the creator for CAT and NFT strikes.

## Minting at a low level

Without the action system, minting takes three steps, because the option needs to know the underlying coin's id, and the underlying coin's puzzle needs to know the option's launcher id:

1. Create an `OptionLauncher` from the parent coin of the launcher and an `OptionLauncherInfo`. At this point, it knows the launcher id, so `launcher.p2_puzzle_hash()` is the puzzle hash to lock the underlying with, and `launcher.underlying()` is the `OptionUnderlying`.
2. Create the underlying coin with that puzzle hash (for a CAT or NFT, as the p2 puzzle hash inside the asset's layers), then call `launcher.with_underlying(underlying_coin_id)`.
3. `launcher.mint(ctx)` returns the conditions for the parent coin to output (which create and spend the launcher) and the `OptionContract`, already sent to the owner.

The expiration (`seconds`) is compared against the block timestamp. The Simulator starts at a timestamp of 0 and adds one second per block, and `sim.set_next_timestamp` or `sim.pass_time` moves it forward.

## Expiring and reclaiming

After the expiration timestamp, the exercise path stops working, and the creator can reclaim the underlying with `underlying.clawback_spend(ctx, creator_spend)`, where `creator_spend` is a spend of the creator's puzzle (whose hash is `creator_puzzle_hash`). For an XCH underlying, `clawback_coin_spend` spends the coin directly. For a CAT or NFT, wrap the returned spend in the asset's layers, the same as for exercising. The option singleton is still around after expiration, but it can no longer be exercised.

This example mints an option at a low level, checks its metadata and lineage the way a wallet would, and then reclaims the underlying after it expires:

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::prelude::*;

#[test]
fn mint_and_reclaim() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = BlsPair::new(1);
    let underlying_parent = sim.new_coin(alice.puzzle_hash, 100);

    // 1. The launcher is created from Alice's 1 mojo coin, and the option is owned by Bob
    let seconds = 10;
    let strike_type = OptionType::Xch { amount: 60 };
    let launcher = OptionLauncher::new(
        &mut ctx,
        alice.coin.coin_id(),
        OptionLauncherInfo::new(alice.puzzle_hash, bob.puzzle_hash, seconds, 100, strike_type),
        1,
    )?;
    let underlying = launcher.underlying();
    let underlying_puzzle_hash = launcher.p2_puzzle_hash();

    // 2. Lock the underlying XCH with the option's puzzle
    alice_p2.spend(
        &mut ctx,
        underlying_parent,
        Conditions::new().create_coin(underlying_puzzle_hash, 100, Memos::None),
    )?;
    let underlying_coin = Coin::new(underlying_parent.coin_id(), underlying_puzzle_hash, 100);
    let launcher = launcher.with_underlying(underlying_coin.coin_id());

    // 3. Mint the option
    let (mint_option, option) = launcher.mint(&mut ctx)?;
    alice_p2.spend(&mut ctx, alice.coin, mint_option)?;

    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    assert_eq!(option.info.p2_puzzle_hash, bob.puzzle_hash);
    assert!(option.info.is_backed_by(&underlying, underlying_coin, underlying_puzzle_hash));

    // A wallet reads the terms from the launcher's solution...
    let launcher_spend = sim.coin_spend(option.info.launcher_id).expect("missing launcher");
    let launcher_solution = ctx.alloc(&launcher_spend.solution)?;
    let metadata = OptionContract::parse_metadata(&mut ctx, launcher_solution)?;
    assert_eq!(metadata, OptionMetadata::new(seconds, strike_type));

    // ...and parses the option from its parent spend
    let parent_spend = sim.coin_spend(option.coin.parent_coin_info).expect("missing parent");
    let parent_puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle);
    let parent_solution = ctx.alloc(&parent_spend.solution)?;
    let parsed = OptionContract::parse_child(&mut ctx, parent_spend.coin, parent_puzzle, parent_solution)?;
    assert_eq!(parsed, Some(option));

    // Alice can't reclaim the underlying before it expires
    let reclaim = |ctx: &mut SpendContext| -> anyhow::Result<()> {
        let creator_spend = alice_p2.spend_with_conditions(
            ctx,
            Conditions::new().create_coin(alice.puzzle_hash, 100, Memos::None),
        )?;
        underlying.clawback_coin_spend(ctx, underlying_coin, creator_spend)?;
        Ok(())
    };

    reclaim(&mut ctx)?;
    assert!(sim.clone().spend_coins(ctx.take(), std::slice::from_ref(&alice.sk)).is_err());

    // After it expires, she can
    sim.set_next_timestamp(seconds)?;
    reclaim(&mut ctx)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(sim.unspent_coins(alice.puzzle_hash, false)[0].amount, 100);

    Ok(())
}
```

## Transferring

Options are transferred like any other singleton. With the action system, `Action::send(option_id, puzzle_hash, amount, hint)`. At a low level, `option.transfer(ctx, &p2, new_p2_puzzle_hash, extra_conditions)` spends it and returns the child, hinted to the new owner. Options can also be offered and requested in [offers](/sdk/offers): `OfferCoins::options` holds offered options, `RequestedPayments::options` holds requested ones, and `OptionAssetInfo` (the underlying coin id and delegated puzzle hash) is what's needed to build the requested option's puzzle hash.

## Gotchas

- **Verify before you trust.** The option singleton only commits to the underlying coin id and a hash of the exercise conditions. Rebuild the `OptionUnderlying` from the metadata, the launcher hint and the underlying coin, and check `is_backed_by`. Also check that the underlying coin is still unspent.
- **Melting is exercising.** `Action::melt_singleton` on an option only works as part of an exercise, since the melt has to be paired with the message to the underlying, and the underlying spend asserts the strike payment.
- **Timestamps are absolute.** `seconds` is a Unix timestamp, not a duration.
- **NFT underlyings are locked immediately.** When the underlying is an NFT minted or updated in the same transaction, no later action can touch it (`DriverError::NoSourceForOutput`).
