---
title: Bulletins
---

# Bulletins

A **bulletin** is a way to publish short, structured messages on chain. Each message is a
`BulletinMessage { topic, content }` (two strings), emitted as a `REMARK` condition by a special
0-amount coin. Anyone indexing the blockchain can find bulletin coins by their puzzle and read their
messages, and the messages are attributable to whoever controls the bulletin's inner puzzle.

Bulletins are ephemeral: the parent creates the 0-amount bulletin coin and the bulletin is spent in the
same transaction, so nothing is left behind except the messages in the spend.

The types are `Bulletin`, `BulletinMessage` and `BulletinLayer`, all in `chia_wallet_sdk::driver` (no
feature flag).

## How it works

The bulletin's puzzle is the MIPS index wrapper (see [Vaults & MIPS](/sdk/primitives/vaults)) around
the publisher's own puzzle, with the fixed nonce `("b" . ())` (`BulletinNonce`). This doesn't change how
the inner puzzle is spent, it only gives the bulletin coin a different puzzle hash from the publisher's
normal coins, so indexers can tell bulletins apart from regular XCH. The `hidden_puzzle_hash` field of
`Bulletin` is the hash of that inner puzzle.

To spend the bulletin, the inner puzzle outputs one `REMARK` per message. `Bulletin::conditions`
builds them, and `Bulletin::parse` reads them back from a spend.

## Publishing and reading a bulletin

```rust
use chia_wallet_sdk::driver::{Bulletin, BulletinMessage};
use chia_wallet_sdk::prelude::*;

#[test]
fn publish_bulletin() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(0);
    let p2 = StandardLayer::new(alice.pk);

    // The bulletin is created by Alice's coin and wraps Alice's own puzzle.
    let (parent_conditions, bulletin) = Bulletin::create(
        alice.coin.coin_id(),
        alice.puzzle_hash,
        vec![BulletinMessage::new(
            "animals/rabbit/vienna-blue".to_string(),
            "The Vienna Blue rabbit breed originally comes from Austria.".to_string(),
        )],
    )?;
    p2.spend(ctx, alice.coin, parent_conditions)?;

    // Spend the bulletin with Alice's puzzle, outputting the messages as remarks.
    let conditions = bulletin.conditions(ctx)?;
    let inner_spend = p2.spend_with_conditions(ctx, conditions)?;
    bulletin.spend(ctx, inner_spend)?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Anyone can parse it from the coin spend.
    let coin_spend = sim.coin_spend(bulletin.coin.coin_id()).unwrap();
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&coin_spend.solution)?;

    let (parsed, _inner_puzzle, _inner_solution) =
        Bulletin::parse(ctx, coin_spend.coin, puzzle, solution)?.expect("not a bulletin");

    assert_eq!(parsed, bulletin);
    assert_eq!(parsed.messages[0].topic, "animals/rabbit/vienna-blue");
    assert_eq!(parsed.hidden_puzzle_hash, alice.puzzle_hash);

    Ok(())
}
```

`Bulletin::parse` returns `None` if the puzzle isn't a bulletin. Along with the `Bulletin`, it returns
the inner puzzle and solution so you can inspect the publisher's spend further. `REMARK` conditions that
don't decode as a `BulletinMessage` are ignored.

## Publishing from a vault

The bulletin's inner puzzle can be any p2 puzzle, including a vault's `P2Singleton`. In that case the
bulletin spend's delegated conditions are the remarks, and the vault authorizes the bulletin coin with a
message like any other coin it owns. [Clear signing](/sdk/clear-signing) recognizes this and reports the
bulletin (with its messages) as a `ParsedAsset::Bulletin` in the transaction summary.

## Gotchas

- `Bulletin::create` only returns the `CREATE_COIN` for the parent; you still have to spend the
  bulletin coin in the same transaction, or a 0-amount coin is left behind with no messages.
- Topics and contents are arbitrary strings. Nothing on chain enforces a topic format, so agree on a
  convention with whoever reads them.
- Messages are public and permanent. Remarks add to the transaction's cost, so keep them short.
