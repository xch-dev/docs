---
title: Clawback
---

# Clawback

A clawback is a p2 puzzle that sends a coin to a receiver while letting the sender take it back for a
limited time. Until the timeout, the sender can claw the coin back; after it, the receiver can claim
it. This protects against sending to the wrong address, since the coin isn't final until the receiver
has had a chance to claim it.

The SDK has two versions, both in `chia_wallet_sdk::driver` (no feature flag):

| Type         | Timeout                        | Discovery                                      | Used by                                                                       |
| ------------ | ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `ClawbackV2` | Absolute timestamp (`seconds`) | Hint plus memo on the `CREATE_COIN`            | Newer wallets and [clear signing](/sdk/clear-signing). Works for XCH and CATs |
| `Clawback`   | Relative seconds (`timelock`)  | A `REMARK` condition next to the `CREATE_COIN` | The reference Chia wallet's clawback format                                   |

Both are built on `P2OneOfManyLayer`: a merkle tree of spend paths where each spend reveals one path.
Because they're p2 puzzles, you can wrap them in a [CAT](/sdk/primitives/cat) layer like any other
inner puzzle.

## ClawbackV2

`ClawbackV2::new(sender_puzzle_hash, receiver_puzzle_hash, seconds, amount, hinted)` describes the
clawback. Its puzzle hash (`clawback.tree_hash()`) commits to all five fields. There are three paths:

| Path         | Who           | When                  | Methods                                                                                                |
| ------------ | ------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| Sender       | Sender's p2   | Before `seconds`      | `recover_spend` (send back to sender), `force_spend` (send to receiver early), `sender_spend` (custom) |
| Receiver     | Receiver's p2 | At or after `seconds` | `finish_spend` (claim), `receiver_spend` (custom)                                                      |
| Push through | Anyone        | At or after `seconds` | `push_through_spend`: pays `amount` to the receiver with no signature                                  |

The `*_coin_spend` variants (`recover_coin_spend`, `finish_coin_spend`, `force_coin_spend`,
`push_through_coin_spend`) insert the spend into the `SpendContext` directly. Use the `*_spend`
variants when you need the `Spend` to wrap in another layer, for example with `Cat::spend_all`.

`hinted` controls whether the coin created by these paths includes a hint for its recipient. Set it to
`true` for CATs (so the recipient's wallet can find the CAT) and usually `false` for XCH.

### Discovering clawbacks

To let the receiver's wallet find and decode the clawback, create the coin with memos of the form
`(receiver_puzzle_hash, (clawback.memo(), ...))`. The first memo is a hint, so the coin shows up when the
receiver looks up coins hinted to their puzzle hash. The second is `(sender_puzzle_hash, (seconds, ()))`,
which together with the coin's amount, the hint and the `hinted` flag lets anyone reconstruct the
`ClawbackV2` with `ClawbackV2::from_memo`. `from_memo` checks the reconstructed puzzle hash against the coin, so a bad
memo just returns `None`.

This example sends a clawback from Alice to Bob, has Bob discover it from the chain, and then claims it
after the timeout.

```rust
use chia_wallet_sdk::clvm_traits::clvm_list;
use chia_wallet_sdk::prelude::*;

#[test]
fn clawback_v2_send_and_claim() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1000);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);
    let bob_p2 = StandardLayer::new(bob.pk);

    // Bob can claim it 100 seconds after the next block.
    let seconds = sim.next_timestamp() + 100;
    let clawback = ClawbackV2::new(alice.puzzle_hash, bob.puzzle_hash, seconds, 1000, false);
    let clawback_puzzle_hash: Bytes32 = clawback.tree_hash().into();

    let memos = ctx.memos(&clvm_list!(bob.puzzle_hash, clawback.memo()))?;
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(clawback_puzzle_hash, 1000, memos),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob finds the coin by its hint, and decodes the clawback from the parent's conditions.
    let coin = sim
        .unspent_coins(bob.puzzle_hash, true)
        .into_iter()
        .find(|coin| coin.puzzle_hash != bob.puzzle_hash)
        .unwrap();
    let parent = sim.coin_spend(coin.parent_coin_info).unwrap();
    let puzzle = ctx.alloc(&parent.puzzle_reveal)?;
    let solution = ctx.alloc(&parent.solution)?;
    let output = ctx.run(puzzle, solution)?;
    let conditions: Vec<Condition> = ctx.extract(output)?;

    let create_coin = conditions
        .into_iter()
        .filter_map(Condition::into_create_coin)
        .find(|cc| cc.puzzle_hash == coin.puzzle_hash && cc.amount == coin.amount)
        .unwrap();
    let Memos::Some(memos) = create_coin.memos else {
        anyhow::bail!("missing memos");
    };
    let (hint, (memo, _rest)) = ctx.extract::<(Bytes32, (NodePtr, NodePtr))>(memos)?;

    let found = ClawbackV2::from_memo(ctx, memo, hint, coin.amount, false, coin.puzzle_hash)
        .expect("not a valid clawback");
    assert_eq!(found, clawback);

    // Claiming before the timeout fails.
    found.finish_coin_spend(ctx, coin, &bob_p2, Conditions::new())?;
    assert!(sim.spend_coins(ctx.take(), &[bob.sk.clone()]).is_err());

    // After the timeout, Bob can claim it.
    sim.set_next_timestamp(seconds)?;
    found.finish_coin_spend(ctx, coin, &bob_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    assert!(sim.unspent_coins(bob.puzzle_hash, false).iter().any(|c| c.amount == 1000));

    Ok(())
}
```

### Clawing back

The sender's paths assert that the timeout hasn't passed (`ASSERT_BEFORE_SECONDS_ABSOLUTE`), so they
stop working once the receiver can claim. If nobody claims the coin, anyone can push it through to the
receiver after the timeout without a signature.

```rust
use chia_wallet_sdk::clvm_traits::clvm_list;
use chia_wallet_sdk::prelude::*;

#[test]
fn clawback_v2_recover_and_push_through() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(3);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    // Send two clawback coins to Bob. The amount is part of the puzzle hash.
    let seconds = sim.next_timestamp() + 100;
    let first = ClawbackV2::new(alice.puzzle_hash, bob.puzzle_hash, seconds, 1, false);
    let second = ClawbackV2::new(alice.puzzle_hash, bob.puzzle_hash, seconds, 2, false);

    let first_memos = ctx.memos(&clvm_list!(bob.puzzle_hash, first.memo()))?;
    let second_memos = ctx.memos(&clvm_list!(bob.puzzle_hash, second.memo()))?;
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(first.tree_hash().into(), 1, first_memos)
            .create_coin(second.tree_hash().into(), 2, second_memos),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;
    let first_coin = Coin::new(alice.coin.coin_id(), first.tree_hash().into(), 1);
    let second_coin = Coin::new(alice.coin.coin_id(), second.tree_hash().into(), 2);

    // Alice changes her mind about the first one, and takes it back before the timeout.
    first.recover_coin_spend(ctx, first_coin, &alice_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Nobody claims the second one, so after the timeout anyone can push it through to Bob.
    sim.set_next_timestamp(seconds)?;
    second.push_through_coin_spend(ctx, second_coin)?;
    sim.spend_coins(ctx.take(), &[])?;

    assert!(sim.unspent_coins(alice.puzzle_hash, false).iter().any(|c| c.amount == 1));
    assert!(sim.unspent_coins(bob.puzzle_hash, false).iter().any(|c| c.amount == 2));

    Ok(())
}
```

### CATs

For CATs, the clawback is the CAT's inner puzzle. Create the CAT with the clawback puzzle hash as its
p2 puzzle hash and the same memos, set `hinted` to `true`, and spend it by passing the clawback's
`Spend` to `Cat::spend_all`:

```rust
use chia_wallet_sdk::clvm_traits::clvm_list;
use chia_wallet_sdk::prelude::*;

#[test]
fn clawback_v2_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let hint = ctx.hint(alice.puzzle_hash)?;
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        1,
        Conditions::new().create_coin(alice.puzzle_hash, 1, hint),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;

    let seconds = sim.next_timestamp() + 100;
    let clawback = ClawbackV2::new(alice.puzzle_hash, bob.puzzle_hash, seconds, 1, true);
    let clawback_puzzle_hash: Bytes32 = clawback.tree_hash().into();
    let memos = ctx.memos(&clvm_list!(bob.puzzle_hash, clawback.memo()))?;

    let inner_spend = alice_p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(clawback_puzzle_hash, 1, memos),
    )?;
    Cat::spend_all(ctx, &[CatSpend::new(cats[0], inner_spend)])?;
    let clawback_cat = cats[0].child(clawback_puzzle_hash, 1);
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Claw the CAT back.
    let spend = clawback.recover_spend(ctx, &alice_p2, Conditions::new())?;
    Cat::spend_all(ctx, &[CatSpend::new(clawback_cat, spend)])?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

## Clawback (v1)

`Clawback { timelock, sender_puzzle_hash, receiver_puzzle_hash }` is the format used by the reference
wallet. The receiver path asserts a relative timelock (`ASSERT_SECONDS_RELATIVE`), and the sender path
can be spent at any time, so the sender can claw back even after the timelock has passed if the receiver
hasn't claimed yet.

Instead of memos, v1 clawbacks are discovered through a `REMARK` condition emitted by the parent spend
alongside the `CREATE_COIN`. `get_remark_condition` builds it, and `Clawback::parse_children` (or
`parse_child`) finds every clawback created by a parent spend.

```rust
use chia_wallet_sdk::driver::Clawback;
use chia_wallet_sdk::prelude::*;

#[test]
fn clawback_v1() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);
    let bob_p2 = StandardLayer::new(bob.pk);

    let clawback = Clawback {
        timelock: 1,
        sender_puzzle_hash: alice.puzzle_hash,
        receiver_puzzle_hash: bob.puzzle_hash,
    };
    let clawback_puzzle_hash: Bytes32 = clawback.tree_hash().into();

    let remark = clawback.get_remark_condition(ctx)?;
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(clawback_puzzle_hash, 1, Memos::None)
            .with(remark),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Parse the clawback back out of the parent spend.
    let parent = sim.coin_spend(alice.coin.coin_id()).unwrap();
    let puzzle = ctx.alloc(&parent.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&parent.solution)?;
    let found = Clawback::parse_child(ctx, puzzle, solution, clawback_puzzle_hash)?
        .expect("clawback not found");
    assert_eq!(found, clawback);

    // Bob claims it once the relative timelock has passed.
    let coin = Coin::new(alice.coin.coin_id(), clawback_puzzle_hash, 1);
    sim.pass_time(1);
    found.claim_coin_spend(ctx, coin, &bob_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    Ok(())
}
```

The sender's counterpart is `clawback_coin_spend`. Both create the full coin amount for the recipient
with a hint. For custom spends, use `receiver_spend` and `sender_spend`.

## Gotchas

- `ClawbackV2::seconds` is an absolute Unix timestamp, while `Clawback::timelock` is relative to the
  coin's creation. In the simulator, use `sim.next_timestamp()`, `set_next_timestamp` and `pass_time`
  to control block timestamps (see [Simulator](/sdk/testing)).
- `amount` and `hinted` are part of a `ClawbackV2`'s puzzle hash. The push-through path pays exactly
  `amount`, so the coin's amount must match it.
- If the sender or receiver is a vault, its path is spent with the vault's p2 spend as the inner spend.
  Clear signing requires vault transactions that use the sender path to expire no later than the
  clawback's `seconds`; see
  [Clear Signing](/sdk/clear-signing#clawbacks-and-expiration).
