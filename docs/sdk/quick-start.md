---
title: Quick Start
---

# Quick Start

This page builds a first transaction three ways: by hand with the standard puzzle, declaratively with
the action system, and finally against mainnet. The first two run entirely on your machine against the
[simulator](/sdk/testing), so you can paste them into a test file and run `cargo test`.

## Set up a project

```bash
cargo new --lib my-chia-app
cd my-chia-app
cargo add chia-wallet-sdk --features rustls
cargo add anyhow
cargo add tokio --features full
```

`anyhow` and `tokio` aren't required by the SDK, but the examples on these pages use them for error
handling and async networking.

## Send XCH by hand

Alice owns a coin worth 1,000 mojos. She sends 900 mojos to Bob and leaves 100 mojos as the fee.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn send_xch() -> anyhow::Result<()> {
    // A fresh simulated blockchain, and a key pair with a 1,000 mojo coin.
    let mut sim = Simulator::new();
    let alice = sim.bls(1_000);
    let bob = BlsPair::new(1);

    // The context holds CLVM memory and collects the coin spends.
    let ctx = &mut SpendContext::new();

    // What Alice's coin should do when it's spent. The hint lets Bob's wallet find the coin.
    let hint = ctx.hint(bob.puzzle_hash)?;
    let conditions = Conditions::new()
        .create_coin(bob.puzzle_hash, 900, hint)
        .reserve_fee(100);

    // Alice's coin is locked by the standard puzzle with her public key.
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;

    // Sign the collected spends with Alice's key and submit them to the simulator.
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let bob_coins = sim.unspent_coins(bob.puzzle_hash, false);
    assert_eq!(bob_coins.len(), 1);
    assert_eq!(bob_coins[0].amount, 900);

    Ok(())
}
```

What happened:

- [`SpendContext`](/sdk/concepts/spend-context) is where every puzzle and solution is built. It
  collects the coin spends you add, and `take()` hands them back.
- [`Conditions`](/sdk/concepts/conditions) is a builder for the conditions a coin outputs when it's
  spent. Here, one new coin and a fee.
- [`StandardLayer`](/sdk/primitives/standard) knows how to spend coins locked by the standard
  transaction puzzle. `spend` builds the puzzle reveal and solution and adds the coin spend to the context.
- `Simulator::spend_coins` works out which signatures are required, signs them with the keys you pass, and
  validates the resulting spend bundle exactly like a full node would. A mistake such as outputs that
  exceed the input, or a missing signature, comes back as an error.

The amounts must balance: the inputs (1,000) have to cover the outputs (900) plus the fee (100). Any
mojos you don't assign to a coin go to the farmer, so forgetting a change output silently overpays.

## Send XCH with the action system

For anything beyond a single coin, it's easier to say what should happen and let the
[action system](/sdk/action-system) work out the spends. It calculates change, adds the fee, and links
the spends so they can't be separated.

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn send_xch_with_actions() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let alice = sim.bls(1_000);
    let bob = BlsPair::new(1);
    let ctx = &mut SpendContext::new();

    // Coins to spend, and where change goes.
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    // What the transaction should do.
    let deltas = spends.apply(
        ctx,
        &[
            Action::send(Id::Xch, bob.puzzle_hash, 250, Memos::None),
            Action::fee(50),
        ],
    )?;

    // Spend every coin with the standard puzzle, using the key that matches its puzzle hash.
    let outputs = spends.finish_with_keys(
        ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob's payment, plus 700 mojos of change back to Alice.
    assert_eq!(outputs.xch.len(), 2);
    assert_eq!(sim.unspent_coins(alice.puzzle_hash, false)[0].amount, 700);

    Ok(())
}
```

The same pattern issues CATs, mints NFTs and DIDs, and takes offers. See the
[action reference](/sdk/action-system/actions) for every action.

## Going to mainnet

On a real network, three things change: the keys come from the user's wallet, the coins come from a
full node, and the signature has to be made for the right network. This function sends XCH from the
first address of a wallet using [coinset.org](https://coinset.org):

```rust
use std::collections::HashMap;

use chia_wallet_sdk::chia::bls::{master_to_wallet_unhardened, sign};
use chia_wallet_sdk::chia::puzzle_types::DeriveSynthetic;
use chia_wallet_sdk::prelude::*;

pub async fn send_on_mainnet(
    master_sk: &SecretKey,
    recipient_address: &str,
    amount: u64,
    fee: u64,
) -> anyhow::Result<Bytes32> {
    let client = CoinsetClient::mainnet();

    // Wallets lock coins to the standard puzzle with a synthetic key, derived per address index.
    let sk = master_to_wallet_unhardened(master_sk, 0).derive_synthetic();
    let p2 = StandardLayer::new(sk.public_key());
    let puzzle_hash: Bytes32 = p2.tree_hash().into();

    // Decode the recipient's address, making sure it's a mainnet address.
    let recipient = Address::decode(recipient_address)?.expect_prefix("xch")?;

    // Find unspent coins and pick enough of them to cover the amount and fee.
    let records = client
        .get_coin_records_by_puzzle_hash(puzzle_hash, None, None, Some(false), None)
        .await?
        .coin_records
        .unwrap_or_default();
    let coins: Vec<Coin> = records.into_iter().map(|record| record.coin).collect();
    let selected = select_coins(coins, amount + fee)?;
    let total: u64 = selected.iter().map(|coin| coin.amount).sum();

    // The first coin creates the payment and change. Every coin asserts that the first one is spent
    // in the same block, so the spends can't be separated.
    let ctx = &mut SpendContext::new();
    let hint = ctx.hint(recipient)?;

    for (index, &coin) in selected.iter().enumerate() {
        let conditions = if index == 0 {
            let mut conditions = Conditions::new()
                .create_coin(recipient, amount, hint)
                .reserve_fee(fee);
            if total > amount + fee {
                conditions = conditions.create_coin(puzzle_hash, total - amount - fee, Memos::None);
            }
            conditions
        } else {
            Conditions::new().assert_concurrent_spend(selected[0].coin_id())
        };
        p2.spend(ctx, coin, conditions)?;
    }

    // Sign every required message with the synthetic key, using mainnet's constants.
    let coin_spends = ctx.take();
    let keys = HashMap::from([(sk.public_key(), &sk)]);
    let mut signature = Signature::default();
    for required in RequiredSignature::from_coin_spends(
        ctx,
        &coin_spends,
        &AggSigConstants::from(&*MAINNET_CONSTANTS),
    )? {
        let RequiredSignature::Bls(required) = required else {
            anyhow::bail!("unexpected secp signature");
        };
        let sk = keys
            .get(&required.public_key)
            .ok_or_else(|| anyhow::anyhow!("missing key"))?;
        signature += &sign(sk, required.message());
    }

    let spend_bundle = SpendBundle::new(coin_spends, signature);
    let transaction_id = spend_bundle.name();

    let response = client.push_tx(spend_bundle).await?;
    if !response.success {
        anyhow::bail!("push_tx failed: {}", response.error.unwrap_or_default());
    }

    Ok(transaction_id)
}
```

A production wallet would also scan more than one address index, check that coins aren't already being
spent in the mempool, and wait for confirmation. The pages linked below cover each of these pieces:

- [Keys & Signing](/sdk/concepts/signing) for key derivation, synthetic keys and network constants.
- [RPC clients](/sdk/networking/rpc) and the [peer protocol](/sdk/networking/peer) for finding coins and
  broadcasting.
- [Utilities](/sdk/utilities) for addresses and coin selection.
- [Testing](/sdk/testing) for testing code like this against the simulator before it touches mainnet.
