# CATs

A CAT (Chia Asset Token) is a fungible asset with a supply that is distinct from other types of assets and can be controlled programmatically with a [TAIL](#tails) program. Its custody is controlled by the [inner puzzle](/docs/coin-set/puzzles.md#layers).

The puzzle hash of the children of CAT coins will be wrapped such that they are CAT coins with the same asset id.

## Puzzles

The main puzzles that make up CATs are:

1. [**CAT2**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/cat_puzzles/cat_v2.clsp) - The outer puzzle of the primitive that enforces the lineage and issuance rules.
2. [**Revocation Layer**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/vc_puzzles/revocation_layer.clsp) - An optional layer that allows the issuer to revoke the CAT.

Some example TAIL puzzles are listed [below](#tails).

## Amounts

While there are 1 trillion mojos in 1 XCH per [social convention](/docs/coin-set/coins.md#mojos), a unit of a CAT is 1,000 mojos. This is an arbitrary decision, but standardized across the ecosystem.

:::note
In the future, [CATalog](https://blog.fireacademy.io/i/153160453/designing-catalog) will likely provide a way to change the unit of an individual CAT. However, the higher precision you use, the more mojos are needed to represent the same amount.
:::

## Lineage

When a CAT coin is spent, it can optionally reveal a lineage proof.

A lineage proof consists of the following:

1. **Parent Parent Coin ID** - The parent coin id of the parent of this CAT.
2. **Parent Inner Puzzle Hash** - The inner puzzle hash of the parent of this CAT.
3. **Parent Amount** - The amount of the parent of this CAT.

The idea is that the inner puzzle hash can be wrapped in the CAT puzzle to compute the full puzzle hash, and then the three components can be hashed together to get the parent coin id. By asserting that the parent coin id matches this computed value, the CAT puzzle knows that its lineage has been checked by the parent already and is valid.

However, if you're issuing a new CAT coin from thin air, the parent isn't a CAT. In this case, you would run the [TAIL](#tails) program instead of providing a lineage proof. The extra delta would be 0 since it's a new coin, but the TAIL can still check that creating this coin is allowed.

## Accounting

CATs aim to have the same [supply rules](/docs/coin-set/coins#transaction-outputs) as XCH coins, while being isolated from other assets. This is achieved by spending all of the CAT coins together to form a ring, and ensuring that the difference between the output amounts and input amounts is zero.

When a CAT coin is spent, it's provided the subtotal of deltas for all coins that are before it in the ring. It then calculates the delta between its amount and the sum of its children, and adds it to the subtotal. Using coin announcements, the CAT coins communicate with their neighbors to ensure that the total delta is zero.

If the total delta is not zero, the [TAIL](#tails) program must be revealed and run to determine if the change in supply is allowed.

## TAILs

The TAIL (Token Asset Issuance Limitations) program is what decides when the supply of a CAT is allowed to change. It's provided the extra delta (the difference between the new supply and the old supply) and returns a list of conditions to output. If the supply change is not allowed, the program will raise or the conditions will fail validation.

While anyone can create their own TAIL program, these ones are commonly used:

1. [**Genesis By Coin ID**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/cat_puzzles/genesis_by_coin_id.clsp) - Also referred to as single issuance. This ensures that only a specific parent coin is allowed to issue this CAT, which prevents the supply from being changes after the original issuance.
2. [**Everything With Signature**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/cat_puzzles/everything_with_signature.clsp) - Also referred to as multi issuance. This allows the owner of a public key to have full control over the supply of the CAT.
3. [**Everything With Singleton**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/cat_puzzles/everything_with_singleton.clsp) - Another form of multi issuance. This allows the owner of a singleton (e.g., vault) to have full control over the supply of the CAT.

Unless you have a good reason to, you should use the single issuance TAIL. This will improve trust in the asset, since buyers can see that the supply is fixed.

## Revocation

Revocable CATs (R-CATs) are a special type of CAT that can be revoked by the issuer. A revocable CAT is created by wrapping the inner puzzle in the revocation layer.

Essentially, the revocation layer allows two spend paths:

1. **Inner Puzzle** - The owner of the CAT coin.
2. **Hidden Puzzle** - The issuer of the CAT.

If the inner puzzle is used to spend the coin, the child will also be wrapped in the revocation layer. This will prevent mojos from "escaping" the CAT's supply. Additionally, it's important that the issuer never creates a non-revocable coin with the same asset id, since this would its owner to combine it with a revocable coin and remove the revocation layer.

On the other hand, if the hidden puzzle is used to spend the coin, the child will not be wrapped in the revocation layer. It's the issuer's responsibility to either melt the mojos out of the supply or wrap the child in the revocation layer manually (and include the p2 puzzle hash of the new owner as the [hint](/docs/coin-set/puzzles.md#hinting)).

:::warning
There is nothing stopping someone other than the issuer from adding the revocation layer to an otherwise non-revocable CAT coin. This could introduce a security risk if sold to an unsuspecting buyer. Wallets should clearly warn users that a CAT is revocable and attempt to determine if a CAT is supposed to be revocable or not.
:::
