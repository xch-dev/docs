---
slug: /wallet-sdk
---

# Chia Wallet SDK

The Chia Wallet SDK is a Rust library for building applications that need to interact with coins on the [Chia Blockchain](https://www.chia.net/), including wallets and dApps (decentralized apps).

## Getting Started

### Installation

Add the Wallet SDK to your Rust project:

```shell
cargo add chia-wallet-sdk --features native-tls
```

### Basic Usage

Here's an example of using the SDK to create a wallet. This wallet will generate a new set of keys, calculate its balance, and spend all of its coins back to itself when there are available coins. It demonstrates the basics of the SDK, including how to connect to a node, generate keys and sign transactions, how to get coin state, how to create a spendbundle, and how to send a transaction.

```rust
use anyhow::{Result, bail};
use bip39::Mnemonic;
use chia::{
    bls::{DerivableKey, SecretKey, Signature, master_to_wallet_unhardened_intermediate, sign},
    protocol::{Bytes32, CoinStateFilters, NewPeakWallet, ProtocolMessageTypes, SpendBundle},
    puzzles::{DeriveSynthetic, Memos, standard::StandardArgs},
    traits::Streamable,
};
use chia_wallet_sdk::utils::Address;
use chia_wallet_sdk::{
    client::{PeerOptions, connect_peer, create_native_tls_connector, load_ssl_cert},
    driver::{Action, Id, Relation, SpendContext, Spends},
    signer::{AggSigConstants, RequiredSignature},
    types::TESTNET11_CONSTANTS,
};
use indexmap::indexmap;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha20Rng;
use std::str::FromStr;

#[tokio::main]
async fn main() -> Result<()> {
    // If the files exist, load the certs, or else generate new certs signed by the Chia Peer Protocol CA
    let ssl = load_ssl_cert("wallet.crt", "wallet.key")?;

    // Creates a tls connector with rustls.
    // create_rustls_connector also available if using rustls feature
    let connector = create_native_tls_connector(&ssl)?;

    let (peer, mut receiver) = connect_peer(
        "testnet11".to_string(),
        connector,
        // Connecting to a local node
        // Could alternatively do peer discovery or set to something else if you have a static non-local node
        "127.0.0.1:58444".parse()?,
        PeerOptions::default(),
    )
    .await?;
    println!("Connected to peer {}", peer.socket_addr());

    // Generate a temporary mnemonic / private key
    // And get the p2_puzzle_hash for the wallet
    // Print the address for the p2_puzzle_hash
    let mnemonic = generate_mnemonic()?;
    let sk = get_key(&mnemonic, 0)?;
    let pk = sk.public_key();
    let p2_puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(pk).into();
    let address = Address::new(p2_puzzle_hash, String::from_str("txch")?);
    println!("Address is {}", address.encode()?);

    // Sit around and wait for new messages from the connected peer
    // Ignore unless NewPeakWallet
    while let Some(message) = receiver.recv().await {
        if message.msg_type != ProtocolMessageTypes::NewPeakWallet {
            continue;
        }

        // When we receive a new peak, we want to get our balance and then make a spend
        let peak = NewPeakWallet::from_bytes(&message.data)?;
        println!("Received new peak {peak:?}");

        // Request unspent coin states from the full node for our p2_puzzle_hash
        let coin_states = peer
            .request_puzzle_state(
                vec![p2_puzzle_hash],
                None,
                TESTNET11_CONSTANTS.genesis_challenge,
                CoinStateFilters::new(false, true, false, 0),
                false,
            )
            .await?
            .unwrap()
            .coin_states;

        // Calculate and print the balance
        let balance: u64 = coin_states.iter().map(|cs| cs.coin.amount).sum();
        println!("Balance: {balance} mojos");

        if balance == 0 {
            continue;
        }
        println!("Spending our entire balance back to ourselves");

        // Create a new SpendContext, which helps create spendbundles in a simple manner
        let mut ctx = SpendContext::new();
        // Specify our p2_puzzle_hash as the address for change
        let mut spends = Spends::new(p2_puzzle_hash);

        // For now, we add all available coins as inputs to the spend
        // In practice, you likely won't spend all coins
        for coin_state in coin_states {
            spends.add(coin_state.coin);
        }

        // Set up a Vec<Action> to track the specific actions we want to perform in this spend
        // Actions are a simple way to compose numerous types of outputs into a single spend
        let mut actions = Vec::new();

        // Here we can push actions onto the actions Vec that represent each action to take in this spend
        // We're just sending two separate coins of different amounts back to ourselves, and doing so
        // each time we get a new wallet peak. This is not a realistic scenario, but demonstrates how
        // to go about making spends.
        // First we'll make a simple 10 mojo spend back to ourselves
        actions.push(Action::send(Id::Xch, p2_puzzle_hash, 10, Memos::None));
        // And then, we'll send another coin to ourselves, that is the remainder of our balance
        actions.push(Action::send(
            Id::Xch,
            p2_puzzle_hash,
            balance - 10,
            Memos::None,
        ));

        // Apply the actions to the spend context and get the deltas (changes)
        let deltas = spends.apply(&mut ctx, &actions)?;

        // Finalize the spend by providing the synthetic public keys needed to construct the
        // actual CoinSpends for each input. The IndexMap maps each p2_puzzle_hash to the
        // synthetic public key that controls it.
        //
        // Under the hood, finish_with_keys does the following (see chia-sdk-driver Spends::finish_with_keys):
        // - Calls create_change: computes change amounts from the computed deltas and adds change outputs.
        // - Emits all CLVM conditions gathered from Actions into the context.
        // - Emits a Relation (AssertConcurrent here) so input coins assert each other via announcements.
        // - For each asset/input:
        //   * If the SpendKind is Conditions (a standard p2/pk style spend), it looks up the
        //     synthetic key for the asset's p2_puzzle_hash and wraps the conditions in the
        //     StandardLayer for that key, producing a Spend.
        //   * If the SpendKind is Settlement (offer/settlement layer), it wraps the payments in
        //     the SettlementLayer to produce the appropriate Spend.
        // - Each produced Spend is pushed into the SpendContext, which accumulates CoinSpends.
        //
        // After this returns, ctx contains all CoinSpends, and we can query the required
        // signatures and sign them before forming a SpendBundle.
        let _outputs = spends.finish_with_keys(
            &mut ctx,
            &deltas,
            Relation::AssertConcurrent,
            &indexmap! {
                p2_puzzle_hash => pk,
            },
        )?;

        // Extract the final CoinSpends from the SpendContext.
        // ctx.take() drains the CoinSpends that were accumulated during spends.finish_with_keys
        // and returns them as a Vec<CoinSpend>. After this call, the internal list inside ctx is
        // emptied, but the SpendContext itself remains valid and reusable for other computations
        // (e.g., determining RequiredSignature from these CoinSpends). We need the CoinSpends here
        // to form the SpendBundle that will be broadcast to the network.
        let coin_spends = ctx.take();

        // Figure out exactly which messages we must sign to make this SpendBundle valid.
        //
        // RequiredSignature::from_coin_spends inspects the CoinSpends that were produced above
        // and extracts the concrete signature requirements for each layer/puzzle involved.
        // The result is a list of RequiredSignature items (currently we only expect BLS ones),
        // each containing:
        //   - the synthetic public key that must sign
        //   - the exact message that must be signed (agg_sig_me over conditions, announcements, etc.)
        //
        // Why AggSigConstants here?
        //   The additional data (a/k/a “AGG_SIG_ME” domain separator) is network-dependent and
        //   must match the chain we are targeting. We use TESTNET11 constants so the resulting
        //   messages are valid for Testnet11. Using the wrong additional_data would yield
        //   signatures that nodes reject.
        let required_signatures = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &AggSigConstants::new(TESTNET11_CONSTANTS.agg_sig_me_additional_data),
        )?;

        // Start with an empty signature that we'll aggregate individual signatures into
        let mut signature = Signature::default();

        // Go through each required signature and sign the message
        for required in required_signatures {
            // We only handle BLS signatures (skip other types)
            let RequiredSignature::Bls(required) = required else {
                continue;
            };

            // Make sure we have the right public key for this signature
            if required.public_key != pk {
                bail!("Missing public key for spend");
            }

            // Sign the required message with our secret key and add it to the aggregated signature
            // The += operator combines signatures using BLS signature aggregation
            signature += &sign(&sk, required.message());
        }

        // Create a spendbundle with the final coin spends and signature
        let spend_bundle = SpendBundle::new(coin_spends, signature);

        // Send the resulting spendbundle to the network via the connected peer
        let ack = peer.send_transaction(spend_bundle).await?;

        println!("Transaction ack {ack:?}");
    }

    println!("Disconnected from peer {}", peer.socket_addr());

    Ok(())
}

fn generate_mnemonic() -> Result<String> {
    let mut rng = ChaCha20Rng::from_os_rng();
    let entropy: [u8; 32] = rng.random();
    Ok(Mnemonic::from_entropy(&entropy)?.to_string())
}

fn get_key(mnemonic: &str, index: u32) -> Result<SecretKey> {
    let mnemonic = Mnemonic::from_str(mnemonic)?;
    let seed = mnemonic.to_seed("");
    Ok(
        master_to_wallet_unhardened_intermediate(&SecretKey::from_seed(&seed))
            .derive_unhardened(index)
            .derive_synthetic(),
    )
}

```
