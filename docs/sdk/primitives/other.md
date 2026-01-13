---
slug: /sdk/primitives/other
title: Other Primitives
---

# Other Primitives

The SDK includes several additional primitives beyond the core CAT, NFT, and Vault types. This page provides brief overviews of these primitives.

## DID (Decentralized Identifiers)

DIDs provide on-chain identity management following the singleton pattern. A DID maintains a persistent identity that can be associated with metadata and used for authentication.

```rust
use chia_wallet_sdk::prelude::*;

// DID structure
let did = Did {
    coin,
    info: DidInfo {
        launcher_id,
        recovery_list_hash,
        num_verifications_required,
        metadata,
        inner_puzzle_hash,
    },
    proof,
};
```

**Use cases:**
- Creator verification for NFTs
- On-chain identity for applications
- Recovery mechanisms with trusted parties

For the complete API, see [Did in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Did.html).

---

## Option Contracts

Options enable on-chain derivatives trading where one party has the right (but not obligation) to buy or sell an asset at a predetermined price.

```rust
use chia_wallet_sdk::prelude::*;

// Option contract structure
let option = OptionContract {
    coin,
    info: OptionInfo {
        launcher_id,
        underlying,
        option_type,  // Call or Put
        strike_price,
        expiry,
    },
    proof,
};
```

**Use cases:**
- Hedging price risk
- Speculation on asset prices
- Structured financial products

For the complete API, see [OptionContract in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.OptionContract.html).

---

## ClawbackV2

ClawbackV2 enables recoverable payments where the sender can reclaim funds within a specified time window if needed.

```rust
use chia_wallet_sdk::prelude::*;

// Clawback allows sender to recover funds before timeout
let clawback = ClawbackV2 {
    coin,
    sender_puzzle_hash,
    recipient_puzzle_hash,
    clawback_timeout,  // Blocks until recipient can claim
};
```

**Use cases:**
- Reversible payments for dispute resolution
- Escrow with sender recovery option
- Safe transfers to new/unverified addresses

For the complete API, see [ClawbackV2 in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.ClawbackV2.html).

---

## StreamedAsset

StreamedAsset implements time-locked or vesting payments where funds are released gradually over time.

```rust
use chia_wallet_sdk::prelude::*;

// Streamed payments release funds over time
let streamed = StreamedAsset {
    coin,
    start_timestamp,
    end_timestamp,
    recipient_puzzle_hash,
    // Funds unlock linearly between start and end
};
```

**Use cases:**
- Employee vesting schedules
- Subscription payments
- Gradual fund release for projects

For the complete API, see [StreamedAsset in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.StreamedAsset.html).

---

## Bulletin

Bulletin provides on-chain data storage using the singleton pattern. It allows storing arbitrary data that can be updated over time.

```rust
use chia_wallet_sdk::prelude::*;

// Bulletin for on-chain data storage
// Uses BulletinLayer for puzzle construction
```

**Use cases:**
- On-chain configuration storage
- Decentralized content publishing
- Data availability proofs

For the complete API, see [BulletinLayer in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.BulletinLayer.html).

---

## Singleton

The Singleton primitive is the foundation for NFTs, DIDs, Vaults, and other unique assets. It ensures only one instance of an asset exists at any time.

```rust
use chia_wallet_sdk::prelude::*;

// Generic singleton structure
let singleton = Singleton {
    coin,
    info: SingletonInfo {
        launcher_id,  // Permanent unique identifier
        inner_puzzle_hash,
    },
    proof,
};
```

**Key properties:**
- Unique identity via launcher_id
- Lineage proofs ensure authenticity
- State persists across spends

For the complete API, see [Singleton in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Singleton.html).

---

## Launcher

Launchers are used to create new singletons (NFTs, DIDs, etc.). The launcher coin's ID becomes the permanent identifier for the singleton.

```rust
use chia_wallet_sdk::prelude::*;

// Create a launcher for minting singletons
let launcher = Launcher::new(parent_coin_id, amount);
let launcher_id = launcher.coin().coin_id();

// The launcher_id becomes the permanent identifier
// for the resulting NFT, DID, or other singleton
```

For the complete API, see [Launcher in docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Launcher.html).

---

## Feature-Gated Primitives

Some primitives require feature flags to enable:

### DataStore (chip-0035)

Data layer support for off-chain data with on-chain proofs:

```toml
chia-wallet-sdk = { version = "0.32", features = ["chip-0035"] }
```

### Action Layer (action-layer)

High-level transaction builder for complex multi-asset operations:

```toml
chia-wallet-sdk = { version = "0.32", features = ["action-layer"] }
```

---

## API Reference

For complete documentation on all primitives, see the [chia-sdk-driver rustdocs](https://docs.rs/chia-sdk-driver).
