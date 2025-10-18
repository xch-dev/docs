# Puzzles

A puzzle is a [CLVM](https://chialisp.com/clvm/) program that is used to control how a coin can be spent. You commit to the puzzle hash up front when you create a coin, and then reveal the puzzle and solution when you spend it.

Puzzles are typically written in either the [Chialisp](https://chialisp.com/) or [Rue](https://rue-lang.com/) programming languages, rather than writing CLVM by hand. For the purposes of this documentation, we will use Rue since it's easier for beginners to understand.

## Currying

Before we get into the details of puzzles, it's important to understand how currying in Chia works. Fundamentally, it's a way to reuse a common program but provide some of its arguments in advance.

For example, let's say you have a program that looks like this:

```rue
fn main(factor: Int, value: Int) -> Int {
    factor * value
}
```

You might say that every instance of this program must commit to the `factor` up front, rather than it being provided in the solution. To make this work, you need to essentially create a new program that takes a single `value` argument and calls the original program with both the `factor` that you have committed to, and the `value` that is provided in the solution.

This is what currying is in Chia - it's a standard format to partially apply arguments to a program. You would say that you curried `factor` into the program, and now the solution is a list with only `value`.

:::note
If you look at the Wikipedia definition of [currying](https://en.wikipedia.org/wiki/Currying), it says that it's a way to transform a function that takes multiple arguments into a sequence of functions, each with a single argument. This term is a bit misused in Chia, and [partial application](https://en.wikipedia.org/wiki/Partial_application) is more accurate. However, since the term is used extensively in the Chia ecosystem, we will refer to it as currying in this documentation.
:::

## Custody

The simplest kind of puzzle is a custody puzzle, which controls who can spend the coin. For example, a wallet can create a puzzle that only allows the owner's private key to spend it. It will then keep track of coins with that puzzle's hash, since it knows it can spend them.

Such a puzzle might look like this:

```rue
fn main(
    public_key: PublicKey,
    conditions: List<Condition>,
) -> List<Condition> {
    let agg_sig = AggSigMe {
        public_key,
        message: tree_hash(conditions),
    };

    [agg_sig, ...conditions]
}
```

When instantiating the puzzle, the wallet will curry the value of `public_key` into the puzzle, which means that only `conditions` will be provided in the solution when the coin is spent.

While custody puzzles are typically more complex, this is equally secure and provides most of the flexibility you would need in practice.

:::note
The most common custody puzzle is the [Standard Transaction](/docs/custody/standard-transaction.md) puzzle, which is used by light wallets such as [Sage](https://sagewallet.net). You should use other forms of custody carefully, as compatibility with other wallets is not guaranteed.
:::

### Delegated Puzzle

The main difference between the prior example and the [Standard Transaction](/docs/custody/standard-transaction.md) puzzle is that the latter uses a delegated puzzle. Instead of the owner signing a static list of conditions, they can sign a delegated puzzle that can be used to spend the coin. This allows for more flexibility, since you could delegate some control over the spend to another party, without giving them your key.

While this isn't compatible with the standard transaction puzzle, here's an example of using a delegated puzzle:

Such a puzzle might look like this:

```rue
fn main(
    public_key: PublicKey,
    delegated_puzzle: fn(...solution: Any) -> List<Condition>,
    delegated_solution: Any,
) -> List<Condition> {
    let agg_sig = AggSigMe {
        public_key,
        message: tree_hash(delegated_puzzle),
    };

    let conditions = delegated_puzzle(...delegated_solution);

    [agg_sig, ...conditions]
}
```

Notice that instead of passing the conditions in directly, we're running the delegated puzzle and solution that are passed into this puzzle's solution to get the conditions. We then verify that the owner signed the delegated puzzle, rather than the conditions themselves.

:::tip
For most spends, this flexibility isn't needed - so the delegated puzzle is a quoted list of conditions, and the solution is nil. This will result in the same behavior as the previous example.
:::

## Layers

Because programs are values, and you can curry values into other programs, you can create a program that is a layer of abstraction on top of another program. This is similar to the [delegated puzzle](#delegated-puzzle) example, but the inner puzzle is curried in rather than being passed into the solution.

For example, let's say you want to create a puzzle that wraps another puzzle's output and enforces that it can only be spent after a certain amount of time has passed.

This is what that might look like:

```rue
fn main(
    seconds: Int,
    inner_puzzle: fn(...solution: Any) -> List<Condition>,
    ...inner_solution: Any,
) -> List<Condition> {
    let conditions = inner_puzzle(...inner_solution);

    let timelock = AssertSecondsAbsolute { seconds };

    [timelock, ...conditions]
}
```

In this case, you would curry both the `seconds` and `inner_puzzle` arguments, and then pass the `inner_solution` into the solution when the coin is spent.

You would spend this just like the inner puzzle, but it would automatically add the timelock to the conditions. This effectively prevents the coin from being spent before the specified amount of time has passed.

This pattern of nesting puzzles inside of each other is very powerful, and used extensively.

### Outer Puzzles

An outer puzzle is a special kind of layer that is designed to live on the outside of all other layers. It shouldn't be used as the inner puzzle of another, but rather as the top level puzzle that is used to spend the coin.

An example of this is the [CAT](/docs/primitives/cats.md) puzzle, which is used to create new types of assets with a controlled supply.

Typically, outer puzzles will wrap the output of the inner puzzle in itself, to prevent the mojos from escaping the asset's supply. This means that the outer puzzle curries the puzzle hash of created coins into a new instance of the outer puzzle and returns the modified conditions rather than the original.

As a simpler example, this is a permanent wrapper puzzle that contains a bit of metadata:

```rue
fn main(
    mod_hash: Bytes32,
    metadata: String,
    inner_puzzle: fn(...solution: Any) -> List<Condition>,
    ...inner_solution: Any,
) -> List<Condition> {
    let conditions = inner_puzzle(...inner_solution);
    morph_conditions(mod_hash, metadata, conditions)
}

fn morph_conditions(
    mod_hash: Bytes32,
    metadata: String,
    conditions: List<Condition>,
) -> List<Condition> {
    if conditions is nil {
        return nil;
    }

    inline let (condition, rest) = conditions;

    let rest = morph_conditions(mod_hash, metadata, rest);

    if condition is CreateCoin {
        let condition = CreateCoin {
            puzzle_hash: curry_tree_hash(mod_hash, [
                tree_hash_atom(mod_hash),
                tree_hash_atom(metadata),
                condition.puzzle_hash,
            ]),
            amount: condition.amount,
            memos: condition.memos,
        };

        return [condition, ...rest];
    }

    [condition, ...rest]
}
```

When initially instantiating the puzzle, you would curry the `mod_hash`, `metadata`, and `inner_puzzle` arguments, and then pass the `inner_solution` into the solution when the coin is spent.

Any coins that the inner puzzle creates will have their puzzle hash wrapped in the outer puzzle (using the same `mod_hash` and `metadata` fields, but with the new inner puzzle). Although unlike the CAT puzzle, this does not prevent the amount of mojos from increasing or decreasing, so this can't be considered a distinct asset from XCH.

### Hinting

If you wrap the custody puzzle hash in other puzzle layers, the hash will no longer match what you are looking for coins with on-chain. You would have to look at every coin spend on the blockchain and find ones where the inner puzzle hash matches your custody puzzle's hash, which is usually impractical.

The solution is [CHIP-0020](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0020.md), which provides a way to hint coins to a custody puzzle hash.

The third argument to the `CREATE_COIN` condition is an optional value that represents memos. The standard way to hint a coin would be to pass a list of memos where the first item is the puzzle hash of the owner. You can still provide additional memos after that for other purposes, since only the first item is used for hinting.

This allows light wallets to find coins more easily, since they can simply look for coins with the hint, and then lookup the puzzle and solution of the parent coin to validate it.

## Primitives

A primitive is a high level abstraction over a standard set of puzzle layers. They typically represent a new type of asset that can be owned by a custody puzzle, such as [CATs](/docs/primitives/cats.md) or [NFTs](/docs/primitives/nfts.md).

The reason to have standard groupings of puzzles is to provide a structured interface for interacting with different types of assets. If any combination of layers was allowed, parsing and validating coins would be much more complex for wallets and other applications. So generally, each combination of outer puzzles is considered a primitive.

Note that the custody puzzle is irrelevant to primitives - it's only used to determine who can spend the coin, and can be flexible as long as the owner's wallet can spend it.
