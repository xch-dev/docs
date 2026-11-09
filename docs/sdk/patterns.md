---
title: Application Patterns
---

# Application Patterns

The other pages explain individual pieces of the SDK. This one is about putting them together in an
application: how to organize keys, how to structure transaction building, and the habits that keep
transactions safe.

## Keep keys indexed by puzzle hash

Everything the SDK hands you identifies ownership by **p2 puzzle hash**: `Spends::finish_with_keys` takes
a map from p2 puzzle hash to synthetic key, `SpendableAsset::p2_puzzle_hash` tells you which key a coin
needs, and parsed primitives expose `info.p2_puzzle_hash`. So the most useful structure for a wallet is a
map from each derived puzzle hash to the key behind it.

```rust
use chia_wallet_sdk::chia::bls::master_to_wallet_unhardened;
use chia_wallet_sdk::chia::puzzle_types::{DeriveSynthetic, Memos};
use chia_wallet_sdk::prelude::*;
use indexmap::IndexMap;

/// The keys for the first `count` addresses of a wallet.
struct Wallet {
    secret_keys: Vec<SecretKey>,
    synthetic_keys: IndexMap<Bytes32, PublicKey>,
}

impl Wallet {
    fn new(master_sk: &SecretKey, count: u32) -> Self {
        let mut secret_keys = Vec::new();
        let mut synthetic_keys = IndexMap::new();

        for index in 0..count {
            let sk = master_to_wallet_unhardened(master_sk, index).derive_synthetic();
            let pk = sk.public_key();
            synthetic_keys.insert(StandardLayer::new(pk).tree_hash().into(), pk);
            secret_keys.push(sk);
        }

        Self { secret_keys, synthetic_keys }
    }

    fn puzzle_hash(&self, index: usize) -> Bytes32 {
        *self.synthetic_keys.get_index(index).unwrap().0
    }

    fn owns(&self, p2_puzzle_hash: Bytes32) -> bool {
        self.synthetic_keys.contains_key(&p2_puzzle_hash)
    }
}

#[test]
fn spend_coins_from_several_addresses() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let wallet = Wallet::new(&SecretKey::from_seed(&[1; 64]), 5);
    let bob = BlsPair::new(1);

    // Coins received on two different addresses.
    let first = sim.new_coin(wallet.puzzle_hash(0), 300);
    let second = sim.new_coin(wallet.puzzle_hash(3), 400);

    let mut spends = Spends::new(wallet.puzzle_hash(0));
    spends.add(first);
    spends.add(second);

    let deltas = spends.apply(
        ctx,
        &[
            Action::send(Id::Xch, bob.puzzle_hash, 600, Memos::None),
            Action::fee(50),
        ],
    )?;

    // Each coin is spent with the key for its own puzzle hash.
    spends.finish_with_keys(ctx, &deltas, Relation::AssertConcurrent, &wallet.synthetic_keys)?;
    sim.spend_coins(ctx.take(), &wallet.secret_keys)?;

    assert!(wallet.owns(wallet.puzzle_hash(0)));
    assert_eq!(sim.unspent_coins(wallet.puzzle_hash(0), false)[0].amount, 50);

    Ok(())
}
```

Real wallets derive keys in batches and keep deriving while new addresses are being used (a "gap
limit"), and also index hardened keys if they use them. See [Keys & Signing](/sdk/concepts/signing).

## Separate building, signing and submitting

Building a transaction doesn't need secret keys, only public keys. Keeping the three steps apart makes
it easy to support watch-only wallets, hardware signers, multi-party signing and offline review:

1. **Build** the coin spends with public keys (the action system or primitives).
2. **Sign**: compute `RequiredSignature::from_coin_spends` for the target network, hand the messages
   to whoever holds the keys, and aggregate the signatures that come back. Because every signer signs a
   specific `(public key, message)` pair, partial signatures from different parties can be added together
   in any order.
3. **Submit** the `SpendBundle` through a [peer](/sdk/networking/peer) or [RPC client](/sdk/networking/rpc).

```rust
use chia_wallet_sdk::chia::bls::sign;
use chia_wallet_sdk::prelude::*;

/// Signs the messages that belong to one party's key. Other parties do the same with their keys.
fn partial_signature(required: &[RequiredSignature], sk: &SecretKey) -> Signature {
    let pk = sk.public_key();
    let mut signature = Signature::default();
    for required in required {
        if let RequiredSignature::Bls(required) = required {
            if required.public_key == pk {
                signature += &sign(sk, required.message());
            }
        }
    }
    signature
}

#[test]
fn two_party_signing() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(100);
    let bob = sim.bls(100);

    // Both coins are spent together, and each needs its owner's signature.
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().assert_concurrent_spend(bob.coin.coin_id()).reserve_fee(100),
    )?;
    StandardLayer::new(bob.pk).spend(
        ctx,
        bob.coin,
        Conditions::new().assert_concurrent_spend(alice.coin.coin_id()),
    )?;
    let coin_spends = ctx.take();

    // The builder shares the required signatures; each party signs only its own.
    let required = RequiredSignature::from_coin_spends(
        ctx,
        &coin_spends,
        &AggSigConstants::from(&*TESTNET11_CONSTANTS),
    )?;
    let signature = partial_signature(&required, &alice.sk) + &partial_signature(&required, &bob.sk);

    sim.new_transaction(SpendBundle::new(coin_spends, signature))?;

    Ok(())
}
```

If the signer is a separate device or person, they shouldn't sign blindly. For vaults, the
[clear signing](/sdk/clear-signing) module parses a transaction into what it actually does, so the signer
can show and check it before signing.

## Link spends that belong together

A spend bundle's coin spends aren't bound to each other by default. Anyone who sees your bundle in the
mempool can drop some of the spends and submit the rest, if the rest are still valid on their own. For
example, they could keep the spend that pays a fee and drop the one that pays you. Always tie the spends
of one transaction together:

- With the action system, choose a [`Relation`](/sdk/action-system#relations).
  `Relation::AssertConcurrent` makes every spend assert every other spend, and is the right default.
- By hand, add `assert_concurrent_spend(other_coin_id)` (or announcements, as described in
  [Conditions](/sdk/concepts/conditions)) to each spend, as in the example above.

## Spend coins you create in the same transaction

A coin created by one spend can be spent in the same block, as long as both spends are in the bundle.
The child's `Coin` can be computed before anything is on chain, from the parent coin id, the puzzle hash
and the amount. This is how intermediate coins work: launchers, the eve spends of singletons, and the
intermediate coins the action system creates when it needs a spend to emit conditions.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn spend_a_coin_created_in_the_same_transaction() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = BlsPair::new(1);
    let p2 = StandardLayer::new(alice.pk);

    // Alice's coin creates an intermediate coin owned by herself...
    p2.spend(ctx, alice.coin, Conditions::new().create_coin(alice.puzzle_hash, 1_000, Memos::None))?;
    let intermediate = Coin::new(alice.coin.coin_id(), alice.puzzle_hash, 1_000);

    // ...which is spent in the same bundle.
    p2.spend(
        ctx,
        intermediate,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 900, Memos::None)
            .reserve_fee(100),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;
    assert_eq!(sim.unspent_coins(bob.puzzle_hash, false).len(), 1);

    Ok(())
}
```

Relative timelocks (`assert_seconds_relative`, `assert_height_relative`) can't be satisfied by a coin
created in the same block, since it has no confirmed height or timestamp yet.

## Track what you've already spent

A coin stays unspent on chain until the block that spends it is farmed, which usually takes under a
minute but can take longer under load. If your application builds a second transaction before the first
confirms, it must not select the same coins again, or one of the two transactions will fail.

- Keep a set of coin ids used by your pending transactions, and exclude them from coin selection until
  their spends confirm or the transaction is dropped.
- Subscribe to coin state updates for your puzzle hashes with the [peer protocol](/sdk/networking/peer),
  or poll an [RPC client](/sdk/networking/rpc), to learn when coins are spent and created.
- Treat a transaction as failed if its coins are spent by something else, and as dropped if it hasn't
  confirmed after some time and isn't in the mempool any more. Then release its coins.

The action system can help here too. `Deltas::from_actions` tells you how much of each asset a set of
actions needs before you select coins, so you only reserve what you need. See
[coin selection with deltas](/sdk/action-system#coin-selection-with-deltas).

## Recognize the coins you receive

To find out what a coin is, fetch its parent's spend and let the primitives parse it. Check the
parsers in order (CAT, NFT, DID and so on), and treat the coin as XCH if its puzzle hash is one of yours.
The [primitives overview](/sdk/primitives#parsing-from-the-parent-coin-spend) has a complete example. Always
confirm that the parsed p2 puzzle hash is one of yours before you show it as a balance: anyone can send
or hint anything to your address.

## Estimate fees from cost

The mempool prioritizes transactions by fee per cost. `spend_bundle_cost` computes the cost of a set of
coin spends locally, so you can multiply it by a fee rate before submitting. See
[estimating cost](/sdk/utilities#estimating-cost) for an example. The SDK's RPC clients don't wrap a fee
estimate endpoint, so get current fee rates from your full node's `get_fee_estimate` RPC or another
source.

## Test against the simulator first

Everything above can be tested without a network. The [simulator](/sdk/testing) validates spend
bundles the same way a full node does (puzzles, conditions, signatures and timelocks), so most bugs in
transaction building show up as test failures instead of rejected mainnet transactions. The
[peer simulator](/sdk/testing/peer-simulator) covers code that talks to a full node.
