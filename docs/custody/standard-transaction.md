# Standard Transaction

The standard transaction ([p2_delegated_puzzle_or_hidden_puzzle](https://github.com/Chia-Network/chia_puzzles/blob/main/puzzles/p2_delegated_puzzle_or_hidden_puzzle.clsp)) is used by the Chia reference client and other light wallets such as [Sage](https://sagewallet.net). It gives full control to whoever owns the public key that is curried into the puzzle. Wallets can generate multiple derivations (i.e., addresses) from their master secret key.

## Derivations

Derivation paths start with `m` (master key) and are followed by a series of child indices. For example, `m/0` would mean the first child.

The standard derivation path used in wallets is `m/12381/8444/2/index`, where `index` is the derivation index of the address. You must derive the synthetic public key of the child public key to ensure compatibility.

There are two types of derivations:

- **Hardened** - Also referred to as non-observer keys. These can only be derived from the secret key, so they provide more privacy.
- **Unhardened** - Also referred to as observer keys. These can be derived from the public key, so they allow you to have a read-only view into wallets without needing the secret key (as long as you have access to the master public key).

Wallets typically prefer unhardened derivations, for two reasons:

1. They are more compatible with tools that need a read-only view of your wallet (i.e., for collecting tax information or monitoring your balance).
2. The wallet doesn't need to store the secret key in memory at rest, which is more secure.

However, both are generally supported and you can use hardened keys if you want that additional privacy benefit and are fine with the tradeoffs.

## Hidden Puzzle

The standard transaction puzzle also supports a modified version of [taproot](https://bitcoinops.org/en/topics/taproot/), which allows you to add a hidden puzzle to the public key. While you can still spend coins normally by signing with the synthetic secret key, you can also choose to reveal the original public key and the hidden puzzle hash. If you do, you can spend the coin by solving the hidden puzzle instead.

The default hidden puzzle hash is `(=)`, which is an invalid program. This ensures that the hidden puzzle can never be used to bypass the signature requirement. If you change the hidden puzzle hash, it will affect the public key, and thus not be compatible with other wallets that don't support custom hidden puzzles.

:::note
As of writing this, there are no documented uses of this functionality in the wild. You should use the default hidden puzzle hash unless you know what you're doing.
:::
