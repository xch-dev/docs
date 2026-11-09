---
title: NFT Fusion
---

# NFT Fusion

A fusion is a singleton that swaps one set of NFTs for another, in either direction, without a trusted
party. It implements [CHIP-0021 (NFT Fusion Puzzle)](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0021.md).
A project deploys a fusion listing the NFTs on each side and locks one side in it. Anyone who holds every
NFT on the other side can then make an [offer](/sdk/offers) of them for the locked ones, and anyone can
take that offer against the fusion. The swap can be reversed the same way, any number of times. Use it to
combine several NFTs into one, divide one into several, or upgrade an NFT to a new version while keeping
the original recoverable.

## Concepts

- **Sides.** A fusion has two fixed lists of NFT launcher IDs, side A and side B, curried into its puzzle.
  By convention side A is the fused or upgraded NFTs and side B is the components or originals. Each side
  needs at least one NFT, and no NFT can be listed twice. An upgrade is one NFT on each side.
- **Locking.** The NFTs on one side are held by the fusion's p2 puzzle (`P2FusionLayer`), which only
  releases an NFT when the fusion singleton is spent in the same block and announces that release.
  Normally the project locks side A after launching the fusion.
- **Fuse and defuse.** `FusionDirection::Fuse` locks side B and unlocks side A.
  `FusionDirection::Defuse` locks side A and unlocks side B. The whole of both sides always moves
  together.
- **Swaps via offers.** The NFTs being locked come from the settlement puzzle, so a regular NFT-for-NFT
  offer made by any wallet works. The fusion singleton pays the requested NFTs to the maker. No signature
  is needed to spend the singleton or the locked NFTs.
- **No minting.** The fusion doesn't create NFTs. Every NFT on both sides must already exist, so a
  project mints the fused NFTs first, typically with its DID, following
  [CHIP-0015](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0015.md) metadata to describe the
  relationship.

Only NFTs with an amount of 1 and the default metadata updater can be used. The driver rejects others with
`DriverError::UnsupportedFusionNft`, since the puzzle couldn't release them.

## Types

All of these are behind the `chip-0021` feature.

| Item                                                                                                                         | Path                              | Purpose                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Fusion` (`Singleton<FusionLayer>`)                                                                                          | `chia_wallet_sdk::driver`         | The fusion singleton: lock NFTs, take offers, swap, parse                                              |
| `FusionLayer`                                                                                                                | `chia_wallet_sdk::driver`         | The singleton's inner puzzle: launcher ID and both sides. `p2_puzzle_hash()` is where locked NFTs live |
| `P2FusionLayer`                                                                                                              | `chia_wallet_sdk::driver`         | The p2 puzzle of locked NFTs, curried with the fusion's launcher ID                                    |
| `FusionDirection`, `FusionUnlock`, `FusionSwap`                                                                              | `chia_wallet_sdk::driver`         | A swap's direction, a locked NFT and where to send it, and the result of a swap                        |
| `Launcher::for_fusion`, `Launcher::launch_fusion`                                                                            | `chia_wallet_sdk::driver`         | Deploying a fusion                                                                                     |
| `FUSION_SINGLETON_AMOUNT`                                                                                                    | `chia_wallet_sdk::driver`         | The singleton's amount (1 mojo)                                                                        |
| `FusionSingletonArgs`, `FusionSingletonSolution`, `P2FusionArgs`, `P2FusionSolution`, `FusionNftToLock`, `FusionNftToUnlock` | `chia_wallet_sdk::types::puzzles` | Curried arguments and solutions of the two puzzles                                                     |
| `FUSION_HINT`                                                                                                                | `chia_wallet_sdk::types::puzzles` | `sha256("CHIP-0021")`, the hint on a fusion's launcher and on each singleton coin after the eve coin   |
| `FUSION_SINGLETON_PUZZLE(_HASH)`, `P2_FUSION_PUZZLE(_HASH)`                                                                  | `chia_wallet_sdk::types::puzzles` | The compiled puzzles, as deployed on mainnet                                                           |

## Launching and locking

`Launcher::for_fusion(ctx, parent_coin_id)` creates a 1 mojo launcher hinted with `FUSION_HINT`, so the
fusion can be found on chain. `launch_fusion(ctx, side_a, side_b)` returns the conditions for the parent
coin and the eve `Fusion`. It stores the sides in the launcher solution's key value list, as the mainnet
deployments do, so `Fusion::parse_launcher` can recover the fusion later.

`fusion.lock_nft(ctx, nft, &p2, extra_conditions)` spends an NFT you own (with any inner layer that
implements `SpendWithConditions`) to the fusion's p2 puzzle and returns the locked NFT. It also removes
any assigned owner (DID), because an offer can't request an NFT that has one. Use
`lock_nft_conditions` if you need the conditions for a custom spend.

## Fusing and defusing

`fusion.take_offer(ctx, &offer, &locked_nfts)` checks that the offer offers exactly one side and requests
exactly the other, works out the direction, and adds the spends of the fusion singleton, the offered
NFTs (into the fusion's p2 puzzle) and the locked NFTs (to the maker) to the `SpendContext`. Pass those
spends to `Offer::take` to get the final spend bundle. The returned `FusionSwap` has the next `fusion`
coin, the NFTs now `locked`, and the NFTs `unlocked` for the maker, ready for the next swap.

This example has a project lock one NFT on side A, then a user fuses two NFTs into it and defuses it back:

```rust unreleased
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::chia::puzzle_types::offer::{NotarizedPayment, Payment};
use chia_wallet_sdk::driver::{Fusion, FusionDirection};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::test::sign_transaction;

fn mint_nfts(
    sim: &mut Simulator,
    ctx: &mut SpendContext,
    owner: &BlsPairWithCoin,
    count: u64,
) -> anyhow::Result<Vec<Nft>> {
    let p2 = StandardLayer::new(owner.pk);
    let mut nfts = Vec::new();

    for edition_number in 1..=count {
        let coin = sim.new_coin(owner.puzzle_hash, 1);
        let metadata = ctx.alloc_hashed(&NftMetadata {
            edition_number,
            ..Default::default()
        })?;
        let mint = NftMint::new(metadata, owner.puzzle_hash, 0, None);
        let (mint_nft, nft) = Launcher::new(coin.coin_id(), 1).mint_nft(ctx, &mint)?;
        p2.spend(ctx, coin, mint_nft)?;
        nfts.push(nft);
    }

    sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk))?;
    Ok(nfts)
}

/// An ordinary offer of some NFTs for others, as any wallet would make it.
fn make_offer(
    ctx: &mut SpendContext,
    maker: &BlsPairWithCoin,
    offered: &[Nft],
    requested: &[Nft],
) -> anyhow::Result<Offer> {
    let nonce = Offer::nonce(offered.iter().map(|nft| nft.coin.coin_id()).collect());

    let mut requested_payments = RequestedPayments::new();
    let mut asset_info = AssetInfo::new();

    for nft in requested {
        let memos = ctx.hint(maker.puzzle_hash)?;
        requested_payments.nfts.insert(
            nft.info.launcher_id,
            vec![NotarizedPayment::new(
                nonce,
                vec![Payment::new(maker.puzzle_hash, 1, memos)],
            )],
        );
        asset_info.insert_nft(
            nft.info.launcher_id,
            NftAssetInfo::new(
                nft.info.metadata,
                nft.info.metadata_updater_puzzle_hash,
                nft.info.royalty_puzzle_hash,
                nft.info.royalty_basis_points,
            ),
        )?;
    }

    let assertions = requested_payments.assertions(ctx, &asset_info)?;
    let p2 = StandardLayer::new(maker.pk);

    for nft in offered {
        let _ = nft.lock_settlement(ctx, &p2, Vec::new(), Conditions::new().extend(assertions.clone()))?;
    }

    let coin_spends = ctx.take();
    let signature = sign_transaction(&coin_spends, std::slice::from_ref(&maker.sk))?;

    Ok(Offer::from_input_spend_bundle(
        ctx,
        SpendBundle::new(coin_spends, signature),
        requested_payments,
        asset_info,
    )?)
}

#[test]
fn fuse_and_defuse() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let project = sim.bls(0);
    let user = sim.bls(0);

    // Side A is one fused NFT held by the project. Side B is two components held by the user.
    let side_a = mint_nfts(&mut sim, ctx, &project, 1)?;
    let side_b = mint_nfts(&mut sim, ctx, &user, 2)?;
    let launcher_ids = |nfts: &[Nft]| nfts.iter().map(|nft| nft.info.launcher_id).collect();

    // Launch the fusion and lock side A in it.
    let project_p2 = StandardLayer::new(project.pk);
    let parent = sim.new_coin(project.puzzle_hash, 1);
    let (launch, fusion) = Launcher::for_fusion(ctx, parent.coin_id())?.launch_fusion(
        ctx,
        launcher_ids(&side_a),
        launcher_ids(&side_b),
    )?;
    project_p2.spend(ctx, parent, launch)?;

    let locked: Vec<Nft> = side_a
        .into_iter()
        .map(|nft| fusion.lock_nft(ctx, nft, &project_p2, Conditions::new()))
        .collect::<Result<_, _>>()?;

    sim.spend_coins(ctx.take(), std::slice::from_ref(&project.sk))?;

    let fusion_p2_puzzle_hash = fusion.info.p2_puzzle_hash();
    assert_eq!(locked[0].info.p2_puzzle_hash, fusion_p2_puzzle_hash);

    // Fuse: the user offers side B and requests side A. Anyone can take the offer.
    let offer = make_offer(ctx, &user, &side_b, &locked)?;
    let fused = fusion.take_offer(ctx, &offer, &locked)?;
    let spend_bundle = offer.take(SpendBundle::new(ctx.take(), Signature::default()));
    sim.new_transaction(spend_bundle)?;

    assert_eq!(fused.unlocked[0].info.p2_puzzle_hash, user.puzzle_hash);
    assert_eq!(fused.locked.len(), 2);
    for nft in fused.unlocked.iter().chain(&fused.locked) {
        assert!(sim.coin_state(nft.coin.coin_id()).is_some());
    }

    // Defuse: the user offers side A back and requests side B, using the next fusion coin.
    let offer = make_offer(ctx, &user, &fused.unlocked, &fused.locked)?;
    let defused = fused.fusion.take_offer(ctx, &offer, &fused.locked)?;
    let spend_bundle = offer.take(SpendBundle::new(ctx.take(), Signature::default()));
    sim.new_transaction(spend_bundle)?;

    assert_eq!(defused.locked[0].info.p2_puzzle_hash, fusion_p2_puzzle_hash);
    for nft in &defused.unlocked {
        assert_eq!(nft.info.p2_puzzle_hash, user.puzzle_hash);
        assert!(sim.coin_state(nft.coin.coin_id()).is_some());
    }

    Ok(())
}
```

Swaps don't pay NFT royalties, since no fungible asset changes hands. If the taker wants to pay a fee,
add a spend of another coin with `reserve_fee` to the bundle passed to `Offer::take`.

Offers from other people should be parsed with `Offer::from_spend_bundle`, as on the
[Offers](/sdk/offers) page. `take_offer` rejects (`DriverError::FusionOfferMismatch`) an offer that offers or
requests anything besides the two sides, offers NFTs with an assigned owner, or requests payments the
fusion can't make (more than one payment per NFT, an amount other than 1, or a hint other than the
recipient's puzzle hash).

## Swapping without an offer

`fusion.swap(ctx, direction, &offered, &unlocks, nonce)` is the lower-level operation `take_offer` is
built on. `offered` are the NFTs being locked, which must already be in the settlement puzzle, and
`unlocks` are `FusionUnlock::new(locked_nft, recipient_puzzle_hash)` pairs. Both can be in any order. The
driver sorts them into the curried order, which the puzzle requires.

You need this for a locked NFT that has an assigned owner (locked with `nft.transfer` rather than
`lock_nft`), since the puzzle commits to that owner and an offer can't request it. The spend that moves an
offered NFT into the settlement puzzle must assert the payment it expects in return, as offers do.
Otherwise anyone who sees that spend can pay the NFT to themselves, because settlement coins can be spent
by anyone:

```rust unreleased
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::chia::puzzle_types::offer::{NotarizedPayment, Payment};
use chia_wallet_sdk::driver::{FusionDirection, FusionUnlock};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::types::{payment_assertion, tree_hash_notarized_payment};

fn mint_nft(sim: &mut Simulator, ctx: &mut SpendContext, owner: &BlsPairWithCoin) -> anyhow::Result<Nft> {
    let coin = sim.new_coin(owner.puzzle_hash, 1);
    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, owner.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    StandardLayer::new(owner.pk).spend(ctx, coin, mint_nft)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk))?;
    Ok(nft)
}

#[test]
fn direct_swap() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let project = sim.bls(0);
    let user = sim.bls(0);
    let upgraded = mint_nft(&mut sim, ctx, &project)?;
    let original = mint_nft(&mut sim, ctx, &user)?;

    // An upgrade: one NFT on each side. The project locks the upgraded NFT (side A).
    let project_p2 = StandardLayer::new(project.pk);
    let parent = sim.new_coin(project.puzzle_hash, 1);
    let (launch, fusion) = Launcher::for_fusion(ctx, parent.coin_id())?.launch_fusion(
        ctx,
        vec![upgraded.info.launcher_id],
        vec![original.info.launcher_id],
    )?;
    project_p2.spend(ctx, parent, launch)?;
    let locked = fusion.lock_nft(ctx, upgraded, &project_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&project.sk))?;

    // The payment the user expects: the locked NFT, in the settlement puzzle, paid to them.
    let nonce = Bytes32::new([42; 32]);
    let memos = ctx.hint(user.puzzle_hash)?;
    let payment = NotarizedPayment::new(nonce, vec![Payment::new(user.puzzle_hash, 1, memos)]);
    let settlement_nft = NftInfo {
        p2_puzzle_hash: SETTLEMENT_PAYMENT_HASH.into(),
        ..locked.info
    };
    let assertion = payment_assertion(
        settlement_nft.puzzle_hash().into(),
        tree_hash_notarized_payment(ctx, &payment),
    );

    // Move side B into the settlement puzzle, asserting the payment, then swap.
    let settled = original.lock_settlement(
        ctx,
        &StandardLayer::new(user.pk),
        Vec::new(),
        Conditions::new().with(assertion),
    )?;
    let swap = fusion.swap(
        ctx,
        FusionDirection::Fuse,
        &[settled],
        &[FusionUnlock::new(locked, user.puzzle_hash)],
        nonce,
    )?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&user.sk))?;

    assert_eq!(swap.unlocked[0].info.launcher_id, upgraded.info.launcher_id);
    assert_eq!(swap.unlocked[0].info.p2_puzzle_hash, user.puzzle_hash);
    assert_eq!(swap.locked[0].info.p2_puzzle_hash, fusion.info.p2_puzzle_hash());

    Ok(())
}
```

`swap` validates everything before adding spends to the context: the NFTs must match the sides
(`FusionNftMismatch`), offered NFTs must be in the settlement puzzle, unlocked NFTs must be locked by
this fusion, and a recipient can't be the fusion's p2 puzzle or the settlement puzzle
(`InvalidFusionTarget`), since the NFT would stay locked or be left for anyone to take.

## Finding and tracking a fusion

The launcher coin and every fusion coin after the eve coin are hinted with `FUSION_HINT`, so a wallet or
indexer can find fusions by that hint.

- `Fusion::parse_launcher(allocator, launcher_coin, launcher_solution)` recovers the eve fusion and its
  sides from the launcher's spend. It returns `Ok(None)` if the coin isn't a launcher or the sides in its
  solution don't match the singleton it created, and an error if a fusion was launched but is invalid
  (an even amount, or sides `FusionLayer::new` rejects). It also accepts the newer reference
  implementation's layout, which puts the sides in a fourth solution item.
- `Fusion::parse_child(allocator, parent_coin, parent_puzzle, parent_solution)` parses the next fusion coin
  from a confirmed fusion spend, along with the `FusionDirection` of that swap, which tells you which side
  is locked now: after `Fuse` side B is locked, after `Defuse` side A is.

```rust unreleased
use chia_wallet_sdk::chia::puzzle_types::nft::NftMetadata;
use chia_wallet_sdk::chia::puzzle_types::offer::{NotarizedPayment, Payment};
use chia_wallet_sdk::driver::{Fusion, FusionDirection, FusionUnlock};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::puzzles::SETTLEMENT_PAYMENT_HASH;
use chia_wallet_sdk::types::puzzles::FUSION_HINT;
use chia_wallet_sdk::types::{payment_assertion, tree_hash_notarized_payment};

fn mint_nft(sim: &mut Simulator, ctx: &mut SpendContext, owner: &BlsPairWithCoin) -> anyhow::Result<Nft> {
    let coin = sim.new_coin(owner.puzzle_hash, 1);
    let metadata = ctx.alloc_hashed(&NftMetadata::default())?;
    let mint = NftMint::new(metadata, owner.puzzle_hash, 0, None);
    let (mint_nft, nft) = Launcher::new(coin.coin_id(), 1).mint_nft(ctx, &mint)?;
    StandardLayer::new(owner.pk).spend(ctx, coin, mint_nft)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk))?;
    Ok(nft)
}

#[test]
fn find_and_track_fusion() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let ctx = &mut SpendContext::new();

    let project = sim.bls(0);
    let user = sim.bls(0);
    let fused = mint_nft(&mut sim, ctx, &project)?;
    let component = mint_nft(&mut sim, ctx, &user)?;

    let project_p2 = StandardLayer::new(project.pk);
    let parent = sim.new_coin(project.puzzle_hash, 1);
    let (launch, fusion) = Launcher::for_fusion(ctx, parent.coin_id())?.launch_fusion(
        ctx,
        vec![fused.info.launcher_id],
        vec![component.info.launcher_id],
    )?;
    project_p2.spend(ctx, parent, launch)?;
    let locked = fusion.lock_nft(ctx, fused, &project_p2, Conditions::new())?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&project.sk))?;

    // Find the launcher by its hint, and recover the fusion from the launcher spend.
    let launcher_id = fusion.info.launcher_id;
    assert_eq!(sim.hinted_coins(FUSION_HINT), [launcher_id]);

    let launcher_spend = sim.coin_spend(launcher_id).expect("launcher spend");
    let solution = ctx.alloc(&launcher_spend.solution)?;
    let parsed = Fusion::parse_launcher(ctx, launcher_spend.coin, solution)?.expect("a fusion");
    assert_eq!(parsed, fusion);
    assert_eq!(parsed.info.side_a(), [fused.info.launcher_id]);

    // Fuse, with the component moved into the settlement puzzle by the user.
    let nonce = Bytes32::new([7; 32]);
    let memos = ctx.hint(user.puzzle_hash)?;
    let payment = NotarizedPayment::new(nonce, vec![Payment::new(user.puzzle_hash, 1, memos)]);
    let settlement_nft = NftInfo {
        p2_puzzle_hash: SETTLEMENT_PAYMENT_HASH.into(),
        ..locked.info
    };
    let assertion = payment_assertion(
        settlement_nft.puzzle_hash().into(),
        tree_hash_notarized_payment(ctx, &payment),
    );
    let settled = component.lock_settlement(
        ctx,
        &StandardLayer::new(user.pk),
        Vec::new(),
        Conditions::new().with(assertion),
    )?;
    let swap = parsed.swap(
        ctx,
        FusionDirection::Fuse,
        &[settled],
        &[FusionUnlock::new(locked, user.puzzle_hash)],
        nonce,
    )?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&user.sk))?;

    // The next fusion coin is hinted too, and its parent spend says which side is locked now.
    assert!(sim.hinted_coins(FUSION_HINT).contains(&swap.fusion.coin.coin_id()));

    let spend = sim.coin_spend(fusion.coin.coin_id()).expect("fusion spend");
    let puzzle = ctx.alloc(&spend.puzzle_reveal)?;
    let puzzle = Puzzle::parse(ctx, puzzle);
    let solution = ctx.alloc(&spend.solution)?;
    let (child, direction) =
        Fusion::parse_child(ctx, spend.coin, puzzle, solution)?.expect("a fusion");

    assert_eq!(child, swap.fusion);
    assert_eq!(direction, FusionDirection::Fuse);

    Ok(())
}
```

To find the locked NFTs themselves, look up coins hinted with `fusion.info.p2_puzzle_hash()`. `lock_nft`
and swaps hint the NFTs they lock with it.

## Gotchas

- **Locking is one-way.** A locked NFT can only leave through a swap. Lock only the NFTs of one side:
  `lock_nft` doesn't check which side is currently locked, and if NFTs from both sides end up locked,
  neither side can be swapped. An NFT that isn't on either side but is sent to the fusion's p2 puzzle is
  stuck forever, so `lock_nft` refuses it, but a plain `nft.transfer` doesn't.
- **There's no admin key.** Once launched, the sides can't change and nothing can be withdrawn except by
  swapping. Double-check the launcher IDs before launching.
- **The fusion must be confirmed before a swap.** The singleton asserts a relative height, so launching
  (or locking) and swapping can't happen in the same block (`EphemeralRelativeCondition`).
- **Swaps use the current coin.** Each swap spends the latest fusion coin, so a swap built from a stale
  `Fusion` fails as a double spend. Track the fusion with `parse_child`, or use the `fusion` returned in
  `FusionSwap`.
- **Cost grows with the number of NFTs.** Both sides are swapped in a single spend, at roughly 120 million
  cost per NFT. Beyond about 40 NFTs in total, a swap exceeds the mempool's cost limit.
- **Owners are removed on lock.** `lock_nft` clears an NFT's assigned DID so it can be requested in
  offers. To keep the owner, transfer the NFT to `p2_puzzle_hash()` yourself and use
  [`swap`](#swapping-without-an-offer) instead of offers.
- **The solution isn't signed.** Anyone can alter the parts of a fusion spend's solution that the puzzle
  ignores, so `parse_child` only reads the direction, the same way the puzzle does. Don't parse a
  confirmed fusion solution as `FusionSingletonSolution` and trust the rest.
