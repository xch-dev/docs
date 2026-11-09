---
title: Utilities
---

# Utilities

This page covers the smaller helpers that most applications need at some point: address encoding, coin selection, hex parsing, network constants, merkle trees, cost estimation, and the `chia-sdk-cli` command line tool. Addresses, coin selection and hex parsing live in `chia-sdk-utils` (`chia_wallet_sdk::utils`), and the rest are in `chia_wallet_sdk::types` and `chia_wallet_sdk::driver`. The most common items are in the prelude.

## Addresses

Chia addresses are [bech32m](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki) encodings of a puzzle hash with a human-readable prefix: `xch` on mainnet and `txch` on testnet11. The same encoding is used with other prefixes for other 32-byte identifiers, such as `nft` for NFT launcher ids and `did:chia:` for DID launcher ids.

- `Address { puzzle_hash, prefix }` is for 32-byte payloads. `Address::decode` fails if the data isn't exactly 32 bytes.
- `Bech32 { data, prefix }` is for payloads of any length.
- `expect_prefix(prefix)` on either type returns the payload, or an error if the prefix is different. Use it to reject testnet addresses in a mainnet app, or an NFT id where an address was expected.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn addresses() -> anyhow::Result<()> {
    let puzzle_hash = Bytes32::new([7; 32]);

    let address = Address::new(puzzle_hash, "xch".to_string()).encode()?;
    assert!(address.starts_with("xch1"));

    // Decode and check the network in one step.
    let decoded = Address::decode(&address)?.expect_prefix("xch")?;
    assert_eq!(decoded, puzzle_hash);
    assert!(Address::decode(&address)?.expect_prefix("txch").is_err());

    // NFT ids use the same encoding with the launcher id.
    let launcher_id = Bytes32::new([9; 32]);
    let nft_id = Address::new(launcher_id, "nft".to_string()).encode()?;
    assert!(nft_id.starts_with("nft1"));

    // Bech32 handles arbitrary-length data.
    let encoded = Bech32::new(Bytes::new(vec![1, 2, 3]), "test".to_string()).encode()?;
    assert_eq!(Bech32::decode(&encoded)?.data.as_ref(), &[1, 2, 3]);

    Ok(())
}
```

Decoding rejects bech32 strings that aren't bech32m (such as Bitcoin segwit v0 addresses) with `Bech32Error::InvalidFormat`.

## Coin selection

`select_coins(spendable_coins, amount)` picks a set of coins whose total is at least `amount`. It follows the same approach as the Chia reference wallet:

1. A single coin that exactly matches the amount, if there is one.
2. All of the coins smaller than the amount, if they add up to exactly the amount.
3. The smallest single coin larger than the amount, if the smaller coins don't add up to enough.
4. Otherwise, a knapsack search over the coins, and finally the largest coins until the amount is reached.

Duplicate coins are ignored, and the result never contains more than 500 coins. It returns `CoinSelectionError::NoSpendableCoins`, `InsufficientBalance(total)` or `ExceededMaxCoins` when no selection is possible. The knapsack search uses a fixed seed, so the result is deterministic for a given input.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::utils::CoinSelectionError;

#[test]
fn coin_selection() -> anyhow::Result<()> {
    let puzzle_hash = Bytes32::new([1; 32]);
    let coins: Vec<Coin> = [100, 250, 400, 1_000]
        .into_iter()
        .enumerate()
        .map(|(i, amount)| Coin::new(Bytes32::new([i as u8; 32]), puzzle_hash, amount))
        .collect();

    // An exact match is preferred.
    let selected = select_coins(coins.clone(), 400)?;
    assert_eq!(selected.iter().map(|coin| coin.amount).collect::<Vec<_>>(), [400]);

    // The selection always covers the amount; the excess becomes change.
    let selected = select_coins(coins.clone(), 600)?;
    let total: u64 = selected.iter().map(|coin| coin.amount).sum();
    assert!(total >= 600);

    assert_eq!(
        select_coins(coins, 10_000),
        Err(CoinSelectionError::InsufficientBalance(1_750))
    );

    Ok(())
}
```

Coin selection only looks at amounts. Filter out coins that are already being spent in pending transactions before calling it. The [action system](/sdk/action-system/custom-spends) has its own selection based on the deltas of a transaction, which also handles CATs and fees.

## Hex

`parse_hex` decodes a hex string into `Bytes`, accepting an optional `0x` prefix. For fixed-size values, convert the result with `try_into`, or use the `hex-literal` crate's `hex!` macro for constants.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn hex_values() -> anyhow::Result<()> {
    let bytes = parse_hex("0xcafe")?;
    assert_eq!(bytes.as_ref(), &[0xca, 0xfe]);

    let coin_id: Bytes32 = parse_hex(&"ab".repeat(32))?.try_into()?;
    assert_eq!(coin_id, Bytes32::new([0xab; 32]));

    // Bytes and Bytes32 print as lowercase hex without a prefix.
    assert_eq!(coin_id.to_string(), "ab".repeat(32));

    Ok(())
}
```

## Network constants

`MAINNET_CONSTANTS` and `TESTNET11_CONSTANTS` (in `chia_wallet_sdk::types` and the prelude) are the `ConsensusConstants` of each network. The fields you'll use most are:

| Field                                                                         | Used for                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `genesis_challenge`                                                           | Identifying the network, for example when connecting to [peers](/sdk/networking/peer)                                    |
| `agg_sig_me_additional_data` and the other `agg_sig_*_additional_data` fields | Signature domain separation, through `AggSigConstants` (see [Keys & Signing](/sdk/concepts/signing#required-signatures)) |
| `max_block_cost_clvm`                                                         | The maximum cost of a block (11 billion)                                                                                 |
| `cost_per_byte`                                                               | The cost charged per byte of a spend bundle's serialized generator                                                       |

For a custom network or local test chain, `chia_wallet_sdk::types::default_constants(genesis_challenge, agg_sig_me)` builds a set of mainnet-like constants with your own genesis challenge and signature domain.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::default_constants;

#[test]
fn constants() {
    assert_ne!(MAINNET_CONSTANTS.genesis_challenge, TESTNET11_CONSTANTS.genesis_challenge);

    // On mainnet and testnet11, the AGG_SIG_ME data is the genesis challenge.
    assert_eq!(
        MAINNET_CONSTANTS.agg_sig_me_additional_data,
        MAINNET_CONSTANTS.genesis_challenge
    );

    let genesis = Bytes32::new([1; 32]);
    let custom = default_constants(genesis, genesis);
    let constants = AggSigConstants::from(&custom);
    assert_eq!(constants.me(), genesis);
}
```

## Merkle trees

`MerkleTree` builds a merkle tree over a list of `Bytes32` leaves, using the same hashing and proof format as Chia's on-chain puzzles (for example `p2_1_of_n`). Puzzles commit to the `root()`, and a spend reveals one leaf with its `proof(leaf)`. `MerkleProof` implements `ToClvm` and `FromClvm`, so you can put it directly into a solution.

The [P2OneOfManyLayer](/sdk/concepts/layers#built-in-layers), [clawbacks](/sdk/primitives/clawback), [vaults](/sdk/primitives/vaults) and [action layer](/sdk/primitives/action-layer) singletons all use merkle trees to commit to a set of puzzles while only revealing the one being used.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::chia::sha2::Sha256;

/// Recomputes the root from a leaf and its proof, as an on-chain puzzle would.
fn verify(root: Bytes32, leaf: Bytes32, proof: &MerkleProof) -> bool {
    let sha256 = |parts: &[&[u8]]| {
        let mut hasher = Sha256::new();
        for part in parts {
            hasher.update(part);
        }
        Bytes32::new(hasher.finalize())
    };

    let mut hash = sha256(&[&[1], &leaf]);
    for (i, sibling) in proof.proof.iter().enumerate() {
        hash = if proof.path & (1 << i) == 0 {
            sha256(&[&[2], &hash, sibling])
        } else {
            sha256(&[&[2], sibling, &hash])
        };
    }
    hash == root
}

#[test]
fn merkle_tree() -> anyhow::Result<()> {
    let leaves: Vec<Bytes32> = (1..=5).map(|i| Bytes32::new([i; 32])).collect();
    let tree = MerkleTree::new(&leaves);

    let proof = tree.proof(leaves[3]).expect("leaf is in the tree");
    assert!(verify(tree.root(), leaves[3], &proof));
    assert!(tree.proof(Bytes32::new([99; 32])).is_none());

    // Proofs are CLVM values, encoded as (path . proof).
    let ctx = &mut SpendContext::new();
    let ptr = ctx.alloc(&proof)?;
    assert_eq!(ctx.extract::<MerkleProof>(ptr)?, proof);

    Ok(())
}
```

`MerkleTree::new` builds every proof up front, so creating the tree costs time proportional to the number of leaves but each `proof` lookup is a hash map access. An empty tree has a root of all zeros. Duplicate leaves share a single proof entry, so avoid them.

## Estimating cost

Every spend bundle has a CLVM cost, and fees are priced per unit of cost. `spend_bundle_cost(&coin_spends)` (in `chia_wallet_sdk::driver`) estimates the cost the mempool will assign: the execution cost of each puzzle, plus fixed costs for each `AGG_SIG_*` and `CREATE_COIN` condition, plus the cost of the serialized bytes.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::driver::spend_bundle_cost;

#[test]
fn estimate_fee() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let alice = sim.bls(1_000_000_000_000);

    let build = |ctx: &mut SpendContext, fee: u64| -> anyhow::Result<Vec<CoinSpend>> {
        StandardLayer::new(alice.pk).spend(
            ctx,
            alice.coin,
            Conditions::new()
                .create_coin(alice.puzzle_hash, 1_000_000_000_000 - fee, Memos::None)
                .reserve_fee(fee),
        )?;
        Ok(ctx.take())
    };

    // Estimate the cost with a placeholder fee, then price it at 5 mojos per cost.
    let cost = spend_bundle_cost(&build(ctx, 0)?)?;
    let fee = cost * 5;
    assert!(cost > 0);

    sim.spend_coins(build(ctx, fee)?, &[alice.sk])?;

    Ok(())
}
```

The cost depends slightly on the fee amount itself, since it changes the serialized size by a few bytes. Round the fee up, or estimate with a fee of similar magnitude.

## Other helpers

| Item                                                          | Location                 | Purpose                                                                                                     |
| ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `announcement_id(coin_info, message)`                         | `chia_wallet_sdk::types` | Computes the id to assert an announcement; see [Conditions](/sdk/concepts/conditions#announcements)         |
| `payment_assertion(puzzle_hash, notarized_payment_hash)`      | `chia_wallet_sdk::types` | Builds the `AssertPuzzleAnnouncement` for a settlement payment; see [Offers](/sdk/offers)                   |
| `tree_hash_notarized_payment(&allocator, &notarized_payment)` | `chia_wallet_sdk::types` | The hash of a notarized payment, with memos hashed in place                                                 |
| `run_puzzle_with_cost(...)`                                   | `chia_wallet_sdk::types` | Runs a puzzle with a cost limit and returns the cost; see [CLVM Values](/sdk/concepts/clvm#running-puzzles) |

## Command line tool

The `chia-sdk-cli` crate is a small command line tool for converting between hex and bech32m. Install it from the SDK repository:

```sh
cargo install --git https://github.com/xch-dev/chia-wallet-sdk chia-sdk-cli
```

```sh
# Encode a puzzle hash as an address (the prefix defaults to xch).
chia-sdk-cli encode 0x0707070707070707070707070707070707070707070707070707070707070707
chia-sdk-cli encode --prefix txch 0707070707070707070707070707070707070707070707070707070707070707

# Decode any bech32m string back to hex.
chia-sdk-cli decode xch1...
```

`encode` accepts hex with or without a `0x` prefix, and `decode` prints the payload as hex without a prefix, whatever its length.
