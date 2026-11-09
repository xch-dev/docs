---
title: CAT
---

# CAT

CATs (Chia Asset Tokens) are fungible tokens. A CAT coin is an ordinary coin whose puzzle is the CAT
outer puzzle wrapped around an inner ("p2") puzzle, usually the [standard puzzle](/sdk/primitives/standard)
of the owner. The outer puzzle guarantees that the total amount of a CAT can only change when its
**TAIL** (Token and Asset Issuance Limitations) program allows it. The tree hash of the TAIL is the
CAT's **asset ID**.

The SDK represents a spendable CAT coin with the `Cat` primitive. This page covers issuing CATs,
spending one or many CAT coins, lineage, parsing CATs from the blockchain, melting, and revocable CATs.
For background on the puzzle itself see [CATs on chialisp.com](https://chialisp.com/cats).

:::tip
The [Action System](/sdk/action-system) handles CAT issuance, sends, change, melting and fees with
`Action::single_issue_cat`, `Action::issue_cat`, `Action::send`, `Action::run_tail` and `Action::burn`,
including multi-asset transactions. Use it unless you need the control the low-level API on this page
gives you.
:::

## The `Cat` type

```rust ignore
pub struct Cat {
    pub coin: Coin,
    pub lineage_proof: Option<LineageProof>,
    pub info: CatInfo,
}

pub struct CatInfo {
    pub asset_id: Bytes32,
    pub hidden_puzzle_hash: Option<Bytes32>, // Some for revocable CATs
    pub p2_puzzle_hash: Bytes32,             // the owner's puzzle hash
}
```

- `info` is everything needed to construct the outer puzzle. `CatInfo::puzzle_hash` computes the full
  puzzle hash, which must equal `coin.puzzle_hash`.
- `lineage_proof` proves that the coin's parent was also a CAT of the same asset ID. It is only `None`
  for an "eve" coin whose spend runs the TAIL.
- The p2 puzzle itself is not stored. You provide its spend each time you spend the CAT, so any p2
  puzzle (standard, vault, clawback, custom) works.

A `Cat` together with knowledge of how to spend its `p2_puzzle_hash` is everything you need to store in
a database to spend the coin later.

## Issuing a CAT

Issuance happens in two steps in the same transaction: a parent coin creates an **eve** CAT coin, and
the eve coin is spent immediately with a `RUN_CAT_TAIL` condition that reveals the TAIL. The issue
helpers do both. They add the eve spend to the context, and return the conditions the parent must output
plus the resulting CAT coins.

The eve coin's outputs are the `extra_conditions` you pass in. They must create exactly `amount` worth of
coins (the TAIL is checked against the delta), and those coins become the issued CATs.

### Single issuance

`Cat::single_issuance` uses the `genesis_by_coin_id` TAIL, curried with the ID of the parent coin. Since a
coin can only be spent once, the supply is fixed forever after this transaction.

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::GenesisByCoinIdTailArgs;
use chia_wallet_sdk::prelude::*;

#[test]
fn single_issuance() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let alice_p2 = StandardLayer::new(alice.pk);

    let memos = ctx.hint(alice.puzzle_hash)?;
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None, // not revocable
        1_000,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, memos),
    )?;

    // The parent (genesis) coin creates the eve CAT.
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let cat = cats[0];
    assert_eq!(
        cat.info.asset_id,
        GenesisByCoinIdTailArgs::curry_tree_hash(alice.coin.coin_id()).into()
    );
    assert_eq!(cat.info.p2_puzzle_hash, alice.puzzle_hash);
    assert!(sim.coin_state(cat.coin.coin_id()).is_some());

    Ok(())
}
```

You can split the supply among several outputs, or send it straight to other people, by adding more
`create_coin` conditions to `extra_conditions`.

### Multi issuance

`Cat::multi_issuance` uses the `everything_with_signature` TAIL, curried with a public key. The TAIL
allows any supply change that is signed by that key, so the issuer can mint more later (or melt) and the
asset ID stays the same because it only depends on the key.

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::EverythingWithSignatureTailArgs;
use chia_wallet_sdk::prelude::*;

#[test]
fn multi_issuance() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(100);
    let alice_p2 = StandardLayer::new(alice.pk);
    let memos = ctx.hint(alice.puzzle_hash)?;

    let (issue_cat, first) = Cat::multi_issuance(
        ctx,
        alice.coin.coin_id(),
        alice.pk,
        None,
        100,
        Conditions::new().create_coin(alice.puzzle_hash, 100, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Later, issue more of the same asset from a different XCH coin.
    let coin = sim.new_coin(alice.puzzle_hash, 50);
    let (issue_cat, second) = Cat::multi_issuance(
        ctx,
        coin.coin_id(),
        alice.pk,
        None,
        50,
        Conditions::new().create_coin(alice.puzzle_hash, 50, memos),
    )?;
    alice_p2.spend(ctx, coin, issue_cat)?;
    // The TAIL requires a signature from `alice.pk`, provided here by the simulator.
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let asset_id: Bytes32 = EverythingWithSignatureTailArgs::curry_tree_hash(alice.pk).into();
    assert_eq!(first[0].info.asset_id, asset_id);
    assert_eq!(second[0].info.asset_id, asset_id);

    Ok(())
}
```

### Custom TAILs

Both helpers are thin wrappers around `Cat::issue`, which takes a `RunCatTail` condition with any TAIL
program and solution. The asset ID is the tree hash of the program you pass:

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::EverythingWithSignatureTailArgs;
use chia_wallet_sdk::prelude::*;

#[test]
fn issue_with_custom_tail() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    // Any curried TAIL works here. This one is equivalent to `multi_issuance`.
    let tail = ctx.curry(EverythingWithSignatureTailArgs::new(alice.pk))?;
    let asset_id: Bytes32 = ctx.tree_hash(tail).into();

    let memos = ctx.hint(alice.puzzle_hash)?;
    let (issue_cat, cats) = Cat::issue(
        ctx,
        alice.coin.coin_id(),
        None,
        1,
        RunCatTail::new(tail, NodePtr::NIL), // TAIL program and its solution
        Conditions::new().create_coin(alice.puzzle_hash, 1, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(cats[0].info.asset_id, asset_id);

    Ok(())
}
```

If you write your own TAIL in Chialisp or Rue, compile it with `compile_chialisp` or `compile_rue` (see
[CLVM Values](/sdk/concepts/clvm)) and pass the resulting program. The TAIL decides when the supply may
change; the SDK doesn't validate that ahead of time, so test issuance and melting with the
[Simulator](/sdk/testing).

## Spending CATs

A CAT spend wraps a p2 spend. Build the p2 spend (for the standard puzzle, with
`StandardLayer::spend_with_conditions`), pair it with the `Cat` in a `CatSpend`, and pass every
`CatSpend` of that asset to `Cat::spend_all`:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn send_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let alice_memos = ctx.hint(alice.puzzle_hash)?;
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        1_000,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, alice_memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Send 250 to Bob and keep 750 as change. The p2 conditions use the
    // recipient's p2 puzzle hash; the CAT layer wraps the outputs for you.
    let bob_memos = ctx.hint(bob.puzzle_hash)?;
    let p2_spend = alice_p2.spend_with_conditions(
        ctx,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 250, bob_memos)
            .create_coin(alice.puzzle_hash, 750, alice_memos),
    )?;

    let children = Cat::spend_all(ctx, &[CatSpend::new(cats[0], p2_spend)])?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // `spend_all` returns the child CATs, ready to be spent again.
    assert_eq!(children[0].info.p2_puzzle_hash, bob.puzzle_hash);
    assert_eq!(children[0].coin.amount, 250);
    assert_eq!(children[1].info.p2_puzzle_hash, alice.puzzle_hash);

    Ok(())
}
```

Inside a CAT, `CREATE_COIN` conditions refer to the **inner** puzzle hash. The CAT layer rewrites each
one to the full CAT puzzle hash of the same asset, so you send to Bob's normal address. Hint outputs with
the p2 puzzle hash so Bob's wallet can find them.

### Spending many CAT coins at once

All CAT coins of the same asset in a transaction must be spent together in a single `spend_all` call.
The CAT puzzle links them in a ring of announcements and checks that the sum of inputs equals the sum of
outputs across the ring (unless the TAIL runs). That means one coin can create outputs worth more than
itself as long as another coin in the ring makes up the difference. `spend_all` calculates the ring,
subtotals and proofs, so you only describe the outputs.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn combine_cats_and_pay_fee() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(300);
    let alice_p2 = StandardLayer::new(alice.pk);
    let memos = ctx.hint(alice.puzzle_hash)?;

    // Issue three separate CAT coins.
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        300,
        Conditions::new()
            .create_coin(alice.puzzle_hash, 100, memos)
            .create_coin(alice.puzzle_hash, 150, memos)
            .create_coin(alice.puzzle_hash, 50, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // An XCH coin to pay the transaction fee.
    let fee_coin = sim.new_coin(alice.puzzle_hash, 10);

    // The first coin creates a single combined output, the rest create nothing.
    let mut cat_spends = Vec::new();
    for (i, &cat) in cats.iter().enumerate() {
        let mut conditions = Conditions::new();
        if i == 0 {
            conditions = conditions
                .create_coin(alice.puzzle_hash, 300, memos)
                .assert_concurrent_spend(fee_coin.coin_id());
        }
        cat_spends.push(CatSpend::new(cat, alice_p2.spend_with_conditions(ctx, conditions)?));
    }
    let children = Cat::spend_all(ctx, &cat_spends)?;

    // XCH and CAT spends are separate rings, so link them explicitly.
    alice_p2.spend(
        ctx,
        fee_coin,
        Conditions::new()
            .reserve_fee(10)
            .assert_concurrent_spend(cats[0].coin.coin_id()),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(children.len(), 1);
    assert_eq!(children[0].coin.amount, 300);

    Ok(())
}
```

Fees are always paid in XCH, so a CAT transaction that pays a fee also spends at least one XCH coin.

`CatSpend` doesn't care what the p2 puzzle is. You can mix coins owned by the standard puzzle, vaults or
custom puzzles in the same ring, as long as you provide a valid `Spend` for each.

### Lower-level spending

`Cat::spend` spends a single coin with an explicit `SingleCatSpend` (previous coin ID, next coin proof,
subtotal and extra delta). You rarely need it; `spend_all` calls it for each coin after computing the
ring. If you want to inspect or build the outer layers yourself, `CatInfo::construct_puzzle` and the
`CatLayer` / `RevocationLayer` types are described in [Layers & Puzzles](/sdk/concepts/layers).

## Lineage proofs

The CAT puzzle needs to know that its parent was a CAT of the same asset ID, otherwise anyone could
create a coin with the CAT puzzle hash out of thin air. The `LineageProof` contains the parent's parent
coin ID, the parent's **inner** puzzle hash and the parent's amount, from which the puzzle recomputes the
parent coin ID and checks it against its own parent.

You can compute lineage without looking anything up when you know the parent `Cat`:

- `Cat::child_lineage_proof` returns the proof for any child of a CAT.
- `Cat::child(p2_puzzle_hash, amount)` returns the full child `Cat` (same asset and revocation layer).
- `Cat::spend_all` returns the children it creates, with lineage filled in.

For coins you receive from someone else, you have to look at the parent spend instead.

## Parsing CATs from the blockchain

When your wallet sees a hinted coin (for example from a peer's puzzle hash subscription), you only have
the `Coin`. To spend it you need its `CatInfo` and lineage proof, which come from the parent coin's spend.
Fetch the parent's puzzle reveal and solution, then call `Cat::parse_children`, which runs the parent's p2
spend and returns every CAT child it created. Pick the one that matches your coin:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn parse_received_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(10);
    let alice_p2 = StandardLayer::new(alice.pk);
    let bob = sim.bls(0);

    let memos = ctx.hint(bob.puzzle_hash)?;
    let (issue_cat, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        10,
        Conditions::new().create_coin(bob.puzzle_hash, 10, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob only knows the coin (e.g. from `sim.hinted_coins` or a peer subscription).
    let coin = sim.coin_state(cats[0].coin.coin_id()).unwrap().coin;

    // Look up the parent spend. With a real node, use the peer or RPC client.
    let parent_spend = sim.coin_spend(coin.parent_coin_info).unwrap();
    let parent_puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let parent_puzzle = Puzzle::parse(ctx, parent_puzzle);
    let parent_solution = ctx.alloc(&parent_spend.solution)?;

    let children = Cat::parse_children(ctx, parent_spend.coin, parent_puzzle, parent_solution)?
        .expect("parent is not a CAT");
    let cat = children
        .into_iter()
        .find(|child| child.coin == coin)
        .expect("coin not found among the children");

    assert_eq!(cat, cats[0]);

    // Bob can now spend it.
    let bob_p2 = StandardLayer::new(bob.pk);
    let p2_spend = bob_p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(bob.puzzle_hash, 10, memos),
    )?;
    Cat::spend_all(ctx, &[CatSpend::new(cat, p2_spend)])?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    Ok(())
}
```

`parse_children` returns `Ok(None)` if the parent isn't a CAT, and an error if it looks like a CAT but
is malformed. Always compare the parsed child with the coin you actually have: parsing returns every
child of the parent, and it trusts the parent's outputs, not the hint.

Related parsing functions:

| Function              | Input                                | Output                                                                                                    |
| --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `Cat::parse_children` | parent coin, puzzle and solution     | every child `Cat` created by the parent spend                                                             |
| `Cat::parse`          | a CAT coin's own puzzle and solution | `ParsedCat`: the `Cat`, its p2 puzzle and solution, and whether it was revoked                            |
| `CatInfo::parse`      | a puzzle only                        | `CatInfo` and the p2 puzzle (`None` for revocable CATs, whose p2 puzzle is only revealed in the solution) |

See [Peer Protocol](/sdk/networking/peer) and [RPC Clients](/sdk/networking/rpc) for fetching coin spends
from a real node, and the [Primitives overview](/sdk/primitives) for the general pattern.

## Melting

Melting removes CAT supply by making the outputs of the ring less than its inputs. That's only allowed
when one of the spends reveals the TAIL with `RUN_CAT_TAIL` and the TAIL approves the negative delta.
With the `everything_with_signature` TAIL, the issuer's signature is enough:

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::EverythingWithSignatureTailArgs;
use chia_wallet_sdk::prelude::*;

#[test]
fn melt_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(10_000);
    let alice_p2 = StandardLayer::new(alice.pk);
    let memos = ctx.hint(alice.puzzle_hash)?;

    let (issue_cat, cats) = Cat::multi_issuance(
        ctx,
        alice.coin.coin_id(),
        alice.pk,
        None,
        10_000,
        Conditions::new().create_coin(alice.puzzle_hash, 10_000, memos),
    )?;
    alice_p2.spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Keep 7,000 and melt 3,000 by revealing the TAIL.
    let tail = ctx.curry(EverythingWithSignatureTailArgs::new(alice.pk))?;
    let p2_spend = alice_p2.spend_with_conditions(
        ctx,
        Conditions::new()
            .create_coin(alice.puzzle_hash, 7_000, memos)
            .run_cat_tail(tail, NodePtr::NIL),
    )?;
    let children = Cat::spend_all(ctx, &[CatSpend::new(cats[0], p2_spend)])?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(children[0].coin.amount, 7_000);

    Ok(())
}
```

The same mechanism with a positive delta issues more supply from existing CAT coins. `spend_all` puts
the required `extra_delta` on whichever spend in the ring outputs `RUN_CAT_TAIL`, so the TAIL can be
revealed by any coin. The melted mojos stay in the transaction as XCH value: they can go to the fee, or
an XCH spend in the same bundle can output more than its input to reclaim them. A `genesis_by_coin_id`
CAT can never be melted, because its TAIL only allows the genesis spend.

## Revocable CATs

A revocable CAT has a `RevocationLayer` between the CAT layer and the p2 puzzle. It is curried with a
**hidden puzzle hash** chosen by the issuer. Each spend either runs the owner's p2 puzzle as usual, or
reveals the hidden puzzle instead, which lets the issuer take back (revoke) the coins. The asset ID still
comes from the TAIL, so a revocable CAT is identified by its asset ID plus `hidden_puzzle_hash`.

Pass `Some(hidden_puzzle_hash)` to any issuance function to make the issued coins revocable. Normal spends
keep the revocation layer: outputs of a non-revoking spend are wrapped in the same layer automatically,
so `Cat::child` and `spend_all` preserve it.

To revoke, use `CatSpend::revoke` with a spend of the hidden puzzle (here the issuer's standard puzzle).
In a revocation spend, outputs are **not** wrapped automatically. A plain output becomes an ordinary,
non-revocable CAT. To keep an output revocable, create it at the revocation-wrapped puzzle hash and hint
it with the p2 puzzle hash; the parsing code uses that hint to recognize it.

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::EverythingWithSignatureTailArgs;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::RevocationArgs;

#[test]
fn revocable_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let issuer = sim.bls(10);
    let issuer_p2 = StandardLayer::new(issuer.pk);
    let bob = sim.bls(0);
    let bob_p2 = StandardLayer::new(bob.pk);

    // The issuer's own puzzle hash is the hidden puzzle hash.
    let bob_memos = ctx.hint(bob.puzzle_hash)?;
    let (issue_cat, cats) = Cat::multi_issuance(
        ctx,
        issuer.coin.coin_id(),
        issuer.pk,
        Some(issuer.puzzle_hash),
        10,
        Conditions::new().create_coin(bob.puzzle_hash, 10, bob_memos),
    )?;
    issuer_p2.spend(ctx, issuer.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[issuer.sk.clone()])?;
    assert_eq!(cats[0].info.hidden_puzzle_hash, Some(issuer.puzzle_hash));

    // Bob spends normally. The child stays revocable.
    let p2_spend = bob_p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(bob.puzzle_hash, 10, bob_memos),
    )?;
    let cats = Cat::spend_all(ctx, &[CatSpend::new(cats[0], p2_spend)])?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;
    assert_eq!(cats[0].info.hidden_puzzle_hash, Some(issuer.puzzle_hash));

    // The issuer revokes: 5 become a plain CAT, 5 stay revocable.
    let issuer_memos = ctx.hint(issuer.puzzle_hash)?;
    let revocable_puzzle_hash: Bytes32 =
        RevocationArgs::new(issuer.puzzle_hash, issuer.puzzle_hash)
            .curry_tree_hash()
            .into();

    let hidden_spend = issuer_p2.spend_with_conditions(
        ctx,
        Conditions::new()
            .create_coin(issuer.puzzle_hash, 5, issuer_memos)
            .create_coin(revocable_puzzle_hash, 5, issuer_memos),
    )?;
    let revoked = Cat::spend_all(ctx, &[CatSpend::revoke(cats[0], hidden_spend)])?;
    sim.spend_coins(ctx.take(), &[issuer.sk])?;

    assert_eq!(revoked[0].info.hidden_puzzle_hash, None);
    assert_eq!(revoked[1].info.hidden_puzzle_hash, Some(issuer.puzzle_hash));
    assert_eq!(revoked[1].info.p2_puzzle_hash, issuer.puzzle_hash);

    Ok(())
}
```

`Cat::unrevocable_child` and `Cat::child_with` let you construct children with a different revocation
setting when you build outputs by hand. When parsing, `Cat::parse_children` applies the same rules, and
`ParsedCat::revoked` tells you whether a spend was a revocation.

:::warning
For revocable CATs the p2 puzzle hash is **not** the inner puzzle hash of the CAT layer, because the
revocation layer sits in between. Use `CatInfo::inner_puzzle_hash` (not `p2_puzzle_hash`) whenever you
need the hash the CAT layer sees, for example in lineage proofs. The `Cat` methods already do this.
:::

## Gotchas

- Never call `spend_all` twice for the same asset in one transaction. Each call forms a separate ring
  that must balance on its own, so value can't move between the two groups.
- Spend different asset IDs in separate `spend_all` calls; they can't share a ring.
- Every output inside a CAT spend becomes a CAT of the same asset. To pay a fee or send XCH, spend an XCH
  coin in the same bundle and link it (for example with `assert_concurrent_spend`).
- The issuance outputs must sum to exactly the issued amount. Too much or too little makes the TAIL fail
  with a `clvm raise` error.
- The eve coin used during issuance has no hint and is spent immediately, so you don't need to track it.

See the [`Cat` rustdoc](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/) for the complete
API, and [Offers](/sdk/offers) for trading CATs.
