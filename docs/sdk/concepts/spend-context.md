---
title: SpendContext
---

# SpendContext

`SpendContext` is the workspace every transaction is built in. Almost every function in the driver crate
takes a `&mut SpendContext`, because building a spend means allocating CLVM values, and the context is
where those values live. It does three things:

1. **Owns the CLVM memory.** It wraps a `clvmr::Allocator`, and puzzles, solutions and conditions are
   allocated in it as `NodePtr` handles. See [CLVM Values](/sdk/concepts/clvm) for how values get in
   and out.
2. **Caches puzzles.** The standard puzzles (the CAT layer, the singleton top layer, the NFT layers and so
   on) are deserialized once per context and reused, no matter how many coins use them.
3. **Collects coin spends.** Spending a coin with a primitive adds a `CoinSpend` to the context. When
   you're done, you take them out and sign them into a `SpendBundle`.

## Creating a context

```rust
use chia_wallet_sdk::prelude::*;

fn build() -> Result<Vec<CoinSpend>, DriverError> {
    let ctx = &mut SpendContext::new();

    // ... spend coins ...

    Ok(ctx.take())
}
```

Most code binds `ctx` as a `&mut SpendContext` up front, as above, so it can be passed straight to
functions that take `&mut SpendContext` without writing `&mut ctx` everywhere. The examples on these
pages do the same.

`SpendContext` dereferences to `Allocator`, so you can pass it anywhere the lower-level crates expect an
`&Allocator` or `&mut Allocator`, such as `ToClvm::to_clvm`, `FromClvm::from_clvm`, or
`RequiredSignature::from_coin_spends`. If you already have an `Allocator`, `SpendContext::from(allocator)`
wraps it.

## Spends

A `Spend` is a puzzle and a solution, both as `NodePtr`s in the context. It isn't tied to a coin yet, which
is what lets layers wrap each other: an inner puzzle's spend becomes part of the outer puzzle's solution.
See [Layers & Puzzles](/sdk/concepts/layers) for how that composition works.

There are three ways a coin spend ends up in the context:

| Method                     | When to use it                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A primitive's spend method | Almost always. `StandardLayer::spend`, `Cat::spend_all`, `Nft::transfer` and friends build the full puzzle and solution and call `ctx.spend` for you.          |
| `ctx.spend(coin, spend)`   | You built a `Spend` yourself, for example with `Layer::construct_spend` or a custom puzzle. It serializes the puzzle and solution and records the `CoinSpend`. |
| `ctx.insert(coin_spend)`   | You already have a serialized `CoinSpend`, for example one you received from someone else or built outside the SDK.                                            |

`ctx.delegated_spend(conditions)` builds a `Spend` whose puzzle is the quoted conditions and whose
solution is nil. That's the "delegated puzzle" that the standard puzzle and many other p2 puzzles run, so
it's the usual way to say "this coin should output these conditions" when you're assembling an inner
spend by hand.

When you're done, get the coin spends back with:

- `ctx.take()`, which removes and returns them, leaving the context ready for another transaction.
- `ctx.iter()`, to inspect them without removing them.
- `for coin_spend in ctx` (`IntoIterator`), to consume the context.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn build_two_coin_spends() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let alice = sim.bls(1_000);
    let coin = sim.new_coin(alice.puzzle_hash, 500);

    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(alice.pk);

    // A primitive adds the coin spend for you.
    p2.spend(ctx, alice.coin, Conditions::new().reserve_fee(1_000))?;

    // Building the Spend yourself, then recording it for a coin.
    let delegated = ctx.delegated_spend(
        Conditions::new()
            .assert_concurrent_spend(alice.coin.coin_id())
            .reserve_fee(500),
    )?;
    let spend = p2.delegated_inner_spend(ctx, delegated)?;
    ctx.spend(coin, spend)?;

    assert_eq!(ctx.iter().count(), 2);

    let coin_spends = ctx.take();
    assert_eq!(ctx.iter().count(), 0);

    sim.spend_coins(coin_spends, &[alice.sk])?;

    Ok(())
}
```

## Allocating values

Anything that implements `ToClvm` can be allocated in the context, and anything that implements
`FromClvm` can be extracted back out. The SDK's argument, solution and condition types all implement both,
as do integers, byte types, keys, tuples, `Vec`s and `Option`s.

| Method                                        | Does                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `ctx.alloc(&value)`                           | Allocates a value and returns its `NodePtr`                        |
| `ctx.alloc_hashed(&value)`                    | Allocates and also computes the tree hash, returning a `HashedPtr` |
| `ctx.extract::<T>(ptr)`                       | Parses a `NodePtr` back into a Rust type                           |
| `ctx.tree_hash(ptr)`                          | Computes the tree hash (the "puzzle hash" if `ptr` is a puzzle)    |
| `ctx.serialize(&value)`                       | Allocates a value and serializes it to a `Program`                 |
| `ctx.serialize_with_backrefs(&value)`         | The same, using back references to compress repeated subtrees      |
| `ctx.run(puzzle, solution)`                   | Runs a puzzle with a solution and returns the output               |
| `ctx.memos(&value)` / `ctx.hint(puzzle_hash)` | Builds the memos argument of `create_coin`                         |

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn allocate_and_run() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();
    let puzzle_hash = Bytes32::new([1; 32]);

    // Build the conditions a coin should output, and quote them as a puzzle.
    let conditions = Conditions::new().create_coin(puzzle_hash, 100, Memos::None);
    let spend = ctx.delegated_spend(conditions)?;

    // Running the puzzle returns the conditions, which parse back into Rust types.
    let output = ctx.run(spend.puzzle, spend.solution)?;
    let parsed: Vec<Condition> = ctx.extract(output)?;
    assert_eq!(
        parsed[0].as_create_coin().map(|c| (c.puzzle_hash, c.amount)),
        Some((puzzle_hash, 100))
    );

    // The tree hash of a puzzle is its puzzle hash, and serializing it gives the puzzle reveal.
    let puzzle_hash = ctx.tree_hash(spend.puzzle);
    let puzzle_reveal = ctx.serialize(&spend.puzzle)?;
    let reparsed = ctx.alloc(&puzzle_reveal)?;
    assert_eq!(ctx.tree_hash(reparsed), puzzle_hash);

    Ok(())
}
```

### Memos and hints

`create_coin` takes a `Memos` argument: `Memos::None`, or `Memos::Some(ptr)` pointing at a list. The first
memo of a coin is its **hint**, which full nodes index so wallets can find coins sent to them even when
the coin's puzzle hash is wrapped (as with CATs and NFTs). `ctx.hint(puzzle_hash)` builds a memo list
containing just the hint, and `ctx.memos(&value)` allocates any list you like, for example a hint followed
by a message.

```rust
use chia_wallet_sdk::prelude::*;

fn memos(ctx: &mut SpendContext, recipient: Bytes32) -> Result<Conditions, DriverError> {
    let hint = ctx.hint(recipient)?;
    let hint_and_note = ctx.memos(&(recipient, ("thanks for lunch", ())))?;

    Ok(Conditions::new()
        .create_coin(recipient, 100, hint)
        .create_coin(recipient, 200, hint_and_note))
}
```

See [Conditions](/sdk/concepts/conditions#memos-and-hints) for more on what memos are used for.

## Puzzles and currying

Puzzles that the SDK knows about implement the `Mod` trait from `chia-sdk-types`, which ties an argument
type to the compiled puzzle and its hash. `ctx.curry(args)` looks up the puzzle from the argument type,
loads it into the context (once), and curries the arguments into it:

```rust
use chia_wallet_sdk::chia::puzzle_types::standard::StandardArgs;
use chia_wallet_sdk::prelude::*;

#[test]
fn curry_a_puzzle() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();
    let pk = BlsPair::new(0).pk;

    // Curry the standard puzzle with a public key.
    let puzzle = ctx.curry(StandardArgs::new(pk))?;

    // The puzzle hash can also be calculated without allocating anything.
    assert_eq!(ctx.tree_hash(puzzle), StandardArgs::curry_tree_hash(pk));

    // Currying again reuses the cached puzzle.
    let again = ctx.curry(StandardArgs::new(pk))?;
    assert_eq!(ctx.tree_hash(again), ctx.tree_hash(puzzle));

    Ok(())
}
```

For puzzles the SDK doesn't define, `ctx.puzzle(puzzle_hash, &bytes)` deserializes and caches any compiled
puzzle by its hash, and `ctx.alloc_mod::<T>()` loads a `Mod` without currying it. To curry arbitrary
arguments into a puzzle, allocate a `CurriedProgram { program, args }`. The
[CLVM Values](/sdk/concepts/clvm#currying) page covers these, and how to define your own `Mod`.

## Lifecycle and memory

A context only grows. Each allocation adds to the underlying `Allocator`, and nothing is freed until the
context is dropped. That's fine for building a transaction, which is short-lived, but it matters for
long-running programs:

- **One context per transaction** is the simplest model. Create it, build, `take()` the spends, drop it.
- **Reuse a context** across transactions if you want to keep the puzzle cache warm, for example when
  building many similar transactions in a loop. `take()` empties the spend list but keeps the memory.
- **Roll back** to an earlier state with a checkpoint. `ctx.checkpoint()` (from `Allocator`) records the
  allocator's size, and `ctx.reset(&checkpoint)` frees everything allocated after it, and also clears the
  puzzle cache and the collected spends. Use it to bound memory in a long-lived context, or to throw away
  a half-built transaction after an error.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn reuse_a_context() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let checkpoint = ctx.checkpoint();

    for amount in [100, 200, 300] {
        let alice = sim.bls(amount);
        StandardLayer::new(alice.pk).spend(ctx, alice.coin, Conditions::new().reserve_fee(amount))?;
        sim.spend_coins(ctx.take(), &[alice.sk])?;

        // Free everything this transaction allocated before building the next one.
        ctx.reset(&checkpoint);
    }

    Ok(())
}
```

:::warning
A `NodePtr` is only meaningful in the context that created it. Don't use pointers from one context in
another, and don't use pointers allocated after a checkpoint once you've reset to it. Store
`Program`s, `TreeHash`es or parsed Rust types (like `Cat` or `Nft`) instead if you need to keep data
around between transactions. Primitive types such as `Cat`, `Nft` and `Did` are built from plain data
(hashes and amounts), so they're safe to keep, except for generic parameters you've set to `NodePtr`
or `HashedPtr` (for example NFT metadata), which point into the context.
:::

## Spend bundles

The context doesn't sign anything. Once you've taken the coin spends, compute the required signatures and
aggregate them as described in [Keys & Signing](/sdk/concepts/signing), then pair them into a
`SpendBundle`. In tests, `Simulator::spend_coins` does this for you. To estimate a fee before
submitting, `chia_wallet_sdk::driver::spend_bundle_cost` computes the cost of the coin spends, as shown in
[Utilities](/sdk/utilities).
