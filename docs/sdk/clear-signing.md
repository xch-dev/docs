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

:::note Unreleased
The SDK's `main` branch (not in a release yet; the latest release is 0.37.1) adds several clear signing
features: signed messages, vaults controlled by other vaults, Secure the Bag payments and expired
clawback push-throughs. It's also stricter in a few places. These are marked "On `main`" below.
Everything else describes 0.37.1, which `main` still does the same way.
:::

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

On `main` (unreleased), there are a few differences:

- The vault must be recreated with an amount of 1 (`VAULT_AMOUNT`), or parsing fails with
  `InvalidVaultAmount`. Clear signing doesn't know the vault coin's actual amount, so if the vault could
  have more, recreating it with 1 would hide that the rest goes to the fee.
- A revealed spend that can't be parsed is ignored if nothing links it to the vault. On 0.37.1 any
  unparsable revealed spend fails the whole transaction. On `main` the error is still returned if the spend
  receives a vault message or the transaction asserts it.
- If the delegated spend authorizes a revealed controlled vault, or is a message envelope, it's parsed
  as described in [Vaults controlled by other vaults](#vaults-controlled-by-other-vaults) and
  [Signed messages](#signed-messages).
- Coins that are visited before anything asserts their spend are visited again once a later spend
  asserts them. The result no longer depends on the order the spends are traversed in.

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
| `reveal_bag` (`main`)               | A `SecureTheBag`, so a coin created with its root is shown as the bag's payments                            |
| `reveal_signing_vault` (`main`)     | The current custody hash (and optionally the coin) of the vault being signed for                            |
| `reveal_controlled_vault` (`main`)  | The spend of a vault controlled by the vault being signed for (`RevealedControlledVault`)                   |

Coins created by the transaction are only recognized as returning to the vault if their puzzle hash is
one of the vault's p2 puzzle hashes. These are calculated from the revealed nonces and reported in
`VaultTransaction::p2_puzzle_hashes`.

On `main`, `reveal_signing_vault(custody_hash, coin)` tells the parser the signing vault's current
custody hash. Clear signing can't look it up, so it's only checked by the signature. Calculate the
message that the members sign (`calculate_vault_puzzle_message` or `calculate_vault_coin_message`) from
the returned `VaultTransaction::signing_vault`, not from anything else in the request. Then a wrong
custody hash or coin gives a signature that can't spend the vault. The coin, if given, must have the
vault's puzzle hash (`WrongSigningVaultPuzzleHash`) and an amount of 1.

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

On `main`, `VaultTransaction` also has:

| Field                | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `launcher_id`        | The vault whose transaction it is: the signing vault, or the last vault in `authorization_path`       |
| `custody_hash`       | That vault's current custody hash, if known. Compare it with `vault_child` to detect a custody change |
| `signed_messages`    | The messages signed by a message envelope, in order. `signs_messages()` is true if there are any      |
| `authorization_path` | The controlled vaults that the signing vault authorizes, down to the vault whose transaction it is    |
| `signing_vault`      | The `SigningVault` (custody hash, puzzle hash, coin) revealed with `reveal_signing_vault`             |

Each child (`ParsedChild`) has a `transfer_type`: `Sent`, `Burned` (sent to the burn puzzle hash),
`Offered` (sent to the settlement puzzle), or `OfferPreSplit` (locked into a revealed
`P2ConditionsOrSingleton`). Its `memos` field (`ParsedMemos`) has the effective recipient p2 puzzle
hash, a decoded `ClawbackV2` if present, any human-readable memos, and the fixed conditions of an offer
pre-split. On `main` there's also `SecureTheBag` (see [below](#secure-the-bag-payments)). A child with a
clawback is always `Sent`. Its p2 puzzle hash is the receiver's, but the sender can still claw it back, so
it isn't shown as burned, offered, an offer pre-split or a bag.

To validate a custody change, compare `vault_child.custody_hash` against a [`MipsMemo`](/sdk/primitives/vaults#recovering-a-vaults-configuration-from-memos)
for the new configuration.

## Clawbacks and expiration

Coins in a [`ClawbackV2`](/sdk/primitives/clawback) puzzle can be spent by the sender before the
timeout and by the receiver after it. If the transaction uses the sender path, it is only valid until
the clawback expires. The parser requires the vault to commit to an expiration
(`ASSERT_BEFORE_SECONDS_ABSOLUTE`) no later than that, and otherwise fails with
`DriverError::UnguaranteedClawBack`, since a transaction that could be held and replayed after the
timeout would do something different.

On `main` (unreleased), clawback spends are handled more carefully. A vault message is received by a
coin, not by a puzzle, so another path of the same clawback could consume the message without outputting
the conditions it commits to. A clawback spend's conditions (its fees, announcement and concurrent spend
assertions) are therefore only trusted once the transaction's time bounds rule out the other paths:

- **Sender path**: trusted once the transaction expires no later than the clawback's timeout. If a spend
  found later in the traversal lowers the expiration, the sender spend is trusted after the fact.
  Without that, it still fails with `UnguaranteedClawBack`.
- **Receiver path** with a vault message: the transaction must also be unable to be valid before the
  timeout. That means the vault (or a message-bound spend that isn't a clawback) asserts
  `ASSERT_SECONDS_ABSOLUTE` of at least the clawback's `seconds`. Otherwise parsing fails with
  `UnguaranteedClawbackExpiry`. A receiver spend without a vault message is only shown if the clawback
  has expired in the same sense.
- **Push-through**: once a clawback has expired, anyone can push it through to the receiver without a
  signature. If the vault asserts the clawback coin's spend (`ASSERT_CONCURRENT_SPEND`) and that the
  clawback has expired (`ASSERT_SECONDS_ABSOLUTE`), the push-through is shown as a verified spend with
  `ClawbackPath::PushThrough`. Its conditions come from the clawback, not the revealed solution. Its
  children are followed like any other, and the coin isn't necessarily the vault's.

The time bounds only come from the vault's own conditions and from message-bound spends that aren't
clawbacks, never from clawback spends themselves.

```rust unreleased
use chia_wallet_sdk::driver::{
    ClawbackInfo, ClawbackPath, ClawbackV2, InnerPuzzleSpend, MipsSpend, P2Singleton, Reveals,
    mips_puzzle_hash, parse_vault_transaction,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::BlsMember;

/// The vault's delegated spend asserts the clawback's spend, and optionally that it has expired.
fn vault_delegated_spend(
    ctx: &mut SpendContext,
    vault: &Vault,
    clawback_coin: Coin,
    earliest_time: Option<u64>,
) -> anyhow::Result<Spend> {
    let mut conditions = Conditions::new()
        .assert_concurrent_spend(clawback_coin.coin_id())
        .create_coin(vault.info.custody_hash.into(), vault.coin.amount, Memos::None);

    if let Some(time) = earliest_time {
        conditions = conditions.assert_seconds_absolute(time);
    }

    Ok(ctx.delegated_spend(conditions)?)
}

#[test]
fn clear_sign_push_through() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], member.curry_tree_hash(), true);
    let (conditions, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // The vault sent Bob a clawback that expires at 1000 seconds.
    let p2 = P2Singleton::new(vault.info.launcher_id, 0);
    let bob = Bytes32::new([1; 32]);
    let clawback = ClawbackV2::new(p2.tree_hash().into(), bob, 1000, 100, false);
    let clawback_coin = sim.new_coin(clawback.tree_hash().into(), 100);
    sim.set_next_timestamp(2000)?;

    // Anyone can push it through to Bob now, and the vault asserts that.
    clawback.push_through_coin_spend(ctx, clawback_coin)?;
    let push_through = ctx.take();

    let mut reveals = Reveals::from_coin_spends(ctx, &push_through)?;
    reveals.reveal_clawback(clawback);

    // Without asserting that the clawback expired, the sender could claw it back instead.
    let delegated_spend = vault_delegated_spend(ctx, &vault, clawback_coin, None)?;
    let tx = parse_vault_transaction(reveals.clone(), ctx, vault.info.launcher_id, delegated_spend)?;
    assert!(tx.spends.is_empty());

    // Asserting the expiration rules out the sender path, so the push-through is shown.
    let delegated_spend = vault_delegated_spend(ctx, &vault, clawback_coin, Some(1000))?;
    let tx = parse_vault_transaction(reveals, ctx, vault.info.launcher_id, delegated_spend)?;
    assert_eq!(tx.spends.len(), 1);
    assert_eq!(
        tx.spends[0].clawback,
        Some(ClawbackInfo::new(clawback, ClawbackPath::PushThrough))
    );
    assert_eq!(tx.spends[0].children[0].memos.p2_puzzle_hash, bob);

    // Sign and submit it.
    let mut spend = MipsSpend::new(delegated_spend);
    let member_puzzle = ctx.curry(member)?;
    spend.members.insert(
        custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &spend)?;
    let coin_spends = [push_through, ctx.take()].concat();
    sim.spend_coins(coin_spends, &[alice.sk])?;

    assert_eq!(sim.unspent_coins(bob, false).len(), 1);

    Ok(())
}
```

## Secure the Bag payments

On `main` (unreleased), a vault can fund a [Secure the Bag](/sdk/primitives/secure-the-bag). Without
help, the root coin looks like a payment to an unknown puzzle hash. Reveal the bag with
`Reveals::reveal_bag(bag)` and a child created with the bag's root hash and the same asset (including the
CAT asset id and a revocable CAT's hidden puzzle hash) gets `TransferType::SecureTheBag(SecureTheBagInfo)`.
The child must also have exactly the bag's total amount. `SecureTheBagInfo` has the bag's format and its
payments as `ParsedBagPayment`s. Each one is `Burned` (to the burn puzzle hash) or `Sent`. A payment to
the settlement puzzle is `Sent` too, since no offer in the transaction can settle a coin that only exists
once the bag is unrolled.

The root counts as one output that leaves the vault in `asset_flows`, even if some payments go back
to the vault, since they're only paid when someone unrolls the bag. Compare the payments' puzzle hashes
with `p2_puzzle_hashes` to show which ones return to the vault. A Legacy bag with a single payment and no
clawback has no nodes, so `reveal_bag` ignores it and the payment is shown as a normal child.

```rust unreleased
use chia_wallet_sdk::driver::{
    BURN_PUZZLE_HASH, BagAsset, BagFormat, BagPayment, InnerPuzzleSpend, MipsSpend, P2Singleton,
    Reveals, SecureTheBag, TransferType, mips_puzzle_hash, parse_vault_transaction,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::{MessageFlags, MessageSide, puzzles::BlsMember};

#[test]
fn clear_sign_secure_the_bag() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], member.curry_tree_hash(), true);
    let (conditions, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    let p2 = P2Singleton::new(vault.info.launcher_id, 0);
    let p2_puzzle_hash: Bytes32 = p2.tree_hash().into();
    let coin = sim.new_coin(p2_puzzle_hash, 1000);

    // Pay Bob and Carol, burn some, and send the rest back to the vault.
    let bag = SecureTheBag::build(
        BagFormat::Legacy { leaf_width: Some(2), sorted: true },
        BagAsset::Xch,
        [
            BagPayment::new(Bytes32::new([1; 32]), 300),
            BagPayment::new(Bytes32::new([2; 32]), 200),
            BagPayment::new(BURN_PUZZLE_HASH, 250),
            BagPayment::new(p2_puzzle_hash, 250),
        ],
    )?;

    // The vault authorizes its coin to fund the bag's root.
    let hint = ctx.hint(bag.root_hash())?;
    let delegated = ctx.delegated_spend(Conditions::new().create_coin(
        bag.root_hash(),
        bag.total_amount(),
        hint,
    ))?;
    let delegated_puzzle_hash = ctx.tree_hash(delegated.puzzle);
    let spend = p2.spend(ctx, vault.info.custody_hash.into(), vault.coin.amount, delegated)?;
    ctx.spend(coin, spend)?;

    let mode = MessageFlags::PUZZLE.encode(MessageSide::Sender)
        | MessageFlags::COIN.encode(MessageSide::Receiver);
    let coin_id = ctx.alloc(&coin.coin_id())?;
    let vault_delegated = ctx.delegated_spend(
        Conditions::new()
            .send_message(mode, delegated_puzzle_hash.to_vec().into(), vec![coin_id])
            .create_coin(vault.info.custody_hash.into(), vault.coin.amount, Memos::None),
    )?;

    let mut mips = MipsSpend::new(vault_delegated);
    let member_puzzle = ctx.curry(member)?;
    mips.members.insert(
        custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &mips)?;
    let coin_spends = ctx.take();

    let mut reveals = Reveals::from_coin_spends(ctx, &coin_spends)?;
    reveals.reveal_bag(bag.clone());
    let tx = parse_vault_transaction(reveals, ctx, vault.info.launcher_id, vault_delegated)?;

    let child = &tx.spends[0].children[0];
    let TransferType::SecureTheBag(info) = &child.transfer_type else {
        panic!("expected a bag");
    };
    assert_eq!(info.payments.len(), 4);

    let burned = info
        .payments
        .iter()
        .filter(|payment| payment.transfer_type == TransferType::Burned)
        .count();
    assert_eq!(burned, 1);

    // One payment goes back to the vault once the bag is unrolled.
    let returned = info
        .payments
        .iter()
        .filter(|payment| tx.p2_puzzle_hashes.contains(&payment.payment.puzzle_hash))
        .count();
    assert_eq!(returned, 1);

    sim.spend_coins(coin_spends, &[alice.sk])?;

    Ok(())
}
```

## CAT issuance

A verified CAT spend that runs its TAIL is reported in `issuances` as an `Issuance`, with the coin id,
asset id, `extra_delta` and `IssuanceKind`. The `extra_delta` comes from the spend's solution, which the
vault's message doesn't cover. On `main` (unreleased), `Issuance::verified` is true only if the vault also
sends a message that authorizes the extra delta (for a TAIL of kind `EverythingWithSingleton`). Only
verified extra deltas count toward the issued and melted amounts in `asset_flows`. An unverified one could
be different when the transaction is included in a block.

## Signed messages

On `main` (unreleased), a vault can [sign off-chain messages](/sdk/primitives/vaults#signed-messages)
with a `vault_message_envelope`. When the delegated spend is an envelope, `parse_vault_transaction`
returns the messages in `signed_messages` (and `signs_messages()` is true), and nothing else. The only
other condition is `vault_child`, which recreates the vault. If the signing vault's custody hash is
revealed, the vault must be recreated with exactly that custody hash and an amount of 1
(`VaultMessageEnvelopeChangesVault`). The verifier requires this too. Messages can be at most 1,024 bytes
(`VaultMessageTooLong`). A delegated spend that sends messages to the message coin and does anything else
fails with `MixedVaultMessageEnvelope`, so a transaction can't pass as a message signature.

## Vaults controlled by other vaults

On `main` (unreleased), a vault's custody can include another vault as a singleton member, so one vault
(the controller) approves the spends of another. When the vault being signed for sends a message to a
vault that's revealed with `reveal_controlled_vault`, clear signing follows it down to that vault. That
vault can control another vault in turn, up to `MAX_CONTROLLED_VAULT_DEPTH` (8) vaults. The returned
transaction is the one of the vault at the end, and the vaults that authorize it are listed in
`authorization_path` as `VaultAuthorization`s.

- Reveal each controlled vault with a `RevealedControlledVault`: its coin, launcher id, current custody
  hash, its delegated spend, and a `ControlledVaultRecovery` if the spend goes through its recovery path.
  The coin must have the singleton puzzle hash for the launcher id and custody hash
  (`WrongControlledVaultPuzzleHash`) and an amount of 1. Also reveal its coin spend
  (`reveal_coin_spend`), so its puzzle can be checked to be a vault. That stops an NFT the vault owns
  from being passed off as a controlled vault (`InvalidControlledVaultPuzzle`).
- A controller can only recreate itself and send the controlled vault one message, its delegated puzzle
  hash (`InvalidVaultControllerSpend`, `WrongControlledVaultMessage`). A controlled vault in the path
  must be recreated unchanged (`VaultControllerChangesVault`). The signing vault must be too, if its
  custody hash is revealed. Otherwise show its `controller_child` like a `vault_child`.
- If the controlled vault's member is fast-forwardable, the message is sent to its puzzle hash rather than
  its coin id. That's only accepted for a revealed controlled vault, since any coin with that puzzle hash
  could receive it.
- For message signing, each controller must use a `vault_controller_envelope`
  (`InvalidVaultControllerEnvelope`), which also messages a coin that can never exist, so the controller's
  spend can't be valid on chain either.
- Clear signing checks that a controlled vault is a vault, not that its custody really includes the
  controller. Like the rest of clear signing, it assumes the vaults in the transaction are the user's.

Use `reveal_vault_nonce` for the nonces of the vault at the end of the path, since that's the vault
whose coins are parsed.

## Linked offers

A vault can't sign an offer the way a normal wallet does, because its coin spends need a message from
the vault spend. Instead, the vault transaction pre-splits coins into `P2ConditionsOrSingleton` puzzles
whose fixed path pays into the settlement puzzle and asserts the requested payments. The offer itself
is then built from those coins without another vault signature, and the vault can cancel it by
spending the coins through the singleton path.

When the `P2ConditionsOrSingleton` puzzles are revealed, `VaultTransaction::linked_offer` summarizes
the future offer: its reserved fee and the payments it requests (split into ones paid back to the vault
and external ones). For making and taking offers in general, see [Offers](/sdk/offers).

On `main` (unreleased), the action system builds offer takes that clear signing can verify when a vault
is the taker. Settlement coins return only their own surplus, and the rest of the change comes from the
taker's own coins. Set `ConditionConfig::return_unplaced_conditions` on the `Spends`. Then, if no coin
spend can emit the transaction-wide conditions (such as the assertions of the settlement payments, when
the vault spends none of its coins), they're returned in `Spends::unplaced_conditions` and no
intermediate coin is created. Add them to the vault's delegated spend. `finish_with_keys` rejects unplaced
conditions, since it has nowhere to put them.

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

On `main` (unreleased), these are added:

| Error                                                             | Cause                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `InvalidVaultAmount`                                              | A vault is recreated, or revealed, with an amount other than 1                         |
| `UnguaranteedClawbackExpiry`                                      | A clawback receiver path is used without asserting that the clawback has expired       |
| `MixedVaultMessageEnvelope`                                       | A delegated spend signs messages and also does something else                          |
| `VaultMessageEnvelopeChangesVault`                                | A vault that signs messages, or authorizes another vault to, isn't recreated unchanged |
| `WrongSigningVaultPuzzleHash`                                     | The revealed signing vault coin doesn't match its launcher id and custody hash         |
| `WrongControlledVaultPuzzleHash` / `InvalidControlledVaultPuzzle` | A revealed controlled vault's coin or puzzle isn't that vault                          |
| `InvalidVaultControllerSpend` / `InvalidVaultControllerEnvelope`  | A controller does more than authorize one controlled vault                             |
| `WrongControlledVaultMessage`                                     | The controller's message doesn't match the controlled vault's delegated puzzle hash    |
| `VaultControllerChangesVault`                                     | A vault in the authorization path doesn't recreate itself unchanged                    |
| `DuplicateControlledVault` / `ControlledVaultTooDeep`             | A controlled vault appears twice, or the path is longer than 8 vaults                  |

All of these are variants of `DriverError`.
