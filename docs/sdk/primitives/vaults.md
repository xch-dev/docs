---
title: Vaults & MIPS
---

# Vaults & MIPS

A **vault** is a singleton whose inner puzzle is a custody configuration built with **MIPS**, the
Meta Inner Puzzle Spec ([CHIP-0043](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0043.md)). Instead of
holding funds directly, a vault controls other coins (XCH, CATs, NFTs) whose p2 puzzle is locked to
the vault's launcher id. Because the vault is a singleton, its custody rules can be changed (rekeyed)
without moving any of those coins.

Use vaults when you need more than a single BLS key: multisig, secp256k1/secp256r1 or passkey
signers, timelocked recovery paths, nested quorums, or restrictions on what a signer is allowed to do.

The pieces fit together like this:

| Piece                            | What it is                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Vault` / `VaultInfo`            | `Singleton<VaultInfo>`: the vault coin, its launcher id and its current `custody_hash`         |
| `Launcher::mint_vault`           | Launches a new vault with a given custody hash                                                 |
| MIPS members                     | Leaf puzzles that authorize a spend (BLS, secp, passkey, another singleton, a fixed puzzle...) |
| `MofN`                           | Combines members (or nested `MofN`s) into an m-of-n quorum                                     |
| `Restriction`                    | Extra puzzles attached to a member or quorum that limit its conditions or the delegated puzzle |
| `MipsSpend` / `InnerPuzzleSpend` | Describes how to spend a custody tree: the delegated spend plus the member spends you're using |
| `P2Singleton`                    | p2 puzzle for coins owned by the vault                                                         |
| `P2ConditionsOrSingleton`        | p2 puzzle that can either output a fixed set of conditions or be spent by the vault            |
| `MipsMemo`                       | On-chain memo that reveals a custody configuration so it can be recovered from the blockchain  |

All of these live in `chia_wallet_sdk::driver`; the member, restriction and wrapper puzzles live in
`chia_wallet_sdk::types::puzzles`. `Vault` and `VaultInfo` are in the prelude. For background on
singletons and launchers see [Singletons & Launchers](/sdk/primitives/singletons).

## How a MIPS puzzle is built

Every node in a custody tree is wrapped the same way:

1. The inner puzzle: either a **member** puzzle or an **m-of-n** puzzle over child nodes.
2. Optionally, a **restrictions** layer with member condition validators and delegated puzzle validators.
3. At the top level only, a **delegated puzzle feeder**, which takes the delegated puzzle and solution
   from the solution, runs it, and passes its tree hash down to the members to sign.
4. An **index wrapper** that curries in a `nonce`, so that the same member can appear with different
   puzzle hashes.

`mips_puzzle_hash(nonce, restrictions, inner_puzzle_hash, top_level)` computes the hash of one such
node. The `top_level` flag must be `true` only for the root of the tree (the vault's custody hash, or a
p2 puzzle), and `false` for every node nested inside an `MofN`.

The delegated puzzle is the part that actually does something: a quoted list of conditions. Members
sign its tree hash, not the conditions themselves, so every member in a quorum signs the same message.

### Members

| Member                                       | Signer                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `BlsMember`, `BlsTaprootMember`              | BLS key (signs with `AGG_SIG_ME`). Taproot uses a synthetic key      |
| `K1Member`                                   | secp256k1 key, signs `sha256(delegated_puzzle_hash + coin_id)`       |
| `R1Member`                                   | secp256r1 key, same message as `K1Member`                            |
| `PasskeyMember`                              | WebAuthn passkey (secp256r1)                                         |
| `SingletonMember`, `SingletonMemberWithMode` | Another singleton (for example another vault) approves via a message |
| `FixedPuzzleMember`                          | Only allows one specific delegated puzzle hash                       |
| `Eip712Member` (`chip-0037`)                 | secp256k1 key signing an EIP-712 typed message                       |

Each secp/BLS member except `Eip712Member` also has a `...PuzzleAssert` variant (for example `K1MemberPuzzleAssert`) that
commits to the vault's puzzle hash instead of the coin id. These are used for "fast forward" spends,
where the same signature needs to stay valid even if the vault coin is replaced by a newer coin with the
same puzzle hash.

### Restrictions and wrappers

A `Restriction` has a `RestrictionKind` and a puzzle hash:

- `MemberCondition`: a validator that inspects the conditions output by the member or quorum. For
  example `Timelock` requires an `ASSERT_SECONDS_RELATIVE` with its curried number of seconds.
- `DelegatedPuzzleHash`: a validator that inspects the delegated puzzle hash.
- `DelegatedPuzzleWrapper`: a wrapper puzzle that is wrapped around the delegated puzzle and can filter
  or add conditions. The SDK enforces these with the `EnforceDelegatedPuzzleWrappers` validator.
  Built-in wrappers include `PreventConditionOpcode`, `PreventMultipleCreateCoinsMod`,
  `ForceAssertCoinAnnouncementMod`, `ForceCoinMessageMod`, `ForceSingletonRecreationMod`, `Timelock`,
  and `Force1of2RestrictedVariable`.

Wrappers change what the members sign: each member signs the hash of the delegated puzzle after all of
the wrappers have been applied. `MipsSpend` handles this for you as long as you use the same wrapper
order on every path.

## Minting a vault and spending its coins

This example creates a vault with a single BLS member, sends XCH to the vault's `P2Singleton` address,
and then spends that XCH. The XCH coin's spend only runs if the vault sends it a message containing the
tree hash of the coin's delegated puzzle, so the vault's signers authorize every coin spend in one
signature.

```rust
use chia_wallet_sdk::driver::{InnerPuzzleSpend, MipsSpend, P2Singleton, mips_puzzle_hash};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::{MessageFlags, MessageSide, puzzles::BlsMember};

#[test]
fn spend_vault_owned_xch() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // A 1-of-1 custody configuration with a single BLS key.
    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], member.curry_tree_hash(), true);

    // Launch the vault from one of Alice's coins.
    let (launch_conditions, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, launch_conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Coins sent to the P2Singleton puzzle hash are owned by the vault.
    let p2 = P2Singleton::new(vault.info.launcher_id, 0);
    let vault_coin = sim.new_coin(p2.tree_hash().into(), 1000);

    // The vault-owned coin outputs these conditions once the vault approves them.
    let bob_puzzle_hash = Bytes32::new([1; 32]);
    let delegated = ctx.delegated_spend(Conditions::new().create_coin(
        bob_puzzle_hash,
        1000,
        Memos::None,
    ))?;
    let delegated_puzzle_hash = ctx.tree_hash(delegated.puzzle);
    let coin_spend = p2.spend(ctx, vault.info.custody_hash.into(), vault.coin.amount, delegated)?;
    ctx.spend(vault_coin, coin_spend)?;

    // The vault sends a message to the coin, and recreates itself with the same custody.
    let mode = MessageFlags::PUZZLE.encode(MessageSide::Sender)
        | MessageFlags::COIN.encode(MessageSide::Receiver);
    let coin_id = ctx.alloc(&vault_coin.coin_id())?;
    let vault_conditions = Conditions::new()
        .send_message(mode, delegated_puzzle_hash.to_vec().into(), vec![coin_id])
        .create_coin(vault.info.custody_hash.into(), vault.coin.amount, Memos::None);

    let mut spend = MipsSpend::new(ctx.delegated_spend(vault_conditions)?);
    let member_puzzle = ctx.curry(member)?;
    spend.members.insert(
        custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &spend)?;

    // The BLS member emits an AGG_SIG_ME, which the simulator signs with Alice's key.
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let child = vault.child(vault.info.custody_hash, vault.coin.amount);
    assert!(sim.coin_state(child.coin.coin_id()).is_some());
    assert_eq!(sim.unspent_coins(bob_puzzle_hash, false).len(), 1);

    Ok(())
}
```

A few things to notice:

- `MipsSpend::members` is keyed by the puzzle hash of each node, as computed by `mips_puzzle_hash`. The
  entry for the root (`custody_hash`) tells the SDK how to spend the top of the tree.
- `Vault::spend` wraps the MIPS spend in the singleton layer. The delegated conditions must recreate the
  vault (an odd-amount `CREATE_COIN`), unless you mean to melt it.
- `Vault::child(custody_hash, amount)` gives you the next vault coin. Pass a different custody hash to
  track a rekey.
- The XCH coin's `P2Singleton::spend` takes the vault's current inner puzzle hash and amount, because the
  `SingletonMember` puzzle needs them to recompute the vault's puzzle hash and receive the message.
- `nonce` lets one vault have many p2 puzzle hashes (`P2Singleton::new(launcher_id, nonce)`), for example
  one per address.

In practice you would usually build the coin spends with the [action system](/sdk/action-system) and
plug in the vault's p2 spends as described in [Custom Spends](/sdk/action-system/custom-spends).

## M-of-n custody

`MofN::new(required, items)` combines node hashes into a quorum. Depending on the shape, it compiles to
a 1-of-n (merkle tree, reveal one path), n-of-n (all members), or general m-of-n puzzle. When spending,
insert an `InnerPuzzleSpend::m_of_n` for the quorum node and a member spend for exactly `required` of
its members.

This 2-of-3 example uses secp256k1 keys, which sign `sha256(delegated_puzzle_hash + vault_coin_id)`
directly (there's no `AGG_SIG` condition to sign, the signature goes in the member's solution).

```rust
use chia_wallet_sdk::chia::sha2::Sha256;
use chia_wallet_sdk::driver::{InnerPuzzleSpend, MipsSpend, MofN, mips_puzzle_hash};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::{K1Member, K1MemberSolution};

#[test]
fn two_of_three_vault() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let keys = K1Pair::range_vec(3);
    let members: Vec<K1Member> = keys.iter().map(|k| K1Member::new(k.pk)).collect();

    // Nested members are not top level.
    let member_hashes: Vec<TreeHash> = members
        .iter()
        .map(|m| mips_puzzle_hash(0, vec![], m.curry_tree_hash(), false))
        .collect();

    let quorum = MofN::new(2, member_hashes.clone());
    let custody_hash = mips_puzzle_hash(0, vec![], quorum.inner_puzzle_hash(), true);

    let funder = sim.bls(1);
    let (launch, vault) =
        Launcher::new(funder.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(funder.pk).spend(ctx, funder.coin, launch)?;
    sim.spend_coins(ctx.take(), &[funder.sk])?;

    let conditions =
        Conditions::new().create_coin(vault.info.custody_hash.into(), 1, Memos::None);
    let mut spend = MipsSpend::new(ctx.delegated_spend(conditions)?);

    spend.members.insert(
        custody_hash,
        InnerPuzzleSpend::m_of_n(0, vec![], quorum.required, quorum.items.clone()),
    );

    // Keys 0 and 2 sign.
    let delegated_puzzle_hash = ctx.tree_hash(spend.delegated.puzzle);
    for i in [0, 2] {
        let mut hasher = Sha256::new();
        hasher.update(delegated_puzzle_hash);
        hasher.update(vault.coin.coin_id());
        let signature = keys[i].sk.sign_prehashed(&hasher.finalize())?;

        let puzzle = ctx.curry(members[i])?;
        let solution = ctx.alloc(&K1MemberSolution::new(vault.coin.coin_id(), signature))?;
        spend.members.insert(
            member_hashes[i],
            InnerPuzzleSpend::new(0, vec![], Spend::new(puzzle, solution)),
        );
    }

    vault.spend(ctx, &spend)?;
    sim.spend_coins(ctx.take(), &[])?;

    Ok(())
}
```

If you insert more member spends than `required`, the SDK uses the first `required` distinct members in
the order of `items`. `MofN::validate` (called during spending) rejects a `required` of zero or more
than the number of items, since such a puzzle is either spendable by anyone or not at all.

## Restricting what a member can do

Restrictions are attached to a node via the `restrictions` argument of `mips_puzzle_hash` and
`InnerPuzzleSpend`. Each restriction (validator or wrapper) also needs a spend in
`MipsSpend::restrictions`, keyed by its puzzle hash.

Here the vault's only member is wrapped in `PreventConditionOpcode`, so it can't create coin
announcements. A normal spend still works, but one that tries to output `CREATE_COIN_ANNOUNCEMENT`
fails.

```rust
use chia_wallet_sdk::chia::consensus::opcodes::CREATE_COIN_ANNOUNCEMENT;
use chia_wallet_sdk::driver::{
    InnerPuzzleSpend, MipsSpend, Restriction, RestrictionKind, mips_puzzle_hash,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::{BlsMember, PreventConditionOpcode};

fn spend_vault(
    ctx: &mut SpendContext,
    vault: &Vault,
    member: BlsMember,
    wrapper: PreventConditionOpcode,
    restriction: Restriction,
    conditions: Conditions,
) -> anyhow::Result<()> {
    let mut spend = MipsSpend::new(ctx.delegated_spend(conditions)?);

    let wrapper_puzzle = ctx.curry(wrapper)?;
    spend.restrictions.insert(
        wrapper.curry_tree_hash(),
        Spend::new(wrapper_puzzle, NodePtr::NIL),
    );

    let member_puzzle = ctx.curry(member)?;
    spend.members.insert(
        vault.info.custody_hash,
        InnerPuzzleSpend::new(0, vec![restriction], Spend::new(member_puzzle, NodePtr::NIL)),
    );

    vault.spend(ctx, &spend)?;
    Ok(())
}

#[test]
fn restricted_vault() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let wrapper = PreventConditionOpcode::new(CREATE_COIN_ANNOUNCEMENT);
    let restriction = Restriction {
        kind: RestrictionKind::DelegatedPuzzleWrapper,
        puzzle_hash: wrapper.curry_tree_hash(),
    };
    let custody_hash = mips_puzzle_hash(0, vec![restriction], member.curry_tree_hash(), true);

    let (launch, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, launch)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Creating a coin announcement is rejected by the wrapper.
    let forbidden = Conditions::new()
        .create_coin(custody_hash.into(), 1, Memos::None)
        .create_coin_announcement(b"hello".to_vec().into());
    spend_vault(ctx, &vault, member, wrapper, restriction, forbidden)?;
    assert!(sim.spend_coins(ctx.take(), &[alice.sk.clone()]).is_err());

    // Anything else is allowed.
    let allowed = Conditions::new().create_coin(custody_hash.into(), 1, Memos::None);
    spend_vault(ctx, &vault, member, wrapper, restriction, allowed)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

The typical vault configuration used by wallets is a top-level 1-of-2 between a **custody** quorum and
a **recovery** quorum. The recovery path is restricted with wrappers so that it can only start a
recovery: it can't create announcements or send messages, can only create one coin, and must go through
`Force1of2RestrictedVariable`, which forces the new custody to be a 1-of-2 between the old custody
(which can cancel) and a timelocked path that finishes the recovery. The helper
`vault_recovery_delegated_puzzle_hash` (and `calculate_vault_start_recovery_message`) in
`chia_wallet_sdk::driver` compute the wrapped delegated puzzle hash that recovery signers must sign.

## Recovering a vault's configuration from memos

A custody hash alone doesn't tell you who the signers are. To make a vault recoverable from the
blockchain (for example when restoring a wallet), write a `MipsMemo` into the memos of the
`CREATE_COIN` that creates the vault with a new custody hash. A `MipsMemo` mirrors the custody tree:
an `InnerPuzzleMemo` per node (nonce, `RestrictionMemo`s, and either a `MemberMemo` or a `MofNMemo`).

Each `MemberMemo` constructor takes a `reveal` flag. If it's `true`, the memo includes the public key
(or launcher id), so anyone can parse it. If it's `false`, only the puzzle hash is stored, and you need
to supply candidate keys in a `MipsMemoContext` to recognize it.

This example rekeys a vault to a 1-of-2 between two BLS keys, writes the memo on chain, recovers the
configuration from the vault's coin spend, and then spends with the new custody.

```rust
use chia_wallet_sdk::driver::{
    InnerPuzzleMemo, InnerPuzzleSpend, MemberMemo, MemoKind, MipsMemo, MipsMemoContext, MipsSpend,
    MofN, MofNMemo, ParsedMember, mips_puzzle_hash,
};
use chia_wallet_sdk::chia::puzzle_types::singleton::SingletonArgs;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::BlsMember;

#[test]
fn rekey_with_memo() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let bob = BlsPair::new(42);

    // Start with Alice as the only member.
    let alice_member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], alice_member.curry_tree_hash(), true);
    let (launch, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, launch)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Describe the new custody: 1-of-2 between Alice and Bob, with keys revealed.
    let mut items = Vec::new();
    for pk in [alice.pk, bob.pk] {
        let member = MemberMemo::bls(ctx, pk, false, false, true)?;
        items.push(InnerPuzzleMemo::new(0, vec![], MemoKind::Member(member)));
    }
    let memo = MipsMemo::new(InnerPuzzleMemo::new(
        0,
        vec![],
        MemoKind::MofN(MofNMemo::new(1, items)),
    ));
    let new_custody_hash = memo.try_inner_puzzle_hash()?;

    // Rekey, writing the memo into the vault's CREATE_COIN.
    let memos = ctx.memos(&vec![memo])?;
    let mut spend = MipsSpend::new(ctx.delegated_spend(
        Conditions::new().create_coin(new_custody_hash.into(), 1, memos),
    )?);
    let puzzle = ctx.curry(alice_member)?;
    spend.members.insert(
        custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &spend)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Later: recover the configuration from the vault's coin spend.
    let coin_spend = sim.coin_spend(vault.coin.coin_id()).unwrap();
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let solution = ctx.alloc(&coin_spend.solution)?;
    let output = ctx.run(puzzle, solution)?;
    let conditions: Vec<Condition> = ctx.extract(output)?;

    let create_coin = conditions
        .into_iter()
        .filter_map(Condition::into_create_coin)
        .find(|cc| cc.amount % 2 == 1)
        .unwrap();
    let Memos::Some(memos) = create_coin.memos else {
        anyhow::bail!("missing memos");
    };
    let memo_list: Vec<NodePtr> = ctx.extract(memos)?;

    // Use the bounded parser for untrusted input, and check it matches the child's puzzle hash.
    let recovered = MipsMemo::from_clvm_bounded(ctx, memo_list[0])?;
    let recovered_custody_hash = recovered.try_inner_puzzle_hash()?;
    assert_eq!(
        create_coin.puzzle_hash,
        SingletonArgs::curry_tree_hash(vault.info.launcher_id, recovered_custody_hash).into()
    );

    let MemoKind::MofN(m_of_n) = &recovered.inner_puzzle.kind else {
        anyhow::bail!("expected an m-of-n");
    };
    let mut keys = Vec::new();
    for item in &m_of_n.items {
        let MemoKind::Member(member) = &item.kind else {
            anyhow::bail!("expected a member");
        };
        match member.parse(ctx, &MipsMemoContext::default()) {
            Some(ParsedMember::Bls(member)) => keys.push(member.public_key),
            other => anyhow::bail!("unexpected member {other:?}"),
        }
    }
    assert_eq!(keys, vec![alice.pk, bob.pk]);

    // Spend the rekeyed vault with Bob's key, using the recovered configuration.
    let vault = vault.child(recovered_custody_hash, 1);
    let member_hashes: Vec<TreeHash> = keys
        .iter()
        .map(|&pk| mips_puzzle_hash(0, vec![], BlsMember::new(pk).curry_tree_hash(), false))
        .collect();
    assert_eq!(
        recovered_custody_hash,
        mips_puzzle_hash(0, vec![], MofN::new(1, member_hashes.clone()).inner_puzzle_hash(), true)
    );

    let mut spend = MipsSpend::new(ctx.delegated_spend(
        Conditions::new().create_coin(recovered_custody_hash.into(), 1, Memos::None),
    )?);
    spend.members.insert(
        recovered_custody_hash,
        InnerPuzzleSpend::m_of_n(0, vec![], 1, member_hashes.clone()),
    );
    let puzzle = ctx.curry(BlsMember::new(bob.pk))?;
    spend.members.insert(
        member_hashes[1],
        InnerPuzzleSpend::new(0, vec![], Spend::new(puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &spend)?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    Ok(())
}
```

Things to keep in mind with memos:

- Always parse memos from the chain with `MipsMemo::from_clvm_bounded`. It rejects deeply nested or
  oversized memos and m-of-n shapes that can't be spent (such as duplicate members), which plain
  `FromClvm` doesn't.
- Never trust a memo on its own; check `try_inner_puzzle_hash()` (or `verify`) against the puzzle hash
  that was actually created.
- The order of `MofNMemo::items` matters, since it determines the merkle tree. Wallets typically sort
  members by puzzle hash.
- `RestrictionMemo` and `WrapperMemo` have constructors for the built-in restrictions (`timelock`,
  `enforce_delegated_puzzle_wrappers`, `force_1_of_2_restricted_variable`, `prevent_condition_opcode`
  and so on), and `parse` methods that return `ParsedRestriction` / `ParsedWrapper`.
- A `MemberMemo` whose memo is the full puzzle reveal parses as `ParsedMember::Custom`, which is how a
  fixed recovery-finish puzzle is revealed.

## P2Singleton and P2ConditionsOrSingleton

`P2Singleton` is a top-level MIPS puzzle with a single `SingletonMember`. Its puzzle hash depends only on
the launcher id and nonce, so it stays the same when the vault is rekeyed. Spend it with
`P2Singleton::spend`, passing the delegated spend, and have the vault send the matching message as
shown above.

`P2ConditionsOrSingleton` is a 1-of-2 between a fixed set of conditions and the vault. Anyone can spend
the fixed path, which outputs exactly the committed conditions; the vault can spend it like a normal
`P2Singleton` coin. Vaults use this to pre-split coins for offers: the fixed path pays into the
settlement puzzle, and the vault can still cancel by spending the singleton path. The default version,
`P2ConditionsOrSingletonVersion::FixedPuzzleMember`, uses a `FixedPuzzleMember`; `Legacy` exists for
coins created with the original format.

The struct only stores the hash of the fixed path, so a coin can be reconstructed from that hash alone.
`P2ConditionsOrSingleton::new` takes the fixed path hash directly, and `from_quoted_conditions_hash`
calculates it from the quoted conditions hash and version. When spending the fixed path, the version is
detected from the quoted conditions (`match_quoted_conditions_hash`).

```rust since-0.37
use chia_wallet_sdk::driver::{P2ConditionsOrSingleton, P2ConditionsOrSingletonVersion};
use chia_wallet_sdk::prelude::*;

#[test]
fn p2_conditions_or_singleton_fixed_path() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let conditions = Conditions::new().create_coin(Bytes32::new([1; 32]), 1, Memos::None);
    let quoted_conditions = ctx.delegated_spend(conditions)?;
    let quoted_conditions_hash = ctx.tree_hash(quoted_conditions.puzzle).into();

    let launcher_id = Bytes32::new([2; 32]);
    let p2 = P2ConditionsOrSingleton::from_quoted_conditions_hash(
        launcher_id,
        0,
        quoted_conditions_hash,
        P2ConditionsOrSingletonVersion::FixedPuzzleMember,
    );

    // No signature is needed to take the fixed path.
    let coin = sim.new_coin(p2.tree_hash().into(), 1);
    let spend = p2.fixed_spend(ctx, quoted_conditions)?;
    ctx.spend(coin, spend)?;
    sim.spend_coins(ctx.take(), &[])?;

    Ok(())
}
```

The vault path is `P2ConditionsOrSingleton::p2_singleton_spend`, which takes the same arguments as
`P2Singleton::spend`. When the vault spends one of these coins, include
`ASSERT_MY_COIN_ID` in the coin's delegated conditions; [clear signing](/sdk/clear-signing) requires it.

## Signed messages

A vault has no single key, so it can't sign an off-chain message (such as a login challenge or an
attestation) the way a BLS or secp key does. Instead, the vault's signers sign a vault spend that can
never be valid on chain. The spend carries the messages, and the signed coin spend is the proof.
Anyone who knows the vault's launcher id and current custody hash can verify it offline, without
knowing what kinds of members the vault has.

How it works:

1. `vault_message_envelope(ctx, &vault, &messages)` builds a delegated spend that recreates the vault
   with the same custody hash and amount, and sends each message (`SEND_MESSAGE` mode `0x17`, at most
   1,024 bytes each) to `VAULT_MESSAGE_COIN_ID`. That coin has a parent id of all zeros, so it can never
   exist, and neither can a valid spend that sends it a message.
2. The vault's signers sign the envelope like any other vault spend (the same `MipsSpend` and
   `Vault::spend`). Wrap the resulting coin spend and aggregated BLS signature (the default signature if
   no BLS signatures are needed) in a `VaultMessageProof`.
3. Send the proof as bytes (`encode` / `decode`) or as a bech32m string with the `vaultsig` prefix
   (`encode_string` / `decode_string`).
4. The verifier calls `verify_vault_signed_message(&proof, launcher_id, custody_hash, genesis_challenge, max_cost)`.
   It checks that the coin is the expected vault, and that the delegated spend is exactly an envelope.
   Then it runs the spend with consensus rules, alongside a spend of the message coin that receives every
   message. It returns the messages in order. The vault's own puzzle checks the signatures, thresholds and
   restrictions, so this works for BLS, secp256r1, passkey and m-of-n custody alike.

Before the signers approve an envelope, [clear signing](/sdk/clear-signing#signed-messages) shows it as
`VaultTransaction::signed_messages` instead of a transaction. A delegated spend can't both sign messages
and do something else (`MixedVaultMessageEnvelope`).

```rust unreleased
use chia_wallet_sdk::driver::{
    InnerPuzzleSpend, MipsSpend, Reveals, VaultMessageProof, mips_puzzle_hash,
    parse_vault_transaction, vault_message_envelope, verify_vault_signed_message,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::sign_transaction;
use chia_wallet_sdk::types::{TESTNET11_CONSTANTS, puzzles::BlsMember};

#[test]
fn sign_a_message_with_a_vault() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // A vault with a single BLS member.
    let alice = sim.bls(1);
    let member = BlsMember::new(alice.pk);
    let custody_hash = mips_puzzle_hash(0, vec![], member.curry_tree_hash(), true);
    let (conditions, vault) =
        Launcher::new(alice.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk.clone()])?;

    // Include a domain, a nonce from the verifier and an expiration, since proofs can be replayed.
    let messages = vec![Bytes::new(
        b"Sign in to example.com\nNonce: 4f9a2c\nExpires: 2026-11-01".to_vec(),
    )];
    let envelope = vault_message_envelope(ctx, &vault, &messages)?;

    // Clear signing shows the envelope as signed messages, not a transaction.
    let tx = parse_vault_transaction(Reveals::default(), ctx, vault.info.launcher_id, envelope)?;
    assert!(tx.signs_messages());
    assert_eq!(tx.signed_messages, messages);
    assert!(tx.spends.is_empty());

    // Sign the envelope like any other vault spend.
    let mut spend = MipsSpend::new(envelope);
    let member_puzzle = ctx.curry(member)?;
    spend.members.insert(
        custody_hash,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    vault.spend(ctx, &spend)?;

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, &[alice.sk])?;
    let proof = VaultMessageProof::new(coin_spends[0].clone(), signature);

    // The proof can be shared as a string.
    let encoded = proof.encode_string()?;
    assert!(encoded.starts_with("vaultsig1"));
    let decoded = VaultMessageProof::decode_string(&encoded)?;

    // The verifier only needs the launcher id and a trusted custody hash.
    let genesis_challenge = TESTNET11_CONSTANTS.genesis_challenge;
    let verified = verify_vault_signed_message(
        &decoded,
        vault.info.launcher_id,
        custody_hash.into(),
        genesis_challenge,
        None,
    )?;
    assert_eq!(verified, messages);

    // With any other custody hash, it's rejected.
    let wrong_custody_hash = Bytes32::new([1; 32]);
    assert!(
        verify_vault_signed_message(
            &decoded,
            vault.info.launcher_id,
            wrong_custody_hash,
            genesis_challenge,
            None,
        )
        .is_err()
    );

    Ok(())
}
```

### What the proof does and doesn't prove

`verify_vault_signed_message` checks everything that consensus would check about the spend itself:
the puzzle reveal, the custody's signatures, `AGG_SIG_ME` against the given genesis challenge, and
assertions about the coin. It also requires the vault's actual output to be exactly the recreated vault,
and rejects any height or time assertion (`VaultMessageTimelocked`). Without the chain it can't check
those, and a timelocked member such as a recovery path could otherwise sign at any time. It doesn't check
that the vault coin exists or is unspent, so:

- **The custody hash must come from a trusted source**, such as the vault's current coin on chain.
  Anyone could make up a custody puzzle for any launcher id that needs no signature. Rekeying the vault
  changes its custody hash, and with it the signers the proof is checked against.
- **Proofs can be replayed.** A proof doesn't expire and isn't tied to an application. It stays valid for
  as long as the custody hash doesn't change. Put a domain, a verifier-chosen nonce and an expiration time
  in the messages, and check them after verifying.
- **Verification costs CPU.** The proof is untrusted, and a proof with an invalid signature can still use
  the whole cost limit before it fails. `max_cost` defaults to `VAULT_MESSAGE_PROOF_DEFAULT_MAX_COST`
  (1,000,000,000; a 3-of-4 passkey vault costs about 214 million). Services that verify proofs from anyone
  should rate limit them or pass a lower limit.
- Consensus runs with the rules from before hard fork 2, in mempool mode. Members that depend on newer
  operators can't sign messages yet.
- Don't use the `ForceCoinMessageMod` wrapper (it's rejected) or custom restrictions that require
  messages for members that should be able to sign messages.

### Vaults controlled by other vaults

A vault's custody can include another vault as a `SingletonMember`, so the controlling vault's signers
approve its spends. To sign messages with the controlled vault, its envelope is authorized by the
controller. The controller signs `vault_controller_envelope(ctx, &controller, controlled_coin, delegated_puzzle_hash, fast_forward)`,
which recreates the controller and sends the envelope's delegated puzzle hash to the controlled vault.
It also sends the same message to `VAULT_CONTROLLER_MESSAGE_COIN_ID`, a second coin that can never exist,
so the controller's spend can't be valid on chain either. Set `fast_forward` if the controlled vault's
member is a fast-forwardable `SingletonMemberWithMode` (mode `0x12`), which receives the message by
puzzle hash rather than coin id.

The proof then includes the controller spends (`VaultMessageProof::with_controllers`), and is encoded
with a second version byte. Verify it with `verify_controlled_vault_signed_message`, which takes the
`VaultInfo` of every controller, since their custody hashes must also be trusted. A controller can itself be
controlled, up to 16 controller spends in total. `verify_vault_signed_message` rejects proofs with
controller spends.

```rust unreleased
use chia_wallet_sdk::driver::{
    InnerPuzzleSpend, MipsSpend, VaultMessageProof, mips_puzzle_hash, vault_controller_envelope,
    vault_message_envelope, verify_controlled_vault_signed_message,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::sign_transaction;
use chia_wallet_sdk::types::{
    TESTNET11_CONSTANTS,
    puzzles::{BlsMember, SingletonMember, SingletonMemberSolution},
};

fn mint_vault(sim: &mut Simulator, ctx: &mut SpendContext, custody_hash: TreeHash) -> anyhow::Result<Vault> {
    let funder = sim.bls(1);
    let (conditions, vault) =
        Launcher::new(funder.coin.coin_id(), 1).mint_vault(ctx, custody_hash, ())?;
    StandardLayer::new(funder.pk).spend(ctx, funder.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[funder.sk])?;
    Ok(vault)
}

#[test]
fn sign_a_message_with_a_controlled_vault() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    // The controller has a BLS member, and the controlled vault's only member is the controller.
    let alice = BlsPair::new(0);
    let bls_member = BlsMember::new(alice.pk);
    let controller_custody = mips_puzzle_hash(0, vec![], bls_member.curry_tree_hash(), true);
    let controller = mint_vault(&mut sim, ctx, controller_custody)?;

    let singleton_member = SingletonMember::new(controller.info.launcher_id);
    let controlled_custody = mips_puzzle_hash(0, vec![], singleton_member.curry_tree_hash(), true);
    let controlled = mint_vault(&mut sim, ctx, controlled_custody)?;

    // The controlled vault's envelope is approved by its singleton member.
    let messages = vec![Bytes::new(b"example.com nonce 81c3".to_vec())];
    let envelope = vault_message_envelope(ctx, &controlled, &messages)?;

    let mut spend = MipsSpend::new(envelope);
    let member_puzzle = ctx.curry(singleton_member)?;
    let member_solution = ctx.alloc(&SingletonMemberSolution::new(
        controller.info.custody_hash.into(),
        controller.coin.amount,
    ))?;
    spend.members.insert(
        controlled_custody,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, member_solution)),
    );
    controlled.spend(ctx, &spend)?;
    let vault_spend = ctx.take().remove(0);

    // The controller authorizes the envelope's delegated puzzle hash, which its BLS key signs.
    let delegated_puzzle_hash = ctx.tree_hash(envelope.puzzle).into();
    let controller_envelope =
        vault_controller_envelope(ctx, &controller, controlled.coin, delegated_puzzle_hash, false)?;

    let mut spend = MipsSpend::new(controller_envelope);
    let member_puzzle = ctx.curry(bls_member)?;
    spend.members.insert(
        controller_custody,
        InnerPuzzleSpend::new(0, vec![], Spend::new(member_puzzle, NodePtr::NIL)),
    );
    controller.spend(ctx, &spend)?;
    let controller_spend = ctx.take().remove(0);

    let signature = sign_transaction(&[vault_spend.clone(), controller_spend.clone()], &[alice.sk])?;
    let proof = VaultMessageProof::with_controllers(vault_spend, vec![controller_spend], signature);

    // The verifier trusts the custody hashes of both the vault and its controller.
    let verified = verify_controlled_vault_signed_message(
        &proof,
        controlled.info.launcher_id,
        controlled_custody.into(),
        &[controller.info],
        TESTNET11_CONSTANTS.genesis_challenge,
        None,
    )?;
    assert_eq!(verified, messages);

    Ok(())
}
```

## CHIP-0037 puzzles

With the `chip-0037` feature, the SDK adds puzzles for controlling Chia coins from Ethereum-style
signers:

- `Eip712Member` (in `types::puzzles`), a MIPS member that verifies a secp256k1 signature over an
  EIP-712 typed message. Use `eip712_prefix_and_domain_separator(genesis_challenge)`,
  `eip712_type_hash()` and `eip712_hash_to_sign(...)` to build the message.
- `P2Eip712MessageLayer`, a standalone p2 puzzle that's spent by an EIP-712 signature.
- `P2ControllerPuzzleLayer`, which locks a coin to a controller puzzle hash: the coin is spent when a
  coin with that puzzle hash sends it a message with the delegated puzzle hash. This lets one signature
  unlock many coins.

## Gotchas

- `top_level` must be `true` only for the root node. Using the wrong flag gives a valid-looking but
  unspendable puzzle hash.
- `MipsSpend` looks up nodes by puzzle hash, so if a hash you inserted doesn't match the tree you get
  `DriverError::MissingSubpathSpend`.
- Every member signs the same delegated puzzle hash. For secp members you compute the message yourself;
  for BLS members the `AGG_SIG_ME` condition is signed like any other (see
  [Keys & Signing](/sdk/concepts/signing)).
- If a vault spend doesn't recreate the vault, the vault is melted and every coin locked to its
  `P2Singleton` puzzle hashes becomes unspendable.
- To check what a vault transaction does before signing it, see [Clear Signing](/sdk/clear-signing).
