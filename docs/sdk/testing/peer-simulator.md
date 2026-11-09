---
title: Peer Simulator
---

# Peer Simulator

`PeerSimulator` runs a [`Simulator`](/sdk/testing) behind a local WebSocket server that speaks the Chia
wallet protocol. You connect a real [`Peer`](/sdk/networking/peer) to it, so code that syncs coin state,
handles subscriptions or submits transactions over the peer protocol can be tested end to end without a
full node.

Use it to test the networking side of a wallet: puzzle and coin state requests, pagination,
subscription updates and transaction submission. For testing spends alone, the plain `Simulator` is
simpler and faster.

:::info Feature flag
`PeerSimulator` requires the `peer-simulator` feature of `chia-wallet-sdk`, and a Tokio runtime. It's
usually only needed in tests, so enable it in `dev-dependencies`:

```toml
[dev-dependencies]
chia-wallet-sdk = { version = "0.36", features = ["peer-simulator"] }
tokio = { version = "1", features = ["full"] }
```

:::

## Starting a simulator and connecting

`PeerSimulator::new()` binds a random port on `127.0.0.1` and starts serving in a background task. The
server shuts down when the `PeerSimulator` is dropped. There are three ways to connect:

| Method            | Returns                           | Behavior                                                                             |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `connect()`       | `Peer`                            | Discards the initial `NewPeakWallet` and spawns a task that drains incoming messages |
| `connect_split()` | `(Peer, mpsc::Receiver<Message>)` | Discards the initial `NewPeakWallet` and gives you the receiver for later events     |
| `connect_raw()`   | `(Peer, mpsc::Receiver<Message>)` | Leaves the initial `NewPeakWallet` in the receiver                                   |

The connection is plain `ws://` with no TLS and no handshake, so you don't need a certificate or the
`rustls`/`native-tls` features. The `Peer` you get is the same type you'd use against a full node.

`PeerSimulator` derefs to `tokio::sync::Mutex<Simulator>`. Lock it to create coins and inspect state,
using the same methods as the [Simulator](/sdk/testing).

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{PeerSimulator, sign_transaction};

#[tokio::test]
async fn send_transaction_to_simulator() -> anyhow::Result<()> {
    let sim = PeerSimulator::new().await?;
    let peer = sim.connect().await?;

    // Fund a key pair directly in the simulator.
    let alice = sim.lock().await.bls(1_000);
    let bob = BlsPair::new(1);

    // Build and sign the transaction as you would for mainnet.
    let ctx = &mut SpendContext::new();
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bob.puzzle_hash, 1_000, Memos::None),
    )?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;

    // Submit it over the peer protocol.
    let ack = peer
        .send_transaction(SpendBundle::new(coin_spends, signature))
        .await?;
    assert_eq!(ack.status, 1, "{:?}", ack.error);

    // Query the result over the peer protocol too.
    let response = peer
        .request_coin_state(
            vec![alice.coin.coin_id()],
            None,
            sim.config().genesis_challenge,
            false,
        )
        .await?
        .expect("request was rejected");
    assert!(response.coin_states[0].spent_height.is_some());

    Ok(())
}
```

`sign_transaction` signs with testnet11's `AGG_SIG_ME` data, which matches the peer simulator's
validation rules. Like the plain simulator, each accepted transaction is confirmed immediately in its
own block.

## Subscriptions and events

When a transaction is accepted, the simulator sends every connected peer a `NewPeakWallet`, and sends a
`CoinStateUpdate` to each peer subscribed to an affected coin ID, puzzle hash or hint. Subscribe with
`request_puzzle_state` / `request_coin_state` (with the subscribe flag set) or with
`register_for_ph_updates` / `register_for_coin_updates`, then read the events from the receiver returned
by `connect_split`.

```rust
use std::time::Duration;

use chia_wallet_sdk::chia::protocol::{
    CoinStateFilters, CoinStateUpdate, Message, ProtocolMessageTypes,
};
use chia_wallet_sdk::chia::traits::Streamable;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{PeerSimulator, sign_transaction};
use tokio::sync::mpsc;

async fn next_coin_update(
    receiver: &mut mpsc::Receiver<Message>,
) -> anyhow::Result<CoinStateUpdate> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await?
            .expect("connection closed");

        if message.msg_type == ProtocolMessageTypes::CoinStateUpdate {
            return Ok(CoinStateUpdate::from_bytes(&message.data)?);
        }
    }
}

#[tokio::test]
async fn receives_payment_notification() -> anyhow::Result<()> {
    let sim = PeerSimulator::new().await?;

    // Bob's wallet connects and subscribes to his puzzle hash.
    let (bob_peer, mut bob_events) = sim.connect_split().await?;
    let bob = BlsPair::new(1);

    let existing = bob_peer
        .request_puzzle_state(
            vec![bob.puzzle_hash],
            None,
            sim.config().genesis_challenge,
            CoinStateFilters::new(true, true, true, 0),
            true,
        )
        .await?
        .expect("request was rejected");
    assert!(existing.coin_states.is_empty());

    // Alice pays Bob from a separate connection.
    let alice_peer = sim.connect().await?;
    let alice = sim.lock().await.bls(1_000);

    let ctx = &mut SpendContext::new();
    let memos = ctx.hint(bob.puzzle_hash)?;
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bob.puzzle_hash, 1_000, memos),
    )?;
    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;

    let ack = alice_peer
        .send_transaction(SpendBundle::new(coin_spends, signature))
        .await?;
    assert_eq!(ack.status, 1);

    // Bob is told about his new coin.
    let update = next_coin_update(&mut bob_events).await?;
    assert_eq!(update.items.len(), 1);
    assert_eq!(update.items[0].coin.puzzle_hash, bob.puzzle_hash);
    assert_eq!(update.items[0].coin.amount, 1_000);
    assert_eq!(update.height, sim.lock().await.height());

    Ok(())
}
```

Updates are only sent for transactions submitted through a peer. Changes you make directly through the
`Simulator` (such as `new_coin` or `spend_coins` on the locked simulator) don't notify anyone, so set up
those coins before the code under test subscribes, or submit spends with `send_transaction`.

## Rejected transactions

An invalid transaction isn't a Rust error. The simulator answers with a `TransactionAck` whose `status`
is `3` (failed) and whose `error` describes the consensus error, just as a full node would. This lets you
test your wallet's handling of rejections:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::PeerSimulator;

#[tokio::test]
async fn rejects_unsigned_spend() -> anyhow::Result<()> {
    let sim = PeerSimulator::new().await?;
    let peer = sim.connect().await?;
    let alice = sim.lock().await.bls(1_000);

    let ctx = &mut SpendContext::new();
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, Memos::None),
    )?;

    // No signature.
    let ack = peer
        .send_transaction(SpendBundle::new(ctx.take(), Signature::default()))
        .await?;

    assert_eq!(ack.status, 3);
    assert!(ack.error.unwrap().contains("BadAggregateSignature"));

    // The coin is still unspent.
    let coin_state = sim.lock().await.coin_state(alice.coin.coin_id()).unwrap();
    assert_eq!(coin_state.spent_height, None);

    Ok(())
}
```

## Supported requests

The simulator implements the requests a light wallet needs:

- `send_transaction`
- `request_puzzle_state` and `request_coin_state`, including filters, subscriptions and resuming from a
  `previous_height` and `header_hash` (see [Known issues](#known-issues))
- `register_for_ph_updates` and `register_for_coin_updates`
- `remove_puzzle_subscriptions` and `remove_coin_subscriptions`
- `request_puzzle_and_solution` and `request_children`

Any other message (for example `request_peers`, `request_transaction` or block requests) is unsupported.
The simulator logs an error and closes that connection, so the request never gets a response.

## Configuration

`PeerSimulator::with_config` takes a `PeerSimulatorConfig`:

| Field                     | Default                       | Effect                                                                                       |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `genesis_challenge`       | testnet11's genesis challenge | The header hash to pass with `previous_height: None` in state requests                       |
| `max_subscriptions`       | 200,000                       | Subscriptions allowed per peer before requests are rejected with `ExceededSubscriptionLimit` |
| `max_response_coins`      | 100,000                       | Maximum coin states returned by `request_coin_state`                                         |
| `puzzle_state_batch_size` | 30,000                        | Above this many coin states, `request_puzzle_state` splits the response into pages           |

`reset()` replaces the simulator state and all subscriptions with fresh ones, without restarting the
server or dropping connections. The underlying `Simulator` always uses the default `SimulatorConfig`.

## Known issues

Two parts of the state requests don't currently behave like a full node, so don't rely on the simulator
to test them:

- Rejections are sent with the response's message type. When the simulator rejects a
  `request_puzzle_state` or `request_coin_state` (reorg or subscription limit) or a
  `request_puzzle_and_solution` (coin not spent at that height), the `Peer` tries to decode the rejection as a response and returns
  `ClientError::Streamable` instead of the inner `Err(rejection)`.
- When a `request_puzzle_state` response is split into pages, the `height` it returns is the first
  height it left out, rather than the last height it included. A client that resumes from that height,
  as it should against a full node, skips the coins created or spent at that height.

## Gotchas

- Don't hold the simulator lock across a peer request. The server locks the same mutex to answer, so
  `let guard = sim.lock().await;` followed by `peer.request_coin_state(...).await` deadlocks. Scope the
  guard in a block, or lock it inline (`sim.lock().await.bls(1_000)`).
- If you use `connect_split` or `connect_raw`, keep reading the receiver or drop it. A full receiver
  blocks the connection, including responses to your requests.
- The simulator validates with testnet11's constants regardless of `genesis_challenge`, so always sign
  for testnet11.

See the [chia-sdk-test rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/test/index.html)
for the full API.
