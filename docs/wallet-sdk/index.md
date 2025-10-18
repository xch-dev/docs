# Introduction

The Chia Wallet SDK is a library that provides abstractions for interacting with the Chia blockchain. It is built with Rust and is available on [crates.io](https://crates.io/crates/chia-wallet-sdk).

The Wallet SDK is built on top of [chia_rs](https://github.com/Chia-Network/chia_rs) and [clvm_rs](https://github.com/Chia-Network/clvm_rs), which are the official Rust packages used by the Chia reference client. While the SDK itself is independently maintained, a [fork](https://github.com/Chia-Network/cni-wallet-sdk) is currently used in the [Chia Cloud Wallet](https://vault.chia.net/).

Additionally, Sage Wallet is a full implementation of a Chia light wallet that is built using the Wallet SDK.

## Stability

Most of the API remains the same between versions, however breaking changes that affect part of the API occur frequently. The library follows [Semantic Versioning](https://semver.org/), so you can depend on a specific version and only update to the latest when you want to.

## Installation

:::tip
If you are trying to use the Wallet SDK in other languages than Rust, you should use the [Bindings](/bindings) instead.
:::

You can add the Wallet SDK as a dependency to your project by adding the following to your `Cargo.toml` file:

```toml
[dependencies]
chia-wallet-sdk = "0.30.0"
```

Or by using the following command:

```bash
cargo add chia-wallet-sdk
```

The API documentation for the Wallet SDK is available on [docs.rs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/).
