---
title: Conditions
---

# Conditions

A coin's puzzle returns a list of conditions when it's spent. Conditions are how a spend has any effect: creating coins, paying fees, requiring signatures, coordinating with other spends, and restricting when the spend is valid. See [Conditions](https://chialisp.com/conditions) on chialisp.com for the consensus rules behind each one.

The SDK represents conditions in two ways, both in `chia_wallet_sdk::types` and the prelude:

- `Condition<T>`, an enum with one variant per condition, used for parsing and inspecting outputs.
- `Conditions<T>`, a list of conditions with a builder method for each one, used when you construct a spend.

Each condition also has its own struct in `chia_wallet_sdk::types::conditions` (for example `CreateCoin`, `ReserveFee`, `AggSigMe`), which the prelude re-exports.

## Building conditions

`Conditions::new()` starts an empty list, and every condition has a snake_case builder method that appends it and returns the list. Pass the finished list to a layer's spend method, such as `StandardLayer::spend`, or to `SpendContext::delegated_spend`.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn send_with_fee() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1_000);
    let bob = BlsPair::new(1);

    // Hint the payment to Bob so his wallet can find it.
    let hint = ctx.hint(bob.puzzle_hash)?;

    let conditions = Conditions::new()
        .create_coin(bob.puzzle_hash, 900, hint)
        .create_coin(alice.puzzle_hash, 50, Memos::None)
        .reserve_fee(50);

    StandardLayer::new(alice.pk).spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    assert_eq!(sim.unspent_coins(bob.puzzle_hash, false).len(), 1);

    Ok(())
}
```

You can also build a list from condition structs with `with` (by value), `push` (by mutable reference) and `extend`, which is convenient when conditions come from several places:

```rust
use chia_wallet_sdk::prelude::*;

fn payout_conditions(payouts: &[(Bytes32, u64)], fee: u64) -> Conditions {
    let mut conditions = Conditions::new().extend(
        payouts
            .iter()
            .map(|&(puzzle_hash, amount)| CreateCoin::new(puzzle_hash, amount, Memos::None)),
    );

    if fee > 0 {
        conditions.push(ReserveFee::new(fee));
    }

    conditions
}

#[test]
fn build_from_structs() {
    let conditions = payout_conditions(&[(Bytes32::new([1; 32]), 10), (Bytes32::new([2; 32]), 20)], 5);
    assert_eq!(conditions.len(), 3);
    assert!(conditions[2].is_reserve_fee());
}
```

`Conditions` is `#[must_use]`, since the builder methods return a new list rather than modifying it in place.

## Condition reference

| Category      | Builder method                                                                                                                                                  | Opcode | Notes                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| Coins         | `create_coin(puzzle_hash, amount, memos)`                                                                                                                       | 51     | See [memos and hints](#memos-and-hints)                                       |
|               | `reserve_fee(amount)`                                                                                                                                           | 52     | Asserts that at least this much of the bundle's surplus goes to fees          |
| Signatures    | `agg_sig_me`, `agg_sig_unsafe`, `agg_sig_parent`, `agg_sig_puzzle`, `agg_sig_amount`, `agg_sig_parent_amount`, `agg_sig_parent_puzzle`, `agg_sig_puzzle_amount` | 43-50  | `(public_key, message)`; see [Keys & Signing](/sdk/concepts/signing)          |
| Announcements | `create_coin_announcement(message)`, `assert_coin_announcement(id)`                                                                                             | 60, 61 |                                                                               |
|               | `create_puzzle_announcement(message)`, `assert_puzzle_announcement(id)`                                                                                         | 62, 63 |                                                                               |
| Messages      | `send_message(mode, message, data)`, `receive_message(mode, message, data)`                                                                                     | 66, 67 | [CHIP-25](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0025.md) |
| Concurrency   | `assert_concurrent_spend(coin_id)`, `assert_concurrent_puzzle(puzzle_hash)`                                                                                     | 64, 65 | Another coin must be spent in the same block                                  |
| Self          | `assert_my_coin_id`, `assert_my_parent_id`, `assert_my_puzzle_hash`, `assert_my_amount`, `assert_my_birth_height`, `assert_my_birth_seconds`                    | 70-75  |                                                                               |
|               | `assert_ephemeral()`                                                                                                                                            | 76     | The coin must be created in the same block                                    |
| Timelocks     | `assert_seconds_relative`, `assert_seconds_absolute`, `assert_height_relative`, `assert_height_absolute`                                                        | 80-83  | Not valid until                                                               |
|               | `assert_before_seconds_relative`, `assert_before_seconds_absolute`, `assert_before_height_relative`, `assert_before_height_absolute`                            | 84-87  | Not valid after                                                               |
| Other         | `remark(rest)`                                                                                                                                                  | 1      | Ignored by consensus; useful for puzzles that read their own output           |
|               | `softfork(cost, rest)`                                                                                                                                          | 90     | Reserved for future consensus extensions                                      |

Some puzzles interpret additional conditions that consensus doesn't know about. The SDK has variants for these too:

| Builder method                                                         | Used by                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `run_cat_tail(program, solution)`                                      | Running a TAIL from a CAT inner puzzle (a `CREATE_COIN` with the magic amount -113) |
| `melt_singleton()`                                                     | Destroying a singleton (also the magic amount -113)                                 |
| `transfer_nft(launcher_id, trade_prices, singleton_inner_puzzle_hash)` | Assigning an NFT to a DID through the NFT ownership layer (opcode -10)              |
| `update_nft_metadata(updater_puzzle_reveal, updater_solution)`         | Updating NFT metadata through the state layer (opcode -24)                          |
| `update_datastore_merkle_root(new_merkle_root, memos)`                 | DataLayer stores, see [DataLayer](/sdk/primitives/datalayer) (opcode -13)           |

You'll mostly reach these through the primitive APIs ([CAT](/sdk/primitives/cat), [NFT](/sdk/primitives/nft), [Singletons](/sdk/primitives/singletons)) rather than building them by hand.

## Memos and hints

The third argument of `create_coin` is a `Memos<T>`: either `Memos::None` or `Memos::Some(list)`, where the list is an allocated CLVM value. Memos are stored on chain with the coin spend but aren't part of the new coin's id.

By convention, if the first memo is 32 bytes, full nodes index it as the coin's **hint**. Wallets subscribe to hints to discover coins whose puzzle hash they wouldn't otherwise recognize. For example, a CAT sent to Bob is locked by a CAT puzzle hash, but is hinted with Bob's inner puzzle hash so his wallet can find it. See the [CAT](/sdk/primitives/cat) and [NFT](/sdk/primitives/nft) pages for how each primitive hints its children.

`SpendContext` has two helpers for building memos:

- `ctx.hint(puzzle_hash)` allocates the list `(puzzle_hash)`.
- `ctx.memos(&value)` allocates any `ToClvm` value as the memo list, for a hint followed by other data.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn hints_and_memos() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(2);
    let bob = BlsPair::new(1);

    // A hint followed by a free-form note.
    let memos = ctx.memos(&(bob.puzzle_hash, ("Thanks for lunch".to_string(), ())))?;

    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bob.puzzle_hash, 2, memos),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // The simulator indexes hints like a full node.
    assert_eq!(sim.hinted_coins(bob.puzzle_hash).len(), 1);

    Ok(())
}
```

## Announcements and messages

Spends in a bundle are independent unless they assert something about each other. Announcements and messages let one spend depend on another, so that a bundle can't be split up and partially included.

### Announcements

A coin creates an announcement with `create_coin_announcement(message)` or `create_puzzle_announcement(message)`. Any other spend in the same block can assert it by its id: `sha256(coin_id + message)` for coin announcements, or `sha256(puzzle_hash + message)` for puzzle announcements. `announcement_id(coin_info, message)` computes this.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::announcement_id;

#[test]
fn linked_by_announcement() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let bob = sim.bls(1);

    // Alice's spend is only valid if Bob's coin is spent in the same block, announcing "ready".
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new()
            .assert_coin_announcement(announcement_id(bob.coin.coin_id(), b"ready")),
    )?;

    StandardLayer::new(bob.pk).spend(
        ctx,
        bob.coin,
        Conditions::new().create_coin_announcement(Bytes::new(b"ready".to_vec())),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk, bob.sk])?;

    Ok(())
}
```

Announcements are public: any spend in the block can assert one, and creating one doesn't require it to be asserted. When you only need to know that another coin is spent alongside yours, `assert_concurrent_spend(coin_id)` is simpler.

### Messages

Messages ([CHIP-25](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0025.md)) are a stricter, point-to-point alternative. A `SEND_MESSAGE` must be matched by exactly one `RECEIVE_MESSAGE` with the same mode and message in the same spend bundle, and vice versa, or the bundle fails.

The `mode` byte says which parts of the sender and receiver coins are committed to. Build it with `MessageFlags` and `MessageSide`: the sender flags occupy the upper three bits and the receiver flags the lower three. The `data` argument identifies the other side: in `send_message`, the receiver's committed parts (for example its coin id), and in `receive_message`, the sender's.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::{MessageFlags, MessageSide};

#[test]
fn linked_by_message() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let bob = sim.bls(1);

    // Alice commits to her puzzle hash, and sends the message to Bob's exact coin.
    let mode = MessageFlags::PUZZLE.encode(MessageSide::Sender)
        | MessageFlags::COIN.encode(MessageSide::Receiver);
    let message = Bytes::new(b"approved".to_vec());

    let bob_coin_id = ctx.alloc(&bob.coin.coin_id())?;
    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().send_message(mode, message.clone(), vec![bob_coin_id]),
    )?;

    let alice_puzzle_hash = ctx.alloc(&alice.puzzle_hash)?;
    StandardLayer::new(bob.pk).spend(
        ctx,
        bob.coin,
        Conditions::new().receive_message(mode, message, vec![alice_puzzle_hash]),
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk, bob.sk])?;

    Ok(())
}
```

Messages are how many newer puzzles authorize each other. For example, [vault](/sdk/primitives/vaults) coins are spent by a message from the vault singleton, and the [action system](/sdk/action-system) uses them to link spends.

## Assertions and timelocks

Assertion conditions don't change state; they make the spend invalid unless something is true. The `assert_my_*` conditions guard against a puzzle being spent as a different coin than intended. Timelocks restrict when a spend can be included:

- `assert_seconds_*` and `assert_height_*` set the earliest time or block height.
- `assert_before_seconds_*` and `assert_before_height_*` set an expiry.
- The `_relative` versions count from when the coin was created, and the `_absolute` versions are timestamps or heights on the chain.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn relative_timelock() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(1);
    let p2 = StandardLayer::new(alice.pk);
    let conditions = Conditions::new()
        .create_coin(alice.puzzle_hash, 1, Memos::None)
        .assert_height_relative(10);

    // Too early: the coin was created less than 10 blocks ago.
    p2.spend(ctx, alice.coin, conditions.clone())?;
    assert!(sim.spend_coins(ctx.take(), &[alice.sk.clone()]).is_err());

    // Ten blocks later, the same spend is valid.
    for _ in 0..10 {
        sim.create_block();
    }
    p2.spend(ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    Ok(())
}
```

## Parsing conditions

To find out what a spend does, run its puzzle with its solution and parse the output. `Vec<Condition>` and `Conditions` both implement `FromClvm`. Each variant has generated helpers: `is_create_coin()`, `as_create_coin()` (a reference) and `into_create_coin()` (by value), and likewise for every other condition. `into_agg_sig()` converts any of the eight signature conditions into a common `AggSig` struct.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn parse_spend_output() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let alice = sim.bls(10);
    let bob = BlsPair::new(1);

    StandardLayer::new(alice.pk).spend(
        ctx,
        alice.coin,
        Conditions::new().create_coin(bob.puzzle_hash, 9, Memos::None).reserve_fee(1),
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Later, look up the spend and see what it created.
    let coin_spend = sim.coin_spend(alice.coin.coin_id()).expect("coin was spent");
    let puzzle = ctx.alloc(&coin_spend.puzzle_reveal)?;
    let solution = ctx.alloc(&coin_spend.solution)?;
    let output = ctx.run(puzzle, solution)?;
    let conditions = ctx.extract::<Vec<Condition>>(output)?;

    let created: Vec<Coin> = conditions
        .iter()
        .filter_map(Condition::as_create_coin)
        .map(|create_coin| {
            Coin::new(alice.coin.coin_id(), create_coin.puzzle_hash, create_coin.amount)
        })
        .collect();
    assert_eq!(created, [Coin::new(alice.coin.coin_id(), bob.puzzle_hash, 9)]);

    // The standard puzzle adds an AGG_SIG_ME for its key.
    let signatures: Vec<_> = conditions.into_iter().filter_map(Condition::into_agg_sig).collect();
    assert_eq!(signatures.len(), 1);
    assert_eq!(signatures[0].public_key, alice.pk);

    Ok(())
}
```

Conditions with an unrecognized opcode, or a recognized opcode that doesn't match the expected shape, parse as `Condition::Other(T)`, so parsing a list never fails because of a single unusual condition. The enum is also `#[non_exhaustive]`, so `match` statements need a wildcard arm.

The type parameter `T` controls how the open-ended parts of a condition are parsed: the memo list of `CreateCoin`, the rest of `Remark` and `Softfork`, the message data, and `Other`. It defaults to `NodePtr`, which leaves them unparsed.

## Gotchas

- **Conditions don't sign anything.** An `AGG_SIG_*` condition only states that a signature is required. You still have to produce the signature; see [Keys & Signing](/sdk/concepts/signing).
- **Fees are implicit.** The fee is whatever input value isn't spent on outputs. `reserve_fee` only asserts that the fee is at least the given amount, and protects against a bundle being stripped of its fee-paying spend.
- **Memos must be allocated in the same allocator as the spend.** `Memos<NodePtr>` points into a specific `SpendContext`. Build it with that context's `hint` or `memos`.
- **Only the first memo is a hint, and only if it's exactly 32 bytes.**
- **Condition order isn't significant** to consensus, but duplicate `CREATE_COIN` conditions with the same puzzle hash and amount create the same coin id and fail. Vary the amount, or use separate parents.
