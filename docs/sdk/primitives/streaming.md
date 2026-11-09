---
title: Streamed Assets
---

# Streamed Assets

A **streamed asset** is an XCH or CAT coin that pays a recipient linearly over time. The coin is
locked by the streaming puzzle, which knows the recipient, an end time, and the time of the last
payment. Whenever the recipient claims, the coin pays out the share that has vested since the last
payment and recreates itself with the remainder. Optionally, a clawback puzzle hash can stop the stream
early and take back whatever hasn't vested yet.

Use this for vesting schedules, salaries, or subscriptions, where the payer commits funds up front but
the recipient only gets access to them gradually.

The relevant types are in `chia_wallet_sdk::driver` (no feature flag):

| Type                  | Purpose                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `StreamingPuzzleInfo` | The stream's parameters: `recipient`, `clawback_ph`, `end_time`, `last_payment_time`             |
| `StreamedAsset`       | A streaming coin: the `Coin`, its CAT `asset_id` and lineage proof (if it's a CAT), and the info |
| `StreamLayer`         | The [layer](/sdk/concepts/layers) for the streaming puzzle itself                                |

## How payments are calculated

Each spend chooses a `payment_time`. The amount paid is

```text
to_pay = amount * (payment_time - last_payment_time) / (end_time - last_payment_time)
```

and the new coin has `last_payment_time = payment_time` and `amount - to_pay` mojos. Once
`payment_time` reaches `end_time` the whole remaining amount is paid and the stream isn't recreated.
`StreamingPuzzleInfo::amount_to_be_paid` does this calculation (in 128-bit arithmetic, like the puzzle),
and `clamp_payment_time` clamps a time past the end to `end_time`.

Each spend requires a message from the recipient's puzzle (or, for a clawback, the clawback puzzle)
whose content is `payment_time`, so only the recipient can trigger payments and only the clawback
puzzle can stop the stream. A normal payment asserts that `payment_time` has already passed
(`ASSERT_SECONDS_ABSOLUTE`), so the recipient can't claim funds early. A clawback does the opposite: it
asserts that `payment_time` is still in the future (`ASSERT_BEFORE_SECONDS_ABSOLUTE`), so the payer
can't backdate it to avoid paying what has already vested. On a clawback, the recipient is paid up to
`payment_time` and the rest goes to `clawback_ph`.

## Streaming XCH

This example locks 1000 mojos in a stream that vests over 1000 seconds. The recipient claims half way
through, and then the payer claws back the rest.

```rust
use chia_wallet_sdk::chia::consensus::make_aggsig_final_message::u64_to_bytes;
use chia_wallet_sdk::driver::{StreamedAsset, StreamingPuzzleInfo};
use chia_wallet_sdk::prelude::*;

#[test]
fn stream_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let payer = sim.bls(1000);
    let recipient = sim.bls(0);

    // For simplicity the clawback puzzle is `1`, which anyone can spend. Use a real puzzle in practice.
    let clawback_puzzle = ctx.alloc(&1)?;
    let clawback_puzzle_hash: Bytes32 = ctx.tree_hash(clawback_puzzle).into();

    let start = sim.next_timestamp();
    let info = StreamingPuzzleInfo::new(
        recipient.puzzle_hash,
        Some(clawback_puzzle_hash),
        start + 1000,
        start,
    );

    // The launch hints let the recipient find the stream and recover its parameters.
    let hints = ctx.alloc(&info.get_launch_hints())?;
    StandardLayer::new(payer.pk).spend(
        ctx,
        payer.coin,
        Conditions::new().create_coin(info.inner_puzzle_hash().into(), 1000, Memos::Some(hints)),
    )?;
    sim.spend_coins(ctx.take(), &[payer.sk])?;

    // Parse the stream from the spend that created it.
    let launch_spend = sim.coin_spend(payer.coin.coin_id()).unwrap();
    let (Some(stream), _, _) = StreamedAsset::from_parent_spend(ctx, &launch_spend)? else {
        anyhow::bail!("no stream found");
    };
    assert_eq!(stream.info, info);

    // Half way through, the recipient claims what has vested.
    let payment_time = start + 500;
    sim.set_next_timestamp(payment_time)?;
    assert_eq!(stream.info.amount_to_be_paid(stream.coin.amount, payment_time)?, 500);

    let message_coin = sim.new_coin(recipient.puzzle_hash, 0);
    let stream_coin_id = ctx.alloc(&stream.coin.coin_id())?;
    StandardLayer::new(recipient.pk).spend(
        ctx,
        message_coin,
        Conditions::new().send_message(
            23,
            u64_to_bytes(payment_time).into(),
            vec![stream_coin_id],
        ),
    )?;
    stream.spend(ctx, payment_time, false)?;
    sim.spend_coins(ctx.take(), &[recipient.sk.clone()])?;

    // The stream continues with the remaining 500 mojos.
    let claim_spend = sim.coin_spend(stream.coin.coin_id()).unwrap();
    let (Some(stream), clawed_back, _) = StreamedAsset::from_parent_spend(ctx, &claim_spend)? else {
        anyhow::bail!("stream ended");
    };
    assert!(!clawed_back);
    assert_eq!(stream.coin.amount, 500);
    assert_eq!(stream.info.last_payment_time, payment_time);

    // Later, the clawback puzzle stops the stream. A clawback's payment time must still be in the
    // future when the spend is included.
    let clawback_time = start + 750;
    sim.set_next_timestamp(clawback_time - 1)?;

    let clawback_coin = sim.new_coin(clawback_puzzle_hash, 0);
    let stream_coin_id = ctx.alloc(&stream.coin.coin_id())?;
    let clawback_solution = ctx.alloc(&Conditions::new().send_message(
        23,
        u64_to_bytes(clawback_time).into(),
        vec![stream_coin_id],
    ))?;
    ctx.spend(clawback_coin, Spend::new(clawback_puzzle, clawback_solution))?;
    stream.spend(ctx, clawback_time, true)?;
    sim.spend_coins(ctx.take(), &[])?;

    // The stream is over, and the recipient got paid for the time up to the clawback.
    let clawback_spend = sim.coin_spend(stream.coin.coin_id()).unwrap();
    let (child, clawed_back, paid) = StreamedAsset::from_parent_spend(ctx, &clawback_spend)?;
    assert!(child.is_none());
    assert!(clawed_back);
    assert_eq!(paid, 250);

    let recipient_total: u64 = sim
        .unspent_coins(recipient.puzzle_hash, false)
        .iter()
        .map(|coin| coin.amount)
        .sum();
    assert_eq!(recipient_total, 750);
    assert_eq!(sim.unspent_coins(clawback_puzzle_hash, false)[0].amount, 250);

    Ok(())
}
```

The message mode `23` (`0b010_111`) means the sender is committed by puzzle hash and the receiver by
full coin identity; see [Conditions](/sdk/concepts/conditions) for how message modes work.

## Parsing streams

`StreamedAsset::from_parent_spend(ctx, &coin_spend)` takes the spend of a coin's parent and returns
`(Option<StreamedAsset>, clawed_back, paid_amount)`:

- If the parent is itself a streaming coin, the child stream is computed from its solution. If the
  parent was clawed back, it returns `(None, true, to_pay)`. If it was the final payment, it returns
  `(None, false, 0)`.
- Otherwise it looks for a `CREATE_COIN` whose memos are valid launch hints
  (`StreamingPuzzleInfo::from_memos`) and whose puzzle hash matches the stream they describe. This is
  how a recipient discovers a new stream: the first memo, the recipient puzzle hash, also works as a
  hint.

Both XCH and CAT streams are handled. For a CAT parent, the returned `StreamedAsset` includes the asset
id and lineage proof.

## Streaming CATs

To stream a CAT, create a CAT with `info.inner_puzzle_hash()` as its inner puzzle hash (with the launch
hints as memos), then parse it with `from_parent_spend` as above. `StreamedAsset::spend` adds the CAT
layer automatically. Construct one directly with `StreamedAsset::cat(coin, asset_id, lineage_proof, info)`
or `StreamedAsset::xch(coin, info)`. See [CAT](/sdk/primitives/cat) for issuing and spending CATs.

## Gotchas

- `payment_time` must be at least `last_payment_time`, and the stream must not have ended
  (`DriverError::InvalidStreamPaymentTime`). Times past `end_time` are clamped, and the message must
  contain the clamped time.
- A claim must be in a block whose timestamp is at least `payment_time`, and a clawback in a block
  whose timestamp is before it. In the [Simulator](/sdk/testing), set the timestamp of the next block
  with `set_next_timestamp`.
- Each payment recreates the coin, so every claim costs a transaction. Claiming less often means fewer,
  larger payouts.
- Without a `clawback_ph`, the stream can't be stopped.
