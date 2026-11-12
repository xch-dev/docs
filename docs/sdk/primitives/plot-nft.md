---
title: Plot NFTs
---

# Plot NFTs

A plot NFT (called a pool wallet in the reference wallet) is a [singleton](/sdk/primitives/singletons)
that lets a farmer change where their pool rewards go without replotting. Plots are created for the plot
NFT's **p2 puzzle hash** (the "pool contract address") instead of for a pool, so the 7/8 pool share of
every block reward they win is locked to a puzzle that only the plot NFT can claim from. The plot NFT's
state decides where claimed rewards are paid: to the owner when self pooling, or to a pool. The farmer
can move between pools by spending the plot NFT, and the plots keep working.

The types are behind the `pooling` feature flag, and live in
[`chia_wallet_sdk::driver`](https://docs.rs/chia-wallet-sdk/latest/chia_wallet_sdk/driver/index.html)
(they aren't in the prelude). The curried arguments and solutions of the puzzles, and helpers such as
`pool_reward_parent_id`, are in `chia_wallet_sdk::types::puzzles`. Background on the puzzles is at
[Pooling on chialisp.com](https://chialisp.com/pooling).

## How it works

Plot NFTs use the original singleton top layer (v1.0), not the v1.1 layer that every other singleton in
the SDK uses, so they have their own `SingletonV1Layer`. Inside it is one of two inner puzzles, depending
on the state:

| State           | Inner puzzle | Rewards are paid to      | Moving out                                                          |
| --------------- | ------------ | ------------------------ | ------------------------------------------------------------------- |
| `SelfPooling`   | Waiting room | The owner's target       | The owner signs, once the coin is confirmed (a lock height of 0)    |
| `FarmingToPool` | Pool member  | The pool's target        | The owner signs to move to the waiting room, which is `LeavingPool` |
| `LeavingPool`   | Waiting room | The pool's target, still | The owner signs, once the pool's relative lock height has passed    |

The **target puzzle hash** is where rewards are paid when they're claimed. It's not the p2 puzzle hash,
which is what plots farm to and never changes. A pool can't be left immediately: the farmer first moves to
the waiting room, and only after the pool's **relative lock height** (a number of blocks, between 5 and
1000 for the reference wallet) can they move to self pooling or another pool. Rewards farmed in the
meantime still go to the pool. Self pooling uses the same waiting room puzzle, with the owner's own
target and a lock of 0.

Reward coins are locked by the `P2SingletonOrDelayedLayer` puzzle, which has two paths:

- **Claim**: the plot NFT absorbs a pool reward and pays it to the current target. Anyone can do this,
  without a signature. A coin is only a pool reward if its parent coin id is the one consensus gives
  pool rewards, which is the first half of the genesis challenge followed by the block height.
- **Delayed**: any coin, including one that isn't a pool reward, can be sent to the **delayed puzzle
  hash** after it has existed for `seconds_delay`. This is the only way to recover XCH that someone sends
  to the pool contract address directly.

| Type                                                                                       | What it is                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlotNft`                                                                                  | `Singleton<PlotNftInfo>`. Has `parse_launcher`, `parse_child`, `join_pool`, `leave_pool`, `self_pool` and `claim_rewards`.                                 |
| `PlotNftInfo`                                                                              | The launcher id, the `PoolState`, `seconds_delay`, `delayed_puzzle_hash` and the network's `pool_reward_prefix`. Has `p2_puzzle_hash` and `claim_delayed`. |
| `PoolState`                                                                                | The state as it's stored on-chain: version, `PoolSingletonState`, target puzzle hash, owner public key, pool URL and relative lock height.                 |
| `PoolSingletonState`                                                                       | `SelfPooling`, `LeavingPool` or `FarmingToPool`.                                                                                                           |
| `SingletonV1Layer`, `PoolMemberLayer`, `PoolWaitingRoomLayer`, `P2SingletonOrDelayedLayer` | The [layers](/sdk/concepts/layers) for the four puzzles, if you need to build or parse the spends yourself.                                                |

The **owner public key** in the state signs every state change. It's a plain BLS key that signs directly,
not a synthetic key like the [standard puzzle](/sdk/primitives/standard) uses.

## Launching

`Launcher::mint_plot_nft` launches a plot NFT in the self pooling or farming to pool state. It takes the
initial `PoolState` (built with `PoolState::self_pooling` or `PoolState::farming_to_pool`), the delay
settings and the network's genesis challenge, and returns the conditions for the launcher's parent to
output along with the eve `PlotNft`. The reference wallet launches with an amount of 1 and a delay of
`DEFAULT_P2_SINGLETON_DELAY` (one week, in seconds), and the delayed puzzle hash is usually the owner's
wallet address.

The p2 puzzle hash depends on the launcher id and the delay settings, so they can't be changed after the
launch. `plot_nft.info.p2_puzzle_hash()` is the pool contract address to create plots with.

```rust
use chia_wallet_sdk::driver::{DEFAULT_P2_SINGLETON_DELAY, PlotNft, PoolSingletonState, PoolState};
use chia_wallet_sdk::prelude::*;

#[test]
fn launch_plot_nft() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let owner = BlsPair::new(42);
    let genesis_challenge = TESTNET11_CONSTANTS.genesis_challenge;

    // Self pool, paying rewards to Alice. Coins that aren't rewards go to her after a week.
    let (conditions, plot_nft) = Launcher::new(alice.coin.coin_id(), 1).mint_plot_nft(
        &mut ctx,
        PoolState::self_pooling(alice.puzzle_hash, owner.pk),
        DEFAULT_P2_SINGLETON_DELAY,
        alice.puzzle_hash,
        genesis_challenge,
    )?;
    StandardLayer::new(alice.pk).spend(&mut ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // The address to create plots for
    let pool_contract_puzzle_hash: Bytes32 = plot_nft.info.p2_puzzle_hash().into();
    assert_ne!(pool_contract_puzzle_hash, plot_nft.coin.puzzle_hash);

    // The launcher spend is enough to get the same plot NFT back
    let launcher_spend = sim.coin_spend(plot_nft.info.launcher_id).expect("missing launcher");
    let solution = ctx.alloc(&launcher_spend.solution)?;
    let parsed = PlotNft::parse_launcher(&ctx, launcher_spend.coin, solution, genesis_challenge)?
        .expect("not a plot NFT");

    assert_eq!(parsed, plot_nft);
    assert_eq!(parsed.info.pool_state.state, PoolSingletonState::SelfPooling);
    assert_eq!(parsed.info.seconds_delay, DEFAULT_P2_SINGLETON_DELAY);

    Ok(())
}
```

`mint_plot_nft` returns `DriverError::InvalidPoolState` for a state the reference wallet wouldn't create
(see [validation](#validation)), for the `LeavingPool` state, and for an even amount.

## Syncing

Plot NFTs can't be parsed from a single parent spend like an NFT or DID can. The state is only revealed
by the spends that change it, and spends that only claim rewards don't reveal anything, so the state of
a coin depends on every spend before it. The delay settings are only revealed by the launcher spend. A
wallet has to start at the launcher and walk forward:

1. Look up the launcher's coin spend, and parse it with `PlotNft::parse_launcher`. It returns `None` if
   the launcher isn't for a plot NFT on the network with that genesis challenge.
2. While the current coin is spent, look up its solution and call `plot_nft.parse_child(&allocator,
solution)`, which returns the next coin in the lineage with its state.

Unlike other `parse_child` functions, this one is a method on the parent `PlotNft`, and it only needs the
solution, since the puzzle is already known. Save the `PlotNftInfo` (or the whole `PlotNft`) once you
have it, so you don't have to walk the lineage again, and so that the delay settings aren't lost. Without them you can't compute the plot NFT's puzzle hash, so you
can't spend it or its rewards.

`parse_child` checks the revealed state against the puzzle hash the singleton moved to, since the
puzzle doesn't enforce that they match. If the owner leaves the waiting room for a puzzle that doesn't
match the state they revealed, it returns `None`, and the SDK can't follow the plot NFT any further.
Leaving a pool can only go to one puzzle, so if a leave spend reveals a state that doesn't match it, the
child is still parsed, as the previous state with `LeavingPool`.

With a [peer](/sdk/networking/peer), the solutions come from `request_puzzle_and_solution`, and the
launcher id comes from wherever you found the plot NFT (for example a launcher coin created by one of your
own coins). The example below uses the `Simulator`.

## Joining and leaving pools

Three methods change the state. Each spends the plot NFT, adds the spend to the context, and returns the
child, and each needs a signature from the owner key:

- `join_pool(ctx, target_puzzle_hash, pool_url, relative_lock_height)` moves from the waiting room
  (self pooling, or leaving a pool once the lock has passed) to farming to a pool. The target puzzle
  hash and relative lock height come from the pool, which publishes them on its `/pool_info` endpoint.
- `leave_pool(ctx)` moves from farming to a pool to the waiting room, keeping the pool's target and lock
  height.
- `self_pool(ctx, target_puzzle_hash)` moves from the waiting room to self pooling. It also changes the
  target of a plot NFT that's already self pooling.

They return `DriverError::InvalidPlotNftTransition` for a move the SDK doesn't support, such as leaving a
pool it isn't farming to, joining a pool without leaving the current one first, or moving to the state
the plot NFT is already in.

The relative lock height is counted from when the current coin was created, so the chain rejects a move
out of the waiting room until enough blocks have passed (`ASSERT_HEIGHT_RELATIVE`). That includes a lock
of 0 on a coin created in the same block, which is why rewards have to be claimed in an earlier block
than the one that joins a pool (see [gotchas](#gotchas)).

This example goes through the whole lifecycle with fake rewards, then syncs the plot NFT from its
launcher:

```rust
use chia_wallet_sdk::driver::{PlotNft, PoolSingletonState, PoolState};
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::pool_reward_parent_id;

const REWARD: u64 = 1_750_000_000_000;

/// Follows a plot NFT from its launcher to its latest coin.
fn sync(
    sim: &Simulator,
    ctx: &mut SpendContext,
    launcher_id: Bytes32,
    genesis_challenge: Bytes32,
) -> anyhow::Result<Option<PlotNft>> {
    let launcher_spend = sim.coin_spend(launcher_id).expect("missing launcher");
    let solution = ctx.alloc(&launcher_spend.solution)?;

    let Some(mut plot_nft) =
        PlotNft::parse_launcher(ctx, launcher_spend.coin, solution, genesis_challenge)?
    else {
        return Ok(None);
    };

    while let Some(solution) = sim.solution(plot_nft.coin.coin_id()) {
        let solution = ctx.alloc(&solution)?;
        let Some(child) = plot_nft.parse_child(ctx, solution)? else {
            return Ok(None);
        };
        plot_nft = child;
    }

    Ok(Some(plot_nft))
}

/// Creates a pool reward coin, as if the plot NFT's plots won the block at `height`.
fn farm_reward(sim: &mut Simulator, plot_nft: &PlotNft, height: u32) -> Coin {
    let reward = Coin::new(
        pool_reward_parent_id(plot_nft.info.pool_reward_prefix, height),
        plot_nft.info.p2_puzzle_hash().into(),
        REWARD,
    );
    sim.insert_coin(reward);
    reward
}

#[test]
fn pool_lifecycle() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let owner = BlsPair::new(42);
    let pool_puzzle_hash = Bytes32::new([1; 32]);
    let genesis_challenge = TESTNET11_CONSTANTS.genesis_challenge;

    let (conditions, plot_nft) = Launcher::new(alice.coin.coin_id(), 1).mint_plot_nft(
        &mut ctx,
        PoolState::self_pooling(alice.puzzle_hash, owner.pk),
        604_800,
        alice.puzzle_hash,
        genesis_challenge,
    )?;
    StandardLayer::new(alice.pk).spend(&mut ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // While self pooling, rewards are paid to Alice
    let reward = farm_reward(&mut sim, &plot_nft, 100);
    let (_, plot_nft) = plot_nft.claim_rewards(&mut ctx, &[reward])?;
    sim.spend_coins(ctx.take(), &[])?;
    assert!(sim.unspent_coins(alice.puzzle_hash, false).iter().any(|coin| coin.amount == REWARD));

    // Join a pool with a relative lock height of 10 blocks
    let plot_nft = plot_nft.join_pool(
        &mut ctx,
        pool_puzzle_hash,
        "https://pool.example.com".to_string(),
        10,
    )?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk))?;
    assert_eq!(plot_nft.info.pool_state.state, PoolSingletonState::FarmingToPool);

    // Rewards now go to the pool
    let reward = farm_reward(&mut sim, &plot_nft, 101);
    let (_, plot_nft) = plot_nft.claim_rewards(&mut ctx, &[reward])?;
    sim.spend_coins(ctx.take(), &[])?;
    assert_eq!(sim.unspent_coins(pool_puzzle_hash, false).len(), 1);

    // Leaving moves to the waiting room, which can't be left until the lock has passed
    let plot_nft = plot_nft.leave_pool(&mut ctx)?;
    sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk))?;
    assert_eq!(plot_nft.info.pool_state.state, PoolSingletonState::LeavingPool);

    let _ = plot_nft.self_pool(&mut ctx, alice.puzzle_hash)?;
    assert!(sim.spend_coins(ctx.take(), std::slice::from_ref(&owner.sk)).is_err());

    for _ in 0..10 {
        sim.create_block();
    }

    let plot_nft = plot_nft.self_pool(&mut ctx, alice.puzzle_hash)?;
    sim.spend_coins(ctx.take(), &[owner.sk])?;
    assert_eq!(plot_nft.info.pool_state, PoolState::self_pooling(alice.puzzle_hash, owner.pk));

    // A wallet that only knows the launcher id ends up at the same coin and state
    let synced = sync(&sim, &mut ctx, plot_nft.info.launcher_id, genesis_challenge)?;
    assert_eq!(synced, Some(plot_nft));

    Ok(())
}
```

## Claiming rewards

`claim_rewards(ctx, rewards)` claims any number of pool rewards in one transaction. The plot NFT is
recreated once for each reward, in order, and the method returns the last child. Each reward is paid to
the target puzzle hash of the current state, whichever state the plot NFT was in when it was farmed.
Nothing is signed, so anyone can claim a plot NFT's rewards, and the pool usually does it for plot NFTs
that are farming to it.

To find the rewards, look up the unspent coins of `plot_nft.info.p2_puzzle_hash()`. The SDK checks every
coin before it adds any spends, and returns `DriverError::InvalidPoolReward` if the list is empty, or if a coin isn't locked to the
p2 puzzle hash, isn't a pool reward, is listed twice, or can't be claimed by the puzzle (see
[gotchas](#gotchas)).

The plot NFT and reward spends don't pay a fee. To pay one, add the returned conditions to the spend
that pays it. They assert an announcement from the first reward, so the fee can't be taken without the
claim:

```rust
use chia_wallet_sdk::driver::PoolState;
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::puzzles::pool_reward_parent_id;

#[test]
fn claim_rewards_with_fee() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let owner = BlsPair::new(42);
    let pool_puzzle_hash = Bytes32::new([1; 32]);

    let (conditions, plot_nft) = Launcher::new(alice.coin.coin_id(), 1).mint_plot_nft(
        &mut ctx,
        PoolState::farming_to_pool(
            pool_puzzle_hash,
            owner.pk,
            "https://pool.example.com".to_string(),
            32,
        ),
        604_800,
        alice.puzzle_hash,
        TESTNET11_CONSTANTS.genesis_challenge,
    )?;
    StandardLayer::new(alice.pk).spend(&mut ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Three blocks were farmed by this plot NFT's plots
    let rewards: Vec<Coin> = [200, 201, 202]
        .into_iter()
        .map(|height| {
            let reward = Coin::new(
                pool_reward_parent_id(plot_nft.info.pool_reward_prefix, height),
                plot_nft.info.p2_puzzle_hash().into(),
                1_750_000_000_000,
            );
            sim.insert_coin(reward);
            reward
        })
        .collect();

    let (conditions, plot_nft) = plot_nft.claim_rewards(&mut ctx, &rewards)?;

    // Bob pays the fee, which only works if the rewards are claimed in the same transaction
    let bob = sim.bls(100);
    StandardLayer::new(bob.pk).spend(&mut ctx, bob.coin, conditions.reserve_fee(100))?;
    sim.spend_coins(ctx.take(), &[bob.sk])?;

    assert_eq!(sim.unspent_coins(pool_puzzle_hash, false).len(), 3);
    assert!(sim.coin_state(plot_nft.coin.coin_id()).is_some());

    Ok(())
}
```

`join_pool`, `leave_pool` and `self_pool` don't return any conditions. To pay a fee for a state change,
spend another coin in the same spend bundle that reserves the fee and asserts the spend of the plot NFT
coin you called the method on (not the returned child) with
`assert_concurrent_spend(plot_nft.coin.coin_id())`, so the fee can't be taken without the state change.

## Claiming other coins after the delay

A coin sent to the p2 puzzle hash that isn't a pool reward, such as a payment someone sent to the pool
contract address by mistake, can't be claimed by the plot NFT. `plot_nft.info.claim_delayed(ctx, coin)`
sends it to the delayed puzzle hash instead, once it has existed for `seconds_delay` seconds
(`ASSERT_SECONDS_RELATIVE`), and returns the new coin. It doesn't spend the plot NFT, and anyone can do
it.

```rust
use chia_wallet_sdk::driver::{DEFAULT_P2_SINGLETON_DELAY, PoolState};
use chia_wallet_sdk::prelude::*;

#[test]
fn claim_delayed() -> anyhow::Result<()> {
    let mut sim = Simulator::new();
    let mut ctx = SpendContext::new();

    let alice = sim.bls(1);
    let owner = BlsPair::new(42);

    let (conditions, plot_nft) = Launcher::new(alice.coin.coin_id(), 1).mint_plot_nft(
        &mut ctx,
        PoolState::self_pooling(alice.puzzle_hash, owner.pk),
        DEFAULT_P2_SINGLETON_DELAY,
        alice.puzzle_hash,
        TESTNET11_CONSTANTS.genesis_challenge,
    )?;
    StandardLayer::new(alice.pk).spend(&mut ctx, alice.coin, conditions)?;
    sim.spend_coins(ctx.take(), &[alice.sk])?;

    // Someone sends XCH to the pool contract address
    let coin = sim.new_coin(plot_nft.info.p2_puzzle_hash().into(), 1_000);
    let created_timestamp = sim.next_timestamp();
    sim.create_block();

    // It isn't a pool reward, so the plot NFT can't claim it
    assert!(matches!(
        plot_nft.claim_rewards(&mut ctx, &[coin]),
        Err(DriverError::InvalidPoolReward(_))
    ));

    // It can only be sent to the delayed puzzle hash, after the delay
    let _ = plot_nft.info.claim_delayed(&mut ctx, coin)?;
    assert!(sim.spend_coins(ctx.take(), &[]).is_err());

    sim.set_next_timestamp(created_timestamp + DEFAULT_P2_SINGLETON_DELAY)?;
    let swept = plot_nft.info.claim_delayed(&mut ctx, coin)?;
    sim.spend_coins(ctx.take(), &[])?;

    assert_eq!(swept.puzzle_hash, alice.puzzle_hash);
    assert!(sim.coin_state(swept.coin_id()).is_some());

    Ok(())
}
```

## Validation

`PoolState::validate` applies the checks the reference wallet makes to a state it's about to move to:
the version isn't newer than `POOL_PROTOCOL_VERSION`, the owner key isn't the infinity point (which could
never sign), a self pooling state has no pool URL and a lock height of 0, and a pool state has a URL and a
lock height between `MINIMUM_RELATIVE_LOCK_HEIGHT` (5) and `MAXIMUM_RELATIVE_LOCK_HEIGHT` (1000).
`mint_plot_nft`, `join_pool` and `self_pool` call it for you, and return `DriverError::InvalidPoolState`.

The puzzles don't enforce any of this, so a state read from the chain can be anything. Parsing never
validates, and you shouldn't validate states you sync either, or a plot NFT that someone else's software
moved to an unusual state would stop syncing.

## Gotchas

- **Claim self pooling rewards before joining a pool, in an earlier block.** Rewards are paid to the
  target at the time of the claim, not when they were farmed, so unclaimed self pooling rewards go to the
  pool once you've joined. The claim has to be confirmed first, since the join asserts a relative height,
  which isn't allowed on a coin created in the same block (`EPHEMERAL_RELATIVE_CONDITION`).
- **Claiming restarts the lock.** The relative lock height is counted from the creation of the current
  coin, and every claim recreates it. Since anyone can claim, a pool (or anyone else) can delay a plot
  NFT leaving it by claiming rewards during the waiting period. The puzzle works this way, and the
  reference wallet has the same behaviour.
- **Odd amounts can't be claimed.** The singleton raises if it creates a second odd coin, so
  `claim_rewards` rejects a reward with an odd amount. Real pool rewards are always even. While farming to a
  pool, it also rejects a reward from height 0, which the pool member puzzle would read as a leave spend.
- **Rewards keep their address across states.** The p2 puzzle hash only depends on the launcher id and
  the delay settings, so rewards farmed in one state can be claimed after the plot NFT has moved to
  another, and they're paid to the new target.
- **Save the delay settings.** They're only in the launcher spend. Without them, you can't compute the plot
  NFT's puzzle hash, so you can't spend it or its rewards.
- **The pool URL isn't committed to.** Neither is the difference between `SelfPooling` and `LeavingPool`.
  They're only in the revealed state, so trust them as much as you trust the owner.
- **Use the right genesis challenge.** The reward prefix is part of the puzzles, so a plot NFT is only
  recognized by `parse_launcher` on the network it was launched for.
