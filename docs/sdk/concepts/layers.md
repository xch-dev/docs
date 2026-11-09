---
title: Layers & Puzzles
---

# Layers & Puzzles

Most Chia puzzles are built by wrapping one puzzle inside another. A CAT is the CAT puzzle wrapped around an inner puzzle that decides who owns it, usually the standard puzzle. An NFT is four puzzles deep: singleton, NFT state, NFT ownership (with a royalty transfer program curried in), and an owner puzzle. The SDK models each of these wrappers as a **layer**: a Rust type that knows how to build its puzzle and solution, and how to recognize itself in an existing puzzle.

Layers are the low-level building blocks underneath the [primitives](/sdk/primitives). Use them directly when you need a puzzle combination that no primitive covers, when you write your own puzzle, or when you want to inspect an arbitrary coin spend. For ordinary XCH, CAT and NFT transactions, the primitives and the [action system](/sdk/action-system) are simpler.

All of the types on this page are in `chia_wallet_sdk::driver`, and the most common ones are in the prelude.

## The Layer trait

```rust ignore
pub trait Layer {
    type Solution;

    fn parse_puzzle(allocator: &Allocator, puzzle: Puzzle) -> Result<Option<Self>, DriverError>
    where
        Self: Sized;
    fn parse_solution(allocator: &Allocator, solution: NodePtr) -> Result<Self::Solution, DriverError>;

    fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError>;
    fn construct_solution(&self, ctx: &mut SpendContext, solution: Self::Solution) -> Result<NodePtr, DriverError>;

    // Provided:
    fn construct_spend(&self, ctx: &mut SpendContext, solution: Self::Solution) -> Result<Spend, DriverError>;
    fn construct_coin_spend(&self, ctx: &mut SpendContext, coin: Coin, solution: Self::Solution) -> Result<CoinSpend, DriverError>;
}
```

- The layer value holds the puzzle's curried state, such as `StandardLayer { synthetic_key }` or `CatLayer { asset_id, inner_puzzle }`.
- `Solution` is the typed solution, usually a CLVM struct like `StandardSolution` or `CatSolution<I::Solution>`.
- `construct_puzzle` and `construct_solution` build the CLVM for a spend. Puzzle mods are cached in the [SpendContext](/sdk/concepts/spend-context), so building the same puzzle repeatedly is cheap.
- `parse_puzzle` returns `Ok(None)` if the puzzle isn't this layer, and an error only if it is this layer but is malformed. That makes it safe to try several layers in turn.
- `parse_solution` decodes a solution, for example from a coin spend you fetched from the chain.

Most layers also implement `ToTreeHash`, which computes the full puzzle hash without allocating, as long as the inner layer implements `ToTreeHash` too.

## Spend and SpendWithConditions

A `Spend` is a puzzle and solution pair of `NodePtr`s that hasn't been attached to a coin yet. `SpendContext::spend(coin, spend)` serializes it into a `CoinSpend` and adds it to the context. `construct_coin_spend` does both steps directly, without adding to the context.

The intermediate `Spend` exists because outer layers need the inner layer's puzzle and solution. Primitives like `Cat` and `Nft` take an inner `Spend` and wrap it.

`SpendWithConditions` is implemented by inner puzzles that can be spent by just outputting a list of [conditions](/sdk/concepts/conditions). `StandardLayer` implements it, and its `spend` helper uses it to spend a coin in one call:

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn standard_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let p2 = StandardLayer::new(alice.pk);

    // spend_with_conditions builds the inner Spend, which an outer layer could wrap...
    let spend = p2.spend_with_conditions(ctx, Conditions::new().reserve_fee(1))?;

    // ...or you can spend it as is.
    ctx.spend(alice.coin, spend)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

## Composing layers

Outer layers are generic over their inner layer. The type spells out the puzzle structure, and constructing it builds the whole puzzle:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::driver::CatLayer;
use chia_wallet_sdk::chia::puzzle_types::{cat::CatArgs, standard::StandardArgs};

#[test]
fn compose_cat_puzzle() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();
    let public_key = SecretKey::from_seed(&[1; 32]).public_key();
    let asset_id = Bytes32::new([2; 32]);

    let layer = CatLayer::new(asset_id, StandardLayer::new(public_key));

    // Build the full puzzle.
    let puzzle = layer.construct_puzzle(ctx)?;

    // The puzzle hash can be computed without allocating.
    let puzzle_hash = layer.tree_hash();
    assert_eq!(ctx.tree_hash(puzzle), puzzle_hash);

    // It's the same as currying the arguments by hand.
    let inner_puzzle_hash = StandardArgs::curry_tree_hash(public_key);
    assert_eq!(puzzle_hash, CatArgs::curry_tree_hash(asset_id, inner_puzzle_hash));

    Ok(())
}
```

## Parsing puzzles

`Puzzle` is the starting point for parsing. `Puzzle::parse(&allocator, ptr)` checks whether a puzzle is curried and splits it into its mod and arguments:

- `Puzzle::Curried(CurriedPuzzle)` has the `mod_hash`, the `args` pointer, and the full `curried_puzzle_hash`.
- `Puzzle::Raw(RawPuzzle)` is a puzzle that isn't curried, with its `puzzle_hash`.

`puzzle.mod_hash()` works for both, so you can compare it against known mod hashes from `Mod::mod_hash()` or `chia_wallet_sdk::puzzles`. Parsing a `Puzzle` is cheap: it computes tree hashes but doesn't run anything.

`Puzzle` also implements `Layer`. Using it as the inner type parses just the outer layer and leaves the inner puzzle opaque, so you can decide how to parse it next. This is how you identify a coin you know nothing about: try the outer layers you support, then look at what's inside.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::driver::CatLayer;

#[test]
fn parse_cat_puzzle() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();
    let public_key = SecretKey::from_seed(&[1; 32]).public_key();
    let asset_id = Bytes32::new([2; 32]);

    // Pretend this puzzle reveal came from a coin spend on chain.
    let puzzle_reveal: Program = {
        let ptr = CatLayer::new(asset_id, StandardLayer::new(public_key)).construct_puzzle(ctx)?;
        ctx.serialize(&ptr)?
    };

    let ptr = ctx.alloc(&puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, ptr);

    // It isn't a standard puzzle...
    assert!(StandardLayer::parse_puzzle(ctx, puzzle)?.is_none());

    // ...but it is a CAT. Parse only the outer layer and keep the inner puzzle opaque.
    let cat = CatLayer::<Puzzle>::parse_puzzle(ctx, puzzle)?.expect("not a CAT");
    assert_eq!(cat.asset_id, asset_id);

    // Now check what's inside.
    let p2 = StandardLayer::parse_puzzle(ctx, cat.inner_puzzle)?.expect("not a standard CAT");
    assert_eq!(p2.synthetic_key, public_key);

    // When you know the whole structure up front, parse it in one go.
    let full = CatLayer::<StandardLayer>::parse_puzzle(ctx, puzzle)?.expect("not a standard CAT");
    assert_eq!(full.inner_puzzle.synthetic_key, public_key);

    Ok(())
}
```

Parsing the puzzle tells you what a coin is. To track an asset like a CAT or NFT from one coin to the next, you parse the parent coin's spend instead, using the primitive's `parse_children` or `parse` methods. See [Primitives](/sdk/primitives) for that pattern.

## Writing a custom layer

To use your own puzzle with the SDK, give it a curried-arguments type with a [`Mod`](/sdk/concepts/clvm#the-mod-trait) implementation, a solution type, and a layer that ties them together.

This example is a timelock layer: an outer puzzle that wraps any inner puzzle and adds `ASSERT_HEIGHT_ABSOLUTE` to its output, so the coin can't be spent before a given block height. The Chialisp source is:

```clsp
(mod (MIN_HEIGHT INNER_PUZZLE inner_solution)
  (c (list 83 MIN_HEIGHT) (a INNER_PUZZLE inner_solution))
)
```

```rust
use std::borrow::Cow;

use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::chia::puzzle_types::standard::StandardSolution;
use hex_literal::hex;

pub const TIMELOCK_PUZZLE: [u8; 27] =
    hex!("ff04ffff04ffff0153ffff04ff02ff808080ffff02ff05ff0b8080");
pub const TIMELOCK_PUZZLE_HASH: TreeHash = TreeHash::new(hex!(
    "020c886c1d46396e6cd015774bb494a5728098532bd66e9fbe14af704947e51e"
));

/// The curried arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct TimelockArgs<I> {
    pub min_height: u32,
    pub inner_puzzle: I,
}

impl<I> Mod for TimelockArgs<I> {
    fn mod_reveal() -> Cow<'static, [u8]> {
        Cow::Borrowed(&TIMELOCK_PUZZLE)
    }

    fn mod_hash() -> TreeHash {
        TIMELOCK_PUZZLE_HASH
    }
}

/// The solution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(list)]
pub struct TimelockSolution<I> {
    pub inner_solution: I,
}

/// The layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelockLayer<I> {
    pub min_height: u32,
    pub inner_puzzle: I,
}

impl<I> Layer for TimelockLayer<I>
where
    I: Layer,
{
    type Solution = TimelockSolution<I::Solution>;

    fn parse_puzzle(allocator: &Allocator, puzzle: Puzzle) -> Result<Option<Self>, DriverError> {
        let Some(puzzle) = puzzle.as_curried() else {
            return Ok(None);
        };

        if puzzle.mod_hash != TIMELOCK_PUZZLE_HASH {
            return Ok(None);
        }

        let args = TimelockArgs::<NodePtr>::from_clvm(allocator, puzzle.args)?;

        let Some(inner_puzzle) =
            I::parse_puzzle(allocator, Puzzle::parse(allocator, args.inner_puzzle))?
        else {
            return Ok(None);
        };

        Ok(Some(Self {
            min_height: args.min_height,
            inner_puzzle,
        }))
    }

    fn parse_solution(
        allocator: &Allocator,
        solution: NodePtr,
    ) -> Result<Self::Solution, DriverError> {
        let solution = TimelockSolution::<NodePtr>::from_clvm(allocator, solution)?;
        Ok(TimelockSolution {
            inner_solution: I::parse_solution(allocator, solution.inner_solution)?,
        })
    }

    fn construct_puzzle(&self, ctx: &mut SpendContext) -> Result<NodePtr, DriverError> {
        let inner_puzzle = self.inner_puzzle.construct_puzzle(ctx)?;
        ctx.curry(TimelockArgs {
            min_height: self.min_height,
            inner_puzzle,
        })
    }

    fn construct_solution(
        &self,
        ctx: &mut SpendContext,
        solution: Self::Solution,
    ) -> Result<NodePtr, DriverError> {
        let inner_solution = self
            .inner_puzzle
            .construct_solution(ctx, solution.inner_solution)?;
        ctx.alloc(&TimelockSolution { inner_solution })
    }
}

impl<I> ToTreeHash for TimelockLayer<I>
where
    I: ToTreeHash,
{
    fn tree_hash(&self) -> TreeHash {
        TimelockArgs {
            min_height: self.min_height,
            inner_puzzle: self.inner_puzzle.tree_hash(),
        }
        .curry_tree_hash()
    }
}

/// Lets the timelocked coin be spent with conditions, like the inner puzzle.
impl<I> SpendWithConditions for TimelockLayer<I>
where
    I: SpendWithConditions,
{
    fn spend_with_conditions(
        &self,
        ctx: &mut SpendContext,
        conditions: Conditions,
    ) -> Result<Spend, DriverError> {
        let inner = self.inner_puzzle.spend_with_conditions(ctx, conditions)?;
        let puzzle = ctx.curry(TimelockArgs {
            min_height: self.min_height,
            inner_puzzle: inner.puzzle,
        })?;
        let solution = ctx.alloc(&TimelockSolution {
            inner_solution: inner.solution,
        })?;
        Ok(Spend::new(puzzle, solution))
    }
}

#[test]
fn timelock_layer() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let p2 = StandardLayer::new(alice.pk);
    let timelock = TimelockLayer {
        min_height: 10,
        inner_puzzle: p2,
    };

    // Lock a coin with the timelock puzzle.
    let timelock_puzzle_hash: Bytes32 = timelock.tree_hash().into();
    p2.spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(timelock_puzzle_hash, 1, Memos::None),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;
    let locked = Coin::new(alice.coin.coin_id(), timelock_puzzle_hash, 1);

    let unlock = Conditions::new().create_coin(alice.puzzle_hash, 1, Memos::None);

    // Spending it before height 10 fails.
    let spend = timelock.spend_with_conditions(ctx, unlock.clone())?;
    ctx.spend(locked, spend)?;
    assert!(sim.spend_coins(ctx.take(), &[alice.sk.clone()]).is_err());

    // After that it works.
    while sim.height() < 10 {
        sim.create_block();
    }
    let spend = timelock.spend_with_conditions(ctx, unlock)?;
    ctx.spend(locked, spend)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Anyone looking at the spend can parse it back into layers.
    let coin_spend = sim.coin_spend(locked.coin_id()).expect("spent");
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let parsed = TimelockLayer::<StandardLayer>::parse_puzzle(ctx, puzzle)?.expect("not a timelock");
    assert_eq!(parsed, timelock);

    let solution = ctx.alloc(&coin_spend.solution)?;
    let solution: TimelockSolution<StandardSolution<NodePtr, NodePtr>> =
        TimelockLayer::<StandardLayer>::parse_solution(ctx, solution)?;
    assert_eq!(solution.inner_solution.original_public_key, None);

    Ok(())
}
```

A few things to note about the pattern, which all of the built-in layers follow:

- `parse_puzzle` checks the mod hash first and returns `Ok(None)` on a mismatch, then delegates to the inner layer through a fresh `Puzzle::parse`.
- The arguments type is generic over the inner puzzle, so the same type is used with a `NodePtr` (building and parsing) and with a `TreeHash` (computing the puzzle hash).
- Outer layers that can't be spent by conditions alone, like `CatLayer`, don't implement `SpendWithConditions`. The CAT primitive wraps an inner `Spend` instead. Choose whichever fits your puzzle.

If you only need to curry a puzzle and don't need parsing, `ctx.curry(args)` and `Spend::new` are enough. A layer is worth writing when you want to recognize your puzzle on chain or compose it with other layers.

## Built-in layers

| Layer                                                                                                                                              | Puzzle                                                                              | Typically wraps / used by                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `StandardLayer` (alias `P2DelegatedOrHiddenLayer`)                                                                                                 | `p2_delegated_puzzle_or_hidden_puzzle`, the standard XCH puzzle                     | Ownership of most coins; [Standard](/sdk/primitives/standard)                                                                |
| `P2DelegatedConditionsLayer`                                                                                                                       | `p2_delegated_conditions`: a key signs a list of conditions                         | Simple key ownership                                                                                                         |
| `CatLayer<I>`                                                                                                                                      | CAT v2                                                                              | [CAT](/sdk/primitives/cat)                                                                                                   |
| `RevocationLayer`                                                                                                                                  | Revocation layer for revocable CATs                                                 | [CAT](/sdk/primitives/cat)                                                                                                   |
| `SingletonLayer<I>`                                                                                                                                | Singleton top layer v1.1                                                            | [Singletons](/sdk/primitives/singletons), NFTs, DIDs, vaults                                                                 |
| `NftStateLayer<M, I>`                                                                                                                              | NFT state layer (metadata and updater)                                              | [NFT](/sdk/primitives/nft)                                                                                                   |
| `NftOwnershipLayer<T, I>`                                                                                                                          | NFT ownership layer (current DID owner and transfer program)                        | [NFT](/sdk/primitives/nft)                                                                                                   |
| `RoyaltyTransferLayer`                                                                                                                             | NFT royalty transfer program                                                        | [NFT](/sdk/primitives/nft)                                                                                                   |
| `DidLayer<M, I>`                                                                                                                                   | DID inner puzzle (metadata and recovery)                                            | [DID](/sdk/primitives/did)                                                                                                   |
| `SettlementLayer`                                                                                                                                  | `settlement_payments`, used by offers                                               | [Offers](/sdk/offers)                                                                                                        |
| `OptionContractLayer<I>`                                                                                                                           | Option contract                                                                     | [Option Contracts](/sdk/primitives/options)                                                                                  |
| `P2SingletonLayer`                                                                                                                                 | Coin spendable only alongside a singleton                                           | [Singletons](/sdk/primitives/singletons), [Clear Signing](/sdk/clear-signing)                                                |
| `P2OneOfManyLayer`                                                                                                                                 | Pick one of many delegated puzzles from a merkle root                               | [Clawback](/sdk/primitives/clawback), [Option Contracts](/sdk/primitives/options), [MerkleTree](/sdk/utilities#merkle-trees) |
| `P2CurriedLayer`                                                                                                                                   | Spend by revealing a puzzle that hashes to a curried puzzle hash                    | [Clawback](/sdk/primitives/clawback)                                                                                         |
| `AugmentedConditionLayer<T, I>`                                                                                                                    | Adds a fixed condition to the inner puzzle's output                                 | [Clawback](/sdk/primitives/clawback), [Option Contracts](/sdk/primitives/options)                                            |
| `StreamLayer`                                                                                                                                      | Streamed payments                                                                   | [Streamed Assets](/sdk/primitives/streaming)                                                                                 |
| `BulletinLayer<I>`                                                                                                                                 | Nonce wrapper that distinguishes bulletin coins                                     | [Bulletins](/sdk/primitives/bulletin)                                                                                        |
| `DelegatedPuzzleFeederLayer<I>`, `IndexWrapperLayer<N, I>`, `SingletonMemberLayer`                                                                 | Meta Inner Puzzle Spec (MIPS) building blocks                                       | [Vaults & MIPS](/sdk/primitives/vaults)                                                                                      |
| `DelegationLayer`, `WriterLayer<I>`, `OracleLayer`                                                                                                 | DataLayer delegation (feature `chip-0035`)                                          | [DataLayer](/sdk/primitives/datalayer)                                                                                       |
| `P2ControllerPuzzleLayer`, `P2Eip712MessageLayer`                                                                                                  | Coins controlled by another puzzle or by an EIP-712 signature (feature `chip-0037`) | Ethereum-style (secp256k1) wallets                                                                                           |
| `ActionLayer<S, P>`, `PrecommitLayer<V>`, `StateSchedulerLayer`, `MOfNLayer`, `P2DelegatedBySingletonLayer`, `ConditionsLayer<T>`, `P2ParentLayer` | Action layer singletons (feature `action-layer`)                                    | [Action Layer](/sdk/primitives/action-layer)                                                                                 |

Besides these, any type that implements both `ToClvm` and `FromClvm` is a layer, whose puzzle is the value itself and whose solution is a `NodePtr`. `Puzzle` is a layer too, as shown above. Both are useful as placeholder inner layers in tests and when parsing.

## Gotchas

- **`Ok(None)` and `Err` mean different things.** `None` means "not this puzzle". An error means the mod hash matched but the arguments didn't parse, which usually indicates a malformed or malicious puzzle. Don't silently treat errors as `None`.
- **Matching a layer doesn't verify the asset.** `CatLayer::parse_puzzle` tells you a coin has a CAT puzzle, not that its lineage is valid. Validate lineage by parsing from the parent spend, as the [primitives](/sdk/primitives) do.
- **Parsing an inner layer requires the full reveal.** A puzzle hash alone can't be parsed. You need the puzzle reveal from a coin spend, which for an unspent coin means parsing the parent's spend and reconstructing the child.
