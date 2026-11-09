---
title: Singletons & Launchers
---

# Singletons & Launchers

A singleton is a coin with a unique, provable identity that persists as it is spent and recreated. NFTs,
DIDs, vaults, option contracts, DataLayer stores and the action layer registries are all singletons. The
singleton top layer (`singleton_top_layer_v1_1`) enforces that each spend creates at most one odd-amount
child with the same identity, and that identity is the coin ID of the **launcher** coin that created it.

This page covers the pieces every singleton shares: `Launcher` and `IntermediateLauncher` for creating
them, the generic `Singleton<I>` type with the `SingletonInfo` trait, proofs, and melting. The specific
singletons have their own pages: [NFT](/sdk/primitives/nft), [DID](/sdk/primitives/did),
[Option Contracts](/sdk/primitives/options), [Vaults](/sdk/primitives/vaults),
[DataLayer](/sdk/primitives/datalayer) and [Action Layer](/sdk/primitives/action-layer). Background on
the puzzle is at [Singletons on chialisp.com](https://chialisp.com/singletons).

:::tip
With the [Action System](/sdk/action-system), `Action::create_did`, `Action::mint_nft` and
`Action::mint_option` launch singletons for you, and `Action::melt_singleton` melts one. You only need the
types on this page when you build singleton spends by hand or create your own kind of singleton.
:::

## How a singleton is launched

1. A parent coin (for example an XCH coin) creates a **launcher coin** with the well-known
   `singleton_launcher` puzzle. The launcher's coin ID becomes the singleton's **launcher ID**.
2. The launcher is spent in the same transaction. Its solution names the singleton puzzle hash and
   amount, and it creates the first singleton coin, called the **eve** coin.
3. The launcher announces its solution, and the parent asserts that announcement, so nobody can spend the
   launcher with a different solution (and hijack the launcher ID) once the parent is spent.

`Launcher` handles steps 2 and 3. You decide on the singleton's inner puzzle hash first, because the
launcher commits to the full puzzle hash.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn launch_singleton() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    // The parent coin will create the launcher coin with amount 1.
    let launcher = Launcher::new(alice.coin.coin_id(), 1);
    let launcher_id = launcher.coin().coin_id();

    // Spend the launcher to create the eve singleton. Here the singleton's inner
    // puzzle is just Alice's standard puzzle. The last argument is the launcher's
    // key/value metadata list, which is usually empty.
    let (parent_conditions, eve_coin) =
        launcher.spend(ctx, alice.puzzle_hash, ())?;

    // `parent_conditions` creates the launcher and asserts its announcement.
    alice_p2.spend(ctx, alice.coin, parent_conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(eve_coin.parent_coin_info, launcher_id);
    assert!(sim.coin_state(eve_coin.coin_id()).is_some());

    Ok(())
}
```

The primitive-specific launch methods are extension methods on `Launcher`: `Launcher::mint_nft` and
`mint_eve_nft` for NFTs, `create_did`, `create_simple_did` and `create_eve_did` for DIDs, and similar
`mint_vault` for [vaults](/sdk/primitives/vaults), and `mint_datastore` for [DataLayer](/sdk/primitives/datalayer) stores (`chip-0035`). They take the `Launcher` by value, so each launcher can only be
used once.

### Launcher variants

| Constructor                                   | Use it when                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Launcher::new(parent_coin_id, amount)`       | the parent creates the launcher and asserts it in the same spend                                           |
| `Launcher::with_memos(parent, amount, memos)` | as above, but the launcher coin is hinted (useful for finding it later)                                    |
| `Launcher::create_early(parent, amount)`      | the launcher is created by one spend and launched from another; returns the `CreateCoin` to output         |
| `Launcher::create_early_with_memos(...)`      | as above, hinted                                                                                           |
| `Launcher::from_coin(coin, conditions)`       | you already have the launcher coin and the conditions the parent must output                               |
| `.with_singleton_amount(amount)`              | the singleton amount differs from the launcher amount (e.g. a 0 mojo launcher creating a 1 mojo singleton) |

Singletons must have an odd amount, which is why 1 mojo is used almost everywhere.

### Creating many launchers from one parent: `IntermediateLauncher`

A launcher's coin ID depends on its parent, puzzle hash and amount. Since every launcher has the same
puzzle hash, one parent can only create one launcher of a given amount. `IntermediateLauncher` works
around this by first creating a 0-mojo intermediate coin curried with `(mint_number, mint_total)`, which
then creates the launcher. Each index gives a unique intermediate coin and so a unique launcher ID.

```rust
use chia_wallet_sdk::driver::IntermediateLauncher;
use chia_wallet_sdk::prelude::*;

#[test]
fn many_launchers() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(3);
    let alice_p2 = StandardLayer::new(alice.pk);

    let total = 3;
    let mut conditions = Conditions::new();
    let mut launcher_ids = Vec::new();

    for i in 0..total {
        // `create` spends the intermediate coin and returns a normal `Launcher`.
        let launcher = IntermediateLauncher::new(alice.coin.coin_id(), i, total).create(ctx)?;
        launcher_ids.push(launcher.coin().coin_id());

        let (launch, _eve_coin) = launcher.spend(ctx, alice.puzzle_hash, ())?;
        conditions = conditions.extend(launch);
    }

    alice_p2.spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Every launcher ID is different.
    let unique: std::collections::HashSet<_> = launcher_ids.iter().collect();
    assert_eq!(unique.len(), 3);

    Ok(())
}
```

The intermediate coins have amount 0 and the launchers have amount 1, so the parent must have at least
`total` mojos available. This is the pattern used for bulk NFT minting from a DID; see
[NFT](/sdk/primitives/nft#bulk-minting).

## `Singleton<I>` and `SingletonInfo`

```rust ignore
pub struct Singleton<I> {
    pub coin: Coin,
    pub proof: Proof,
    pub info: I,
}

pub trait SingletonInfo {
    fn launcher_id(&self) -> Bytes32;
    fn inner_puzzle_hash(&self) -> TreeHash;
    fn puzzle_hash(&self) -> TreeHash; // provided: singleton layer around inner_puzzle_hash
}
```

`Singleton<I>` is generic over an info type that describes everything inside the singleton layer except
the p2 puzzle. `Nft` is `Singleton<NftInfo>`, `Did` is `Singleton<DidInfo>`, and the vault, option and
action layer primitives follow the same shape. As with `Cat`, the `Singleton` plus the ability to spend
its p2 puzzle is everything you need to store.

The methods on `Singleton<I>` are generic:

- `child_lineage_proof()` returns the `LineageProof` for any child of this coin.
- `child_with(info, amount)` returns the child `Singleton` for a new info value. Construct the child from
  the new info, rather than copying the singleton and mutating `info`, so the coin's puzzle hash matches.

### Proofs

The singleton puzzle needs to know its parent was a legitimate singleton with the same launcher ID.
`Proof` is either:

- `Proof::Eve(EveProof)` for the eve coin, whose parent is the launcher. It contains the launcher's parent
  coin ID and amount.
- `Proof::Lineage(LineageProof)` for every later coin. It contains the parent's parent coin ID, the
  parent's **inner** puzzle hash and the parent's amount.

The eve coin is normally spent in the same transaction it's created in (the NFT and DID launch methods do
this for you), so the singletons you store and sync will have lineage proofs. Spending a singleton
returns its child with the next proof filled in, and the `parse_child` functions of each primitive
reconstruct the proof from the parent spend.

## A custom singleton

Implementing `SingletonInfo` is enough to use `Singleton<I>` for your own singletons. This example
launches a singleton owned directly by a standard puzzle, spends it once and then melts it:

```rust
use chia_wallet_sdk::chia::puzzle_types::{
    EveProof, Proof,
    singleton::{SingletonArgs, SingletonSolution},
};
use chia_wallet_sdk::prelude::*;

#[derive(Debug, Clone, Copy)]
struct MyInfo {
    launcher_id: Bytes32,
    p2_puzzle_hash: Bytes32,
}

impl SingletonInfo for MyInfo {
    fn launcher_id(&self) -> Bytes32 {
        self.launcher_id
    }

    fn inner_puzzle_hash(&self) -> TreeHash {
        // No extra layers, so the inner puzzle is the p2 puzzle.
        self.p2_puzzle_hash.into()
    }
}

fn spend_singleton(
    ctx: &mut SpendContext,
    singleton: &Singleton<MyInfo>,
    p2: &StandardLayer,
    conditions: Conditions,
) -> anyhow::Result<()> {
    let inner = p2.spend_with_conditions(ctx, conditions)?;
    let puzzle = ctx.curry(SingletonArgs::new(singleton.info.launcher_id, inner.puzzle))?;
    let solution = ctx.alloc(&SingletonSolution {
        lineage_proof: singleton.proof,
        amount: singleton.coin.amount,
        inner_solution: inner.solution,
    })?;
    ctx.spend(singleton.coin, Spend::new(puzzle, solution))?;
    Ok(())
}

#[test]
fn custom_singleton() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let alice_p2 = StandardLayer::new(alice.pk);

    let launcher = Launcher::new(alice.coin.coin_id(), 1);
    let launcher_coin = launcher.coin();
    let info = MyInfo {
        launcher_id: launcher_coin.coin_id(),
        p2_puzzle_hash: alice.puzzle_hash,
    };

    let (launch, eve_coin) = launcher.spend(ctx, info.inner_puzzle_hash().into(), ())?;
    alice_p2.spend(ctx, alice.coin, launch)?;

    let eve = Singleton::new(
        eve_coin,
        Proof::Eve(EveProof {
            parent_parent_coin_info: launcher_coin.parent_coin_info,
            parent_amount: launcher_coin.amount,
        }),
        info,
    );
    assert_eq!(eve.coin.puzzle_hash, info.puzzle_hash().into());

    // Recreate the singleton. The inner puzzle outputs its *inner* puzzle hash,
    // and the singleton layer wraps the odd-amount output for us.
    spend_singleton(
        ctx,
        &eve,
        &alice_p2,
        Conditions::new().create_coin(info.inner_puzzle_hash().into(), 1, Memos::None),
    )?;
    let child = eve.child_with(info, 1);

    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;
    assert!(sim.coin_state(child.coin.coin_id()).is_some());

    // Melt the singleton: no odd child, plus the special melt condition.
    spend_singleton(ctx, &child, &alice_p2, Conditions::new().melt_singleton())?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert!(sim.coin_state(child.coin.coin_id()).unwrap().spent_height.is_some());

    Ok(())
}
```

In a real singleton you would add your own layers between the singleton layer and the p2 puzzle, and
`inner_puzzle_hash` would return the hash of that whole stack. See
[Layers & Puzzles](/sdk/concepts/layers) for `SingletonLayer` and writing custom layers.

## Melting

A singleton is destroyed ("melted") when its inner puzzle outputs `Conditions::melt_singleton()`
(a `CREATE_COIN` with the magic amount `-113`) and doesn't create an odd-amount child. The singleton's
mojos are released into the transaction, where they can pay the fee or be claimed by another spend.
Melted singletons can't be revived, and the launcher ID can never be reused.

For DIDs, use `did.spend_with(ctx, &p2, Conditions::new().melt_singleton())`. Not every singleton
supports melting: the NFT layers reject it (see [NFT](/sdk/primitives/nft#transferring)), so NFTs are
burned by sending them to an unspendable puzzle hash instead.

## Gotchas

- Singleton amounts must be odd. Even-amount outputs of a singleton are ordinary coins, not children, so
  a singleton can create extra coins (for example a 0 mojo intermediate coin) without affecting its
  lineage.
- Inside the singleton, `CREATE_COIN` for the child uses the inner puzzle hash. The singleton layer wraps
  it. Passing the full singleton puzzle hash creates a different, invalid coin.
- The launcher must be spent in the same transaction as its parent; otherwise anyone can front-run the
  launch. The conditions returned by `Launcher::spend` include the announcement assertion that prevents
  this, so always add them to the parent's spend.
- Launcher IDs are only unique per parent coin and amount. Use `IntermediateLauncher` (or
  `create_early` from different intermediate coins) to launch several singletons from one coin.

See the [driver rustdoc](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/) for the full
`Launcher`, `IntermediateLauncher` and `Singleton` APIs.
