---
title: Troubleshooting
---

# Troubleshooting

Problems with transactions show up in one of three places:

- **While building**, as a `DriverError` from the driver crate (for example `InsufficientFunds` from the
  action system, or `FromClvm` when a puzzle doesn't parse).
- **While signing**, as a `SignerError` from `RequiredSignature::from_coin_spends`.
- **While validating**, as an `ErrorCode` from consensus. The [simulator](/sdk/testing) returns these as
  `SimulatorError::Validation(code)`, and a full node returns the same codes in the `error` of a rejected
  transaction.

This page goes through the common validation errors first, then build-time errors.

## Reproduce it in the simulator

Before anything else, rebuild the failing transaction in a test against the `Simulator`. It validates
bundles the same way a full node does, gives you the exact `ErrorCode`, and lets you change one thing at
a time. Matching on the error code makes the failure precise:

```rust
use chia_wallet_sdk::chia::consensus::validation_error::ErrorCode;
use chia_wallet_sdk::prelude::*;

#[test]
fn common_validation_errors() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();
    let alice = sim.bls(1_000);
    let p2 = StandardLayer::new(alice.pk);

    // Outputs exceed the input.
    p2.spend(ctx, alice.coin, Conditions::new().create_coin(alice.puzzle_hash, 1_001, Memos::None))?;
    let error = sim.spend_coins(ctx.take(), &[alice.sk.clone()]).unwrap_err();
    assert!(matches!(error, SimulatorError::Validation(ErrorCode::MintingCoin)));

    // The leftover is smaller than the reserved fee.
    p2.spend(
        ctx,
        alice.coin,
        Conditions::new()
            .create_coin(alice.puzzle_hash, 950, Memos::None)
            .reserve_fee(100),
    )?;
    let error = sim.spend_coins(ctx.take(), &[alice.sk.clone()]).unwrap_err();
    assert!(matches!(error, SimulatorError::Validation(ErrorCode::ReserveFeeConditionFailed)));

    // Asserting a spend that isn't in the bundle.
    p2.spend(
        ctx,
        alice.coin,
        Conditions::new().assert_concurrent_spend(Bytes32::new([1; 32])),
    )?;
    let error = sim.spend_coins(ctx.take(), &[alice.sk.clone()]).unwrap_err();
    assert!(matches!(error, SimulatorError::Validation(ErrorCode::AssertConcurrentSpendFailed)));

    // Signed for the wrong network: the simulator uses testnet11.
    p2.spend(ctx, alice.coin, Conditions::new().reserve_fee(1_000))?;
    let coin_spends = ctx.take();
    let mut signature = Signature::default();
    for required in RequiredSignature::from_coin_spends(
        ctx,
        &coin_spends,
        &AggSigConstants::from(&*MAINNET_CONSTANTS),
    )? {
        if let RequiredSignature::Bls(required) = required {
            signature += &chia_wallet_sdk::chia::bls::sign(&alice.sk, required.message());
        }
    }
    let error = sim.new_transaction(SpendBundle::new(coin_spends, signature)).unwrap_err();
    assert!(matches!(error, SimulatorError::Validation(ErrorCode::BadAggregateSignature)));

    // Spending the same coin twice.
    p2.spend(ctx, alice.coin, Conditions::new().reserve_fee(1_000))?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;
    p2.spend(ctx, alice.coin, Conditions::new().reserve_fee(1_000))?;
    let error = sim.spend_coins(ctx.take(), &[alice.sk]).unwrap_err();
    assert!(matches!(error, SimulatorError::Validation(ErrorCode::DoubleSpend)));

    Ok(())
}
```

To see what a spend actually outputs, run its puzzle with its solution and parse the conditions, as
shown in [Conditions](/sdk/concepts/conditions#parsing-conditions). Most failures become obvious once
you compare the conditions you expected with the ones the puzzle produced.

## Validation errors

| Error code                                                                             | What it usually means                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MintingCoin`                                                                          | The outputs of the bundle add up to more than its inputs. Check your amounts and change.                                                                                    |
| `ReserveFeeConditionFailed`                                                            | The bundle's leftover value (inputs minus outputs) is less than the sum of `RESERVE_FEE` conditions.                                                                        |
| `BadAggregateSignature`                                                                | A signature is missing, made with the wrong key, or made for the wrong network. See [Signing](#signature-problems).                                                         |
| `DoubleSpend`                                                                          | The coin was already spent, or the same coin appears twice in the bundle.                                                                                                   |
| `UnknownUnspent`                                                                       | The coin doesn't exist yet (it isn't confirmed, or its parent isn't in the bundle), or the coin's id is wrong because the puzzle hash or amount you built it with is wrong. |
| `WrongPuzzleHash`                                                                      | The puzzle reveal doesn't hash to the coin's puzzle hash. You're spending the coin with the wrong key, inner puzzle, or layer arguments.                                    |
| `GeneratorRuntimeError`                                                                | The puzzle raised an error (`x`) or failed to run with the solution. This includes failed CAT, singleton and NFT checks, which are enforced inside the puzzles.             |
| `AssertConcurrentSpendFailed`, `AssertConcurrentPuzzleFailed`                          | A spend asserted another spend that isn't in the bundle.                                                                                                                    |
| `AssertCoinAnnouncementFailed`, `AssertPuzzleAnnouncementFailed`                       | An announcement was asserted but not created. The announcement id is `sha256(coin_id or puzzle_hash + message)`, so check which side you hashed.                            |
| `MessageNotSentOrReceived`                                                             | A `SEND_MESSAGE` and `RECEIVE_MESSAGE` don't pair up. Both sides must agree on the mode, message and the coin they commit to.                                               |
| `AssertSecondsRelativeFailed`, `AssertHeightRelativeFailed`, and the absolute variants | A timelock hasn't passed yet. In the simulator, use `pass_time` and `create_block`.                                                                                         |
| `EphemeralRelativeCondition`                                                           | A relative timelock on a coin that was created in the same block. It has no confirmed height or timestamp yet.                                                              |
| `AssertBeforeSecondsAbsoluteFailed` and friends                                        | The transaction expired.                                                                                                                                                    |
| `CostExceeded`                                                                         | The bundle is too expensive. Split it into several transactions.                                                                                                            |

### Signature problems

A `BadAggregateSignature` means the aggregate signature doesn't match the messages the spends require.
The usual causes:

- **Wrong network.** `AGG_SIG_ME` and its variants commit to the network's genesis challenge, so a
  signature made with `MAINNET_CONSTANTS` is invalid on testnet11 and vice versa. The simulator uses
  testnet11. See [Keys & Signing](/sdk/concepts/signing).
- **Wrong key.** Wallet coins are locked with a **synthetic** key. Signing with the unsynthesized wallet
  key gives a valid signature for the wrong public key. Derive the synthetic secret key with
  `DeriveSynthetic` and sign with that.
- **Missing signer.** Every spend that requires a signature needs one. In a multi-key transaction,
  collect the required signatures once and make sure every one of them is signed.
- **Changed spends.** If you modify the coin spends after signing, the messages change and the signature
  no longer matches. Sign last.

`Simulator::spend_coins` returns `SimulatorError::MissingKey` instead, if it isn't given a secret key that
matches a required public key.

### Coin ids that don't match

Coin ids are `sha256(parent_coin_id + puzzle_hash + amount)`. If you compute a child coin yourself and
the network says it doesn't exist (`UnknownUnspent`), one of the three inputs is wrong. Common mistakes:

- Using the **p2** puzzle hash for a CAT, NFT or DID child. Their coins' puzzle hashes are the full,
  wrapped puzzle hash. Use the primitive's `child` methods (for example `Cat::child`) or
  `info.puzzle_hash()` instead of building the `Coin` yourself.
- Building a CAT's `Coin` from the parent's id and amount, but with the inner puzzle hash from a
  `CREATE_COIN` condition, rather than the outer puzzle hash.

### Spends that can be separated

If someone else's transaction confirms with only part of your bundle, the spends weren't linked. Anyone
can take a valid subset of a bundle from the mempool and submit it on its own. Link every spend in a
transaction with `assert_concurrent_spend`, announcements, or a `Relation` in the action system. See
[Application Patterns](/sdk/patterns#link-spends-that-belong-together).

## Errors while building

| `DriverError`                   | Cause and fix                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InsufficientFunds`             | The coins added to `Spends` don't cover the actions. Select more coins using `Deltas`, as shown in [coin selection with deltas](/sdk/action-system#coin-selection-with-deltas). |
| `MissingKey`                    | `finish_with_keys` found a coin whose p2 puzzle hash isn't in the key map.                                                                                                      |
| `MissingSpend`                  | `Spends::spend` wasn't given a p2 spend for every item in `unspent()`. See [Custom Spends](/sdk/action-system/custom-spends).                                                   |
| `CannotEmitConditions`          | The action system needed a spend to emit transaction-wide conditions, and no coin could. Add an XCH coin.                                                                       |
| `DuplicateSettlementPayment`    | Two settlement coins would make the same notarized payment. Use distinct nonces.                                                                                                |
| `SingletonAmountMismatch`       | A `send` or `melt_singleton` action's amount doesn't match the singleton's amount.                                                                                              |
| `AmountOverflow`, `FeeOverflow` | An amount doesn't fit in a `u64`.                                                                                                                                               |
| `MissingChild`                  | The spend you parsed or performed didn't recreate the singleton (for example it was melted), so there's no child to return.                                                     |
| `NotRevocable`                  | `add_for_revocation` was called with a CAT that has no hidden puzzle.                                                                                                           |
| `FromClvm`, `ToClvm`            | A value didn't have the shape its type expects. Usually a puzzle or solution of a different type, or a different version of a puzzle.                                           |
| `Eval`                          | Running a puzzle failed. The same spend would fail on chain.                                                                                                                    |
| `OldSettlementPayment`          | The offer uses the old version of the settlement payments puzzle, which isn't supported.                                                                                        |

The SDK's parsers return `Ok(None)` when a puzzle simply isn't the type you asked for (for example
`Cat::parse_children` on an NFT spend), and an error only when it looks like that type but is malformed.
So an `Ok(None)` while you expected a value usually means you're parsing the wrong spend, often the coin's
own spend instead of its parent's. See the [primitives overview](/sdk/primitives#parsing-from-the-parent-coin-spend).

## Errors while signing

`RequiredSignature::from_coin_spends` runs every puzzle to find its `AGG_SIG_*` conditions, so a puzzle
that fails to run fails here, as `SignerError::Eval`, before anything is submitted. Other variants:

| `SignerError`                    | Cause                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Eval`                           | A puzzle failed to run with its solution. The spend is invalid.                                                         |
| `FromClvm`                       | A puzzle's output isn't a valid list of conditions.                                                                     |
| `InfinityPublicKey`              | A condition asks for a signature from the infinity public key, which can't sign.                                        |
| `InvalidSecpKey`                 | A secp condition contains an invalid public key.                                                                        |
| `PuzzleHashMismatch`             | A coin spend's puzzle reveal doesn't hash to the coin's puzzle hash.                                                    |
| `UnsafeMessageHasAdditionalData` | An `AGG_SIG_UNSAFE` message ends with the network's additional data, which would let it be replayed as an `AGG_SIG_ME`. |
| `AggSigMessageTooLong`           | A message is longer than consensus allows.                                                                              |

## Networking problems

- **Requests that never return.** If a peer disconnects, outstanding requests can wait forever. Wrap
  peer requests in `tokio::time::timeout`, as described in [Peer Protocol](/sdk/networking/peer).
- **`WrongNetwork` on connect.** The network id you passed doesn't match the node's (`"mainnet"` or
  `"testnet11"`).
- **TLS errors.** Networking requires the `rustls` or `native-tls` feature, and full nodes require a
  client certificate. See [certificates and connectors](/sdk/networking/peer#certificates-and-connectors).
- **A transaction is accepted but never confirms.** It might have been outbid, or dropped by the node you
  sent it to. Check whether it's still in the mempool, rebroadcast it to other peers, or replace it with a
  higher fee.

## Getting help

If you've narrowed a problem down to a small simulator test and it still looks wrong, open an issue on
[chia-wallet-sdk](https://github.com/xch-dev/chia-wallet-sdk/issues) with the test, or ask in the
[Sage Discord](https://discord.gg/sagewallet).
