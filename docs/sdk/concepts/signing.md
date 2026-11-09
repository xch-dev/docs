---
title: Keys & Signing
---

# Keys & Signing

Chia uses BLS12-381 signatures. A puzzle requests a signature by outputting an `AGG_SIG_*` [condition](/sdk/concepts/conditions) with a public key and a message. Every signature required by every spend in a bundle is aggregated into a single signature, which goes in the `SpendBundle` alongside the coin spends. Some newer puzzles also verify secp256k1 or secp256r1 signatures inside the puzzle itself.

The SDK splits this work into three parts:

- Keys and derivation come from `chia-bls` (`chia_wallet_sdk::chia::bls`) and `chia-secp` (`chia_wallet_sdk::chia::secp`). `SecretKey`, `PublicKey`, `Signature` and the secp key types are in the prelude.
- `chia-sdk-signer` (`chia_wallet_sdk::signer`) runs your coin spends and tells you which signatures they need.
- You sign those messages with your keys, aggregate them, and build the `SpendBundle`.

## BLS keys

A wallet starts from a master `SecretKey`, normally derived from a BIP-39 mnemonic. Convert the mnemonic to its 64-byte seed with a BIP-39 library such as the `bip39` crate (with an empty passphrase, to match the Chia reference wallet), then call `SecretKey::from_seed(&seed)`.

Wallet keys are derived from the master key using the path `m/12381/8444/2/index`. The `chia-bls` crate provides helpers for this path:

| Function                                         | Derives                                                  | Works on                   |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------- |
| `master_to_wallet_unhardened(&key, index)`       | Unhardened wallet key                                    | `SecretKey` or `PublicKey` |
| `master_to_wallet_unhardened_intermediate(&key)` | The key at `m/12381/8444/2`, to derive many indices from | `SecretKey` or `PublicKey` |
| `master_to_wallet_hardened(&sk, index)`          | Hardened wallet key                                      | `SecretKey` only           |
| `master_to_wallet_hardened_intermediate(&sk)`    | The hardened key at `m/12381/8444/2`                     | `SecretKey` only           |

Unhardened derivation works on public keys, so a watch-only wallet can generate addresses from the master public key alone, and derive the matching secret keys later when it needs to sign. Hardened keys can only be derived from the secret key.

The `DerivableKey` trait provides `derive_unhardened(index)` on both key types, which is what the unhardened helpers use. `SecretKey::derive_hardened(index)` is the hardened equivalent.

## Synthetic keys

The standard puzzle doesn't curry in your wallet public key directly. It curries a **synthetic key**: your key combined with the hash of a hidden puzzle, which lets the coin optionally be spent by revealing that hidden puzzle instead of signing. Wallets use the default hidden puzzle, which can't be spent, so in practice only the key holder can spend the coin. See [the standard transaction](https://chialisp.com/standard-transactions) for how this works.

The `DeriveSynthetic` trait from `chia_wallet_sdk::chia::puzzle_types` does the conversion. It's implemented for both `PublicKey` and `SecretKey`, and the two stay in step: the synthetic secret key signs for the synthetic public key.

- `key.derive_synthetic()` uses the default hidden puzzle.
- `key.derive_synthetic_hidden(&hidden_puzzle_hash)` uses a custom one.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::chia::bls::{
    DerivableKey, master_to_wallet_unhardened, master_to_wallet_unhardened_intermediate,
};
use chia_wallet_sdk::chia::puzzle_types::{DeriveSynthetic, standard::StandardArgs};

/// The first `count` receive addresses of a wallet, from its master public key only.
fn receive_addresses(master_pk: &PublicKey, count: u32) -> anyhow::Result<Vec<String>> {
    // Derive the intermediate key once, then each index from it.
    let intermediate = master_to_wallet_unhardened_intermediate(master_pk);

    (0..count)
        .map(|index| {
            let synthetic_key = intermediate.derive_unhardened(index).derive_synthetic();
            let puzzle_hash = StandardArgs::curry_tree_hash(synthetic_key);
            Ok(Address::new(puzzle_hash.into(), "xch".to_string()).encode()?)
        })
        .collect()
}

#[test]
fn derive_wallet_keys() -> anyhow::Result<()> {
    // In a real wallet, this seed comes from the user's mnemonic.
    let master_sk = SecretKey::from_seed(&[42; 64]);
    let master_pk = master_sk.public_key();

    let addresses = receive_addresses(&master_pk, 5)?;
    assert_eq!(addresses.len(), 5);

    // Deriving the secret key along the same path gives the matching signing key.
    let synthetic_sk = master_to_wallet_unhardened(&master_sk, 0).derive_synthetic();
    let synthetic_pk = master_to_wallet_unhardened(&master_pk, 0).derive_synthetic();
    assert_eq!(synthetic_sk.public_key(), synthetic_pk);

    // The fingerprint identifies a wallet by its master public key.
    println!("fingerprint {}", master_pk.get_fingerprint());

    Ok(())
}
```

`StandardLayer::new` takes the synthetic public key, and the action system's `finish_with_keys` takes a map from p2 puzzle hash to synthetic public key (see the [Action System](/sdk/action-system)).

## Required signatures

You don't need to work out signature messages yourself. `RequiredSignature::from_coin_spends` runs each coin spend, collects its `AGG_SIG_*` conditions, and returns a `RequiredSignature` for each one:

- `RequiredSignature::Bls(RequiredBlsSignature)` has the `public_key` and the full `message()` to sign. The message is the condition's raw message, followed by the coin information the condition commits to (for `AGG_SIG_ME`, the coin id), followed by a network-specific domain string. `AGG_SIG_UNSAFE` is the exception: its message is signed as is, with no coin information or domain string.
- `RequiredSignature::Secp(RequiredSecpSignature)` is a secp256k1 or secp256r1 signature that a puzzle verifies itself. See [Secp keys](#secp-keys).

The domain strings come from `AggSigConstants`, which you build from the network's consensus constants. Mainnet and testnet11 have different genesis challenges, so the same spend needs a different signature on each network:

| Network         | Constants                                                                         |
| --------------- | --------------------------------------------------------------------------------- |
| Mainnet         | `AggSigConstants::from(&*MAINNET_CONSTANTS)`                                      |
| Testnet11       | `AggSigConstants::from(&*TESTNET11_CONSTANTS)`                                    |
| Another network | `AggSigConstants::new(agg_sig_me_additional_data)`, usually the genesis challenge |

The [Simulator](/sdk/testing) validates signatures against testnet11 constants.

## Building a SpendBundle

Once you know the required signatures, sign each message with the matching secret key, aggregate the results, and pair the signature with the coin spends:

```rust
use std::collections::HashMap;

use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::chia::bls::{aggregate_verify, master_to_wallet_unhardened, sign};
use chia_wallet_sdk::chia::puzzle_types::DeriveSynthetic;

/// Signs a transaction with whichever of `secret_keys` are needed.
fn sign_spends(
    coin_spends: &[CoinSpend],
    secret_keys: &[SecretKey],
    constants: &AggSigConstants,
) -> anyhow::Result<Signature> {
    let keys: HashMap<PublicKey, &SecretKey> =
        secret_keys.iter().map(|sk| (sk.public_key(), sk)).collect();

    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(&mut allocator, coin_spends, constants)?;

    let mut signature = Signature::default();

    for required in required {
        let RequiredSignature::Bls(required) = required else {
            anyhow::bail!("secp signatures are provided in the solution, not the aggregate");
        };

        let Some(sk) = keys.get(&required.public_key) else {
            anyhow::bail!("missing secret key for {:?}", required.public_key);
        };

        signature += &sign(sk, required.message());
    }

    Ok(signature)
}

#[test]
fn sign_and_submit() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // A wallet key at index 0, and a coin locked to its standard puzzle.
    let master_sk = SecretKey::from_seed(&[7; 64]);
    let synthetic_sk = master_to_wallet_unhardened(&master_sk, 0).derive_synthetic();
    let synthetic_pk = synthetic_sk.public_key();
    let p2 = StandardLayer::new(synthetic_pk);
    let coin = sim.new_coin(p2.tree_hash().into(), 1_000);

    p2.spend(ctx, coin, Conditions::new().reserve_fee(1_000))?;
    let coin_spends = ctx.take();

    // The simulator uses testnet11, so sign for testnet11.
    let testnet = AggSigConstants::from(&*TESTNET11_CONSTANTS);
    let signature = sign_spends(&coin_spends, &[synthetic_sk.clone()], &testnet)?;

    // A signature for mainnet is different, and wouldn't be valid here.
    let mainnet = AggSigConstants::from(&*MAINNET_CONSTANTS);
    let mainnet_signature = sign_spends(&coin_spends, &[synthetic_sk], &mainnet)?;
    assert_ne!(signature, mainnet_signature);
    let wrong_network = SpendBundle::new(coin_spends.clone(), mainnet_signature);
    assert!(sim.new_transaction(wrong_network).is_err());

    // You can verify the aggregate signature locally before submitting.
    let mut allocator = Allocator::new();
    let messages: Vec<(PublicKey, Vec<u8>)> =
        RequiredSignature::from_coin_spends(&mut allocator, &coin_spends, &testnet)?
            .into_iter()
            .filter_map(|required| match required {
                RequiredSignature::Bls(bls) => Some((bls.public_key, bls.message())),
                RequiredSignature::Secp(_) => None,
            })
            .collect();
    assert!(aggregate_verify(
        &signature,
        messages.iter().map(|(pk, msg)| (pk, msg.as_slice()))
    ));

    let spend_bundle = SpendBundle::new(coin_spends, signature);
    sim.new_transaction(spend_bundle)?;

    Ok(())
}
```

In tests, `Simulator::spend_coins(coin_spends, &secret_keys)` does all of this for you with testnet11 constants. In production, submit the `SpendBundle` with a [peer](/sdk/networking/peer) or an [RPC client](/sdk/networking/rpc).

Signing works the same way for every puzzle, not only the standard puzzle, because `RequiredSignature` runs the actual puzzle. As long as you hold the secret key for each requested public key, the aggregate signature is valid. Spends that request no signatures, like the offer settlement puzzle, contribute nothing, and a bundle with no required signatures uses `Signature::default()`.

### Signing errors

`RequiredSignature::from_coin_spends` returns a `SignerError` rather than a list you might sign blindly when something looks wrong:

| Error                            | Meaning                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PuzzleHashMismatch`             | A puzzle reveal doesn't hash to its coin's puzzle hash. Someone may be trying to get a signature valid for a different coin.                         |
| `InfinityPublicKey`              | A condition requests a signature from the identity public key.                                                                                       |
| `UnsafeMessageHasAdditionalData` | An `AGG_SIG_UNSAFE` message ends with one of the network's domain strings, so signing it could authorize an `AGG_SIG_ME` (or other) spend elsewhere. |
| `AggSigMessageTooLong`           | The message exceeds the consensus limit of 1024 bytes.                                                                                               |
| `Eval`, `FromClvm`, `ToClvm`     | The puzzle failed to run, or its output isn't a valid condition list.                                                                                |

## Secp keys

Some puzzles verify secp256k1 or secp256r1 (P-256) signatures with the `secp256k1_verify` and `secp256r1_verify` operators instead of `AGG_SIG_*` conditions. This lets coins be controlled by Ethereum-style keys, hardware wallets and passkeys. The key types are `K1SecretKey`, `K1PublicKey`, `K1Signature` and the `R1` equivalents, all in the prelude.

Unlike BLS signatures, these signatures are passed in the puzzle's solution, not aggregated into the `SpendBundle`. The message is a 32-byte hash defined by the puzzle, signed with `sign_prehashed`. [Vaults & MIPS](/sdk/primitives/vaults) covers the member puzzles that use these keys and how to sign for them.

When `RequiredSignature` runs a spend whose puzzle verifies a secp signature, it reports a `RequiredSignature::Secp` with the `public_key`, the `message_hash` the puzzle checked, and a `placeholder_ptr` pointing at the signature value the puzzle passed to the operator (in the allocator you gave `from_coin_spends`). Verification is treated as successful while collecting, so a signer can discover which secp signatures a spend needs before the real signatures have been filled in.

## Gotchas

- **Sign with the synthetic key.** The standard puzzle requires a signature from the synthetic public key. Signing with the unsynthesized wallet key produces a valid-looking but useless signature.
- **Simulator key pairs aren't synthetic.** `BlsPair` and `Simulator::bls` lock coins to `StandardArgs::curry_tree_hash(pk)` with the plain key, to keep tests short. Real wallets call `derive_synthetic` first.
- **Signatures are network-specific.** A bundle signed with mainnet constants is invalid on testnet11 and vice versa. Pass the right `AggSigConstants` for the network you submit to.
- **Only sign what you've checked.** `RequiredSignature` tells you what a spend needs, not whether you want it to happen. Before signing a spend bundle someone else built, inspect what it does; see [Clear Signing](/sdk/clear-signing) for vault transactions and [Offers](/sdk/offers) for trades.
