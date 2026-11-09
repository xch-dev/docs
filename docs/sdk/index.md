---
title: Introduction
slug: /sdk
---

# Wallet SDK

The Chia Wallet SDK is a Rust library for building applications that work with coins on the
[Chia blockchain](https://chia.net): wallets, dApps, indexers, trading bots, and services that mint or
custody assets. It knows how to build, parse and sign spends for the standard puzzles (XCH, CATs, NFTs,
DIDs, vaults, offers and more), how to talk to full nodes, and how to test all of it locally against a
simulated blockchain. [Sage](/sage/getting-started) is built on it.

It is a library, not a prebuilt wallet. It doesn't store keys, track balances or pick coins for you
unless you ask it to. You decide where coins and keys come from, and the SDK turns your intent into
valid coin spends.

:::info
These docs assume you know Rust and the basics of Chia's coin set model: coins, puzzles and solutions,
conditions, and singletons. For background, see the [Chia documentation](https://docs.chia.net) and
[chialisp.com](https://chialisp.com). The API reference for every item lives on
[docs.rs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/).
:::

## Installation

Add the crate to your project:

```bash
cargo add chia-wallet-sdk
```

Networking needs a TLS backend, which you choose with a feature flag:

```toml
[dependencies]
chia-wallet-sdk = { version = "0.37", features = ["rustls"] }
```

### Feature flags

| Feature             | Enables                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rustls`            | TLS for [peer connections](/sdk/networking/peer), [RPC clients](/sdk/networking/rpc) and the [daemon](/sdk/networking/daemon), using rustls |
| `native-tls`        | The same, using the platform's native TLS library                                                                                           |
| `chip-0035`         | [DataLayer stores](/sdk/primitives/datalayer) (CHIP-0035)                                                                                   |
| `chip-0037`         | The CHIP-0037 controller puzzle and EIP-712 message layers used with [vaults](/sdk/primitives/vaults)                                       |
| `action-layer`      | [Action layer singletons](/sdk/primitives/action-layer) such as CATalog and XCHandles (implies `chip-0035`)                                 |
| `offer-compression` | Compressing and decompressing [offer](/sdk/offers) strings                                                                                  |
| `peer-simulator`    | The [peer simulator](/sdk/testing/peer-simulator), an in-process full node for networking tests                                             |

Everything else, including the [simulator](/sdk/testing), is always available.

## How the crate is organized

`chia-wallet-sdk` is a facade over a workspace of smaller crates. You can depend on just the facade and
reach everything through it, or depend on the individual crates if you want a smaller build.

| Module                     | Crate              | What's in it                                                                                                                                                                                                    |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chia_wallet_sdk::driver`  | `chia-sdk-driver`  | [SpendContext](/sdk/concepts/spend-context), [layers](/sdk/concepts/layers), [primitives](/sdk/primitives), the [action system](/sdk/action-system), [offers](/sdk/offers), [clear signing](/sdk/clear-signing) |
| `chia_wallet_sdk::types`   | `chia-sdk-types`   | [Conditions](/sdk/concepts/conditions), puzzle argument and solution types, the `Mod` trait, network constants, Merkle trees                                                                                    |
| `chia_wallet_sdk::signer`  | `chia-sdk-signer`  | Working out which [signatures](/sdk/concepts/signing) a transaction needs                                                                                                                                       |
| `chia_wallet_sdk::client`  | `chia-sdk-client`  | [Peer connections](/sdk/networking/peer) over the full node wallet protocol                                                                                                                                     |
| `chia_wallet_sdk::coinset` | `chia-sdk-coinset` | [RPC clients](/sdk/networking/rpc) for coinset.org and full nodes                                                                                                                                               |
| `chia_wallet_sdk::daemon`  | `chia-sdk-daemon`  | A [daemon](/sdk/networking/daemon) websocket client                                                                                                                                                             |
| `chia_wallet_sdk::test`    | `chia-sdk-test`    | The [simulator](/sdk/testing), test key pairs and the [peer simulator](/sdk/testing/peer-simulator)                                                                                                             |
| `chia_wallet_sdk::utils`   | `chia-sdk-utils`   | [Addresses, coin selection and hex helpers](/sdk/utilities)                                                                                                                                                     |

The SDK builds on the [chia_rs](https://github.com/Chia-Network/chia_rs) crates and re-exports the ones you
need, so you don't have to keep their versions in sync yourself:

| Path                                                  | Crate                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `chia_wallet_sdk::chia::protocol`                     | `chia-protocol`: `Coin`, `CoinSpend`, `SpendBundle`, `Bytes32`, `Program` and the wire protocol |
| `chia_wallet_sdk::chia::bls`                          | `chia-bls`: BLS keys, signatures and key derivation                                             |
| `chia_wallet_sdk::chia::secp`                         | `chia-secp`: secp256k1 and secp256r1 keys                                                       |
| `chia_wallet_sdk::chia::puzzle_types`                 | `chia-puzzle-types`: argument and solution types for the standard puzzles                       |
| `chia_wallet_sdk::chia::consensus`                    | `chia-consensus`: consensus constants and validation                                            |
| `chia_wallet_sdk::puzzles`                            | `chia-puzzles`: compiled puzzle bytes and their hashes                                          |
| `chia_wallet_sdk::clvmr`, `clvm_traits`, `clvm_utils` | The CLVM runtime, `ToClvm`/`FromClvm`, and tree hashing and currying                            |

Most programs only need the prelude, which collects the commonly used types:

```rust
use chia_wallet_sdk::prelude::*;

fn takes_common_types(_ctx: &mut SpendContext, _coin: Coin, _conditions: Conditions) {}
```

## The big picture

Every Chia transaction is a `SpendBundle`: a list of coin spends (each a coin, its puzzle reveal and a
solution) plus one aggregated signature. Building one with the SDK follows the same shape no matter
what assets are involved:

1. **Allocate.** Create a [SpendContext](/sdk/concepts/spend-context). It owns the CLVM memory that puzzles
   and solutions are built in, and collects the coin spends you add.
2. **Describe what should happen.** Either spend coins directly with a [primitive](/sdk/primitives) such as
   `StandardLayer`, `Cat` or `Nft`, passing the [conditions](/sdk/concepts/conditions) each coin should
   output, or describe the whole transaction declaratively with the [action system](/sdk/action-system)
   and let it create change, link spends and build the conditions for you.
3. **Sign.** Work out which signatures the spends require with `RequiredSignature` and sign them with
   your keys. See [Keys & Signing](/sdk/concepts/signing).
4. **Submit.** Send the `SpendBundle` to the network through a [peer](/sdk/networking/peer) or an
   [RPC client](/sdk/networking/rpc), or validate it locally with the [simulator](/sdk/testing).

To recognize coins you receive, you go the other way: fetch the parent coin's spend and let a
primitive parse it (for example `Cat::parse_children` or `Nft::parse_child`). The
[primitives overview](/sdk/primitives) explains this pattern.

## Where to go next

- [Quick Start](/sdk/quick-start) builds, signs and validates a first transaction.
- [Core Concepts](/sdk/concepts/clvm) explains the building blocks everything else uses.
- [Action System](/sdk/action-system) is the easiest way to build multi-asset transactions.
- [Primitives](/sdk/primitives) covers each asset type in depth.
- [Testing](/sdk/testing) shows how to test your code against a simulated blockchain.
- [Bindings](/sdk/bindings) covers using the SDK from Node.js, the browser and Python.
