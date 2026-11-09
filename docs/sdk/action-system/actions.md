---
title: Action Reference
---

# Action Reference

Every action is created with a constructor on [`Action`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/enum.Action.html) and applied with `Spends::apply`. This page covers each constructor, grouped by what it works on, with a runnable example for each group. Read the [Action System overview](/sdk/action-system) first for how `Spends`, `Id` and `Deltas` fit together.

All examples run against the [Simulator](/sdk/testing) and spend coins with `finish_with_keys`.

## Summary

| Constructor                                                     | Applies to                 | Creates                         | Delta                                           |
| --------------------------------------------------------------- | -------------------------- | ------------------------------- | ----------------------------------------------- |
| `send(id, puzzle_hash, amount, memos)`                          | XCH, CAT, NFT, DID, option | A payment, or moves a singleton | `id` output `amount`                            |
| `burn(id, amount, memos)`                                       | XCH, CAT, NFT, DID, option | A payment to `BURN_PUZZLE_HASH` | `id` output `amount`                            |
| `fee(amount)`                                                   | XCH                        | A `RESERVE_FEE` condition       | XCH output `amount`                             |
| `single_issue_cat(hidden_puzzle_hash, amount)`                  | XCH                        | `Id::New(index)` CAT            | XCH output, new CAT input                       |
| `issue_cat(tail_spend, hidden_puzzle_hash, amount)`             | XCH                        | `Id::New(index)` CAT            | XCH output, new CAT input                       |
| `run_tail(id, tail_spend, supply_delta)`                        | CAT                        | More supply, or melted XCH      | CAT `supply_delta`, XCH the opposite            |
| `mint_nft(...)` and the `mint_empty_*` variants                 | XCH                        | `Id::New(index)` NFT            | XCH output, new NFT input                       |
| `mint_nft_from_did(...)`, `mint_nft_from_nft(...)` and variants | DID or NFT (+ XCH)         | `Id::New(index)` NFT            | XCH output, new NFT input                       |
| `update_nft(id, metadata_update_spends, transfer)`              | NFT (+ DID/NFT owner)      | Updated NFT                     | NFT needed                                      |
| `create_did(...)`, `create_empty_did()`                         | XCH                        | `Id::New(index)` DID            | XCH output, new DID input                       |
| `update_did(id, ...)`                                           | DID                        | Updated DID                     | DID needed                                      |
| `mint_option(...)`                                              | XCH + underlying asset     | `Id::New(index)` option         | XCH output, underlying output, new option input |
| `melt_singleton(id, amount)`                                    | DID or option              | XCH                             | Singleton output, XCH input                     |
| `settle(id, notarized_payment)`                                 | Settlement coins           | Notarized payments              | `id` output the payment amounts                 |
| `settle_royalty(ctx, id, launcher_id, puzzle_hash, amount)`     | Settlement coins           | A royalty payment               | `id` output `amount`                            |

The column "Delta" is what `Deltas::from_actions` records, which is what you select coins against. Singletons have a delta of 1 in and 1 out when they're updated, which nets to zero but marks them as needed.

## Payments

### `Action::send`

`Action::send(id, puzzle_hash, amount, memos)` creates a coin of the asset with the given p2 puzzle hash and amount. For CATs, the puzzle hash is wrapped in the CAT layer for you (and in the revocation layer, for revocable CATs), so you pass the recipient's p2 puzzle hash, not the full CAT puzzle hash.

The memos are used as given. Wallets find CATs and singletons by their hint, so pass `ctx.hint(puzzle_hash)?` when sending them to someone. For XCH, `Memos::None` is fine, since the coin's puzzle hash is the recipient's puzzle hash.

For a singleton (NFT, DID or option contract), `send` sets where the singleton goes when it's recreated, and `amount` must be the singleton's amount, otherwise it fails with `DriverError::SingletonAmountMismatch`. A singleton that isn't sent anywhere goes to the change puzzle hash.

The SDK picks which coin creates each payment. If two payments would be identical (same puzzle hash and amount from the same parent), the second one is created from an intermediate coin, so sending the same amount to the same person twice works as expected.

### `Action::burn`

`Action::burn(id, amount, memos)` is `send` to `BURN_PUZZLE_HASH` (`0x000...dead`), a puzzle hash with no known puzzle, so the coins can never be spent.

### `Action::fee`

`Action::fee(amount)` pays a fee to the farmer. The fee is the XCH left over after every output, and it's asserted with a `RESERVE_FEE` condition, which is attached to one of the spends when they're prepared. Multiple fee actions add up. `Outputs::fee` is the total, and `Outputs::reserved_fee` is the part asserted with `RESERVE_FEE`.

To leave a fee without asserting it, construct the variant directly: `Action::Fee(FeeAction { amount, reserved: false })`.

```rust
use chia_wallet_sdk::chia::puzzle_types::Memos;
use chia_wallet_sdk::driver::BURN_PUZZLE_HASH;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn payments() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(100);
    let bob = BlsPair::new(1);
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    let actions = [
        // Two identical XCH payments
        Action::send(Id::Xch, bob.puzzle_hash, 10, Memos::None),
        Action::send(Id::Xch, bob.puzzle_hash, 10, Memos::None),
        // Issue a CAT, send most of it to Bob (hinted), and burn the rest
        Action::single_issue_cat(None, 50),
        Action::send(Id::New(2), bob.puzzle_hash, 30, bob_hint),
        Action::burn(Id::New(2), 20, Memos::None),
        Action::fee(1),
    ];

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;

    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob has two separate 10 mojo coins
    assert_eq!(sim.unspent_coins(bob.puzzle_hash, false).len(), 2);

    // 100 - 20 sent - 50 used to issue the CAT - 1 fee
    let change = outputs
        .xch
        .iter()
        .find(|coin| coin.puzzle_hash == alice.puzzle_hash)
        .expect("missing change");
    assert_eq!(change.amount, 29);

    // The CAT outputs are Bob's coin and the burned coin
    let cats = &outputs.cats[&Id::New(2)];
    assert!(cats.iter().any(|cat| cat.info.p2_puzzle_hash == bob.puzzle_hash));
    assert!(cats.iter().any(|cat| cat.info.p2_puzzle_hash == BURN_PUZZLE_HASH));
    assert_eq!(outputs.reserved_fee, 1);

    Ok(())
}
```

## CATs

See [CAT](/sdk/primitives/cat) for how CATs, TAILs and revocable CATs work on chain.

### `Action::single_issue_cat`

`Action::single_issue_cat(hidden_puzzle_hash, amount)` issues a CAT with the single issuance TAIL (`GenesisByCoinIdTailArgs`), which is derived from the XCH coin that issues it, so no more of the CAT can ever be issued. The asset id depends on which coin the SDK picks as the parent, so read it from the outputs afterwards.

### `Action::issue_cat`

`Action::issue_cat(tail_spend, hidden_puzzle_hash, amount)` issues a CAT with any TAIL. The asset id is the tree hash of `tail_spend.puzzle`, and the TAIL is run with `tail_spend.solution`, so it must allow the issuance.

Pass `Some(hidden_puzzle_hash)` to either constructor to issue a [revocable CAT](/sdk/primitives/cat), which the holder of the hidden puzzle can revoke later. See [Custom Spends](/sdk/action-system/custom-spends#revocation) for revoking with the action system.

The issued CAT is `Id::New(index)`, with one exception: if coins with the same asset id are already in the `Spends`, the new coin joins their ring and must be referred to as `Id::Existing(asset_id)`.

Issuing a CAT costs `amount` mojos of XCH, since every CAT mojo is backed by an XCH mojo.

### `Action::run_tail`

`Action::run_tail(id, tail_spend, supply_delta)` runs the TAIL of a CAT that's already in the spends. The `Delta` is the change in supply:

- `Delta::new(amount, 0)` issues `amount` more of the CAT, which costs `amount` XCH.
- `Delta::new(0, amount)` melts `amount` of the CAT back into XCH, which is returned as XCH change. At least one XCH coin must be in the spends to receive it (`deltas.is_needed(&Id::Xch)` is true), even one with an amount of zero.

Each CAT spend can only run its TAIL once, so the SDK finds a CAT spend that hasn't run it yet (or creates an intermediate coin to run it from).

```rust
use chia_wallet_sdk::chia::puzzle_types::cat::EverythingWithSignatureTailArgs;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn issue_and_melt_cat() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(100);
    let keys = indexmap! { alice.puzzle_hash => alice.pk };

    // A TAIL that can be run whenever Alice signs, so she can issue and melt at will
    let tail = ctx.curry(EverythingWithSignatureTailArgs::new(alice.pk))?;
    let tail_spend = Spend::new(tail, NodePtr::NIL);

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    let deltas = spends.apply(&mut ctx, &[Action::issue_cat(tail_spend, None, 100)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let cat = outputs.cats[&Id::New(0)][0];
    let id = Id::Existing(cat.info.asset_id);
    assert_eq!(cat.info.asset_id, ctx.tree_hash(tail).into());

    // Melt 40 of the CAT. The XCH comes back as change, so an XCH coin is needed to receive it.
    let actions = [Action::run_tail(id, tail_spend, Delta::new(0, 40))];
    assert!(Deltas::from_actions(&actions).is_needed(&Id::Xch));

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(cat);
    spends.add(sim.new_coin(alice.puzzle_hash, 0));

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &keys)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // 60 of the CAT is left as change, and 40 mojos of XCH were released
    assert_eq!(outputs.cats[&id][0].coin.amount, 60);
    assert_eq!(outputs.xch[0].amount, 40);

    Ok(())
}
```

## NFTs

See [NFT](/sdk/primitives/nft) for NFT metadata, royalties and ownership on chain.

### `Action::mint_nft` and variants

`Action::mint_nft(metadata, metadata_updater_puzzle_hash, royalty_puzzle_hash, royalty_basis_points, amount)` mints an NFT from an XCH coin. The metadata is a `HashedPtr` (allocate it with `ctx.alloc_hashed(&NftMetadata { .. })?`), the metadata updater is usually `NFT_METADATA_UPDATER_DEFAULT_HASH`, and the royalty is in basis points (300 is 3%). The amount must be odd, and is almost always 1. Unless it's sent elsewhere, the NFT goes to the change puzzle hash.

The other constructors are shorthands:

| Constructor                                                          | Launcher parent | Metadata, updater | Royalty |
| -------------------------------------------------------------------- | --------------- | ----------------- | ------- |
| `mint_nft(...)`                                                      | XCH coin        | Given             | Given   |
| `mint_nft_from_did(did_id, ...)`                                     | The DID's spend | Given             | Given   |
| `mint_nft_from_nft(nft_id, ...)`                                     | The NFT's spend | Given             | Given   |
| `mint_empty_nft()`                                                   | XCH coin        | Empty             | None    |
| `mint_empty_royalty_nft(puzzle_hash, basis_points)`                  | XCH coin        | Empty             | Given   |
| `mint_empty_nft_from_did(did_id)`                                    | The DID's spend | Empty             | None    |
| `mint_empty_royalty_nft_from_did(did_id, puzzle_hash, basis_points)` | The DID's spend | Empty             | Given   |
| `mint_empty_nft_from_nft(nft_id)`                                    | The NFT's spend | Empty             | None    |
| `mint_empty_royalty_nft_from_nft(nft_id, puzzle_hash, basis_points)` | The NFT's spend | Empty             | Given   |

The "empty" variants use nil metadata and an amount of 1, which is mostly useful for tests.

Minting from a DID or NFT only makes the singleton the parent of the launcher. It **doesn't** assign the new NFT to it. To mint an NFT that belongs to a DID (as in a DID-backed collection), follow the mint with `update_nft` and a `TransferNftById` that points at the DID. The NFT's value still comes from XCH, so an XCH coin is needed as well.

### `Action::update_nft`

`Action::update_nft(id, metadata_update_spends, transfer)` changes an NFT that's in the spends:

- `metadata_update_spends` are spends of the metadata updater puzzle, run in order, each against the result of the previous one. Each one requires its own spend of the NFT, which the SDK adds to the NFT's lineage. For the default updater, build them with `MetadataUpdate { kind: UriKind::Data, uri }.spend(&mut ctx)?`, which prepends a URI to the data, metadata or license URI list.
- `transfer: Some(TransferNftById::new(owner_id, trade_prices))` sets the NFT's owner. `owner_id` is `Some(id)` of a DID or NFT in the same transaction (which is spent to authorize the assignment) or `None` to remove the current owner. `trade_prices` are the [trade prices](/sdk/offers#royalties) that determine royalties when the NFT is offered.

Updating doesn't move the NFT. Combine it with `send` to update and transfer at the same time.

```rust
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::driver::{MetadataUpdate, UriKind};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::NFT_METADATA_UPDATER_DEFAULT_HASH;
use indexmap::indexmap;

#[test]
fn mint_update_and_send_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let bob = BlsPair::new(1);
    let keys = indexmap! { alice.puzzle_hash => alice.pk };

    let metadata = ctx.alloc_hashed(&NftMetadata {
        data_uris: vec!["https://example.com/1.png".to_string()],
        data_hash: Some(Bytes32::new([1; 32])),
        ..Default::default()
    })?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    let deltas = spends.apply(
        &mut ctx,
        &[Action::mint_nft(
            metadata,
            NFT_METADATA_UPDATER_DEFAULT_HASH.into(),
            alice.puzzle_hash,
            300,
            1,
        )],
    )?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let nft = outputs.nfts[&Id::New(0)];
    let id = Id::Existing(nft.info.launcher_id);
    assert_eq!(nft.info.royalty_basis_points, 300);

    // Add a mirror URI, then send the NFT to Bob in the same transaction
    let update = MetadataUpdate {
        kind: UriKind::Data,
        uri: "https://mirror.example.com/1.png".to_string(),
    }
    .spend(&mut ctx)?;
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(nft);

    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::update_nft(id, vec![update], None),
            Action::send(id, bob.puzzle_hash, 1, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let nft = outputs.nfts[&id];
    assert_eq!(nft.info.p2_puzzle_hash, bob.puzzle_hash);

    let metadata: NftMetadata = ctx.extract(nft.info.metadata.ptr())?;
    assert_eq!(metadata.data_uris.len(), 2);
    assert_eq!(metadata.data_uris[0], "https://mirror.example.com/1.png");

    Ok(())
}
```

Minting an NFT that belongs to an existing DID:

```rust
use chia_wallet_sdk::driver::TransferNftById;
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn mint_nft_owned_by_did() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let keys = indexmap! { alice.puzzle_hash => alice.pk };

    // Create the DID first
    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(&mut ctx, &[Action::create_empty_did()])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let did = outputs.dids[&Id::New(0)];
    let did_id = Id::Existing(did.info.launcher_id);

    // Mint from the DID and assign the NFT to it. The NFT's mojo comes from an XCH coin.
    let actions = [
        Action::mint_empty_royalty_nft_from_did(did_id, alice.puzzle_hash, 500),
        Action::update_nft(
            Id::New(0),
            vec![],
            Some(TransferNftById::new(Some(did_id), vec![])),
        ),
    ];

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(did);
    spends.add(sim.new_coin(alice.puzzle_hash, 1));

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &keys)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let nft = outputs.nfts[&Id::New(0)];
    assert_eq!(nft.info.current_owner, Some(did.info.launcher_id));
    assert_eq!(nft.info.p2_puzzle_hash, alice.puzzle_hash);

    // The DID was spent to authorize the assignment, and is recreated
    assert!(outputs.dids.contains_key(&did_id));

    Ok(())
}
```

## DIDs

See [DID](/sdk/primitives/did) for what a DID's recovery list, verifications and metadata mean.

### `Action::create_did` and `Action::create_empty_did`

`Action::create_did(recovery_list_hash, num_verifications_required, metadata, amount)` creates a DID from an XCH coin. The amount must be odd. `Action::create_empty_did()` is a DID with no recovery list, one required verification, nil metadata and an amount of 1. Unless it's sent elsewhere, the DID goes to the change puzzle hash.

### `Action::update_did`

`Action::update_did(id, new_recovery_list_hash, new_num_verifications_required, new_metadata)` changes any combination of the DID's fields. `None` leaves a field unchanged. The recovery list hash is an `Option<Option<Bytes32>>`, so `Some(None)` removes it.

### `Action::melt_singleton`

`Action::melt_singleton(id, amount)` destroys a DID (or [option contract](#options)) for good, returning its amount to the transaction as XCH. The amount must be the singleton's amount. A singleton spend can't create an odd coin alongside the melt condition, so the XCH comes back as change through an XCH coin, which you need to add to the spends. NFTs can't be melted; burn them with `Action::burn` instead.

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn did_lifecycle() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let bob = sim.bls(0);
    let alice_keys = indexmap! { alice.puzzle_hash => alice.pk };
    let bob_keys = indexmap! { bob.puzzle_hash => bob.pk };

    let metadata = ctx.alloc_hashed(&"Alice's DID")?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);
    let deltas = spends.apply(&mut ctx, &[Action::create_did(None, 1, metadata, 1)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&alice.sk))?;

    let did = outputs.dids[&Id::New(0)];
    let id = Id::Existing(did.info.launcher_id);

    // Update the metadata and send it to Bob
    let new_metadata = ctx.alloc_hashed(&"Bob's DID")?;
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(did);
    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::update_did(id, None, None, Some(new_metadata)),
            Action::send(id, bob.puzzle_hash, 1, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &alice_keys)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let did = outputs.dids[&id];
    assert_eq!(did.info.p2_puzzle_hash, bob.puzzle_hash);
    assert_eq!(did.info.metadata, new_metadata);

    // Bob melts it, and receives its mojo through his (zero amount) XCH coin
    let mut spends = Spends::new(bob.puzzle_hash);
    spends.add(did);
    spends.add(bob.coin);
    let deltas = spends.apply(&mut ctx, &[Action::melt_singleton(id, 1)])?;
    let outputs = spends.finish_with_keys(&mut ctx, &deltas, Relation::None, &bob_keys)?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    assert!(outputs.dids.is_empty());
    assert_eq!(outputs.xch[0].amount, 1);

    Ok(())
}
```

## Options

### `Action::mint_option`

`Action::mint_option(creator_puzzle_hash, seconds, underlying_id, underlying_amount, strike_type, amount)` mints an [option contract](/sdk/primitives/options) singleton from an XCH coin, and locks `underlying_amount` of the underlying asset (XCH, a CAT, or an NFT, by `underlying_id`) in a coin that the option controls. Until the `seconds` timestamp, the owner of the option can exercise it by paying the `strike_type` (an `OptionType`) to `creator_puzzle_hash`. After that, the creator can reclaim the underlying asset.

The option is `Id::New(index)`, and its owner is the p2 puzzle hash of the XCH coin it was minted from. Send it elsewhere with `Action::send`. When the underlying is an NFT, the NFT is locked in the same transaction, so no other action can use it afterwards (they fail with `DriverError::NoSourceForOutput`).

### Exercising with `Action::melt_singleton`

Exercising an option means melting it. `Action::melt_singleton(option_id, amount)` melts the option and authorizes its underlying coin to be exercised, but spending the underlying coin and paying the strike are separate steps. See [Exercising](/sdk/primitives/options#exercising) for the full flow.

```rust
use chia_wallet_sdk::prelude::*;
use indexmap::indexmap;

#[test]
fn mint_cat_option() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(101);
    let bob = BlsPair::new(1);
    let bob_hint = ctx.hint(bob.puzzle_hash)?;

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(alice.coin);

    // Issue 100 of a CAT, lock it in an option that Bob can exercise for 50 mojos until
    // timestamp 1000, and give the option to Bob
    let deltas = spends.apply(
        &mut ctx,
        &[
            Action::single_issue_cat(None, 100),
            Action::mint_option(
                alice.puzzle_hash,
                1000,
                Id::New(0),
                100,
                OptionType::Xch { amount: 50 },
                1,
            ),
            Action::send(Id::New(1), bob.puzzle_hash, 1, bob_hint),
        ],
    )?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::None,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    let option = outputs.options[&Id::New(1)];
    assert_eq!(option.info.p2_puzzle_hash, bob.puzzle_hash);

    // The underlying CAT coin is one of the CAT outputs
    let underlying = outputs.cats[&Id::New(0)]
        .iter()
        .find(|cat| cat.coin.coin_id() == option.info.underlying_coin_id)
        .expect("missing underlying");
    assert_eq!(underlying.coin.amount, 100);

    Ok(())
}
```

## Settlement

These actions spend settlement coins, which are coins locked by the settlement payments puzzle. Anyone can spend a settlement coin, but it can only make notarized payments. They're how [offers](/sdk/offers) are taken. Add the settlement coins to the spends (for an offer, `spends.add(offer.offered_coins().clone())`), and the SDK spends them as settlement spends automatically.

### `Action::settle`

`Action::settle(id, notarized_payment)` makes a `NotarizedPayment` (a nonce and a list of payments) from a settlement coin of the asset. For an offer, the requested payments are exactly these actions: `offer.requested_payments().actions()` returns one `settle` per notarized payment.

If the asset's only coins aren't settlement coins (for example, you're paying an offer's request for XCH from your own wallet), the SDK creates an intermediate settlement coin and pays from it. A settle on an NFT or option moves the singleton into a settlement coin first if needed.

### `Action::settle_royalty`

`Action::settle_royalty(&mut ctx, id, launcher_id, royalty_puzzle_hash, royalty_amount)` is `settle` with the royalty payment an NFT's royalty puzzle asserts: the nonce is the NFT's launcher id, and the payment is hinted to the royalty puzzle hash. See [Royalties](/sdk/offers#royalties) for calculating the amounts.

Every payment made by a settlement coin, including change created from it, is asserted by a conditions spend in the transaction, so the settlement spends can't be stripped out. That's why the example adds one of Alice's coins, even with an amount of zero.

```rust
use chia_wallet_sdk::chia::puzzle_types::{
    Memos,
    offer::{NotarizedPayment, Payment},
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use indexmap::indexmap;

#[test]
fn settle_payments() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(0);
    let bob = BlsPair::new(1);
    let carol = BlsPair::new(2);

    // A settlement coin, like the one an offer maker creates
    let settlement = sim.new_coin(SETTLEMENT_PAYMENT_HASH.into(), 10);

    let mut spends = Spends::new(alice.puzzle_hash);
    spends.add(settlement);
    spends.add(alice.coin);

    let nft_launcher_id = Bytes32::new([9; 32]);

    let actions = [
        Action::settle(
            Id::Xch,
            NotarizedPayment::new(
                Bytes32::new([1; 32]),
                vec![Payment::new(bob.puzzle_hash, 3, Memos::None)],
            ),
        ),
        Action::settle_royalty(&mut ctx, Id::Xch, nft_launcher_id, carol.puzzle_hash, 2)?,
    ];

    let deltas = spends.apply(&mut ctx, &actions)?;
    let outputs = spends.finish_with_keys(
        &mut ctx,
        &deltas,
        Relation::AssertConcurrent,
        &indexmap! { alice.puzzle_hash => alice.pk },
    )?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Bob and Carol are paid, and the remaining 5 mojos go to Alice as change
    let paid = |puzzle_hash| {
        outputs
            .xch
            .iter()
            .filter(|coin| coin.puzzle_hash == puzzle_hash)
            .map(|coin| coin.amount)
            .sum::<u64>()
    };
    assert_eq!(paid(bob.puzzle_hash), 3);
    assert_eq!(paid(carol.puzzle_hash), 2);
    assert_eq!(paid(alice.puzzle_hash), 5);

    Ok(())
}
```

## The `SpendAction` trait

Every action type (`SendAction`, `IssueCatAction`, `MintNftAction`, and so on) implements `SpendAction`, which has two methods: `calculate_delta` (what `Deltas::from_actions` calls) and `spend` (what `Spends::apply` calls). The `Action` enum dispatches to them. The action structs have public fields, so you can construct a variant directly (`Action::Fee(FeeAction { .. })`) when a constructor doesn't expose an option you need.
