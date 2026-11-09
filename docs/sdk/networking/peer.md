---
title: Peer Protocol
---

# Peer Protocol

The `chia-sdk-client` crate (re-exported as `chia_wallet_sdk::client`) connects directly to Chia full
nodes over the peer-to-peer wallet protocol, the same protocol the reference light wallet uses. A `Peer`
is a single authenticated WebSocket connection to one full node. Through it you can look up coin state,
subscribe to puzzle hashes and coin IDs, fetch the puzzle and solution of a spent coin, and submit
transactions.

Use the peer protocol when you want a self-contained light wallet that talks to the network with no
trusted third party. If you would rather make HTTP calls to a hosted indexer or your own full node's RPC,
use the [RPC clients](/sdk/networking/rpc) instead. Both approaches give you the same `Coin`,
`CoinState` and `CoinSpend` types, so the rest of the SDK works the same either way.

:::info Feature flags
Connecting requires a TLS backend. Enable exactly one of the `rustls` or `native-tls` features on
`chia-wallet-sdk`. Without one, `Peer::connect`, `connect_peer`, `Client` and the connector helpers are
not compiled. `Peer`, `PeerOptions`, `Network` and the rate limiter types are always available.
:::

```toml
[dependencies]
chia-wallet-sdk = { version = "0.37", features = ["rustls"] }
tokio = { version = "1", features = ["full"] }
```

## How it fits together

| Item                                                      | Role                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ChiaCertificate` (`chia_wallet_sdk::chia::ssl`)          | The client TLS certificate and key that identify your node to the peer               |
| `load_ssl_cert`                                           | Loads a certificate from disk, or generates and saves one if the files can't be read |
| `create_rustls_connector` / `create_native_tls_connector` | Builds a `Connector` (TLS config) from a certificate                                 |
| `Network`                                                 | Default port, genesis challenge and DNS introducers for mainnet or testnet11         |
| `connect_peer`                                            | Opens the WebSocket, performs the wallet handshake and checks the network ID         |
| `Peer`                                                    | Cloneable handle for sending requests on one connection                              |
| `mpsc::Receiver<Message>`                                 | Messages the peer pushes to you unprompted: new peaks and coin state updates         |
| `Client` / `ClientState`                                  | Optional bookkeeping for many peers, with ban and trust lists                        |
| `ClientError`                                             | Every error the crate returns                                                        |

## Certificates and connectors

Full nodes require mutual TLS, but they accept any self-signed client certificate. You don't need the
certificate of an installed Chia node. Generating one with `ChiaCertificate::generate` works, but the
certificate is part of how a peer identifies you, so a long-running wallet should generate it once and
keep it. `load_ssl_cert` does that: it reads the PEM files if they exist, and otherwise generates a new
certificate and writes both files.

```rust
use chia_wallet_sdk::client::{create_rustls_connector, load_ssl_cert};

#[test]
fn persistent_certificate() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("chia-sdk-docs-peer-cert");
    std::fs::create_dir_all(&dir)?;
    let cert_path = dir.join("wallet.crt");
    let key_path = dir.join("wallet.key");

    // The first call generates the files, later calls load the same certificate.
    let cert = load_ssl_cert(cert_path.to_str().unwrap(), key_path.to_str().unwrap())?;
    let again = load_ssl_cert(cert_path.to_str().unwrap(), key_path.to_str().unwrap())?;
    assert_eq!(cert.cert_pem, again.cert_pem);

    // A connector is the TLS configuration used to open connections. It's cheap to clone.
    let _connector = create_rustls_connector(&cert)?;

    Ok(())
}
```

With the `native-tls` feature, use `create_native_tls_connector` instead. Both connectors present your
certificate and skip verification of the full node's certificate, because full nodes also use self-signed
certificates. The connection is encrypted, but the server's identity isn't authenticated, so treat data
from any single peer as untrusted.

:::warning
`load_ssl_cert` overwrites the paths you give it when it can't read them. Don't point it at the
certificate files of an existing Chia installation unless you're sure they exist. To use existing
certificate files, read them yourself and construct `ChiaCertificate { cert_pem, key_pem }`.
:::

## Connecting to a peer

`connect_peer` opens a `wss://<ip>:<port>/ws` connection, sends a `Handshake` that identifies you as a
wallet, and waits for the full node's handshake. It fails with `ClientError::WrongNetwork` if the node
is on a different network, and `ClientError::WrongNodeType` if the remote isn't a full node. The network
ID is `"mainnet"` or `"testnet11"`.

To find peers, `Network::default_mainnet()` and `Network::default_testnet11()` include the DNS
introducers run by Chia Network and the community. `lookup_all` resolves them in batches and returns
socket addresses on the network's default port (8444 for mainnet, 58444 for testnet11). Many of the
returned addresses won't accept a connection, so try several with a timeout.

```rust
use std::time::Duration;

use chia_wallet_sdk::chia::protocol::Message;
use chia_wallet_sdk::chia::ssl::ChiaCertificate;
use chia_wallet_sdk::client::{Network, connect_peer, create_rustls_connector};
use chia_wallet_sdk::prelude::*;
use tokio::sync::mpsc;

async fn connect_to_mainnet(
    cert: &ChiaCertificate,
) -> anyhow::Result<(Peer, mpsc::Receiver<Message>)> {
    let connector = create_rustls_connector(cert)?;
    let network = Network::default_mainnet();

    // Resolve two introducers at a time, waiting at most 5 seconds for each.
    let addrs = network.lookup_all(Duration::from_secs(5), 2).await;

    for addr in addrs {
        let attempt = connect_peer(
            "mainnet".to_string(),
            connector.clone(),
            addr,
            PeerOptions::default(),
        );

        match tokio::time::timeout(Duration::from_secs(3), attempt).await {
            Ok(Ok((peer, receiver))) => return Ok((peer, receiver)),
            Ok(Err(error)) => eprintln!("{addr}: {error}"),
            Err(_) => eprintln!("{addr}: timed out"),
        }
    }

    anyhow::bail!("could not connect to any mainnet peer")
}
```

`Peer::connect` and `Peer::connect_full_uri` open the connection without sending the handshake. Use
them only if you want to send your own `Handshake` message. For anything else, use `connect_peer`.

A `Peer` is an `Arc` around the connection, so clone it freely and share it between tasks. Requests
from multiple tasks can be in flight at once, because each request gets a message ID and the response is
routed back to the caller that sent it. Call `peer.close()` to close the WebSocket. Dropping the last
clone stops the background task that reads incoming messages.

## Requesting state

All wallet protocol requests are `async` methods on `Peer`. Some requests can be rejected by the node,
so those methods return `Result<Result<Response, Rejection>, ClientError>`. The outer `Result` reports
connection and decoding failures. The inner one is the node's answer.

| Method                                                      | Returns                                                | Use it to                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `request_puzzle_state`                                      | `Result<RespondPuzzleState, RejectPuzzleState>`        | Fetch (and optionally subscribe to) every coin with given puzzle hashes or hints |
| `request_coin_state`                                        | `Result<RespondCoinState, RejectCoinState>`            | Fetch (and optionally subscribe to) coins by ID                                  |
| `request_puzzle_and_solution`                               | `Result<PuzzleSolutionResponse, RejectPuzzleSolution>` | Get the reveal and solution of a coin spent at a given height                    |
| `request_children`                                          | `RespondChildren`                                      | List coins created by a spent coin                                               |
| `register_for_ph_updates`                                   | `RespondToPhUpdates`                                   | Older subscription API for puzzle hashes                                         |
| `register_for_coin_updates`                                 | `RespondToCoinUpdates`                                 | Older subscription API for coin IDs                                              |
| `remove_puzzle_subscriptions` / `remove_coin_subscriptions` | Removed hashes or IDs                                  | Unsubscribe (pass `None` to remove all)                                          |
| `send_transaction`                                          | `TransactionAck`                                       | Submit a `SpendBundle` to the node's mempool                                     |
| `request_transaction`                                       | `RespondTransaction`                                   | Fetch a mempool transaction by ID                                                |
| `request_peers`                                             | `RespondPeers`                                         | Ask the node for other peers                                                     |

The request and response types are defined in `chia-protocol` and re-exported as
`chia_wallet_sdk::chia::protocol`. For anything not covered, `request_infallible`, `request_fallible`
and `request_raw` send any `ChiaProtocolMessage` and decode the reply into the types you name. `send`
sends a message without waiting for a reply.

### Syncing a puzzle hash

`request_puzzle_state` is the main way a light wallet discovers its coins. It takes a `header_hash` and
`previous_height` that describe where to resume from. For the first request, pass `None` and the
network's genesis challenge. The node returns up to a batch of coin states, the height and header hash
it got to, and `is_finished`. If it isn't finished, ask again from where it stopped. If the chain
reorganized past that point in the meantime, the node rejects the request with
`RejectStateReason::Reorg` and you have to restart from an earlier point.

The `CoinStateFilters` select spent and unspent coins, whether to include coins hinted with the puzzle
hash (not just coins locked by it), and a minimum amount. With `subscribe_when_finished` set, the node
also subscribes you to those puzzle hashes after the last batch, so later changes arrive on the
receiver.

```rust
use chia_wallet_sdk::chia::protocol::CoinStateFilters;
use chia_wallet_sdk::prelude::*;

/// Returns every coin state for `puzzle_hash` and subscribes to future updates.
pub async fn sync_puzzle_hash(
    peer: &Peer,
    puzzle_hash: Bytes32,
    genesis_challenge: Bytes32,
) -> anyhow::Result<Vec<CoinState>> {
    let mut coin_states = Vec::new();
    let mut previous_height = None;
    let mut header_hash = genesis_challenge;

    loop {
        let response = peer
            .request_puzzle_state(
                vec![puzzle_hash],
                previous_height,
                header_hash,
                CoinStateFilters::new(true, true, true, 0),
                true,
            )
            .await?
            .map_err(|rejection| anyhow::anyhow!("rejected: {:?}", rejection.reason))?;

        coin_states.extend(response.coin_states);

        if response.is_finished {
            return Ok(coin_states);
        }

        previous_height = Some(response.height);
        header_hash = response.header_hash;
    }
}

#[cfg(test)]
mod tests {
    use chia_wallet_sdk::test::PeerSimulator;

    use super::*;

    #[tokio::test]
    async fn sync_against_simulator() -> anyhow::Result<()> {
        let sim = PeerSimulator::new().await?;
        let peer = sim.connect().await?;

        let alice = sim.lock().await.bls(1_000);

        let coin_states =
            sync_puzzle_hash(&peer, alice.puzzle_hash, sim.config().genesis_challenge).await?;

        assert_eq!(coin_states.len(), 1);
        assert_eq!(coin_states[0].coin, alice.coin);
        assert_eq!(coin_states[0].spent_height, None);

        Ok(())
    }
}
```

The test runs the helper against a local [Peer Simulator](/sdk/testing/peer-simulator), which speaks
the same protocol as a full node.

### Looking up a parent spend

To spend a CAT, NFT, DID or other primitive, you need its parent's puzzle reveal and solution (see
[Primitives](/sdk/primitives)). Look up the coin's state to find the parent, then fetch the parent's
spend at the height it was spent, which is the height the child was created.

```rust
use chia_wallet_sdk::prelude::*;

/// Fetches the spend that created `coin_id`.
pub async fn fetch_parent_spend(
    peer: &Peer,
    coin_id: Bytes32,
    genesis_challenge: Bytes32,
) -> anyhow::Result<Option<CoinSpend>> {
    let response = peer
        .request_coin_state(vec![coin_id], None, genesis_challenge, false)
        .await?
        .map_err(|rejection| anyhow::anyhow!("rejected: {:?}", rejection.reason))?;

    let Some(coin_state) = response.coin_states.first() else {
        return Ok(None);
    };
    let Some(created_height) = coin_state.created_height else {
        return Ok(None);
    };

    let parent_id = coin_state.coin.parent_coin_info;

    let parent = peer
        .request_coin_state(vec![parent_id], None, genesis_challenge, false)
        .await?
        .map_err(|rejection| anyhow::anyhow!("rejected: {:?}", rejection.reason))?;

    let Some(parent_state) = parent.coin_states.first() else {
        return Ok(None);
    };

    let Ok(puzzle_and_solution) = peer
        .request_puzzle_and_solution(parent_id, created_height)
        .await?
    else {
        return Ok(None);
    };

    Ok(Some(CoinSpend::new(
        parent_state.coin,
        puzzle_and_solution.puzzle,
        puzzle_and_solution.solution,
    )))
}
```

### Submitting a transaction

`send_transaction` submits a signed `SpendBundle` and returns the node's `TransactionAck`. The `status`
field follows the full node's `MempoolInclusionStatus`: `1` means the transaction entered the mempool,
`2` means the node is holding it as pending but hasn't added it to the mempool yet, and `3` means it
failed. `error` holds the reason when it failed.

```rust
use chia_wallet_sdk::prelude::*;

pub async fn broadcast(peer: &Peer, spend_bundle: SpendBundle) -> anyhow::Result<Bytes32> {
    let ack = peer.send_transaction(spend_bundle).await?;

    match ack.status {
        1 => Ok(ack.txid),
        2 => {
            eprintln!("transaction {} is pending: {:?}", ack.txid, ack.error);
            Ok(ack.txid)
        }
        _ => anyhow::bail!("transaction failed: {}", ack.error.unwrap_or_default()),
    }
}
```

An accepted transaction isn't confirmed yet. Wait for a coin state update that shows the spent coins
with a `spent_height`, and consider rebroadcasting to other peers in case the first one drops it.

## Events

`connect_peer` returns an `mpsc::Receiver<Message>` alongside the `Peer`. Responses to your requests go
to the callers that made them. Everything the node sends on its own goes to the receiver. For a wallet,
that's mainly:

- `NewPeakWallet`: the node has a new peak (header hash, height, weight and fork point). It's sent right
  after the handshake and then every time the chain advances.
- `CoinStateUpdate`: coins you subscribed to (by puzzle hash, hint or coin ID) were created, spent or
  reorged. `fork_height` tells you how far back the update reaches.

Messages are raw `Message` values. Match on `msg_type` and decode the body with `Streamable::from_bytes`.

```rust
use chia_wallet_sdk::chia::protocol::{
    CoinStateUpdate, Message, NewPeakWallet, ProtocolMessageTypes,
};
use chia_wallet_sdk::chia::traits::Streamable;
use tokio::sync::mpsc;

pub async fn handle_events(mut receiver: mpsc::Receiver<Message>) -> anyhow::Result<()> {
    while let Some(message) = receiver.recv().await {
        match message.msg_type {
            ProtocolMessageTypes::NewPeakWallet => {
                let peak = NewPeakWallet::from_bytes(&message.data)?;
                println!("new peak at height {}", peak.height);
            }
            ProtocolMessageTypes::CoinStateUpdate => {
                let update = CoinStateUpdate::from_bytes(&message.data)?;
                for coin_state in update.items {
                    println!(
                        "coin {} created at {:?}, spent at {:?}",
                        coin_state.coin.coin_id(),
                        coin_state.created_height,
                        coin_state.spent_height
                    );
                }
            }
            _ => {}
        }
    }

    // The channel closes when the connection does.
    Ok(())
}
```

The receiver buffers up to 32 messages. If you keep it but stop reading, the background reader blocks
once the buffer is full, and responses to your requests stop arriving too. Either drain it (for example
in a spawned task) or drop it, in which case unsolicited messages are discarded. When the connection
closes, the receiver returns `None`.

:::warning
Requests that are waiting for a response when the connection drops are not failed. Their futures stay
pending, so put a timeout on requests (see [Gotchas](#gotchas)) and treat the receiver closing as the
signal that the peer is gone. New requests on a closed connection fail with `ClientError::WebSocket`.
:::

## Managing multiple peers

A light wallet usually connects to several peers so that one slow or dishonest node can't stall it.
`Client` is a small helper for that. It holds the network ID, a `Network` and a connector, and keeps a
`ClientState` with the connected peers keyed by IP address, plus ban and trust lists. `Client` derefs to
a `tokio::sync::Mutex<ClientState>`.

```rust
use std::time::Duration;

use chia_wallet_sdk::chia::ssl::ChiaCertificate;
use chia_wallet_sdk::client::{Client, Network, create_rustls_connector};
use chia_wallet_sdk::prelude::*;

pub async fn connect_many(cert: &ChiaCertificate, target: usize) -> anyhow::Result<Client> {
    let network = Network::default_testnet11();
    let addrs = network.lookup_all(Duration::from_secs(5), 2).await;

    let client = Client::new(
        "testnet11".to_string(),
        network,
        create_rustls_connector(cert)?,
    );

    for addr in addrs {
        if client.lock().await.peers().count() >= target {
            break;
        }

        let connect = client.connect(addr, PeerOptions::default());
        if let Ok(Ok(receiver)) = tokio::time::timeout(Duration::from_secs(3), connect).await {
            tokio::spawn(async move {
                let mut receiver = receiver;
                while receiver.recv().await.is_some() {}
            });
        }
    }

    // Ban a misbehaving peer. Trusted peers can't be banned.
    let mut state = client.lock().await;
    let first = state.peers().next().map(Peer::socket_addr);
    if let Some(addr) = first {
        state.ban(addr.ip());
    }
    drop(state);

    Ok(client)
}
```

`Client::connect` refuses banned IPs with `ClientError::BannedPeer`, and `ban` also disconnects the peer.
`Client` doesn't discover peers, reconnect or pick which peer to ask; those policies are up to your
application.

## Rate limits

Full nodes enforce per-connection rate limits and disconnect peers that exceed them. To stay under the
limits, every `Peer` runs an outbound `RateLimiter` loaded with the node's `V2_RATE_LIMITS`. When a
message would exceed a limit, `send` waits (checking once per second) until the 60-second window resets
instead of sending it.

`PeerOptions::rate_limit_factor` scales the limits. The default of `0.6` uses 60% of what the node
allows, leaving headroom for differences between your clock and the node's. Raise it towards `1.0` if
you control the node, or lower it if you're being disconnected.

```rust
use chia_wallet_sdk::prelude::*;

fn conservative_options() -> PeerOptions {
    PeerOptions {
        rate_limit_factor: 0.3,
    }
}
```

`RateLimiter`, `RateLimits`, `RateLimit` and the `V1_RATE_LIMITS`/`V2_RATE_LIMITS` tables are public if
you need to apply the same limits elsewhere, for example on the server side of a test harness.

## Errors

Every fallible function returns `ClientError`. The variants you'll handle most often are:

| Variant                                                             | Meaning                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `WebSocket`, `Io`                                                   | The connection couldn't be opened or was lost                                   |
| `WrongNetwork`, `WrongNodeType`                                     | The handshake succeeded but the peer is on another network or isn't a full node |
| `MissingHandshake`                                                  | The connection closed before the peer sent its handshake                        |
| `InvalidResponse`                                                   | The peer replied with a message of the wrong type                               |
| `Recv`                                                              | The response channel for a request was dropped                                  |
| `Streamable`                                                        | A message couldn't be decoded                                                   |
| `Ssl`, `Rustls`, `NativeTls`, `Pem`, `MissingPkcs8Key`, `MissingCa` | Certificate or TLS setup failed                                                 |
| `BannedPeer`                                                        | `Client::connect` was called with a banned IP                                   |

Rejections such as `RejectPuzzleState` aren't errors. They're returned as the inner `Err` of the
request methods described above.

## Gotchas

- `Peer` has no request timeouts. A peer that never answers leaves the future pending forever, so wrap
  requests in `tokio::time::timeout` in production code.
- The peer simulator and full nodes support different subsets of messages. Requests the
  [peer simulator](/sdk/testing/peer-simulator) doesn't implement (such as `request_peers`) close the
  simulated connection.
- `request_puzzle_and_solution` needs the exact height at which the coin was spent. Use
  `spent_height` from the coin's `CoinState` (or the child's `created_height`).
- Coin states from a single peer are unauthenticated. For high-value decisions, confirm with more than
  one peer.

See the [chia-sdk-client rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/client/index.html)
for the full API and the [Chia wallet protocol docs](https://docs.chia.net/) for the underlying messages.
