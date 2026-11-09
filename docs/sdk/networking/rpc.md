---
title: RPC Clients
---

# RPC Clients

The `chia-sdk-coinset` crate (re-exported as `chia_wallet_sdk::coinset`, and included in the prelude)
is an HTTP client for the full node RPC API. It talks to either a hosted [Coinset](https://coinset.org)
endpoint, which needs no setup, or your own full node's RPC server, which needs the node's TLS
certificate.

Use an RPC client when you want simple request/response access to chain data: looking up coins by
puzzle hash or hint, fetching a parent's puzzle and solution, reading block records, and pushing
transactions. There are no subscriptions or push notifications; for those, use the
[peer protocol](/sdk/networking/peer).

## Clients

| Type             | Connects to                                                                                                        | Feature                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `CoinsetClient`  | Any server with the full node RPC API over plain HTTPS (Coinset by default)                                        | Always available                          |
| `FullNodeClient` | Your full node's RPC port (`https://localhost:8555` by default), authenticated with the node's private certificate | `rustls` or `native-tls`, not on `wasm32` |
| `MockRpcClient`  | Nothing: returns canned JSON responses you register, for unit tests                                                | Always available                          |
| `DaemonClient`   | The Chia daemon's WebSocket, which forwards to the full node (see [Daemon client](/sdk/networking/daemon))         | `rustls` or `native-tls`                  |

All of them implement the `ChiaRpcClient` trait, which provides every RPC method. Write your code
against the trait and you can swap a hosted endpoint for a local node, or for a mock in tests.

## Querying Coinset

`CoinsetClient::mainnet()` and `CoinsetClient::testnet11()` point at `https://api.coinset.org` and
`https://testnet11.api.coinset.org`. Use `CoinsetClient::new(url)` for anything else, such as a
self-hosted Coinset instance.

```rust
use chia_wallet_sdk::prelude::*;

async fn print_peak() -> anyhow::Result<()> {
    let client = CoinsetClient::mainnet();

    let response = client.get_blockchain_state().await?;
    let Some(state) = response.blockchain_state else {
        anyhow::bail!("RPC error: {}", response.error.unwrap_or_default());
    };

    println!("peak height: {}", state.peak.height);
    println!("synced: {}", state.sync.synced);
    println!("mempool size: {}", state.mempool_size);

    Ok(())
}
```

### Checking responses

Each method returns `Result<Response, Self::Error>`. The `Err` case is a transport failure (the request
couldn't be sent, or the body couldn't be decoded). A request the node rejects still returns `Ok`, with
`success: false` and a message in `error`. The payload fields are `Option`s that are `None` in that
case, so check them rather than unwrapping.

## Methods

`ChiaRpcClient` implements these methods on top of a single required method, `make_post_request`, which
posts a JSON body to `<base_url>/<endpoint>`. Each one maps to the full node RPC endpoint of the same
name (see the [full node RPC reference](https://docs.chia.net/full-node-rpc/)).

| Area        | Methods                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain state | `get_blockchain_state`, `get_network_info`                                                                                                                     |
| Blocks      | `get_block`, `get_blocks`, `get_block_record`, `get_block_record_by_height`, `get_block_records`, `get_block_spends`, `get_additions_and_removals`             |
| Coins       | `get_coin_record_by_name`, `get_coin_records_by_names`, `get_coin_records_by_puzzle_hash(es)`, `get_coin_records_by_hint(s)`, `get_coin_records_by_parent_ids` |
| Spends      | `get_puzzle_and_solution`                                                                                                                                      |
| Mempool     | `push_tx`, `get_mempool_item_by_tx_id`, `get_mempool_items_by_coin_name`                                                                                       |

The response types (`BlockchainStateResponse`, `GetCoinRecordsResponse`, `CoinRecord`,
`PushTxResponse` and so on) are plain serde structs. `CoinRecord` has the `coin`, whether it's
`spent`, the `confirmed_block_index` and `spent_block_index` heights, `coinbase` and `timestamp`.

## Finding coins

The `get_coin_records_by_*` methods take optional `start_height`, `end_height` and
`include_spent_coins` filters, plus a `cursor`. Coinset caps how many records it returns per request:
when a response is cut short, it sets `truncated: Some(true)` and returns a `next_cursor` to pass back in
the next request. A Chia full node never truncates, and leaves both fields as `None`.

The function below is generic over `ChiaRpcClient`, so it works with any client:

```rust
use chia_wallet_sdk::prelude::*;

/// Returns the unspent coins locked by `puzzle_hash`, following pagination cursors.
pub async fn unspent_coins<C: ChiaRpcClient>(
    client: &C,
    puzzle_hash: Bytes32,
) -> Result<Vec<Coin>, C::Error> {
    let mut coins = Vec::new();
    let mut cursor = None;

    loop {
        let response = client
            .get_coin_records_by_puzzle_hash(puzzle_hash, None, None, Some(false), cursor)
            .await?;

        coins.extend(
            response
                .coin_records
                .unwrap_or_default()
                .into_iter()
                .filter(|record| !record.spent)
                .map(|record| record.coin),
        );

        match response.next_cursor {
            Some(next) if response.truncated == Some(true) => cursor = Some(next),
            _ => return Ok(coins),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finds_unspent_coins() -> Result<(), Box<dyn std::error::Error>> {
        let mut client = MockRpcClient::new();

        client.mock_response(
            "http://api.example.com/get_coin_records_by_puzzle_hash",
            r#"{
                "coin_records": [{
                    "coin": {
                        "parent_coin_info": "0x4dda4b8b6017c633794c2b719c3591870b4bc7682930094c11a311112c772ce6",
                        "puzzle_hash": "0x18cfd81a9a58d598197730b2f2a21ff3b72951577be1dcc6004080ad17069e84",
                        "amount": 1000
                    },
                    "coinbase": false,
                    "confirmed_block_index": 5612341,
                    "spent": false,
                    "spent_block_index": 0,
                    "timestamp": 1720407964
                }],
                "success": true
            }"#,
        );

        let puzzle_hash = Bytes32::new(hex_literal::hex!(
            "18cfd81a9a58d598197730b2f2a21ff3b72951577be1dcc6004080ad17069e84"
        ));

        let coins = unspent_coins(&client, puzzle_hash).await?;
        assert_eq!(coins.len(), 1);
        assert_eq!(coins[0].amount, 1000);

        // The mock records every request, so you can check what was sent.
        let requests = client.get_requests();
        assert_eq!(
            requests[0].0,
            "http://api.example.com/get_coin_records_by_puzzle_hash"
        );
        assert_eq!(requests[0].1["include_spent_coins"], false);

        Ok(())
    }
}
```

To find CATs, NFTs and other assets sent to a wallet, use `get_coin_records_by_hint` with the wallet's
puzzle hash. Those coins are locked by an outer puzzle, so their puzzle hash differs from the wallet's,
but senders hint them with the recipient's puzzle hash (see
[Conditions](/sdk/concepts/conditions)).

## Fetching a parent spend

Parsing a primitive from the chain means getting its parent's coin spend (see
[Primitives](/sdk/primitives)). `get_puzzle_and_solution` returns it as a `CoinSpend`. Pass the height
the parent was spent at, which is the height the child was confirmed at.

```rust
use chia_wallet_sdk::prelude::*;

/// Returns the coin spend that created `coin_id`.
pub async fn parent_spend(
    client: &CoinsetClient,
    coin_id: Bytes32,
) -> anyhow::Result<Option<CoinSpend>> {
    let Some(record) = client.get_coin_record_by_name(coin_id).await?.coin_record else {
        return Ok(None);
    };

    let response = client
        .get_puzzle_and_solution(
            record.coin.parent_coin_info,
            Some(record.confirmed_block_index),
        )
        .await?;

    Ok(response.coin_solution)
}
```

## Pushing a transaction

`push_tx` submits a signed `SpendBundle`. On success, `status` is `"SUCCESS"` (or `"PENDING"` if the node
holds the transaction without adding it to the mempool yet). On failure, `success` is `false` and
`error` explains why.

```rust
use chia_wallet_sdk::prelude::*;

pub async fn broadcast<C: ChiaRpcClient>(
    client: &C,
    spend_bundle: SpendBundle,
) -> anyhow::Result<Bytes32>
where
    C::Error: std::error::Error + Send + Sync + 'static,
{
    let transaction_id = spend_bundle.name();
    let response = client.push_tx(spend_bundle).await?;

    if !response.success {
        anyhow::bail!("push_tx failed: {}", response.error.unwrap_or_default());
    }

    Ok(transaction_id)
}
```

Once pushed, poll `get_mempool_item_by_tx_id` to see whether it's still in the mempool, and
`get_coin_record_by_name` on one of the spent coins to see when it confirms.

## Connecting to your own full node

`FullNodeClient` talks to a full node's RPC server, which uses mutual TLS. Pass the PEM contents of the
node's private full node certificate and key, which a standard installation keeps in
`~/.chia/mainnet/config/ssl/full_node/private_full_node.crt` and `private_full_node.key`.
`FullNodeClient::new` connects to `https://localhost:8555`; use `with_base_url` for another host or
port. The server's certificate isn't verified, since nodes use self-signed certificates.

```rust
use std::path::Path;

use chia_wallet_sdk::prelude::*;

fn local_full_node(chia_root: &Path) -> anyhow::Result<FullNodeClient> {
    let ssl = chia_root.join("config/ssl/full_node");
    let cert = std::fs::read(ssl.join("private_full_node.crt"))?;
    let key = std::fs::read(ssl.join("private_full_node.key"))?;

    Ok(FullNodeClient::new(&cert, &key)?)
}

async fn local_network_name(chia_root: &Path) -> anyhow::Result<Option<String>> {
    let client = local_full_node(chia_root)?;
    Ok(client.get_network_info().await?.network_name)
}
```

:::info Feature flags
`FullNodeClient` is only compiled with the `rustls` or `native-tls` feature, and never on `wasm32`.
`CoinsetClient` and `MockRpcClient` are always available. In the browser, `CoinsetClient` uses `fetch`
through `reqwest`'s WASM support.
:::

## Implementing your own client

To route RPC calls through something else (a proxy, a client with custom headers or timeouts, a
recording layer), implement `ChiaRpcClient` yourself. You only need `base_url` and `make_post_request`;
every RPC method comes with the trait. The method's bounds use `serde`'s `Serialize` and
`DeserializeOwned`, so your crate needs a `serde` dependency to implement it.

This wrapper logs every call and then forwards it to another client:

```rust ignore
use chia_wallet_sdk::prelude::*;
use serde::{Serialize, de::DeserializeOwned};

struct Logged<C>(C);

impl<C: ChiaRpcClient + Sync> ChiaRpcClient for Logged<C> {
    type Error = C::Error;

    fn base_url(&self) -> &str {
        self.0.base_url()
    }

    async fn make_post_request<R, B>(&self, endpoint: &str, body: B) -> Result<R, Self::Error>
    where
        B: Serialize + Send,
        R: DeserializeOwned + Send,
    {
        println!("POST {}/{endpoint}", self.base_url());
        self.0.make_post_request(endpoint, body).await
    }
}

// Every trait method now goes through the wrapper.
async fn logged_peak() -> anyhow::Result<()> {
    let client = Logged(CoinsetClient::mainnet());
    let state = client.get_blockchain_state().await?;
    println!("{:?}", state.blockchain_state.map(|state| state.peak.height));
    Ok(())
}
```

## Testing

There are two ways to test RPC code without a network:

- `MockRpcClient` returns a fixed JSON string per URL (`http://api.example.com/<endpoint>`), as in the
  [example above](#finding-coins), and records the requests it received. It suits unit tests of parsing
  and request construction. It returns the same response every time, so it can't model state changes.
- The [Full Node Simulator](/sdk/testing/full-node-simulator) is an in-memory full node with a mempool
  and block farming that returns the same response types. With the `full-node-simulator-http` feature of
  `chia-sdk-test` it also serves them over HTTP, so a `CoinsetClient` pointed at it exercises your real
  client code.

## Gotchas

- Hashes are sent as `0x`-prefixed hex, and amounts as JSON numbers. If you build request bodies yourself
  through `make_post_request`, follow the same format.
- `get_coin_records_by_*` ignores spent coins unless `include_spent_coins` is `Some(true)`.
- `get_block` and `get_blocks` return full blocks, which can be large. Use `get_block_record(s)` when you
  only need headers and heights.
- Public Coinset endpoints are rate limited. Batch lookups with the plural methods
  (`get_coin_records_by_names`, `get_coin_records_by_puzzle_hashes`) instead of many single requests.

See the [chia-sdk-coinset rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/coinset/index.html)
for every request and response type.
