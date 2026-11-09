---
title: Daemon Client
---

# Daemon Client

The `chia-sdk-daemon` crate (re-exported as `chia_wallet_sdk::daemon`) connects to the daemon of a
locally installed Chia node. The daemon is the process that starts and supervises the full node, wallet,
farmer and other services, and relays messages between them and UIs over a single WebSocket at
`wss://localhost:55400`.

`DaemonClient` gives you two things over that connection:

- Full node RPC calls. `DaemonClient` implements `ChiaRpcClient`, so every method described in
  [RPC Clients](/sdk/networking/rpc) works on it, routed through the daemon to the `chia_full_node`
  service.
- Events. You can register under a service name and receive the messages the daemon forwards to it,
  such as the `state_changed` notifications that drive the Chia GUI.

Use it when your application runs next to a Chia installation and you want live events, or you'd rather
hold one daemon connection than talk to each service's RPC port. For a node elsewhere, or when you don't
need events, a [`FullNodeClient`](/sdk/networking/rpc#connecting-to-your-own-full-node) is simpler.

:::info Feature flags
`DaemonClient` is only compiled with the `rustls` or `native-tls` feature. The message types
(`DaemonEvent`, `WebsocketRequest`, `WebsocketResponse`) and `DaemonError` are always available.
:::

## Connecting

The daemon uses mutual TLS with the installation's private CA, so connect with the daemon's private
certificate and key. A standard installation keeps them in
`~/.chia/mainnet/config/ssl/daemon/private_daemon.crt` and `private_daemon.key`. Read the files and build
a connector with the [TLS helpers from `chia-sdk-client`](/sdk/networking/peer#certificates-and-connectors).

```rust
use std::{path::Path, time::Duration};

use chia_wallet_sdk::chia::ssl::ChiaCertificate;
use chia_wallet_sdk::client::create_rustls_connector;
use chia_wallet_sdk::daemon::DaemonClient;
use chia_wallet_sdk::prelude::*;

async fn connect_daemon(chia_root: &Path) -> anyhow::Result<DaemonClient> {
    let ssl = chia_root.join("config/ssl/daemon");
    let cert = ChiaCertificate {
        cert_pem: std::fs::read_to_string(ssl.join("private_daemon.crt"))?,
        key_pem: std::fs::read_to_string(ssl.join("private_daemon.key"))?,
    };

    let client = DaemonClient::connect(
        "wss://localhost:55400",
        create_rustls_connector(&cert)?,
        // How long each request waits for its response.
        Duration::from_secs(30),
    )
    .await?;

    Ok(client)
}

async fn peak_height(client: &DaemonClient) -> anyhow::Result<Option<u32>> {
    let response = client.get_blockchain_state().await?;
    Ok(response.blockchain_state.map(|state| state.peak.height))
}
```

:::warning
Don't load the daemon certificate with `load_ssl_cert`. When it can't read the files, it generates a
new self-signed certificate and tries to write it to those paths, and the daemon rejects that
certificate. Paths starting with `~` are never expanded, so they always take that branch. Read the files
directly as above.
:::

On connect, the client picks a unique origin name (`chia-wallet-sdk-<timestamp>`) and registers it with
the daemon so that responses are routed back to it. `DaemonClient` is cheap to clone; all clones share
the connection.

## RPC calls

Every `ChiaRpcClient` method sends a request with the RPC endpoint as the command and `chia_full_node` as
the destination, then waits up to the timeout you passed to `connect`. Responses use the same types as
the HTTP clients, so code written against `ChiaRpcClient` works unchanged:

```rust
use chia_wallet_sdk::daemon::{DaemonClient, DaemonError};
use chia_wallet_sdk::prelude::*;

/// Works with a `DaemonClient`, `CoinsetClient`, `FullNodeClient` or `MockRpcClient`.
async fn coin_is_spent<C: ChiaRpcClient>(client: &C, coin_id: Bytes32) -> Result<bool, C::Error> {
    let response = client.get_coin_record_by_name(coin_id).await?;
    Ok(response.coin_record.is_some_and(|record| record.spent))
}

async fn check_with_daemon(client: &DaemonClient, coin_id: Bytes32) -> Result<bool, DaemonError> {
    coin_is_spent(client, coin_id).await
}
```

Requests always go to the full node. `DaemonClient` doesn't expose a way to send commands to the wallet,
farmer or daemon itself.

## Events

The daemon forwards messages to registered service names. `subscribe(service)` registers the client
under `service` (once per name) and returns a `tokio::sync::broadcast::Receiver<DaemonEvent>`. Each
`DaemonEvent` has the `command` (for example `state_changed`), the `origin` service that sent it, and the
JSON `data`.

Which name to register depends on what you want to hear. The Chia GUI registers as `wallet_ui` to
receive `state_changed` events from the full node and wallet. Services also send metrics events to
`metrics`.

```rust
use chia_wallet_sdk::daemon::DaemonClient;
use tokio::sync::broadcast::error::RecvError;

async fn watch_state_changes(client: &DaemonClient) -> anyhow::Result<()> {
    let mut events = client.subscribe("wallet_ui").await?;

    loop {
        match events.recv().await {
            Ok(event) if event.command == "state_changed" => {
                println!("{} changed: {}", event.origin, event.data["state"]);
            }
            Ok(_) => {}
            Err(RecvError::Lagged(skipped)) => eprintln!("missed {skipped} events"),
            Err(RecvError::Closed) => return Ok(()),
        }
    }
}
```

All subscriptions share one broadcast channel, which holds the last 256 events. A receiver gets every
event the daemon sends to this client, whatever service name it was registered under, so filter on
`origin` and `command`. A receiver that falls more than 256 events behind gets `RecvError::Lagged` and
skips ahead.

## Reconnection

If the WebSocket fails, the client reconnects on its own. It fails any requests waiting for a response
with `DaemonError::ReceiveFailed`, then retries with exponential backoff from 1 second up to 30 seconds.
After reconnecting, it registers its origin and every subscribed service again, so event receivers keep
working. While disconnected, new requests fail immediately with `DaemonError::ConnectionClosed`.

```rust
use chia_wallet_sdk::daemon::DaemonClient;

fn monitor_connection(client: &DaemonClient) {
    // Give up after 10 failed attempts instead of retrying forever.
    client.set_max_reconnect_attempts(Some(10));

    let mut disconnected = client.on_disconnect();
    let mut reconnected = client.on_reconnect();

    tokio::spawn(async move {
        while disconnected.recv().await.is_ok() {
            eprintln!("lost connection to the daemon");
        }
    });

    tokio::spawn(async move {
        while reconnected.recv().await.is_ok() {
            eprintln!("reconnected to the daemon");
        }
    });
}
```

Call `close()` to close the connection. Reconnection is triggered by read errors, so a connection that
the daemon closes cleanly is not reopened.

## Errors

| `DaemonError`        | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `WebSocket`          | The connection couldn't be opened or closed cleanly                           |
| `Json`               | A request couldn't be serialized or a response didn't match the expected type |
| `Timeout(duration)`  | No response arrived within the timeout given to `connect`                     |
| `ConnectionClosed`   | The client is disconnected and waiting to reconnect                           |
| `SendFailed`         | The request couldn't be written to the WebSocket                              |
| `ReceiveFailed`      | The connection dropped while the request was waiting                          |
| `ReconnectFailed(n)` | Reconnection gave up after `n` attempts (logged, not returned to callers)     |

As with the HTTP clients, an RPC error reported by the full node isn't a `DaemonError`. It comes back as
a response with `success: false` and an `error` message.

See the [chia-sdk-daemon rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/daemon/index.html)
and the [Chia daemon documentation](https://docs.chia.net/) for the underlying protocol.
