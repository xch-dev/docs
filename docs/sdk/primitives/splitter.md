---
title: Splitter
---

# Splitter

A splitter coin divides its amount between a fixed list of recipients. It uses the puzzle from
[CHIP-0008 (Splitter Puzzle)](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0008.md). The
recipients and their shares are curried into the puzzle, so they can't change once funds are sent to
it. Spending the coin needs no signature: anyone can trigger the split, and the outputs are always the
same. The usual use is splitting NFT royalties between several creators, or with a charity, by using a
splitter's puzzle hash as the NFT's royalty puzzle hash. It works the same way for any asset whose outer
puzzle wraps a p2 puzzle, such as a CAT.

## How the puzzle works

The curried argument is the payout scheme, a list of `(puzzle_hash share)` pairs. The solution is the
coin's amount and the sum of all shares. When the coin is spent, the puzzle outputs:

1. `CREATE_COIN_ANNOUNCEMENT` with an empty message, so other spends can depend on the split.
2. `ASSERT_MY_AMOUNT` for the amount in the solution.
3. One `CREATE_COIN` per recipient, in the order of the scheme. Each pays `amount * share / total_shares`,
   rounded down, except the last recipient, who receives whatever is left. Each coin is hinted with the
   recipient's puzzle hash.

The puzzle fails if the total in the solution doesn't match the sum of the shares. Shares are relative,
so `80/20`, `4/1` and `8000/2000` split coins the same way. They aren't percentages.

## Types

| Type                                      | Path                              | Purpose                                                                                |
| ----------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `SplitterLayer`                           | `chia_wallet_sdk::driver`         | The [layer](/sdk/concepts/layers) for the puzzle: validation, payouts, spends, parsing |
| `SplitterPayout`                          | `chia_wallet_sdk::driver`         | A recipient's puzzle hash and the amount it receives from a given coin                 |
| `SplitterShare`                           | `chia_wallet_sdk::types::puzzles` | A recipient in the payout scheme: puzzle hash and share                                |
| `SplitterArgs`, `SplitterSolution`        | `chia_wallet_sdk::types::puzzles` | The curried arguments and the solution                                                 |
| `SPLITTER_PUZZLE`, `SPLITTER_PUZZLE_HASH` | `chia_wallet_sdk::types::puzzles` | The compiled puzzle (from the CHIP's reference implementation) and its mod hash        |

`SplitterLayer::new(shares)` validates the scheme and returns `DriverError::InvalidSplitter` unless there
is at least one recipient, every share is nonzero, the puzzle hashes are unique, and the shares sum to at
most `u64::MAX`. The puzzle itself would accept some of these schemes, but its spends would always fail
(two recipients with the same puzzle hash and amount would create the same coin twice, for example), so
coins sent to them would be stuck.

The layer's puzzle hash, `splitter.tree_hash()`, is the address you send funds to, or the royalty puzzle
hash you mint NFTs with. The order of the recipients is part of the puzzle hash.

## Splitting XCH

The splitter's spend reissues the whole amount of the coin, so it can't pay a fee itself. Any fee comes
from another coin, which should assert `SplitterLayer::announcement_id(coin_id)` so that the fee is only
paid if the split happens in the same block.

`payouts(amount)` calculates what each recipient gets, using the same rounding as the puzzle, and
`inner_spend(ctx, amount)` builds the spend. For an XCH coin, the inner spend is the whole spend:

```rust
use chia_wallet_sdk::driver::SplitterLayer;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::SplitterShare;

#[test]
fn split_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let artist = sim.bls(0);
    let charity = sim.bls(0);

    // 80% to the artist and 20% to the charity.
    let splitter = SplitterLayer::new(vec![
        SplitterShare::new(artist.puzzle_hash, 80),
        SplitterShare::new(charity.puzzle_hash, 20),
    ])?;
    let splitter_puzzle_hash: Bytes32 = splitter.tree_hash().into();

    // Alice funds the splitter, and pays the fee for splitting it in the same transaction.
    let alice = sim.bls(1_004);
    let alice_p2 = StandardLayer::new(alice.pk);
    let coin = Coin::new(alice.coin.coin_id(), splitter_puzzle_hash, 1_003);

    let memos = ctx.hint(splitter_puzzle_hash)?;
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(splitter_puzzle_hash, 1_003, memos)
            .reserve_fee(1)
            .assert_coin_announcement(SplitterLayer::announcement_id(coin.coin_id())),
    )?;

    // Anyone can split the coin, since no signature is needed.
    let spend = splitter.inner_spend(ctx, coin.amount)?;
    ctx.spend(coin, spend)?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // 1003 * 80 / 100 = 802 (rounded down), and the last recipient gets the remaining 201.
    let payouts = splitter.payouts(coin.amount);
    assert_eq!(payouts[0].amount, 802);
    assert_eq!(payouts[1].amount, 201);

    for payout in payouts {
        let child = Coin::new(coin.coin_id(), payout.puzzle_hash, payout.amount);
        assert!(sim.coin_state(child.coin_id()).is_some());
        assert_eq!(sim.hinted_coins(payout.puzzle_hash), [child.coin_id()]);
    }

    Ok(())
}
```

## Splitting a CAT

To split a CAT, use the splitter as the CAT's inner puzzle. Pass the inner spend to
[`Cat::spend_all`](/sdk/primitives/cat), which wraps it in the CAT layer. The children are CATs of the
same asset with the recipients' puzzle hashes as their p2 puzzle hashes:

```rust
use chia_wallet_sdk::driver::SplitterLayer;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::SplitterShare;

#[test]
fn split_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let bob = sim.bls(0);
    let carol = sim.bls(0);
    let dave = sim.bls(0);

    let splitter = SplitterLayer::new(vec![
        SplitterShare::new(bob.puzzle_hash, 1),
        SplitterShare::new(carol.puzzle_hash, 1),
        SplitterShare::new(dave.puzzle_hash, 1),
    ])?;
    let splitter_puzzle_hash: Bytes32 = splitter.tree_hash().into();

    // Issue a CAT straight to the splitter's puzzle hash.
    let alice = sim.bls(100);
    let alice_p2 = StandardLayer::new(alice.pk);
    let memos = ctx.hint(splitter_puzzle_hash)?;
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        100,
        Conditions::new().create_coin(splitter_puzzle_hash, 100, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Split the CAT coin.
    let spend = splitter.inner_spend(ctx, cats[0].coin.amount)?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(cats[0], spend)])?;
    sim.spend_coins(ctx.take(), &[])?;

    let amounts: Vec<u64> = children.iter().map(|cat| cat.coin.amount).collect();
    assert_eq!(amounts, [33, 33, 34]);
    assert_eq!(children[2].info.p2_puzzle_hash, dave.puzzle_hash);

    for child in children {
        assert!(sim.coin_state(child.coin.coin_id()).is_some());
    }

    Ok(())
}
```

## Parsing a splitter

`SplitterLayer` implements `Layer`, so `SplitterLayer::parse_puzzle` recognizes the puzzle in a coin
spend's puzzle reveal (or inside a CAT's inner puzzle) and recovers the scheme. It returns `Ok(None)` for
other puzzles, and `DriverError::InvalidSplitter` if the scheme is one `SplitterLayer::new` would reject,
or if it doesn't serialize back to the same puzzle hash (for example, a share encoded as a non-canonical
integer, or extra values after a share, which the puzzle ignores but are part of the puzzle hash):

```rust
use chia_wallet_sdk::driver::SplitterLayer;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::SplitterShare;

#[test]
fn parse_splitter() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let splitter = SplitterLayer::new(vec![
        SplitterShare::new(Bytes32::new([1; 32]), 3),
        SplitterShare::new(Bytes32::new([2; 32]), 7),
    ])?;

    let coin = sim.new_coin(splitter.tree_hash().into(), 1_000);
    let spend = splitter.inner_spend(ctx, coin.amount)?;
    ctx.spend(coin, spend)?;
    sim.spend_coins(ctx.take(), &[])?;

    // Later, from the confirmed coin spend alone.
    let coin_spend = sim.coin_spend(coin.coin_id()).expect("splitter spend");
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);

    let parsed = SplitterLayer::parse_puzzle(ctx, puzzle)?.expect("a splitter");
    assert_eq!(parsed, splitter);
    assert_eq!(parsed.total_shares(), 10);

    Ok(())
}
```

## Gotchas

- **Keep the payout scheme.** A splitter coin can only be spent by revealing its puzzle, and the scheme
  can't be recovered from the puzzle hash. Until a coin with that puzzle hash has been spent once (so
  its reveal is on chain), whoever wants to trigger splits needs the scheme from somewhere else.
- **Recipient count is limited by cost.** `SplitterLayer::new` doesn't cap the number of recipients, but
  a spend with more than roughly 2,300 to 2,400 recipients exceeds the mempool's cost limit for a single
  transaction (fewer for CATs and for large amounts, and fewer still if the transaction also pays a
  fee).
- **Small amounts round to zero.** Every recipient except the last is paid a rounded-down amount, so a
  coin smaller than the total shares can give recipients nothing (a 1 mojo coin split 50/50 pays 0 and 1).
  The full amount always goes somewhere.
- **The recipients are puzzle hashes.** A recipient can be another splitter, a vault, or any other
  puzzle. For CATs and other wrapped assets, the recipient's puzzle hash is the child's inner (p2)
  puzzle hash.
