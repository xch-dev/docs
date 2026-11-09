---
title: Full Node Simulator
---

# Full Node Simulator

`FullNodeSimulator` is an in-memory model of a full node, as opposed to the [`Simulator`](/sdk/testing),
which models only consensus validation. Transactions go into a mempool and are only confirmed when you
farm a block. The mempool handles conflicts, replace-by-fee, identical spend deduplication and singleton
fast-forward. You can revert blocks and reorganize the chain, and query everything through methods that
return the same response types as the [RPC clients](/sdk/networking/rpc).

With the `full-node-simulator-http` feature, `FullNodeSimulatorServer` serves the simulator over HTTP
with the full node RPC API, so `CoinsetClient` (or any other language's RPC client) can drive it as if it
were a real node.

Use it to test the lifecycle of a transaction rather than just its validity: code that pushes
transactions and waits for confirmation, fee bumping, handling of reorgs, or an application that reads
chain state over RPC.

|                  | `Simulator`                                                    | `FullNodeSimulator`                                      |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Confirmation     | Immediately, one block per transaction                         | When you call `farm_block`                               |
| Mempool          | None                                                           | Conflicts, replace-by-fee, dedup, singleton fast-forward |
| Reorgs           | No                                                             | `revert_blocks`, `reorg_blocks`                          |
| Funding          | `new_coin`, `bls`                                              | Prefarm coins, farming rewards, or `new_coin`            |
| Signatures       | Testnet11 constants, `spend_coins` signs for you               | Simulator constants, you sign                            |
| Queries          | `coin_state`, `children` and similar                           | Full node RPC methods and response types                 |
| Over the network | [`PeerSimulator`](/sdk/testing/peer-simulator) (peer protocol) | `FullNodeSimulatorServer` (HTTP RPC)                     |

`FullNodeSimulator` and `FullNodeSimulatorEvent` are in `chia_wallet_sdk::test` and need no feature flag.

## The chain

`FullNodeSimulator::new()` starts at height 1 with a genesis block, seeded with 1337. Use `with_seed` for a
different deterministic chain, or `with_secret_key` to choose the master key. The genesis block contains
two prefarm coins worth 21 million XCH in total, paid to the standard puzzle of the master key's
hardened wallet key at index 1 (`get_prefarm_puzzle_hash`). Timestamps start at the wall-clock time the
simulator was created and advance by one second per block.

Every block pays a 2 XCH reward to the farming puzzle hash, which starts as the prefarm puzzle hash.
Change it with `set_farming_ph` to fund a test wallet by farming. You can also add coins directly with
`new_coin` or `insert_coin`, as with the plain simulator.

## Signing

The simulator has its own network constants. Its genesis challenge, which is also its `AGG_SIG_ME`
additional data, is returned by `get_aggsig_additional_data()`. Sign with that, not with mainnet or
testnet11 constants, or the simulator rejects the signature.

```rust
use chia_wallet_sdk::chia::bls::{SecretKey, master_to_wallet_hardened, sign};
use chia_wallet_sdk::chia::puzzle_types::DeriveSynthetic;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::FullNodeSimulator;

/// Signs coin spends for the full node simulator with BLS keys.
fn sign_for_simulator(
    sim: &FullNodeSimulator,
    coin_spends: &[CoinSpend],
    secret_keys: &[SecretKey],
) -> anyhow::Result<Signature> {
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        coin_spends,
        &AggSigConstants::new(sim.get_aggsig_additional_data()),
    )?;

    let mut signature = Signature::default();
    for required in required {
        let RequiredSignature::Bls(required) = required else {
            continue;
        };
        let sk = secret_keys
            .iter()
            .find(|sk| sk.public_key() == required.public_key)
            .ok_or_else(|| anyhow::anyhow!("missing key"))?;
        signature += &sign(sk, required.message());
    }
    Ok(signature)
}

#[test]
fn spend_prefarm() -> anyhow::Result<()> {
    let mut sim = FullNodeSimulator::new();

    // The prefarm belongs to the synthetic key of the master key's wallet index 1.
    let sk = master_to_wallet_hardened(&sim.get_master_secret_key(), 1).derive_synthetic();
    let prefarm_puzzle_hash = sim.get_prefarm_puzzle_hash();

    let records = sim
        .get_coin_records_by_puzzle_hash(prefarm_puzzle_hash, None, None, None)
        .coin_records
        .unwrap();
    let prefarm = records[0].coin;

    // Send 1 XCH to Alice, with the rest as change.
    let alice = BlsPair::new(0);
    let ctx = &mut SpendContext::new();
    StandardLayer::new(sk.public_key()).spend(
        ctx,
        prefarm,
        Conditions::new()
            .create_coin(alice.puzzle_hash, 1_000_000_000_000, Memos::None)
            .create_coin(
                prefarm_puzzle_hash,
                prefarm.amount - 1_000_000_000_000,
                Memos::None,
            ),
    )?;
    let coin_spends = ctx.take();
    let signature = sign_for_simulator(&sim, &coin_spends, &[sk])?;

    // Pushing only adds the transaction to the mempool.
    let response = sim.push_tx(SpendBundle::new(coin_spends, signature));
    assert!(response.success, "{:?}", response.error);
    assert!(
        sim.get_coin_records_by_puzzle_hash(alice.puzzle_hash, None, None, None)
            .coin_records
            .unwrap()
            .is_empty()
    );

    // Farming a block confirms it.
    sim.farm_block(1);
    let alice_coins = sim
        .get_coin_records_by_puzzle_hash(alice.puzzle_hash, None, None, None)
        .coin_records
        .unwrap();
    assert_eq!(alice_coins.len(), 1);
    assert_eq!(alice_coins[0].confirmed_block_index, sim.height());

    Ok(())
}
```

## Pushing transactions

`push_tx(spend_bundle)` validates a spend bundle against the current peak and adds it to the mempool. It
returns a `PushTxResponse` with `success`, a `status` of `"SUCCESS"` or `"FAILED"`, and an `error`
message. `push_tx_detailed` returns the same response plus the `SimulatorError`, so tests can match on
the `ErrorCode`.

The mempool follows the full node's rules:

- A bundle that spends a coin already spent by a mempool item conflicts with it. It replaces the
  existing items only if it spends every coin they spend, and pays a higher fee than they do combined.
  Otherwise it's rejected with `ErrorCode::MempoolConflict`.
- Spends that are eligible for deduplication (identical spends of the same coin) don't conflict, and are
  included once.
- If a bundle spends a singleton coin that has since been spent, by a confirmed block or a mempool item,
  and the spend can be fast-forwarded, the simulator rewrites it to spend the singleton's latest coin.

`farm_block(n)` farms `n` blocks (at least one). Each block includes every mempool item that's still
valid and doesn't conflict with one already included, and returns its `BlockRecord`.

```rust
use chia_wallet_sdk::chia::consensus::validation_error::ErrorCode;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{FullNodeSimulator, to_program, to_puzzle};

/// Spends an anyone-can-spend coin, creating one child. The difference is the fee.
fn spend_with_fee(coin: Coin, puzzle_reveal: &Program, fee: u64) -> anyhow::Result<SpendBundle> {
    let solution = to_program([CreateCoin::new(
        coin.puzzle_hash,
        coin.amount - fee,
        Memos::<NodePtr>::None,
    )])?;
    Ok(SpendBundle::new(
        vec![CoinSpend::new(coin, puzzle_reveal.clone(), solution)],
        Signature::default(),
    ))
}

#[test]
fn replace_by_fee() -> anyhow::Result<()> {
    let mut sim = FullNodeSimulator::new();
    let (puzzle_hash, puzzle_reveal) = to_puzzle(1)?;
    let coin = sim.new_coin(puzzle_hash, 1_000);

    let first = spend_with_fee(coin, &puzzle_reveal, 10)?;
    let same_fee = spend_with_fee(coin, &puzzle_reveal, 10)?;
    let higher_fee = spend_with_fee(coin, &puzzle_reveal, 50)?;

    assert!(sim.push_tx(first.clone()).success);

    // An identical bundle is already in the mempool, so it's accepted without changes.
    assert!(sim.push_tx(same_fee).success);

    // A conflicting bundle with a lower or equal fee is rejected.
    let lower_fee = spend_with_fee(coin, &puzzle_reveal, 5)?;
    let rejected = sim.push_tx_detailed(lower_fee);
    assert!(!rejected.response.success);
    assert!(matches!(
        rejected.error,
        Some(SimulatorError::Validation(ErrorCode::MempoolConflict))
    ));

    // A higher fee replaces the original.
    assert!(sim.push_tx(higher_fee.clone()).success);
    assert!(sim.get_mempool_item_by_tx_id(first.name()).mempool_item.is_none());
    assert!(sim.get_mempool_item_by_tx_id(higher_fee.name()).mempool_item.is_some());

    sim.farm_block(1);
    let children = sim
        .get_coin_records_by_parent_ids(vec![coin.coin_id()], None, None, None)
        .coin_records
        .unwrap();
    assert_eq!(children[0].coin.amount, 950);

    Ok(())
}
```

## Queries

The query methods mirror the full node RPC API and return `chia-sdk-coinset` response types, so the
assertions in your tests look like the code that reads a real node:

- Chain: `height`, `header_hash`, `header_hash_of`, `get_blockchain_state`, `get_network_info`
  (network name `simulator0`, prefix `txch`), `get_block_record`, `get_block_record_by_height`,
  `get_block_records`, `get_additions_and_removals`, `get_block_spends`
- Coins: `get_coin_record_by_name`, `get_coin_records_by_names`, `get_coin_records_by_puzzle_hash(es)`,
  `get_coin_records_by_hint(s)`, `get_coin_records_by_parent_ids`, `get_puzzle_and_solution`
- Mempool: `get_mempool_item_by_tx_id`, `get_mempool_items_by_coin_name`

Unlike the trait methods, the coin record queries have no `cursor` argument, since nothing is truncated.
Full blocks (`get_block`, `get_blocks`) aren't modeled.

## Reorgs and events

`revert_blocks(n)` removes the last `n` blocks and puts their transactions back into the mempool, as a
full node does when its peak rolls back. It returns the header hashes of the removed blocks.

`reorg_blocks(n, m)` simulates switching to a competing chain: it reverts `n` blocks and farms `n + m`
new ones from the current mempool, so the new chain is longer. Transactions from the reverted blocks are
not put back into the mempool, as if the competing chain never saw them, so their spent coins become
unspent again.

Every farmed block and every reorg is recorded as a `FullNodeSimulatorEvent` (`Block` or `Reorg`).
`drain_events` returns and clears them. Use them to drive the code under test the way a node's
notifications would.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{FullNodeSimulator, FullNodeSimulatorEvent, to_program, to_puzzle};

#[test]
fn rollbacks_and_reorgs() -> anyhow::Result<()> {
    let mut sim = FullNodeSimulator::new();
    let (puzzle_hash, puzzle_reveal) = to_puzzle(1)?;
    let coin = sim.new_coin(puzzle_hash, 100);

    let solution = to_program([CreateCoin::new(puzzle_hash, 100, Memos::<NodePtr>::None)])?;
    let bundle = SpendBundle::new(
        vec![CoinSpend::new(coin, puzzle_reveal, solution)],
        Signature::default(),
    );
    assert!(sim.push_tx(bundle).success);
    sim.farm_block(1);

    let is_spent = |sim: &FullNodeSimulator| {
        sim.get_coin_record_by_name(coin.coin_id())
            .coin_record
            .is_some_and(|record| record.spent)
    };
    assert!(is_spent(&sim));

    // Rolling back the block returns the transaction to the mempool...
    sim.revert_blocks(1);
    assert!(!is_spent(&sim));
    assert_eq!(
        sim.get_mempool_items_by_coin_name(coin.coin_id())
            .mempool_items
            .unwrap()
            .len(),
        1
    );

    // ...so the next block confirms it again.
    sim.farm_block(1);
    assert!(is_spent(&sim));
    sim.drain_events();

    // A reorg replaces the block with one that doesn't include the transaction.
    sim.reorg_blocks(1, 1);
    assert!(!is_spent(&sim));

    let events = sim.drain_events();
    assert!(matches!(events.last(), Some(FullNodeSimulatorEvent::Reorg { .. })));

    Ok(())
}
```

When `serde` is enabled on `chia-sdk-test` (the `full-node-simulator-http` feature turns it on),
`dump_state` and `restore_state` save and load the whole chain and mempool as a JSON string, for example
to share a prepared fixture between tests.

## Serving over HTTP

`FullNodeSimulatorServer` runs the simulator behind an HTTP server on a random port on `127.0.0.1`. It
answers the full node RPC endpoints that `ChiaRpcClient` uses (except `get_block` and `get_blocks`, which
return `success: false`), plus `get_aggsig_additional_data` and a few control endpoints under `/sim/`:

| Endpoint                                | Body                                                    | Effect                                   |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `/sim/farm_block`                       | `{ "blocks": 1 }`                                       | `farm_block`, returns `block_records`    |
| `/sim/revert_blocks`                    | `{ "blocks": 1 }`                                       | `revert_blocks`, returns `header_hashes` |
| `/sim/reorg_blocks`                     | `{ "num_of_blocks_to_rev": 1, "num_of_new_blocks": 1 }` | `reorg_blocks`                           |
| `/sim/new_coin`                         | `{ "puzzle_hash": "0x…", "amount": 100 }`               | `new_coin`, returns the `coin`           |
| `/sim/insert_coin`                      | `{ "coin": { … } }`                                     | `insert_coin`                            |
| `/sim/set_farming_ph`                   | `{ "puzzle_hash": "0x…" }`                              | `set_farming_ph`                         |
| `/sim/dump_state`, `/sim/restore_state` | `{}`, `{ "state": "…" }`                                | `dump_state`, `restore_state`            |
| `/sim/drain_events`                     | `{}`                                                    | `drain_events`, returns `events`         |

:::info Feature flag
The server needs the `full-node-simulator-http` feature of `chia-sdk-test`. `chia-wallet-sdk` doesn't
have a feature that enables it, so add `chia-sdk-test` as a direct dependency (at the same version) with
the feature turned on. The example below is not compiled as part of these docs for that reason.

```toml
[dev-dependencies]
chia-sdk-test = { version = "0.36", features = ["full-node-simulator-http"] }
```

:::

`FullNodeSimulatorServer::new()` starts a server with a default simulator. To control the simulator from
the test as well, create it yourself as an `Arc<std::sync::Mutex<FullNodeSimulator>>` and pass it to
`with_simulator`. The server stops when it's dropped.

```rust ignore
use std::sync::{Arc, Mutex};

use chia_sdk_test::{FullNodeSimulator, FullNodeSimulatorServer};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{to_program, to_puzzle};

#[tokio::test]
async fn rpc_against_simulator() -> anyhow::Result<()> {
    let sim = Arc::new(Mutex::new(FullNodeSimulator::new()));
    let server = FullNodeSimulatorServer::with_simulator(sim.clone()).await?;

    // The code under test only sees an RPC client.
    let client = CoinsetClient::new(server.url());

    let (puzzle_hash, puzzle_reveal) = to_puzzle(1)?;
    let coin = sim.lock().unwrap().new_coin(puzzle_hash, 100);

    let solution = to_program([CreateCoin::new(puzzle_hash, 100, Memos::<NodePtr>::None)])?;
    let response = client
        .push_tx(SpendBundle::new(
            vec![CoinSpend::new(coin, puzzle_reveal, solution)],
            Signature::default(),
        ))
        .await?;
    assert!(response.success);

    // Farm from the test, then observe the result over RPC.
    sim.lock().unwrap().farm_block(1);

    let record = client
        .get_coin_record_by_name(coin.coin_id())
        .await?
        .coin_record
        .unwrap();
    assert!(record.spent);

    Ok(())
}
```

The simulator is behind a `std::sync::Mutex`, so don't hold its guard across an `.await`. Lock it, call
the method, and let the guard drop, as above.

The Node.js and Python [bindings](/sdk/bindings) also expose `FullNodeSimulator` with a `startServer`
(`start_server`) method, so tests in those languages can run the same HTTP simulator.

## Gotchas

- Sign with `get_aggsig_additional_data()`. Signatures made for testnet11, including by
  `chia_wallet_sdk::test::sign_transaction`, fail with `BadAggregateSignature`.
- `push_tx` succeeding means the transaction is in the mempool, not confirmed. Farm a block before
  checking coin records.
- Heights start at 1 (genesis), not 0 as in `Simulator`.
- There's no way to set the clock. Timestamps follow the wall clock at creation plus one second per block,
  so absolute timelocks in the future can't be reached by farming quickly. Use the `Simulator` to test
  time-based conditions.

See the [chia-sdk-test rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/test/index.html)
for the full API.
