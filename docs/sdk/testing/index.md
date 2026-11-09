---
title: Simulator
slug: /sdk/testing
---

# Simulator

The `chia-sdk-test` crate (re-exported as `chia_wallet_sdk::test`) contains `Simulator`, an in-memory
blockchain for testing spends. You create coins out of thin air, build spends with the rest of the SDK,
and hand them to the simulator, which validates them with the same consensus code a full node uses:
puzzle execution and cost, conditions, timelocks, announcements and messages, and aggregate signatures.
If the simulator accepts a spend bundle, the network would accept it too, so tests can catch real bugs
without a node or a testnet wallet.

Almost every example in these docs is a `#[test]` against the simulator. The key types (`Simulator`,
`SimulatorConfig`, `SimulatorError`, `BlsPair`, `BlsPairWithCoin`, `K1Pair`, `R1Pair`) are in the
prelude.

| Tool                                                    | Use it for                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Simulator`                                             | Fast, synchronous unit tests of spends                                                      |
| [`PeerSimulator`](/sdk/testing/peer-simulator)          | Testing code that talks to a full node over the peer protocol (`Peer`)                      |
| [`FullNodeSimulator`](/sdk/testing/full-node-simulator) | Testing mempool behavior, block farming and reorgs, or code that uses the full node RPC API |

## A first test

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn send_and_find_coin() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // A key pair with a standard (XCH) coin of 1,000 mojos.
    let alice = sim.bls(1_000);
    let bob = BlsPair::new(42);

    let memos = ctx.hint(bob.puzzle_hash)?;
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(bob.puzzle_hash, 900, memos)
            .reserve_fee(100),
    )?;

    // Signs with the given keys, validates and applies the spends as a new block.
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Alice's coin is spent and Bob has a new coin.
    assert!(sim.coin_state(alice.coin.coin_id()).unwrap().spent_height.is_some());

    let bob_coins = sim.unspent_coins(bob.puzzle_hash, false);
    assert_eq!(bob_coins.len(), 1);
    assert_eq!(bob_coins[0].amount, 900);

    Ok(())
}
```

## Coins and keys

The simulator doesn't have a genesis block or farming rewards. You create coins directly:

- `new_coin(puzzle_hash, amount)` creates a coin with a random parent ID and returns it.
- `insert_coin(coin)` adds a coin you constructed yourself, which is useful when the parent ID matters
  (for example, an eve coin whose parent must be a particular launcher).
- `bls(amount)` generates a fresh BLS key pair, creates a standard coin for it, and returns a
  `BlsPairWithCoin` with `sk`, `pk`, `puzzle_hash` and `coin`.

The key pair types are deterministic, so the same seed always produces the same key:

| Type              | Contents                                       | Use it for                                                   |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `BlsPair`         | BLS `sk`, `pk`, and the standard `puzzle_hash` | Standard wallets, CAT/NFT/DID owners                         |
| `BlsPairWithCoin` | A `BlsPair` plus a funded `coin`               | Returned by `Simulator::bls`                                 |
| `K1Pair`          | secp256k1 `sk` and `pk`                        | [Vault](/sdk/primitives/vaults) members using secp256k1 keys |
| `R1Pair`          | secp256r1 `sk` and `pk`                        | Vault members using passkeys (secp256r1)                     |

Each has `new(seed)`, `range::<N>()` for an array of `N` pairs seeded `0..N`, `range_with_seed`, and
`range_vec` / `range_vec_with_seed` for a `Vec`. `Simulator::bls` draws its keys from the simulator's own
seeded RNG, so they're deterministic too, but differ from `BlsPair::new(0)` and friends.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn many_signers() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let [alice, bob, carol] = BlsPair::range::<3>();
    let alice_coin = sim.new_coin(alice.puzzle_hash, 500);
    let bob_coin = sim.new_coin(bob.puzzle_hash, 500);

    // Both coins pay Carol, and the transaction needs both signatures.
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice_coin,
        Conditions::new().create_coin(carol.puzzle_hash, 500, Memos::None),
    )?;
    StandardLayer::new(bob.pk).spend(
        ctx,
        bob_coin,
        Conditions::new().create_coin(carol.puzzle_hash, 500, Memos::None),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk, bob.sk])?;

    assert_eq!(sim.unspent_coins(carol.puzzle_hash, false).len(), 2);

    Ok(())
}
```

## Submitting spends

There are two ways to submit a transaction:

- `spend_coins(coin_spends, &secret_keys)` works out which BLS signatures the spends require, signs
  them with the matching keys from `secret_keys`, and submits the result. It fails with
  `SimulatorError::MissingKey` if a required key isn't in the list. Extra keys are ignored.
- `new_transaction(spend_bundle)` submits a `SpendBundle` you've already signed, for example to test your
  own signing code, an offer, or an invalid signature.

`spend_coins` signs with testnet11's `AGG_SIG_ME` additional data, and the simulator validates with
testnet11's consensus constants, so sign with `TESTNET11_CONSTANTS` when you sign manually. The signing
step is also available on its own as `chia_wallet_sdk::test::sign_transaction(&coin_spends, &keys)`.
secp256k1 and secp256r1 signatures are part of the puzzle solution rather than the aggregate signature,
so you put them into the spend yourself, and `spend_coins` only needs the BLS keys.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn sign_manually() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, Memos::None),
    )?;
    let coin_spends = ctx.take();

    // Work out what needs signing, using testnet11's constants to match the simulator.
    let mut allocator = Allocator::new();
    let required = RequiredSignature::from_coin_spends(
        &mut allocator,
        &coin_spends,
        &AggSigConstants::new(TESTNET11_CONSTANTS.agg_sig_me_additional_data),
    )?;

    let mut signature = Signature::default();
    for required in required {
        let RequiredSignature::Bls(required) = required else {
            continue;
        };
        assert_eq!(required.public_key, alice.pk);
        signature += &chia_wallet_sdk::chia::bls::sign(&alice.sk, required.message());
    }

    let updates = sim.new_transaction(SpendBundle::new(coin_spends, signature))?;

    // The result maps each affected coin ID to its new state.
    assert_eq!(updates.len(), 2);

    Ok(())
}
```

Each successful transaction is its own block. `spend_coins` and `new_transaction` return an
`IndexMap<Bytes32, CoinState>` of every coin the transaction created or spent, which is handy for finding
outputs without recomputing their IDs. A rejected transaction leaves the simulator unchanged.

See [Keys & Signing](/sdk/concepts/signing) for how `RequiredSignature` works.

## Validation errors

When a transaction is invalid, you get a `SimulatorError`:

| Variant                         | Meaning                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `Validation(ErrorCode)`         | Consensus rejected the bundle. The `ErrorCode` is the same one a full node would report       |
| `Signer(SignerError)`           | `spend_coins` couldn't work out the required signatures (for example, a puzzle failed to run) |
| `MissingKey`                    | `spend_coins` wasn't given a key for a required signature                                     |
| `Io`, `ChainState`, `StateDump` | Used by the full node simulator and serialization                                             |

`ErrorCode` lives in `chia_wallet_sdk::chia::consensus::validation_error`. Matching on it makes tests of
failure cases precise. The `expect_spend(result, should_pass)` helper asserts that a result passed or
failed, for tests that run the same spend with different inputs.

```rust
use chia_wallet_sdk::chia::consensus::validation_error::ErrorCode;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::expect_spend;

#[test]
fn rejects_invalid_spends() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let alice = sim.bls(1_000);
    let alice_p2 = StandardLayer::new(alice.pk);

    // Creating more value than the coin has.
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 2_000, Memos::None),
    )?;
    let result = sim.spend_coins(ctx.take(), &[alice.sk.clone()]);
    assert!(matches!(
        result,
        Err(SimulatorError::Validation(ErrorCode::MintingCoin))
    ));

    // Signing with the wrong key.
    let mallory = BlsPair::new(1);
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, Memos::None),
    )?;
    let result = sim.spend_coins(ctx.take(), &[mallory.sk]);
    assert!(matches!(result, Err(SimulatorError::MissingKey)));

    // The valid spend still works, because failed attempts don't change the state.
    alice_p2.spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, Memos::None),
    )?;
    expect_spend(sim.spend_coins(ctx.take(), &[alice.sk]), true);

    Ok(())
}
```

## Height and time

The simulator starts at height 0 with a next timestamp of 0. Every transaction creates a block at the
current height and timestamp, then increments the height by one and the timestamp by one second. You can
move the clock yourself:

| Method                                     | Effect                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `height()`                                 | The height the next block will have                                        |
| `next_timestamp()`                         | The timestamp the next block will have                                     |
| `pass_time(seconds)`                       | Moves the next timestamp forward                                           |
| `set_next_timestamp(t)`                    | Sets the next timestamp. Fails if `t` is before the last block's timestamp |
| `create_block()`                           | Creates an empty block, advancing height by one                            |
| `header_hash()` / `header_hash_of(height)` | Random but deterministic header hashes, per block                          |

Timelocks are checked against these values. For example, a coin can be locked until a timestamp with
`assert_seconds_absolute`, and the test advances time to unlock it:

```rust
use chia_wallet_sdk::chia::consensus::validation_error::ErrorCode;
use chia_wallet_sdk::prelude::*;

#[test]
fn timelocked_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let alice = sim.bls(1_000);

    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(alice.puzzle_hash, 1_000, Memos::None)
            .assert_seconds_absolute(3_600),
    )?;
    let coin_spends = ctx.take();

    let result = sim.spend_coins(coin_spends.clone(), &[alice.sk.clone()]);
    assert!(matches!(
        result,
        Err(SimulatorError::Validation(ErrorCode::AssertSecondsAbsoluteFailed))
    ));

    sim.pass_time(3_600);
    sim.spend_coins(coin_spends, &[alice.sk])?;

    Ok(())
}
```

Relative timelocks (`assert_height_relative`, `assert_seconds_relative`) are measured from the block the
coin was created in. A coin made with `new_coin` or `bls` belongs to the next block, which doesn't
exist until a transaction or `create_block` creates it. Call `sim.create_block()` after creating a coin
whose relative timelock you want to test, or the spend fails with
`ErrorCode::EphemeralRelativeCondition`.

## Looking up state

The simulator records coin states, spends and hints, so tests can exercise the same lookups a wallet
does against a node:

| Method                                                                    | Returns                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `coin_state(coin_id)`                                                     | The `CoinState` (coin, `created_height`, `spent_height`), if known        |
| `lookup_coin_ids(&ids)`                                                   | Coin states for a set of IDs                                              |
| `lookup_puzzle_hashes(puzzle_hashes, include_hints)`                      | Coin states locked by, or optionally hinted with, the given puzzle hashes |
| `unspent_coins(puzzle_hash, include_hints)`                               | Unspent coins for one puzzle hash                                         |
| `children(coin_id)`                                                       | Coins created by a coin                                                   |
| `hinted_coins(hint)`                                                      | IDs of coins hinted with `hint`                                           |
| `coin_spend(coin_id)`, `puzzle_reveal`, `solution`, `puzzle_and_solution` | How a spent coin was spent                                                |

Hints are recorded from the memos of `CREATE_COIN` conditions, the same way a full node indexes them.
`hint_coin(coin_id, hint)` adds a hint by hand, for coins you created with `new_coin`.

A useful pattern is to test parsing the way it happens in a real wallet: spend a coin, then reconstruct
the child from the parent spend the simulator recorded rather than from values you already have.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn find_and_parse_cat_by_hint() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let alice = sim.bls(1_000);

    // Issue a CAT hinted to Alice.
    let memos = ctx.hint(alice.puzzle_hash)?;
    let (issue_cat, _cats) = Cat::single_issuance(
        ctx,
        alice.coin.coin_id(),
        None,
        1_000,
        Conditions::new().create_coin(alice.puzzle_hash, 1_000, memos),
    )?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, issue_cat)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // A wallet finds its CATs by hint, since their puzzle hash isn't the wallet's.
    let hinted = sim.unspent_coins(alice.puzzle_hash, true);
    let cat_coin = hinted
        .into_iter()
        .find(|coin| coin.puzzle_hash != alice.puzzle_hash)
        .expect("missing CAT coin");

    // Rebuild the CAT from its parent's spend.
    let parent_spend = sim
        .coin_spend(cat_coin.parent_coin_info)
        .expect("missing parent spend");
    let puzzle = ctx.alloc(&parent_spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&parent_spend.solution)?;

    let cats = Cat::parse_children(ctx, parent_spend.coin, puzzle, solution)?
        .expect("parent isn't a CAT");
    assert!(cats.iter().any(|cat| cat.coin == cat_coin));

    Ok(())
}
```

## Configuration

`Simulator::new()` uses `SimulatorConfig::default()`. Use `Simulator::with_config` to change it:

| Field            | Default                           | Effect                                                                                     |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `seed`           | `1337`                            | Seed for the RNG behind coin parent IDs, header hashes and `bls` keys                      |
| `save_spends`    | `true`                            | Record coin spends, needed for `coin_spend`, `puzzle_reveal` and `solution`                |
| `save_hints`     | `true`                            | Record hints from `CREATE_COIN` memos, needed for hint lookups                             |
| `timestamp_mode` | `Increment { start: 0, step: 1 }` | Currently not used by `Simulator`; timestamps always start at 0 and advance by 1 per block |

Turning off `save_spends` and `save_hints` reduces memory use in long-running tests that create
many transactions.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn custom_config() {
    let config = SimulatorConfig {
        seed: 7,
        save_spends: false,
        ..SimulatorConfig::default()
    };

    let mut a = Simulator::with_config(config);
    let mut b = Simulator::with_config(config);

    // The same seed gives the same keys and coins.
    assert_eq!(a.bls(100).coin, b.bls(100).coin);
}
```

`Simulator` implements `Clone` and `PartialEq`, so you can snapshot the state before a branch of a test
and compare or restore it afterwards. With the `serde` feature of `chia-sdk-test` (not exposed by
`chia-wallet-sdk`, so add `chia-sdk-test` as a direct dependency to use it), `serialize` and
`deserialize` save and load the simulator state as bytes.

## Helpers

`chia_wallet_sdk::test` has a few more helpers for tests:

- `to_program(value)` converts any `ToClvm` value to a `Program`, and `to_puzzle(value)` also returns its
  tree hash. `to_puzzle(1)` gives the puzzle `1`, which returns its solution as its conditions, so anyone
  can spend it. It's the quickest way to make a coin for a test that isn't about signatures.
- `debug_announcements(&coin_spends)` prints every announcement the spends create and assert, and
  panics if an asserted announcement isn't created. Use it to debug `AssertCoinAnnouncementFailed` and
  similar errors.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::{to_program, to_puzzle};

#[test]
fn anyone_can_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();

    let (puzzle_hash, puzzle_reveal) = to_puzzle(1)?;
    let coin = sim.new_coin(puzzle_hash, 100);

    // The solution is the list of conditions.
    let solution = to_program([CreateCoin::new(puzzle_hash, 100, Memos::<NodePtr>::None)])?;

    sim.new_transaction(SpendBundle::new(
        vec![CoinSpend::new(coin, puzzle_reveal, solution)],
        Signature::default(),
    ))?;

    assert_eq!(sim.children(coin.coin_id()).len(), 1);

    Ok(())
}
```

## Benchmarking cost

`Benchmark` collects the CLVM cost of spends under labels and prints a summary table with the average,
count, minimum, maximum and median for each label. `add_spends` measures the cost and then submits the
spends to the simulator (signing them like `spend_coins`), so it slots into a normal test.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::Benchmark;

#[test]
fn benchmark_standard_spend() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();
    let mut benchmark = Benchmark::new("Standard spend".to_string());

    for outputs in [1, 2, 5] {
        let alice = sim.bls(1_000);
        let mut conditions = Conditions::new();
        for amount in 1..=outputs {
            // Outputs must be unique, so vary the amount. The rest is left as the fee.
            conditions = conditions.create_coin(alice.puzzle_hash, amount, Memos::None);
        }

        StandardLayer::new(alice.pk).spend(&mut ctx, alice.coin, conditions)?;
        let coin_spends = ctx.take();

        benchmark.add_spends(
            &mut ctx,
            &mut sim,
            coin_spends,
            &format!("{outputs} outputs"),
            &[alice.sk],
        )?;
    }

    // Pass a file name to also write the table to disk.
    benchmark.print_summary(None);

    Ok(())
}
```

The cost includes the per-byte cost of the spend bundle and the conditions, as a full node computes it.
For the cost of a single spend bundle outside a benchmark, use `spend_bundle_cost` (see
[Utilities](/sdk/utilities)).

## Limitations

The simulator models consensus validation, not a network:

- There's no mempool. A valid transaction is confirmed immediately in its own block, so there's no fee
  competition, replacement by fee or deduplication. Use the
  [full node simulator](/sdk/testing/full-node-simulator) to test those.
- There are no reorgs, block rewards or farming.
- Header hashes are random, not real block hashes, and there are no block records.
- The maximum cost per transaction is half the block limit (5,500,000,000), matching the mempool's limit
  for a single transaction.

See the [chia-sdk-test rustdocs](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/test/index.html)
for the full API.
