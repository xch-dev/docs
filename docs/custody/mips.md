# MIPS

MIPS (Meta Inner Puzzle Spec) is a standard framework for custody puzzles that allows for flexible custody configurations.

The standard implementation of MIPS currently includes the following features:

1. **Multiple Curves** - BLS12-381, secp256k1, and secp256r1 are supported.
2. **Multisig** - You can compose trees of multiple member puzzles that must sign.
3. **Vaults** - You can delegate control over your coins to a vault coin.
4. **Vault of Vaults** - You can delegate control over vaults to a multisig of vaults.
5. **Delayed Recovery** - You can use another set of keys to recover your vault after a certain amount of time.
6. **Fast Forward** - Variants of the member puzzles that allow the vault to be spent multiple times at once.

While the framework was partially designed to make the [vault](/docs/primitives/vaults.md) primitive possible, it can be used more generally to construct custody puzzles. For example, both [clawbacks](/docs/custody/clawbacks.md) and [option contracts](/docs/primitives/option-contracts.md) make use of MIPS as well.

## Architecture Puzzles

A custody puzzle follows the MIPS framework if it's composed of the following layers:

1. **Index Wrapper** - A layer that adds a nonce that can change the puzzle hash. Its CLVM is simply `(a 5 7)`.
2. [**Delegated Puzzle Feeder**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/architecture_puzzles/delegated_puzzle_feeder.clsp) - A layer that runs a delegated puzzle and solution, and passes the hash into the inner puzzle.
3. [**Restrictions**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/architecture_puzzles/restrictions.clsp) - An optional layer that adds restrictions to the inner puzzle.
4. **Inner Puzzle** - This is either a single member puzzle or a multisig.

There are 3 different types of m-of-n used to implement multisigs, as an automatic optimization:

1. [**M-of-N**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/architecture_puzzles/m_of_n.clsp) - A subset of members must sign.
2. [**N-of-N**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/architecture_puzzles/n_of_n.clsp) - All members must sign.
3. [**1-of-N**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/architecture_puzzles/1_of_n.clsp) - Only one member is required to sign.

## Member Puzzles

### BLS

These members require a BLS public key to sign:

1. [**BLS Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/bls_member.clsp) - Requires an `AGG_SIG_ME` condition.
2. [**BLS Member (Puzzle Assert)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/bls_member_puzzle_assert.clsp) - Requires a fast forwardable `AGG_SIG_PUZZLE` condition.
3. [**BLS Taproot Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/bls_with_taproot_member.clsp) - Requires an `AGG_SIG_ME` condition. The synthetic public key can be used to reveal and spend a [hidden puzzle](/docs/custody/standard-transaction.md#hidden-puzzle) instead.
4. [**BLS Taproot Member (Puzzle Assert)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/bls_with_taproot_member_puzzle_assert.clsp) - Requires a fast forwardable `AGG_SIG_PUZZLE` condition. The synthetic public key can be used to reveal and spend a [hidden puzzle](/docs/custody/standard-transaction.md#hidden-puzzle) instead.

### SECP

There are also members for secp256k1 and secp256r1:

1. [**secp256k1 Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/secp256k1_member.clsp) - Requires an `ASSERT_MY_COIN_ID` condition and verifies a signature.
2. [**secp256k1 Member (Puzzle Assert)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/secp256k1_member_puzzle_assert.clsp) - Requires a fast forwardable `ASSERT_MY_PUZZLE_HASH` condition and verifies a signature.
3. [**secp256r1 Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/secp256r1_member.clsp) - Requires an `ASSERT_MY_COIN_ID` condition and verifies a signature.
4. [**secp256r1 Member (Puzzle Assert)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/secp256r1_member_puzzle_assert.clsp) - Requires a fast forwardable `ASSERT_MY_PUZZLE_HASH` condition and verifies a signature.

### Passkeys

Passkeys have their own member puzzles:

1. [**Passkey Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/passkey_member.clsp) - Requires an `ASSERT_MY_COIN_ID` condition and verifies a [WebAuthn](https://en.wikipedia.org/wiki/WebAuthn) signature.
2. [**Passkey Member (Puzzle Assert)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/passkey_member_puzzle_assert.clsp) - Requires a fast forwardable `ASSERT_MY_PUZZLE_HASH` condition and verifies a [WebAuthn](https://en.wikipedia.org/wiki/WebAuthn) signature.

### Singletons

You can delegate signing to another singleton (e.g., a vault):

1. [**Singleton Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/singleton_member.clsp) - Receives a message from another singleton puzzle by coin id.
2. [**Singleton Member (With Mode)**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/singleton_member_with_mode.clsp) - Receives a message from another singleton with a custom mode (for example, by puzzle hash).

### Misc

These are misc member puzzles that don't fit into the other categories:

1. [**Fixed Puzzle Member**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/member_puzzles/fixed_puzzle_member.clsp) - Requires that the delegated puzzle hash be a specific value without verifying any signatures.

## Restriction Puzzles

In the MIPS framework, restrictions can be replaced on either the delegated puzzle or the member conditions. This is done by wrapping the inner puzzle in the restrictions puzzle, which is curried with a list of each type of restriction.

### Delegated Puzzle Restrictions

There is currently only one delegated puzzle restriction:

1. [**Enforce Delegated Puzzle Wrappers**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/enforce_dpuz_wrappers.clsp) - Enforces a series of wrappers are included in the delegated puzzle.

### Delegated Puzzle Wrappers

Most restrictions are delegated puzzle wrappers, since they can be used to validate and modify the conditions that are output by the delegated puzzle.

These are the currently supported delegated puzzle wrappers:

1. [**Force 1 of 2 With Restricted Variable**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/force_1_of_2_w_restricted_variable.clsp) - Created coins must be a 1 of 2 multisig with a fixed left side and a variable right side with restrictions. This is specifically intended for [delayed recovery](#delayed-recovery).
2. [**Force Assert Coin Announcement**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/force_assert_coin_announcement.clsp) - Forces an `ASSERT_COIN_ANNOUNCEMENT` condition to be output.
3. [**Force Coin Message**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/force_coin_message.clsp) - Forces a `SEND_MESSAGE` condition to be output where the receiver is a coin id.
4. [**Prevent Condition Opcode**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/prevent_condition_opcode.clsp) - Prevents a specific condition opcode from being output.
5. [**Prevent Multiple Create Coins**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/prevent_multiple_create_coins.clsp) - Prevents multiple `CREATE_COIN` conditions from being output.
6. [**Timelock**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/timelock.clsp) - Forces an `ASSERT_SECONDS_ABSOLUTE` condition to be output.

### Member Condition Restrictions

Member condition restrictions are given the combined conditions that the sub-tree of member puzzles in the inner puzzle output. They can raise if the conditions don't meet certain criteria.

There aren't currently any restrictions that were designed to be used for member conditions. However, certain delegated puzzle wrappers can be used (with caution) as member condition restrictions as well.

For example, the [Timelock Wrapper](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/mips_puzzles/restriction_puzzles/wrappers/timelock.clsp) enforces an `ASSERT_SECONDS_ABSOLUTE` condition is present, and it's currently used to enforce a timelock on an untrusted recovery member in the [vault](/docs/primitives/vaults.md) primitive.

:::warning
This will not validate conditions that are output by the delegated puzzle, so you should be careful when using this kind of restriction.
:::

## Delayed Recovery

The idea with delayed recovery is to create two separate sets of members:

1. **Custody** - Has complete control over the coin, and can cancel pending recovery.
2. **Recovery** - Can initiate a rekey of the vault, but must wait to complete it.

Due to the way MIPS is structured, this is challenging to implement

This is an explanation of how it's currently implemented in vaults:

1. The vault is a 1 of 2 multisig
2. The left side of the tree is the custody members
3. The right side of the tree is the recovery members
4. The left side is unrestricted and can change the entire vault
5. The right side is restricted with `force_1_of_2_w_restricted_variable`
6. When the right side is spent, it must create a new 1 of 2 multisig with the same left side
7. After recovery is initiated, the right side must be restricted with a predefined timelock
8. Before the timelock expires, the left side can still cancel recovery by resetting the right side to something else
9. After the timelock expires, the right side can be spent to complete recovery
