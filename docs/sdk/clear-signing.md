---
title: Clear Signing
---

# Clear Signing

When a [vault](/sdk/primitives/vaults) signs a transaction, its signers only sign the tree hash of the
vault's delegated puzzle. That hash says nothing on its own, so before asking a user (or a hardware
signer) to approve it, you want to know what the transaction will actually do: which coins it spends,
where the value goes, how much fee it pays, whether it changes the vault's custody, whether it links
an offer.

The clear signing module (`chia_wallet_sdk::driver`, no feature flag) does this. You give it the
vault's delegated spend and the coin spends that go along with it, and `parse_vault_transaction`
returns a `VaultTransaction` describing the effects that are **guaranteed** if the signature is used.

The guiding rule is that only verifiable information is reported. A coin spend is only included if the
vault's delegated spend commits to it (by sending it a message with its delegated puzzle hash, or by
asserting that it's spent), and only if the coin's conditions can't be changed without invalidating
that commitment. Anything that could be swapped out by whoever assembles the final spend bundle is
either left out or causes an error.

## How it works

1. The vault's delegated spend must be a quoted list of conditions (the format produced by
   `SpendContext::delegated_spend`). Anything else fails with `DriverError::InvalidDelegatedSpendFormat`,
   because a delegated puzzle that computes its conditions from the solution would be malleable.
2. From those conditions it reads the vault's own effects: the odd `CREATE_COIN` that recreates the
   vault (`vault_child`), any even "drop" coins (`drop_coins`), `RESERVE_FEE`, expiration
   (`ASSERT_BEFORE_SECONDS_ABSOLUTE`), and every `SEND_MESSAGE`.
3. Each `SEND_MESSAGE` must have the vault format: sender committed by puzzle, receiver committed by
   coin id. The message names the coin the vault is authorizing. That coin's spend must be revealed,
   its p2 puzzle must be one of the vault's (`P2Singleton`, `P2ConditionsOrSingleton`, or a clawback
   around one of those), and the message must equal the tree hash of the coin's delegated conditions.
4. The children of every verified spend are parsed: XCH, CATs (including revocable CATs), NFTs, and
   bulletins, with their memos, hints and clawbacks decoded. Spends of those children that are
   asserted by the vault (`ASSERT_CONCURRENT_SPEND`) are verified recursively.
5. Settlement payments that the transaction asserts are matched against revealed requested payments,
   which is how offers are summarized.

## Example

This example builds a vault with a single BLS member, has the vault spend one of its XCH coins to pay
Bob with a fee, and parses the result before signing it. It also shows that a transaction that hides
one of the authorized coin spends is rejected.

```rust
use chia_wallet_sdk::clvm_traits::clvm_list;
use chia_wallet_sdk::driver::{
    ClawbackV2, InnerPuzzleSpend, MipsSpend, P2Singleton, ParsedAsset, Reveals, VaultOutput,
    mips_puzzle_hash, parse_vault_transaction,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::{MessageFlags, MessageSide, puzzles::BlsMember};

struct TestVault {
    vault: Vault,
    member: BlsMember,
    p2: P2Singleton,
    sk: SecretKey,
}

fn mint_vault(sim: &mut Simulator, ctx: &mut SpendContext) -> anyhow::Result<TestVault> {
    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], member.curry_tree_hash(), true);

    let (conditions, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    let p2 = P2Singleton::new(vault.info.launcher_id, 0);

    Ok(TestVault { vault, member, p2, sk: alice.sk })
}

/// Builds an unsigned transaction in which the vault authorizes `coin` to output `conditions`.
/// Returns the coin spends and the vault's delegated spend (the thing that gets signed).
fn build_transaction(
    ctx: &mut SpendContext,
    v: &TestVault,
    coin: Coin,
    conditions: Conditions,
) -> anyhow::Result<(Vec<CoinSpend>, Spend)> {
    let delegated = ctx.delegated_spend(conditions)?;
    let delegated_puzzle_hash = ctx.tree_hash(delegated.puzzle);
    let spend = v.p2.spend(ctx, v.vault.info.custody_hash.into(), v.vault.coin.amount, delegated)?;
    ctx.spend(coin, spend)?;

    let mode = MessageFlags::PUZZLE.encode(MessageSide::Sender)
        | MessageFlags::COIN.encode(MessageSide::Receiver);
    let coin_id = ctx.alloc(&coin.coin_id())?;
    let vault_delegated = ctx.delegated_spend(
        Conditions::new()
            .send_message(mode, delegated_puzzle_hash.to_vec().into(), vec![coin_id])
            .create_coin(v.vault.info.custody_hash.into(), v.vault.coin.amount, Memos::None),
    )?;

    let mut mips = MipsSpend::new(vault_delegated);
    let member_puzzle = ctx.curry(v.member)?;
    mips.members.insert(
        v.vault.info.custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    v.vault.spend(ctx, &mips)?;

    Ok((ctx.take(), vault_delegated))
}

#[test]
fn clear_sign_payment() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let v = mint_vault(&mut sim, ctx)?;
    let coin = sim.new_coin(v.p2.tree_hash().into(), 1000);
    let bob = Bytes32::new([1; 32]);

    let (coin_spends, delegated_spend) = build_transaction(
        ctx,
        &v,
        coin,
        Conditions::new()
            .create_coin(bob, 900, Memos::None)
            .reserve_fee(100),
    )?;

    // Parse before signing.
    let reveals = Reveals::from_coin_spends(ctx, &coin_spends)?;
    let tx = parse_vault_transaction(reveals, ctx, v.vault.info.launcher_id, delegated_spend)?;

    // The vault keeps its custody configuration and amount.
    assert_eq!(
        tx.vault_child,
        Some(VaultOutput::new(v.vault.info.custody_hash.into(), 1))
    );
    assert_eq!(tx.reserved_fee, 100);
    assert_eq!(tx.p2_puzzle_hashes, vec![Bytes32::from(v.p2.tree_hash())]);

    // One vault-owned XCH coin is spent, creating one coin for Bob.
    assert_eq!(tx.spends.len(), 1);
    let spend = &tx.spends[0];
    assert!(matches!(spend.asset, ParsedAsset::Xch(_)));
    assert_eq!(spend.children.len(), 1);
    assert_eq!(spend.children[0].memos.p2_puzzle_hash, bob);
    assert_eq!(spend.children[0].asset.coin().amount, 900);

    // Looks good, so sign and submit it.
    sim.spend_coins(coin_spends, &[v.sk])?;

    Ok(())
}

#[test]
fn clear_sign_clawback() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let v = mint_vault(&mut sim, ctx)?;
    let p2_puzzle_hash: Bytes32 = v.p2.tree_hash().into();
    let coin = sim.new_coin(p2_puzzle_hash, 1000);
    let bob = Bytes32::new([1; 32]);

    // Send to Bob with a clawback, using the standard clawback memo format.
    let clawback = ClawbackV2::new(p2_puzzle_hash, bob, 1_000_000, 1000, false);
    let memos = ctx.memos(&clvm_list!(bob, clawback.memo()))?;

    let (coin_spends, delegated_spend) = build_transaction(
        ctx,
        &v,
        coin,
        Conditions::new().create_coin(clawback.tree_hash().into(), 1000, memos),
    )?;

    let reveals = Reveals::from_coin_spends(ctx, &coin_spends)?;
    let tx = parse_vault_transaction(reveals, ctx, v.vault.info.launcher_id, delegated_spend)?;

    // The child is recognized as a clawback, and its recipient is Bob.
    let child = &tx.spends[0].children[0];
    assert_eq!(child.memos.clawback, Some(clawback));
    assert_eq!(child.memos.p2_puzzle_hash, bob);

    Ok(())
}

#[test]
fn hidden_spend_is_rejected() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let v = mint_vault(&mut sim, ctx)?;
    let coin = sim.new_coin(v.p2.tree_hash().into(), 1000);

    let (coin_spends, delegated_spend) = build_transaction(
        ctx,
        &v,
        coin,
        Conditions::new().create_coin(Bytes32::new([1; 32]), 1000, Memos::None),
    )?;

    // Only reveal the vault's own spend, not the coin it authorizes.
    let vault_spend = coin_spends.last().unwrap().clone();
    let reveals = Reveals::from_coin_spends(ctx, &[vault_spend])?;
    let result = parse_vault_transaction(reveals, ctx, v.vault.info.launcher_id, delegated_spend);

    assert!(matches!(result, Err(DriverError::MissingSpend)));

    Ok(())
}
```

In a real wallet you'd build the coin spends with the [action system](/sdk/action-system) and a vault
p2 spend (see [Custom Spends](/sdk/action-system/custom-spends)), then pass the result through
`parse_vault_transaction` before collecting signatures.

## Inputs: `Reveals`

`Reveals` holds everything the parser is allowed to know about:

| Method                              | What it reveals                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Reveals::from_coin_spends`         | All coin spends in the transaction. Coin spends whose parent is all zeros are treated as requested payments |
| `reveal_coin_spend`                 | A single coin spend (the puzzle reveal is checked against the coin's puzzle hash)                           |
| `reveal_settlement_payment`         | A requested settlement payment, given its outer puzzle and settlement solution                              |
| `reveal_clawback`                   | A `ClawbackV2` p2 puzzle, so spends of coins locked in it can be recognized                                 |
| `reveal_p2_conditions_or_singleton` | A `P2ConditionsOrSingleton`, so children locked to it are recognized as offer pre-splits                    |
| `reveal_vault_nonce`                | An extra `P2Singleton` nonce the vault uses (nonce 0 is always included)                                    |

Coins created by the transaction are only recognized as returning to the vault if their puzzle hash is
one of the vault's p2 puzzle hashes. These are calculated from the revealed nonces and reported in
`VaultTransaction::p2_puzzle_hashes`.

## Output: `VaultTransaction`

| Field                   | Meaning                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `vault_child`           | The new custody hash and amount of the vault, or `None` if the vault is melted. A different hash means a rekey      |
| `drop_coins`            | Even-amount coins created directly by the vault spend (for example to launch singletons)                            |
| `spends`                | `VerifiedSpend`s: the asset spent, its custody (`CustodyInfo`), clawback path, children, and whether it was revoked |
| `issuances`             | CAT mints and melts (`RunCatTail`) authorized by the transaction                                                    |
| `asserted_payments`     | Settlement payments that are both revealed and asserted                                                             |
| `received_payments`     | Asserted payment outputs to one of the vault's p2 puzzle hashes                                                     |
| `external_payments`     | Asserted payment outputs to anyone else (required by the transaction, not necessarily paid by the vault)            |
| `asset_flows`           | Per-asset totals: input, output, issued, melted, received, paid and unaccounted amounts                             |
| `linked_offer`          | Summary of the offer this transaction pre-splits coins for, if any                                                  |
| `reserved_fee`          | Total `RESERVE_FEE` of the vault and its verified spends                                                            |
| `delegated_puzzle_hash` | The hash the signers are signing                                                                                    |

Each child (`ParsedChild`) has a `transfer_type`: `Sent`, `Burned` (sent to the burn puzzle hash),
`Offered` (sent to the settlement puzzle), or `OfferPreSplit` (locked into a revealed
`P2ConditionsOrSingleton`). Its `memos` field (`ParsedMemos`) has the effective recipient p2 puzzle
hash, a decoded `ClawbackV2` if present, any human-readable memos, and the fixed conditions of an offer
pre-split.

To validate a custody change, compare `vault_child.custody_hash` against a [`MipsMemo`](/sdk/primitives/vaults#recovering-a-vaults-configuration-from-memos)
for the new configuration.

## Clawbacks and expiration

Coins in a [`ClawbackV2`](/sdk/primitives/clawback) puzzle can be spent by the sender before the
timeout and by the receiver after it. If the transaction uses the sender path, it is only valid until
the clawback expires. The parser requires the vault to commit to an expiration
(`ASSERT_BEFORE_SECONDS_ABSOLUTE`) no later than that, and otherwise fails with
`DriverError::UnguaranteedClawBack`, since a transaction that could be held and replayed after the
timeout would do something different.

## Linked offers

A vault can't sign an offer the way a normal wallet does, because its coin spends need a message from
the vault spend. Instead, the vault transaction pre-splits coins into `P2ConditionsOrSingleton` puzzles
whose fixed path pays into the settlement puzzle and asserts the requested payments. The offer itself
is then built from those coins without another vault signature, and the vault can cancel it by
spending the coins through the singleton path.

When the `P2ConditionsOrSingleton` puzzles are revealed, `VaultTransaction::linked_offer` summarizes
the future offer: its reserved fee and the payments it requests (split into ones paid back to the vault
and external ones). For making and taking offers in general, see [Offers](/sdk/offers).

## Signing helpers

`chia_wallet_sdk::driver` also exposes the messages that vault members sign, which is useful for
external signers:

- `calculate_vault_coin_message(delegated_puzzle_hash, vault_coin_id, genesis_challenge)`: the
  `AGG_SIG_ME` style message for coin-bound members.
- `calculate_vault_puzzle_message(delegated_puzzle_hash, vault_puzzle_hash)`: the message for
  puzzle-asserting ("fast forward") members.
- `vault_recovery_delegated_puzzle_hash` and `calculate_vault_start_recovery_message`: the wrapped
  delegated puzzle hash and message for starting a recovery, for either `VaultVersion`.

## Errors

Parsing is conservative, so many unusual but valid transactions are rejected. Common errors:

| Error                                       | Cause                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `InvalidDelegatedSpendFormat`               | The vault's delegated puzzle isn't a quoted list of conditions                         |
| `InvalidVaultMessageFormat`                 | A `SEND_MESSAGE` from the vault doesn't use the puzzle-to-coin format with one coin id |
| `MissingSpend`                              | A coin the vault sends a message to isn't revealed                                     |
| `InvalidLinkedCustody`                      | A messaged coin's p2 puzzle isn't a recognized vault custody puzzle                    |
| `UnmatchedVaultMessage` / `WrongConditions` | A message doesn't match the coin's delegated conditions                                |
| `DuplicateVaultMessage`                     | The same coin is authorized twice                                                      |
| `MissingP2ConditionsOrSingletonAssertion`   | A vault spend of a `P2ConditionsOrSingleton` coin doesn't include `ASSERT_MY_COIN_ID`  |
| `UnguaranteedClawBack`                      | A clawback sender path is used without a matching expiration                           |

All of these are variants of `DriverError`.
