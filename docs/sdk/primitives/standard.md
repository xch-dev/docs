---
title: Standard (XCH)
---

# Standard (XCH)

Almost every XCH coin on the Chia blockchain is locked by the standard transaction puzzle,
`p2_delegated_puzzle_or_hidden_puzzle`. The SDK drives it with `StandardLayer`. You use it directly
whenever you spend XCH, and indirectly whenever a CAT, NFT, DID or other asset is owned by a normal
wallet address, because the standard puzzle is then the asset's inner ("p2") puzzle.

Unlike the other primitives on these pages, standard coins have no outer layer, lineage or on-chain
state beyond the coin itself, so there is no separate `Xch` type. A plain `Coin` plus the public key that
owns it is all you need.

:::tip
For ordinary payments with change and fees, the [Action System](/sdk/action-system) can create change,
balance amounts and produce the spends for you (`Action::send`, `Action::fee`). This page covers the
underlying primitive, which is what you need for custom flows or when you want full control.
:::

## How the standard puzzle works

The puzzle is curried with a single argument, the owner's **synthetic public key**. To spend the coin
you provide a delegated puzzle and its solution. The puzzle runs the delegated puzzle, returns its
conditions, and adds an `AGG_SIG_ME` condition requiring a signature from the synthetic key over the
delegated puzzle's tree hash. So whoever holds the key decides what the coin does, and the signature
commits to exactly those conditions.

The synthetic key is derived from the wallet key and a hidden puzzle hash. Wallets use the default
hidden puzzle, which can't be spent, so in practice a standard coin can only be spent by signing. See
[Keys & Signing](/sdk/concepts/signing) for key derivation, synthetic keys and how signatures are
collected.

`StandardLayer` implements three traits:

| Trait                 | What it gives you                                                                 |
| --------------------- | --------------------------------------------------------------------------------- |
| `Layer`               | `construct_puzzle`, `construct_spend`, `parse_puzzle` and `parse_solution`        |
| `SpendWithConditions` | `spend_with_conditions`, which quotes a `Conditions` list as the delegated puzzle |
| `ToTreeHash`          | the puzzle hash of the curried puzzle, which is the address of the key            |

The `SpendWithConditions` impl is what lets a `StandardLayer` be passed as the `inner` argument of
methods like `Nft::transfer` or `Did::update` on the other primitive pages.

## Sending XCH

`StandardLayer::spend` builds the coin spend for a list of conditions and adds it to the
[SpendContext](/sdk/concepts/spend-context). The outputs must add up to the input amount, minus
whatever is left over as the fee (`reserve_fee` asserts that the leftover is at least that amount).

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn send_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = sim.bls(0);

    let alice_p2 = StandardLayer::new(alice.pk);

    // Hint the outputs with the recipient's puzzle hash so wallets can find them.
    let bob_memos = ctx.hint(bob.puzzle_hash)?;
    let change_memos = ctx.hint(alice.puzzle_hash)?;

    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 600, bob_memos)
            .create_coin(alice.puzzle_hash, 350, change_memos)
            .reserve_fee(50),
    )?;

    // The simulator signs with the given keys and validates the spend bundle.
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // The child coin can be computed without looking anything up.
    let bob_coin = Coin::new(alice.coin.coin_id(), bob.puzzle_hash, 600);
    assert!(sim.coin_state(bob_coin.coin_id()).is_some());

    Ok(())
}
```

A coin's ID is `sha256(parent_coin_id + puzzle_hash + amount)`, so the child is fully determined by the
`CREATE_COIN` condition and the parent. Two `CREATE_COIN` conditions with the same puzzle hash and
amount in the same spend would produce the same coin ID, which isn't allowed.

## Spending several coins together

When a transaction spends more than one coin, each spend's conditions are independent. Link them with
`assert_concurrent_spend` (or announcements) so each spend is only valid if the others are included in
the same block. This guarantees the transaction is all-or-nothing at the puzzle level.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn spend_two_coins() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(500);
    let alice_p2 = StandardLayer::new(alice.pk);

    // A second coin owned by the same key.
    let second = sim.new_coin(alice.puzzle_hash, 300);

    let bob = sim.bls(0);
    let memos = ctx.hint(bob.puzzle_hash)?;

    // The first coin creates the whole output...
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 800, memos)
            .assert_concurrent_spend(second.coin_id()),
    )?;

    // ...and the second coin contributes its value without creating any coins.
    alice_p2.spend(
        ctx,
        second,
        Conditions::new().assert_concurrent_spend(alice.coin.coin_id()),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

Conservation is checked across the whole spend bundle, not per coin, which is why the second coin can
have no outputs at all.

## Using the standard puzzle as an inner puzzle

Other primitives take the p2 spend as a `Spend` (a puzzle and solution pair) rather than spending a
coin directly. `spend_with_conditions` returns that `Spend` without adding anything to the context:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn inner_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    // A Spend that can be wrapped by the CAT, NFT or DID layers.
    let inner: Spend = alice_p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(alice.puzzle_hash, 1, Memos::None),
    )?;

    // The puzzle hash of the inner puzzle is the owner's address.
    assert_eq!(ctx.tree_hash(inner.puzzle), alice_p2.tree_hash());

    // Spending it directly is equivalent to `alice_p2.spend(...)`.
    ctx.spend(alice.coin, inner)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

If the delegated puzzle is something other than a quoted list of conditions, use
`delegated_inner_spend`, which takes an arbitrary delegated puzzle and solution as a `Spend`.
`SpendContext::delegated_spend` builds such a quoted-conditions `Spend` on its own, which is useful when
you need a delegated puzzle but not the standard puzzle around it.

## Puzzle hashes and addresses

The puzzle hash of a standard coin depends only on the synthetic key. You can compute it with
`StandardLayer::tree_hash` or `StandardArgs::curry_tree_hash`, and encode it as an `xch1...` address with
`Address` (see [Utilities](/sdk/utilities)).

```rust
use chia_wallet_sdk::chia::puzzle_types::{DeriveSynthetic, standard::StandardArgs};
use chia_wallet_sdk::prelude::*;

#[test]
fn puzzle_hash_and_address() -> anyhow::Result<()> {
    let sk = SecretKey::from_seed(&[1; 32]);

    // Wallets use the synthetic key with the default hidden puzzle.
    let synthetic_pk = sk.public_key().derive_synthetic();

    let puzzle_hash: Bytes32 = StandardLayer::new(synthetic_pk).tree_hash().into();
    assert_eq!(puzzle_hash, StandardArgs::curry_tree_hash(synthetic_pk).into());

    let address = Address::new(puzzle_hash, "xch".to_string()).encode()?;
    assert!(address.starts_with("xch1"));

    Ok(())
}
```

:::note
The `Simulator`'s `bls` key pairs use the public key directly as the curried key, without synthetic
derivation. That's fine for tests, but a real wallet's addresses come from synthetic keys derived from
hardened or unhardened child keys of the master key.
:::

## Parsing a standard spend

To find out what a standard coin spend did, parse the puzzle with `StandardLayer::parse_puzzle` and run
it to get the output conditions:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn parse_standard_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 1, Memos::None),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Look up the spend (from the simulator here, or a full node in practice).
    let coin_spend = sim.coin_spend(alice.coin.coin_id()).unwrap();
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let solution = ctx.alloc(&coin_spend.solution)?;

    let layer = StandardLayer::parse_puzzle(ctx, Puzzle::parse(ctx, puzzle))?
        .expect("not a standard puzzle");
    assert_eq!(layer.synthetic_key, alice.pk);

    let output = ctx.run(puzzle, solution)?;
    let conditions: Vec<Condition> = ctx.extract(output)?;
    let create_coins: Vec<_> = conditions
        .into_iter()
        .filter_map(Condition::into_create_coin)
        .collect();
    assert_eq!(create_coins.len(), 1);

    Ok(())
}
```

## Gotchas

- `StandardLayer::new` takes the **synthetic** key, not the wallet's master or child key. Passing the
  wrong key gives you a different puzzle hash, so the coin won't match and the spend fails.
- Remember to `reserve_fee` (or simply leave value unclaimed) for the fee. Any value you don't create as
  outputs goes to the farmer, so double check change outputs.
- Hints are memos, not part of the puzzle hash. An unhinted coin is still spendable, but wallets that
  sync by hint won't see it. Use `ctx.hint(puzzle_hash)` for the recipient's puzzle hash.
- Everything in the delegated puzzle is covered by the signature, so once signed the conditions can't be
  changed. Build the full set of conditions before signing.

See the [`StandardLayer` rustdoc](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/) for
the full API.
