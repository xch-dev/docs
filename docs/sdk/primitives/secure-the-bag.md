---
title: Secure the Bag
---

# Secure the Bag

**Secure the Bag** lets you commit to a large list of payments with a single coin. The payments are
arranged into a tree of nodes, and each node's puzzle is a fixed list of `CREATE_COIN` conditions for its
children. The root of the tree is one puzzle hash. Sending the total amount to that puzzle hash secures
every payment in a single transaction, and you don't need to create thousands of coins up front. Later,
anyone can **unroll** the bag by spending nodes, either all at once or only along the path to one
payment. Node puzzles need no signature, and they can only output the committed children, so the
payments can't be changed or redirected once the root coin exists.

Use it for airdrops and bulk payouts that are too large for one block, or when you want the payments
to be guaranteed now and let the recipients (or anyone else) pay the fees to claim them later. It
works for XCH, CATs and revocable CATs. It can also secure NFT bulk mints, through the secure the mint
pre-launcher puzzle (`SecuredMint`).

There's no feature flag. Everything on this page is in `chia_wallet_sdk::driver`.

## The types

| Type                                | What it is                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SecureTheBag`                      | A built bag: its root hash, total amount, depth, payments and nodes. Spends nodes and unrolls the bag     |
| `BagFormat`                         | How payments are ordered and grouped into nodes, and what each node outputs. Only `Legacy` exists for now |
| `BagAsset`                          | The asset in the bag: `Xch`, `Cat { asset_id }` or `RevocableCat { asset_id, hidden_puzzle_hash }`        |
| `BagPayment`                        | One payment: recipient puzzle hash, amount and an optional `ClawbackV2`                                   |
| `BagNode` / `BagChild`              | A node and its children. A child is either another node or a payment                                      |
| `BagCoin`                           | A coin in the bag on chain, `Xch(Coin)` or `Cat(Cat)`. Used as the starting point for spends              |
| `SecuredMint` / `SecuredMintOutput` | An NFT mint secured by a one mojo pre-launcher coin, and the coins that minting from it creates           |

The root and node puzzle hashes are **p2 puzzle hashes**. For XCH they're the coins' puzzle hashes. For
CATs they're the puzzle hashes inside the CAT layer (and the revocation layer), so the same tree works
for every asset. `SecureTheBag::root_hash` is the p2 puzzle hash you send the funds to, and
`root_puzzle_hash` is the full puzzle hash of the root coin, including the asset's outer puzzle.

## The Legacy format

`BagFormat::Legacy` matches the bags that Cloud Wallet has already created on chain, so the SDK can
rebuild and unroll them. `BagFormat::legacy()` is the default: sorted payments and the default width.

- Payments are sorted by the puzzle hash of the coin each one creates (when `sorted` is true), then split
  into consecutive chunks of `leaf_width`. The nodes of each level are chunked the same way, level by
  level, until one node remains. That node is the root.
- The default width depends on the number of payments: 100 for up to 1,000 payments, 250 up to 10,000,
  500 up to 100,000, and 1,000 beyond that. Set `leaf_width: Some(n)` to override it.
- Each node's puzzle is `(q . conditions)`. The first condition is a `CREATE_COIN_ANNOUNCEMENT` of `"$"`,
  which a fee spend can assert. After it comes one `CREATE_COIN` per child. A payment is hinted with its
  puzzle hash, a node with its own puzzle hash, and a clawback payment with
  `(receiver_puzzle_hash clawback_memo)`, so wallets can find the clawback from the parent spend.
- A single payment without a clawback isn't bagged at all. The root hash is then the payment's own puzzle
  hash, the depth is 0 and there are no nodes.
- Airdrops sort their payments, but Cloud Wallet's NFT bulk mints keep the order of the mints. For those,
  use `BagFormat::Legacy { leaf_width, sorted: false }`. The root then depends on the order of the input.

The root hash depends on the format, the width, the order (if unsorted) and every payment. To rebuild a
bag that's already on chain, you need the exact same inputs.

## Building a bag

`SecureTheBag::build(format, asset, payments)` builds the whole tree in memory. It fails with:

| Error                 | Cause                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `EmptyBag`            | No payments                                                                                 |
| `DuplicateBagPayment` | Two payments would create a coin with the same puzzle hash                                  |
| `BagClawbackMismatch` | A payment's clawback has a different receiver or amount than the payment                    |
| `AmountOverflow`      | The total doesn't fit in a `u64`                                                            |
| `InvalidBagWidth`     | A width of 0, or a width of 1 with more than one payment, which would never reach a root    |
| `BagNodeCollision`    | A payment's puzzle hash is the same as one of the nodes, which would make the bag ambiguous |

Two payments to the same recipient and amount would create identical coins, so `build` rejects them. If
you need to pay someone twice, merge the payments. A payment and a clawback payment to the same receiver
are fine, since the clawback coin has a different puzzle hash.

Once the bag is built, fund it by creating a coin of the asset with `root_hash()` (inside the asset's
outer puzzle) and exactly `total_amount()`. A root coin with less can't be spent, and anything more would
be lost to fees.

The bag also lets you navigate the tree:

- `payments()` returns the payments in the order of the bag (sorted, for a sorted format).
- `nodes()` returns every node keyed by its p2 puzzle hash, in the order they were built. Each level comes
  before the level above it, so the root is last.
- `path(puzzle_hash)` returns the nodes from the root down to the coin with that p2 puzzle hash. For a
  payment, use `BagPayment::coin_puzzle_hash()`, which is the clawback's puzzle hash for a clawback payment.
- `parent`, `node`, `amount` and `depth` look up individual parts of the tree.

## Unrolling a bag

There are four ways to spend nodes, depending on how much of the bag you want to unroll:

| Method                                | What it spends                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `spend_node(ctx, coin)`               | One node coin. Returns the coins it creates                                                        |
| `spend_path(ctx, start, puzzle_hash)` | Every node from `start` down to one coin, usually a payment. Returns that coin                     |
| `unroll(ctx, start)`                  | Every node under `start`. Returns the payment coins                                                |
| `node_spend(ctx, puzzle_hash)`        | Nothing. Returns the p2 `Spend` of a node, which you can wrap in the asset's outer puzzle yourself |

`coin_path(start, puzzle_hash)` calculates the coins along the same path as `spend_path`, without spending
anything. The starting coin is checked to be part of the bag, with the right asset and amount.

The start doesn't have to be the root. Once part of the bag has been unrolled, the root is spent, so a
second claim starts from the closest unspent node on its path. This example builds a bag of ten XCH
payments with a width of three. It funds the root, claims one payment, then claims a second payment
from a node that the first claim created:

```rust
use chia_wallet_sdk::driver::{BagAsset, BagCoin, BagFormat, BagPayment, SecureTheBag};
use chia_wallet_sdk::prelude::*;

#[test]
fn claim_payments_from_a_bag() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // Ten payments of 1 to 10 mojos, in leaves of [0, 1, 2], [3, 4, 5], [6, 7, 8] and [9].
    let payments = (0..10u8).map(|i| BagPayment::new(Bytes32::new([i; 32]), u64::from(i) + 1));
    let format = BagFormat::Legacy { leaf_width: Some(3), sorted: true };
    let bag = SecureTheBag::build(format, BagAsset::Xch, payments)?;

    assert_eq!(bag.total_amount(), 55);
    assert_eq!(bag.depth(), 3);

    // Securing every payment takes one coin with the root hash and the total amount.
    let alice = sim.bls(bag.total_amount());
    let hint = ctx.hint(bag.root_hash())?;
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bag.root_hash(), bag.total_amount(), hint),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let root = BagCoin::Xch(Coin::new(alice.coin.coin_id(), bag.root_hash(), bag.total_amount()));

    // Anyone can claim a payment by spending the nodes on its path. No signature is needed.
    let first = Bytes32::new([4; 32]);
    let payment = bag.spend_path(ctx, root, first)?;
    sim.spend_coins(ctx.take(), &[])?;

    assert_eq!(payment.coin().amount, 5);
    assert_eq!(sim.hinted_coins(first), vec![payment.coin().coin_id()]);

    // The root is spent now, so the second claim starts from the unspent leaf on its path.
    let second = Bytes32::new([1; 32]);
    let leaf = *bag.path(second).unwrap().last().unwrap();
    let leaf_coin = *bag.coin_path(root, leaf)?.last().unwrap();

    let payment = bag.spend_path(ctx, leaf_coin, second)?;
    sim.spend_coins(ctx.take(), &[])?;

    assert_eq!(sim.hinted_coins(second), vec![payment.coin().coin_id()]);

    Ok(())
}
```

### CAT bags and clawbacks

For a CAT bag, the root and nodes are CAT coins. `BagCoin::Cat` wraps a `Cat`, and the node spends go
through `Cat::spend_all`, so lineage proofs are handled for you. A payment with a `ClawbackV2` creates a
clawback coin instead of paying the receiver directly. Build it with `BagPayment::from_clawback`. The
sender can still claw it back before the timeout, as with any [clawback](/sdk/primitives/clawback).

This example issues a CAT straight into a bag of five payments and one clawback payment, then unrolls
all of it in one transaction:

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::GenesisByCoinIdTailArgs;
use chia_wallet_sdk::driver::{BagAsset, BagFormat, BagPayment, BagCoin, ClawbackV2, SecureTheBag};
use chia_wallet_sdk::prelude::*;

#[test]
fn unroll_a_cat_bag() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1000);
    let asset_id = GenesisByCoinIdTailArgs::curry_tree_hash(alice.coin.coin_id()).into();
    let asset = BagAsset::Cat { asset_id };

    let mut payments: Vec<BagPayment> = (0..5u8)
        .map(|i| BagPayment::new(Bytes32::new([i; 32]), 100))
        .collect();

    // Bob's payment can be clawed back by Alice for the first 100 seconds.
    let bob = Bytes32::new([9; 32]);
    let clawback = ClawbackV2::new(alice.puzzle_hash, bob, 100, 500, true);
    payments.push(BagPayment::from_clawback(clawback));

    let format = BagFormat::Legacy { leaf_width: Some(2), sorted: true };
    let bag = SecureTheBag::build(format, asset, payments)?;

    // Issue the CAT directly to the root hash, which is the p2 puzzle hash inside the CAT layer.
    let hint = ctx.hint(bag.root_hash())?;
    let (issue, cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        bag.total_amount(),
        Conditions::new().create_coin(bag.root_hash(), bag.total_amount(), hint),
    )?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, issue)?;

    let root = BagCoin::Cat(cats[0]);
    assert_eq!(root.coin().puzzle_hash, bag.root_puzzle_hash());

    // Spend every node and get back the payment coins.
    let coins = bag.unroll(ctx, root)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(coins.len(), 6);

    for payment in bag.payments() {
        let coin = coins
            .iter()
            .find(|coin| coin.p2_puzzle_hash() == payment.coin_puzzle_hash())
            .unwrap();

        assert_eq!(coin.coin().amount, payment.amount);
        assert!(sim.coin_state(coin.coin().coin_id()).is_some());

        // Every payment, including the clawback, is hinted to its recipient.
        assert!(sim.hinted_coins(payment.puzzle_hash).contains(&coin.coin().coin_id()));
    }

    Ok(())
}
```

## Secured NFT mints

A bag can also secure an NFT bulk mint. Each mint becomes a one mojo **pre-launcher** coin, whose puzzle
is the secure the mint launcher from
[mintgarden-io/secure-the-mint](https://github.com/mintgarden-io/secure-the-mint). The puzzle commits to
the NFT's metadata hash, metadata updater, royalty and owner. When it's spent, it creates a singleton
launcher and asserts that the launcher creates the eve NFT with exactly those values. The eve NFT then
sends itself to the owner with a hint. Nobody can change what gets minted once the bag is funded, and
anyone can do the minting.

`SecuredMint::new(metadata, metadata_updater_puzzle_hash, royalty_puzzle_hash, royalty_basis_points, p2_puzzle_hash)`
describes one mint. `bag_payment()` is the payment that creates its pre-launcher in a bag,
`mint(ctx, pre_launcher)` spends the pre-launcher, launcher and eve NFT, and `output(pre_launcher)`
calculates the same `SecuredMintOutput` (pre-launcher, launcher, eve NFT and final NFT) without spending
anything. The curried arguments are `SecureTheMintLauncherArgs` in `chia_wallet_sdk::types::puzzles`.

The pre-launcher must have an amount of exactly 1 (`InvalidPreLauncherAmount` otherwise), since anything
more would go to the fee. With `with_melt_public_key`, the pre-launcher can also be melted without minting
(`melt`), which requires a signature from that key on the message `0x01` with the `AGG_SIG_ME` additional
data. Cloud Wallet doesn't set a melt key, and the key changes the pre-launcher's puzzle hash.

NFT bulk mints keep the mints in order, so they use an unsorted bag:

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::driver::{BagAsset, BagCoin, BagFormat, SecureTheBag, SecuredMint};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::NFT_METADATA_UPDATER_DEFAULT_HASH;

#[test]
fn mint_nfts_from_a_bag() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let mut mints = Vec::new();

    for i in 0..7u8 {
        let metadata = ctx.alloc_hashed(&NftMetadata {
            edition_number: u64::from(i) + 1,
            edition_total: 7,
            data_uris: vec![format!("https://example.com/{i}.png")],
            data_hash: Some(Bytes32::new([i; 32])),
            ..Default::default()
        })?;

        mints.push(SecuredMint::new(
            metadata,
            NFT_METADATA_UPDATER_DEFAULT_HASH.into(),
            Bytes32::new([200; 32]),
            300,
            Bytes32::new([100 + i; 32]),
        ));
    }

    let format = BagFormat::Legacy { leaf_width: Some(3), sorted: false };
    let bag = SecureTheBag::build(format, BagAsset::Xch, mints.iter().map(SecuredMint::bag_payment))?;
    assert_eq!(bag.total_amount(), 7);

    let alice = sim.bls(bag.total_amount());
    let hint = ctx.hint(bag.root_hash())?;
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bag.root_hash(), bag.total_amount(), hint),
    )?;

    let root = BagCoin::Xch(Coin::new(alice.coin.coin_id(), bag.root_hash(), bag.total_amount()));
    let pre_launchers = bag.unroll(ctx, root)?;

    for mint in &mints {
        let pre_launcher = pre_launchers
            .iter()
            .find(|coin| coin.p2_puzzle_hash() == mint.pre_launcher_puzzle_hash())
            .unwrap();

        let output = mint.mint(ctx, pre_launcher.coin())?;
        assert_eq!(output.nft.info.p2_puzzle_hash, mint.p2_puzzle_hash);
    }

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    for mint in &mints {
        assert_eq!(sim.hinted_coins(mint.p2_puzzle_hash).len(), 1);
    }

    Ok(())
}
```

Here the root is created, unrolled and minted in one transaction. In practice you'd create the root
first, and unroll and mint later, possibly in many transactions.

## Clear signing

When a [vault](/sdk/primitives/vaults) funds a bag, the root is just a coin sent to an unknown puzzle
hash. Reveal the bag with `Reveals::reveal_bag` and [clear signing](/sdk/clear-signing#secure-the-bag-payments)
shows the root as the bag's payments instead.

## Gotchas

- The bag isn't stored on chain. Only the root hash is, so you must keep the payment list, format, width
  and order to unroll the bag later. If you lose them, the funds are stuck in the root coin.
- The node puzzles have no signature and no fee. Whoever unrolls the bag pays the fees, from a separate
  spend that can assert the node's `"$"` coin announcement.
- `unroll` spends every node in one transaction. A bag with many payments won't fit in a block, so unroll
  large bags a level or a node at a time with `spend_node`, or let each recipient use `spend_path`.
- Once a node is spent, start later claims from the closest unspent node on the path. Spending the root
  again would be a double spend, and `coin_path` returns `NotBagAncestor` if the start isn't on the path.
- A revocable CAT bag can still be revoked by the issuer until it's unrolled, just like any revocable CAT.
- An unsorted bag's root depends on the order of the payments. Rebuild it in exactly the same order.
