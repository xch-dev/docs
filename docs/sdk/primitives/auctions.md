---
title: Auctions
---

# Auctions

An **auction** is a singleton that sells an NFT in an English (ascending price) auction. The seller
locks the NFT with the auction and picks the rules up front. After that, anyone can place a bid in XCH
or a CAT without the seller's involvement. Each bid locks up the bidder's funds and refunds the
previous bidder in full. When the auction ends, the NFT goes to the winning bidder and the winning bid
is paid out to the seller, the fee recipients and the NFT's royalty address. The auction is built on
the [action layer](/sdk/primitives/action-layer), so no one controls it once it's launched, the seller
included.

:::info Unreleased
This feature is on the SDK's `main` branch and isn't in a release yet (the latest release is 0.37.1).
To try it, depend on the git repository with the `auction` feature:
`chia-wallet-sdk = { git = "https://github.com/xch-dev/chia-wallet-sdk", features = ["auction"] }`
:::

The `auction` feature implies `action-layer`. The drivers are in `chia_wallet_sdk::driver` (`Auction`,
`AuctionInfo`, `AuctionSettings`, ...) and the puzzle types are in `chia_wallet_sdk::types::puzzles`
(`AuctionBid`, `AuctionState`, `AuctionTimings`, `AuctionPayments`, ...).

## How an auction works

An auction is made of three kinds of coins:

```text
Auction singleton (amount 1)
  SingletonLayer
    ActionLayer { merkle root of [bid, end, cancel], AuctionState, reserve finalizer }

Reserve coin (XCH or CAT)   locked by the auction, holds the current winning bid
Locked NFT                  locked by the auction until it ends or is cancelled
```

- **The singleton** is an [action layer](/sdk/primitives/action-layer) singleton with three actions:
  bid, end and cancel. Its state (`AuctionState`) is the amount in the reserve, whether the auction
  has ended, and the current winning bid. Anyone can spend it by running actions. The puzzles enforce
  the rules, not a signature.
- **The reserve** holds the winning bidder's funds. The singleton uses the action layer's reserve
  finalizer: every spend of the singleton also spends the reserve and recreates it with the new
  `state.reserve_amount`. Actions output reserve conditions (refunds and payouts), which the finalizer
  forwards to the reserve coin. The reserve can be XCH (`AuctionReserve::Xch`) or a CAT
  (`AuctionReserve::Cat`, revocable CATs included). It starts as an empty (0 mojo) coin.
- **The lock** is the p2 puzzle hash that the NFT and the reserve are locked with.
  `auction_lock_p2_puzzle_hash(launcher_id)` is a [MIPS](/sdk/primitives/vaults) puzzle whose only member
  is the auction singleton (a `SingletonMember`), so locked coins can only be spent when the auction
  sends them a message. `spend_auction_lock` builds that spend. Because the lock is derived from the
  launcher id, you lock the NFT before the auction exists, in the same transaction that launches it.

### Actions

| Action | Driver method                                | When it's allowed                                                      | What it does                                                                                                                                                                      |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bid    | `Auction::bid_action_spend(ctx, bid, grace)` | Before the end time, or within the grace period of the previous spend  | Checks the bid is strictly higher than the winning bid and accepted by the bid verifier, refunds the previous bidder, and sets the reserve amount to the new bid's reserve amount |
| End    | `Auction::end_action_spend(ctx, &nft)`       | After the end time, and at least the grace period after the last spend | Pays out the winning bid from the reserve, recreates the reserve empty, marks the auction ended and authorizes the NFT to be unlocked                                             |
| Cancel | `Auction::cancel_action_spend(ctx, &nft)`    | Before the first bid, at any time                                      | Authorized by a message from the payout puzzle. Marks the auction ended and sends the NFT back to the payout puzzle hash                                                          |

You pass action spends to `Auction::spend(ctx, action_spends, other_cat_spends)`, which spends the
singleton, the reserve, and the settlement coin that pays the NFT royalty (if there is one), and
returns the child auction. Several actions can run in one spend, for example several bids, each
outbidding the last.

An ended (or cancelled) auction can't be bid on, ended or cancelled again. Each of those fails on chain.

### Bids

An `AuctionBid` is an amount and the bidder's puzzle hash. That puzzle hash gets the NFT if the bid
wins, or a full refund if someone outbids it.

A bidder must lock up more than the bid. `AuctionInfo::reserve_amount_for_bid(amount)` is the bid plus
the **buyer's premium** plus the **NFT royalty** (both in basis points of the bid, rounded down). For
example, with a 3% premium and a 5% royalty, a bid of 200 locks up 200 + 6 + 10 = 216 mojos. If the bid
is outbid, all 216 are refunded.

To fund a bid, the bidder spends coins worth the reserve amount in the same spend bundle, and asserts
`Auction::bid_announcement_id(bid)`. The auction coin creates that coin announcement for each bid it
accepts, so the funds can only be used for that exact bid. Coins that don't create change leave
their value for the reserve. For CAT reserves, pass the bidder's CAT spends as `other_cat_spends`,
and `Auction::spend` spends them in the same CAT ring as the reserve. For XCH reserves,
`other_cat_spends` must be empty (otherwise `DriverError::UnexpectedAuctionCatSpends`).

### Bid verifiers

Besides being strictly higher than the current winning bid, each bid has to pass the auction's
`AuctionBidVerifier`:

| Variant                                      | Rule                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Flat { minimum_bid, bid_increment }`        | The first bid is at least `minimum_bid`, and each later bid is at least `bid_increment` higher                    |
| `Percent { minimum_bid, bid_increment_bps }` | The first bid is at least `minimum_bid`, and each later bid is at least `bid_increment_bps` higher (rounded down) |

Both values are `NonZeroU64`. The verifier is a small curried puzzle (`AuctionFlatBidVerifierArgs` or
`AuctionPercentBidVerifierArgs`) that is curried into the bid action.

### Timing

`AuctionTimings { end_time, grace_period }` sets when bidding closes:

- Before `end_time` (a Unix timestamp in seconds), bids are placed with `grace: false`.
- If `grace_period` is nonzero, a bid can still be placed after `end_time` with `grace: true`, as long
  as it's within `grace_period` seconds of the previous spend of the auction. Every bid restarts the
  window, which stops someone from sniping at the last second.
- The auction can be ended once `end_time` has passed and (with a grace period) `grace_period` seconds
  have passed since the last spend.

### Ending and payouts

When the auction ends with a winning bid of `amount`, the reserve pays:

| Recipient                         | Amount                                |
| --------------------------------- | ------------------------------------- |
| `buyers_premium.puzzle_hash`      | `amount * buyers_premium.bps / 10000` |
| `commission.puzzle_hash`          | `amount * commission.bps / 10000`     |
| `payout_puzzle_hash` (the seller) | `amount` minus the commission         |
| The NFT's royalty puzzle hash     | `amount * royalty_bps / 10000`        |

Zero payments are skipped. The royalty goes through a settlement payments coin, with the NFT's
launcher id as the nonce of the notarized payment, the same way an [offer](/sdk/offers) pays NFT
royalties. `Auction::spend` creates and spends that settlement coin for you. `calculate_auction_payment`
does the same rounded-down math as the puzzles.

The end and cancel actions also authorize the NFT to be unlocked. In the same spend bundle, call
`Auction::unlock_nft(ctx, &nft)` on the auction _before_ it's ended. It runs the **NFT unlocker**
puzzle (`AuctionNftUnlockerArgs`) to get the NFT's output conditions and spends the locked NFT
through the lock. The NFT goes to the winning bidder's puzzle hash, or back to the payout puzzle hash if
there were no bids. Its DID owner is cleared and, if there's a royalty, the transfer declares the
winning bid (paid through the settlement payments puzzle) as the trade price. `unlock_nft` returns the new NFT.

### Cancelling

Before the first bid, the seller can cancel the auction. Cancelling must be authorized by a coin with
the auction's payout puzzle hash, which outputs `Auction::cancel_authorization(ctx)` in the same
spend bundle. That is a `SEND_MESSAGE` of `AUCTION_CANCEL_MESSAGE` with mode
`AUCTION_CANCEL_MESSAGE_MODE`, which commits to the sender's puzzle hash and to this exact auction coin,
so an authorization can't be replayed later. Cancelling has no timing restrictions. It leaves the
auction in the same state as ending it with no bids.

## Settings

`AuctionSettings` is fixed when the auction is launched:

| Field          | Type                 | Description                                                                                                                                                                                     |
| -------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bid_verifier` | `AuctionBidVerifier` | Minimum bid and increment                                                                                                                                                                       |
| `timings`      | `AuctionTimings`     | End time and grace period                                                                                                                                                                       |
| `payments`     | `AuctionPayments`    | `buyers_premium` and `commission` (each an `AuctionBpsPayment { bps, puzzle_hash }`) and `payout_puzzle_hash`, which gets the proceeds (or the NFT if there are no bids) and authorizes cancels |

The NFT's royalty (`RoyaltyInfo`: launcher id, royalty puzzle hash and basis points) is taken from the
NFT itself and curried into the auction too.

The SDK rejects settings that the puzzles can't protect against, both when launching and when parsing:

- Any of the premium, commission or royalty above `AUCTION_MAX_BPS` (10,000, or 100%):
  `DriverError::AuctionBpsTooHigh`.
- Two paid recipients with the same puzzle hash (they could create identical coins, which would make
  the auction impossible to end): `DriverError::DuplicateAuctionPaymentPuzzleHash`. A fee with 0 bps
  isn't paid, so its puzzle hash doesn't count.
- A paid recipient that's the settlement payments puzzle hash or the auction's lock:
  `DriverError::ReservedAuctionPaymentPuzzleHash`.

## Types

| Type                                                                                                                                                               | Crate path       | Description                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Auction`                                                                                                                                                          | `driver`         | `Singleton<AuctionInfo>`: the auction coin, its lineage proof and info                                                      |
| `AuctionInfo`                                                                                                                                                      | `driver`         | Launcher id, settings, locked NFT coin id, NFT royalty, state and reserve. Computes action hashes and the inner puzzle hash |
| `AuctionSettings`, `AuctionBidVerifier`                                                                                                                            | `driver`         | The seller's settings                                                                                                       |
| `AuctionReserve`                                                                                                                                                   | `driver`         | `Xch(Coin)` or `Cat(Cat)`                                                                                                   |
| `AuctionChildState`                                                                                                                                                | `driver`         | Result of `Auction::child_state`: the next state, the reserve's conditions and the royalty amount                           |
| `AuctionMemo`, `AuctionReserveMemo`                                                                                                                                | `driver`         | Stored in the launcher solution so wallets can find the auction                                                             |
| `AuctionLaunch`                                                                                                                                                    | `driver`         | A parsed launcher spend, before it's checked against the NFT                                                                |
| `auction_lock_p2_puzzle_hash`, `spend_auction_lock`                                                                                                                | `driver`         | The lock that holds the NFT and reserve                                                                                     |
| `AUCTION_SINGLETON_AMOUNT`, `AUCTION_MAX_BPS`, `calculate_auction_payment`                                                                                         | `driver`         | Constants and fee math                                                                                                      |
| `AuctionBid`, `AuctionState`, `AuctionTimings`, `AuctionPayments`, `AuctionBpsPayment`                                                                             | `types::puzzles` | CLVM types used by the puzzles                                                                                              |
| `AuctionBidActionArgs`, `AuctionEndActionArgs`, `AuctionCancelActionArgs`, `AuctionNftUnlockerArgs`, `AuctionFlatBidVerifierArgs`, `AuctionPercentBidVerifierArgs` | `types::puzzles` | Curried arguments of the puzzles. You rarely need them directly, since `AuctionInfo` builds them                            |

## Example: launch, bid and settle

This example (adapted from the SDK's auction tests) mints an NFT, locks it and launches an XCH auction
for it in a single transaction. Then two bidders bid, and the auction is ended and settled.

To launch:

1. Pick the auction's launcher, so you know its id and the lock puzzle hash.
2. Send the NFT to `auction_lock_p2_puzzle_hash(launcher_id)`.
3. Create an empty reserve coin with the lock puzzle hash (for a CAT reserve, an empty CAT coin whose
   inner puzzle hash is the lock).
4. Call `Launcher::launch_auction(ctx, settings, reserve, &locked_nft)`. The launcher must have a
   singleton amount of `AUCTION_SINGLETON_AMOUNT` (1), since the reserve finalizer always recreates the
   singleton with an amount of 1.

```rust unreleased
use std::num::NonZeroU64;

use chia_wallet_sdk::driver::{
    AuctionBidVerifier, AuctionLaunch, AuctionReserve, AuctionSettings, RoyaltyInfo,
    auction_lock_p2_puzzle_hash,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::types::puzzles::{AuctionBid, AuctionBpsPayment, AuctionPayments, AuctionTimings};

const PREMIUM_PUZZLE_HASH: Bytes32 = Bytes32::new([1; 32]);
const COMMISSION_PUZZLE_HASH: Bytes32 = Bytes32::new([2; 32]);
const ROYALTY_PUZZLE_HASH: Bytes32 = Bytes32::new([3; 32]);
const END_TIME: u64 = 1_000;

#[test]
fn auction_launch_bid_and_settle() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let seller = sim.bls(2);
    let seller_p2 = StandardLayer::new(seller.pk);

    // Mint an NFT with a 5% royalty. Its launcher has an amount of 0, so it doesn't collide with
    // the auction's launcher (amount 1) created by the same coin.
    let mut mint = NftMint::new(HashedPtr::NIL, seller.puzzle_hash, 500, None);
    mint.royalty_puzzle_hash = ROYALTY_PUZZLE_HASH;
    let (mint_nft, nft) = Launcher::new(seller.coin.coin_id(), 0)
        .with_singleton_amount(1)
        .mint_nft(ctx, &mint)?;

    // Lock the NFT with the auction's launcher id.
    let launcher = Launcher::new(seller.coin.coin_id(), 1);
    let lock_puzzle_hash = auction_lock_p2_puzzle_hash(launcher.coin().coin_id());
    let locked_nft = nft.spend_with(
        ctx,
        &seller_p2,
        Conditions::new().create_coin(lock_puzzle_hash, nft.coin.amount, Memos::None),
    )?;

    // The reserve starts as an empty coin locked by the auction.
    let reserve = AuctionReserve::Xch(Coin::new(seller.coin.coin_id(), lock_puzzle_hash, 0));

    // A 100 mojo minimum bid and increment, a 3% buyer's premium and a 1% commission.
    let settings = AuctionSettings::new(
        AuctionBidVerifier::Flat {
            minimum_bid: NonZeroU64::new(100).unwrap(),
            bid_increment: NonZeroU64::new(100).unwrap(),
        },
        AuctionTimings::new(END_TIME, 0),
        AuctionPayments::new(
            AuctionBpsPayment::new(300, PREMIUM_PUZZLE_HASH),
            AuctionBpsPayment::new(100, COMMISSION_PUZZLE_HASH),
            seller.puzzle_hash,
        ),
    );

    let (launch_auction, mut auction) =
        launcher.launch_auction(ctx, settings, reserve, &locked_nft)?;

    seller_p2.spend(
        ctx,
        seller.coin,
        mint_nft
            .create_coin(lock_puzzle_hash, 0, Memos::None)
            .extend(launch_auction),
    )?;
    sim.spend_coins(ctx.take(), &[seller.sk])?;

    // Anyone can find the auction from its launcher spend. The royalty isn't in the memo, so it
    // comes from the locked NFT (which a wallet would look up by `launch.nft_coin_id()`).
    let launcher_spend = sim.coin_spend(auction.info.launcher_id).unwrap();
    let solution = ctx.alloc(&launcher_spend.solution)?;
    let launch = AuctionLaunch::parse(ctx, launcher_spend.coin, solution).unwrap();
    assert_eq!(launch.nft_coin_id(), locked_nft.coin.coin_id());
    let royalty = RoyaltyInfo::new(
        locked_nft.info.launcher_id,
        locked_nft.info.royalty_puzzle_hash,
        locked_nft.info.royalty_basis_points,
    );
    assert_eq!(launch.into_auction(royalty, None)?, auction);

    // Each bidder funds the reserve with a coin worth exactly the reserve amount for their bid,
    // and asserts the bid's announcement so the funds can't be used for anything else.
    let mut bidders = Vec::new();

    for amount in [100, 200] {
        let reserve_amount = auction.info.reserve_amount_for_bid(amount).unwrap();
        let bidder = sim.bls(reserve_amount);
        let bid = AuctionBid::new(amount, bidder.puzzle_hash);

        let bid_action = auction.bid_action_spend(ctx, bid, false)?;
        StandardLayer::new(bidder.pk).spend(
            ctx,
            bidder.coin,
            Conditions::new().assert_coin_announcement(auction.bid_announcement_id(bid)),
        )?;

        let previous = auction;
        auction = auction.spend(ctx, vec![bid_action], vec![])?;
        sim.spend_coins(ctx.take(), &[bidder.sk.clone()])?;

        // Wallets follow the auction by parsing each spend of it.
        let auction_spend = sim.coin_spend(previous.coin.coin_id()).unwrap();
        let solution = ctx.alloc(&auction_spend.solution)?;
        assert_eq!(previous.parse_child(ctx, solution)?, auction);

        bidders.push((bidder, previous.info.reserve, reserve_amount));
    }

    // The bid of 200 locks up 200 + 6 (premium) + 10 (royalty).
    assert_eq!(auction.info.state.reserve_amount, 216);

    // The first bidder was refunded in full by the reserve they were outbid from.
    let (first, _, first_reserve_amount) = &bidders[0];
    let (_, outbid_reserve, _) = bidders[1];
    let refund = Coin::new(
        outbid_reserve.coin().coin_id(),
        first.puzzle_hash,
        *first_reserve_amount,
    );
    assert!(sim.coin_state(refund.coin_id()).is_some());

    // After the end time, anyone can end the auction. No signatures are needed.
    sim.set_next_timestamp(END_TIME)?;
    let final_reserve = auction.info.reserve.coin();

    let end_action = auction.end_action_spend(ctx, &locked_nft)?;
    let won_nft = auction.unlock_nft(ctx, &locked_nft)?;
    let auction = auction.spend(ctx, vec![end_action], vec![])?;
    sim.spend_coins(ctx.take(), &[])?;

    assert!(auction.info.state.ended);
    assert_eq!(won_nft.info.p2_puzzle_hash, bidders[1].0.puzzle_hash);
    assert!(sim.coin_state(won_nft.coin.coin_id()).is_some());

    // The reserve paid the premium, the commission and the seller.
    for (puzzle_hash, amount) in [
        (PREMIUM_PUZZLE_HASH, 6),
        (COMMISSION_PUZZLE_HASH, 2),
        (seller.puzzle_hash, 198),
    ] {
        let coin = Coin::new(final_reserve.coin_id(), puzzle_hash, amount);
        assert!(sim.coin_state(coin.coin_id()).is_some());
    }

    // The royalty was paid through a settlement coin.
    let settlement = Coin::new(final_reserve.coin_id(), SETTLEMENT_PAYMENT_HASH.into(), 10);
    let royalty_coin = Coin::new(settlement.coin_id(), ROYALTY_PUZZLE_HASH, 10);
    assert!(sim.coin_state(royalty_coin.coin_id()).is_some());

    // The reserve is recreated empty.
    assert_eq!(auction.info.reserve.coin().amount, 0);

    Ok(())
}
```

## Example: cancelling before the first bid

The seller authorizes a cancel by spending a coin with the payout puzzle hash (any coin, even an empty
one) that outputs `cancel_authorization`. The NFT goes back to the payout puzzle hash.

```rust unreleased
use std::num::NonZeroU64;

use chia_wallet_sdk::driver::{
    AuctionBidVerifier, AuctionReserve, AuctionSettings, auction_lock_p2_puzzle_hash,
};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::{AuctionBpsPayment, AuctionPayments, AuctionTimings};

#[test]
fn auction_cancel() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let seller = sim.bls(2);
    let seller_p2 = StandardLayer::new(seller.pk);

    // Mint, lock and launch, as in the previous example (with no fees and no royalty).
    let mint = NftMint::new(HashedPtr::NIL, seller.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(seller.coin.coin_id(), 0)
        .with_singleton_amount(1)
        .mint_nft(ctx, &mint)?;

    let launcher = Launcher::new(seller.coin.coin_id(), 1);
    let lock_puzzle_hash = auction_lock_p2_puzzle_hash(launcher.coin().coin_id());
    let locked_nft = nft.spend_with(
        ctx,
        &seller_p2,
        Conditions::new().create_coin(lock_puzzle_hash, 1, Memos::None),
    )?;

    let settings = AuctionSettings::new(
        AuctionBidVerifier::Flat {
            minimum_bid: NonZeroU64::new(1_000).unwrap(),
            bid_increment: NonZeroU64::new(100).unwrap(),
        },
        AuctionTimings::new(1_000_000, 300),
        AuctionPayments::new(
            AuctionBpsPayment::new(0, Bytes32::default()),
            AuctionBpsPayment::new(0, Bytes32::default()),
            seller.puzzle_hash,
        ),
    );
    let reserve = AuctionReserve::Xch(Coin::new(seller.coin.coin_id(), lock_puzzle_hash, 0));
    let (launch_auction, auction) = launcher.launch_auction(ctx, settings, reserve, &locked_nft)?;

    seller_p2.spend(
        ctx,
        seller.coin,
        mint_nft
            .create_coin(lock_puzzle_hash, 0, Memos::None)
            .extend(launch_auction),
    )?;
    sim.spend_coins(ctx.take(), &[seller.sk.clone()])?;

    // A coin with the payout puzzle hash authorizes the cancel of this auction coin.
    let authorizer = sim.new_coin(seller.puzzle_hash, 0);
    let authorization = auction.cancel_authorization(ctx)?;
    seller_p2.spend(ctx, authorizer, authorization)?;

    let cancel_action = auction.cancel_action_spend(ctx, &locked_nft)?;
    let returned_nft = auction.unlock_nft(ctx, &locked_nft)?;
    let auction = auction.spend(ctx, vec![cancel_action], vec![])?;
    sim.spend_coins(ctx.take(), &[seller.sk])?;

    assert!(auction.info.state.ended);
    assert_eq!(returned_nft.info.p2_puzzle_hash, seller.puzzle_hash);
    assert!(sim.coin_state(returned_nft.coin.coin_id()).is_some());

    Ok(())
}
```

## Finding and following auctions

The launcher solution's key value list is an `AuctionMemo`: a version (0), the settings, the coin id
of the locked NFT and an `AuctionReserveMemo` (the reserve's parent coin id, plus the asset id and
hidden puzzle hash for CAT reserves). To reconstruct an auction from chain data:

1. `AuctionLaunch::parse(allocator, launcher_coin, launcher_solution)` returns `None` if the coin isn't a
   launcher or the solution doesn't hold an auction memo.
2. Look up the NFT at `launch.nft_coin_id()` and build its `RoyaltyInfo`. The royalty is curried into
   the auction but isn't in the memo.
3. For a CAT reserve, parse the spend of the reserve's parent (`launch.reserve_parent_coin_info()`)
   with `Cat::parse_children` to get the reserve's lineage proof. The memo doesn't store it, since it
   couldn't be trusted.
4. `launch.into_auction(royalty, reserve_lineage_proof)` validates the settings and checks that they
   (and the royalty) produce the singleton puzzle hash that was launched. It fails with
   `DriverError::AuctionPuzzleHashMismatch` if not, or `InvalidAuctionSingletonAmount` if the singleton
   amount isn't 1.

After that, call `auction.parse_child(ctx, solution)` with the solution of each confirmed spend of the
auction coin to get the next auction. It runs the revealed action puzzles to compute the new state,
so only use it on solutions from confirmed spends.

`Auction::child_state(ctx, &action_spends)` runs actions without spending anything, the same way the
action layer and reserve finalizer will on chain. You can use it to check a bid before submitting it,
or to see the reserve's conditions and royalty amount.

## Relation to the action layer

The auction is an [action layer](/sdk/primitives/action-layer) singleton, but it has its own small
driver instead of the registry-style `new_action` / `pending_spend` / `finish_spend` flow. You build
action spends with `Auction`'s methods and pass them all to `Auction::spend`, which builds the
`ActionLayer` spend (with merkle proofs for each action), the `Finalizer::Reserve` solution and the
reserve spend. The pieces it uses are the action layer's `ActionLayer`, `Finalizer::Reserve` with the
default reserve-amount-from-state program, and reserve conditions. Unlike the reward distributor's
`Reserve`, the auction's reserve can be XCH, and it's locked with a MIPS singleton member instead of
`P2DelegatedBySingletonLayer`.

## Gotchas

- **Lock the NFT before launching.** `launch_auction` fails with `DriverError::AuctionNftNotLocked`
  unless the NFT's p2 puzzle hash is the auction's lock, and with `InvalidAuctionReserve` unless the
  reserve is an empty coin locked by the auction. The auction can't check this on chain, so before
  bidding, wallets must check that the locked NFT is unspent and locked by the auction.
- **Any matching coin can be the reserve.** The reserve finalizer takes the reserve's parent from the
  singleton's solution, so any coin with the reserve's puzzle hash and amount works. While the reserve
  amount is 0, anyone can create an empty coin with the lock puzzle hash and spend it as the reserve
  (useful if the original reserve was never created). This is why `parse_child` follows the reserve
  that was actually spent rather than the one you were tracking.
- **Unlock in the same spend bundle.** The end and cancel actions only authorize the NFT's unlock.
  Call `unlock_nft` on the auction _before_ calling `spend` with the end or cancel action, and include
  both in the same transaction.
- **Fund bids exactly.** The bidder's coins must provide `reserve_amount_for_bid(amount)`, and should
  assert `bid_announcement_id(bid)` so the funds can't be redirected to a different bid.
- The singleton amount is always 1 (`AUCTION_SINGLETON_AMOUNT`). Launchers with other singleton
  amounts are rejected.
- A bid's puzzle hash gets both the refund and the NFT. A bid refund sent to the settlement payments
  puzzle hash is treated as a normal refund, not as the royalty.
