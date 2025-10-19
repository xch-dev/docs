# Coins

Everything on the Chia blockchain is represented as a coin. They are similar to both Bitcoin's UTXOs and real life coins, except they are fully programmable.

A coin is made up of the following 3 parts:

1. **Parent Coin ID** - The id of the parent coin.
2. **Puzzle Hash** - The hash of the coin's [puzzle](/docs/coin-set/puzzles.md) program.
3. **Amount** - The number of mojos locked up in the coin.

If you calculate the sha256 hash of the CLVM representation of these 3 values, you get the coin's id.

## Mojos

A coin's amount is represented by a unit called a mojo. As far as the blockchain is concerned, every coin is measured in mojos. An amount must be zero or more mojos, and be an integer (non-fractional).

:::info
There are 1 trillion mojos in 1 XCH, but this is just a social convention for display purposes. Nothing on the blockchain is concerned with the precision of XCH.
:::

## Block Rewards

Every transaction block creates reward coins that were earned since the previous transaction block.

These rewards are split into two coins:

1. **Farmer Reward** - 1/8th of the block reward.
2. **Pool Reward** - 7/8th of the block reward.

The parent coin id is calculated by concatenating these 2 parts:

1. **Genesis Challenge** - The first 16 bytes of the genesis challenge for pool rewards, and the last 16 bytes for farmer rewards.
2. **Block Height** - The byte representation of the block height (with zeros in between).

## Transaction Outputs

Transaction blocks contain a transaction generator program, which produces a list of coin spends. When a coin is spent, its program outputs a list of conditions, which can be used to validate information or create new coins.

Because every coin has its own unique program (known as a puzzle), there is no universal way to spend a coin. However, for practical reasons most coins used by the Chia ecosystem use a standard set of puzzles that apps can understand and spend.

In addition to the rules imposed by the puzzle, and conditions that are checked by consensus, there are properties that apply to all coins:

1. **Unique IDs** - No two coins can have the same combination of parent coin id, puzzle hash, and amount.
2. **No Minting** - The supply of mojos is not allowed to increase, except by block rewards.
3. **Fees** - Any left over amount in a transaction is added to the farmer reward as a fee, rather than being removed from circulation.
4. **Flash Loans** - Intermediate coins may have value that is created out of thin air, as long as they are spent and the final output is the same.
5. **Order Independence** - The order of coin spends does not affect the end result. You can also combine the value of multiple coins into the output of a single coin.
