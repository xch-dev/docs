---
slug: /sdk/primitives/cat
title: CAT
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# CAT (Chia Asset Tokens)

CATs (Chia Asset Tokens) are fungible tokens on the Chia blockchain. Each CAT has a unique asset ID derived from its TAIL (Token and Asset Issuance Limiter) program, which controls how the token can be minted.

## Overview

CATs work by wrapping an inner puzzle (typically a standard p2 puzzle) with the CAT layer. The CAT layer:

- Enforces that the total CAT amount is preserved across spends (no creation/destruction)
- Identifies the token by its asset ID
- Requires lineage proofs to verify the CAT's history

## Key Types

| Type | Description |
|------|-------------|
| `Cat` | A CAT coin with its info and optional lineage proof |
| `CatInfo` | Asset ID and inner puzzle hash |
| `CatSpend` | Combines a CAT with an inner spend |
| `LineageProof` | Proof of the CAT's parent for validation |

## Issuing CATs

The simplest way to issue a new CAT is using the single-issuance TAIL (genesis by coin ID):

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// The p2 layer for ownership
let p2 = StandardLayer::new(public_key);

// Create hint memos for coin discovery
let memos = ctx.hint(puzzle_hash)?;

// Conditions for the newly created CAT coins
let conditions = Conditions::new()
    .create_coin(puzzle_hash, 1_000, memos);

// Issue the CAT - this returns:
// - issue_cat: Conditions to add to the parent spend
// - cats: Vector of created Cat objects
let (issue_cat, cats) = Cat::issue_with_coin(
    ctx,
    parent_coin_id,  // The coin ID that will be spent to issue
    1_000,           // Total amount to issue
    conditions,      // Output conditions
)?;

// Spend the parent coin with the issuance conditions
p2.spend(ctx, parent_coin, issue_cat)?;

// The asset ID is derived from the parent coin ID
let asset_id = cats[0].info.asset_id;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin, CatInfo, Cat, CatSpend, Simulator } from "chia-wallet-sdk";

const clvm = new Clvm();
const sim = new Simulator();
const alice = sim.bls(1000n);

// Create a simple TAIL (genesis by coin ID uses nil TAIL for single issuance)
const tail = clvm.nil();
const assetId = tail.treeHash();

// Create CAT info with the asset ID and inner puzzle hash
const catInfo = new CatInfo(assetId, null, alice.puzzleHash);

// Issue the CAT by spending the parent coin
clvm.spendStandardCoin(
  alice.coin,
  alice.pk,
  clvm.delegatedSpend([clvm.createCoin(catInfo.puzzleHash(), 1000n)])
);

// Create the eve CAT (first CAT coin)
const eveCat = new Cat(
  new Coin(alice.coin.coinId(), catInfo.puzzleHash(), 1000n),
  null,  // No lineage proof for eve
  catInfo
);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin, CatInfo, Cat, CatSpend, Simulator

clvm = Clvm()
sim = Simulator()
alice = sim.bls(1000)

# Create a simple TAIL (genesis by coin ID uses nil TAIL for single issuance)
tail = clvm.nil()
asset_id = tail.tree_hash()

# Create CAT info with the asset ID and inner puzzle hash
cat_info = CatInfo(asset_id, None, alice.puzzle_hash)

# Issue the CAT by spending the parent coin
clvm.spend_standard_coin(
    alice.coin,
    alice.pk,
    clvm.delegated_spend([clvm.create_coin(cat_info.puzzle_hash(), 1000)])
)

# Create the eve CAT (first CAT coin)
eve_cat = Cat(
    Coin(alice.coin.coin_id(), cat_info.puzzle_hash(), 1000),
    None,  # No lineage proof for eve
    cat_info
)
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
package main

import (
	"log"

	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

func main() {
	clvm, _ := sdk.NewClvm()
	defer clvm.Close()

	sim, _ := sdk.NewSimulator()
	defer sim.Close()

	alice, _ := sim.Bls(1000)
	defer alice.Close()

	// Create a simple TAIL (genesis by coin ID uses nil TAIL for single issuance)
	tail, _ := clvm.Nil()
	defer tail.Close()

	assetId, _ := tail.TreeHash()

	puzzleHash, _ := alice.PuzzleHash()

	// Create CAT info with the asset ID and inner puzzle hash
	catInfo, _ := sdk.NewCatInfo(assetId, nil, puzzleHash)
	defer catInfo.Close()

	catPuzzleHash, _ := catInfo.PuzzleHash()

	// Issue the CAT by spending the parent coin
	createCoin, _ := clvm.CreateCoin(catPuzzleHash, 1000, nil)
	defer createCoin.Close()

	delegated, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin})
	defer delegated.Close()

	coin, _ := alice.Coin()
	defer coin.Close()

	pk, _ := alice.Pk()
	defer pk.Close()

	err := clvm.SpendStandardCoin(coin, pk, delegated)
	if err != nil {
		log.Fatal(err)
	}

	// Create the eve CAT (first CAT coin)
	coinId, _ := coin.CoinId()

	eveCoin, _ := sdk.NewCoin(coinId, catPuzzleHash, 1000)
	defer eveCoin.Close()

	eveCat, _ := sdk.NewCat(eveCoin, nil, catInfo)
	defer eveCat.Close()
}
```

  </TabItem>
</Tabs>

:::info
The asset ID for single-issuance CATs is deterministically derived from the parent coin ID. This means you can calculate the asset ID before issuing.
:::

## Spending CATs

CAT spends require creating a `CatSpend` that combines the CAT with its inner puzzle spend:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Setup
let p2 = StandardLayer::new(public_key);
let memos = ctx.hint(recipient_puzzle_hash)?;

// Create the inner spend (what the standard layer would do)
let inner_spend = p2.spend_with_conditions(
    ctx,
    Conditions::new().create_coin(recipient_puzzle_hash, 1_000, memos),
)?;

// Wrap it in a CatSpend
let cat_spends = [CatSpend::new(cat, inner_spend)];

// Execute all CAT spends
Cat::spend_all(ctx, &cat_spends)?;

let coin_spends = ctx.take();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, CatSpend } from "chia-wallet-sdk";

const clvm = new Clvm();

// Create the inner spend with conditions
const innerSpend = clvm.standardSpend(
  publicKey,
  clvm.delegatedSpend([
    clvm.createCoin(recipientPuzzleHash, 1000n, clvm.alloc([recipientPuzzleHash])),
  ])
);

// Wrap it in a CatSpend and execute
clvm.spendCats([new CatSpend(cat, innerSpend)]);

const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, CatSpend

clvm = Clvm()

# Create the inner spend with conditions
inner_spend = clvm.standard_spend(
    public_key,
    clvm.delegated_spend([
        clvm.create_coin(recipient_puzzle_hash, 1000, clvm.alloc([recipient_puzzle_hash])),
    ])
)

# Wrap it in a CatSpend and execute
clvm.spend_cats([CatSpend(cat, inner_spend)])

coin_spends = clvm.coin_spends()
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
clvm, _ := sdk.NewClvm()
defer clvm.Close()

// Create the inner spend with conditions
memos, _ := clvm.Alloc(sdk.ClvmList{sdk.ClvmBytes(recipientPuzzleHash)})
defer memos.Close()

createCoin, _ := clvm.CreateCoin(recipientPuzzleHash, 1000, memos)
defer createCoin.Close()

delegated, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin})
defer delegated.Close()

innerSpend, _ := clvm.StandardSpend(publicKey, delegated)
defer innerSpend.Close()

// Wrap it in a CatSpend and execute
catSpend, _ := sdk.NewCatSpend(cat, innerSpend)
defer catSpend.Close()

clvm.SpendCats([]*sdk.CatSpend{catSpend})

coinSpends, _ := clvm.CoinSpends()
```

  </TabItem>
</Tabs>

### Why `spend_all`?

CAT spends must be validated together because the CAT layer verifies that the total amount in equals the total amount out. The `Cat::spend_all` function handles:

- Linking CAT spends via announcements
- Ensuring amount conservation
- Validating lineage proofs

## Computing Child Coins

After spending a CAT, you can compute the child CAT:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
// After spending, compute the new CAT
let child_cat = cat.child(recipient_puzzle_hash, 1_000);

// Access the underlying coin
let child_coin = child_cat.coin;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// After spending, compute the new CAT
const childCat = cat.child(recipientPuzzleHash, 1000n);

// Access the underlying coin
const childCoin = childCat.coin;
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# After spending, compute the new CAT
child_cat = cat.child(recipient_puzzle_hash, 1000)

# Access the underlying coin
child_coin = child_cat.coin
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
// After spending, compute the new CAT
childCat, _ := cat.Child(recipientPuzzleHash, 1000)
defer childCat.Close()

// Access the underlying coin
childCoin, _ := childCat.Coin()
defer childCoin.Close()
```

  </TabItem>
</Tabs>

## Multi-Input CAT Spends

When spending multiple CATs of the same asset type together:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
let ctx = &mut SpendContext::new();
let p2 = StandardLayer::new(public_key);

// Build spends for multiple CAT coins
let cat_spends = [
    CatSpend::new(
        cat1,
        p2.spend_with_conditions(ctx, Conditions::new())?,
    ),
    CatSpend::new(
        cat2,
        p2.spend_with_conditions(
            ctx,
            Conditions::new()
                .create_coin(recipient, combined_amount, ctx.hint(recipient)?),
        )?,
    ),
];

Cat::spend_all(ctx, &cat_spends)?;
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
// Build spends for multiple CAT coins
clvm.spendCats([
  new CatSpend(cat1, clvm.standardSpend(publicKey, clvm.delegatedSpend([]))),
  new CatSpend(
    cat2,
    clvm.standardSpend(
      publicKey,
      clvm.delegatedSpend([
        clvm.createCoin(recipient, combinedAmount, clvm.alloc([recipient])),
      ])
    )
  ),
]);
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
# Build spends for multiple CAT coins
clvm.spend_cats([
    CatSpend(cat1, clvm.standard_spend(public_key, clvm.delegated_spend([]))),
    CatSpend(
        cat2,
        clvm.standard_spend(
            public_key,
            clvm.delegated_spend([
                clvm.create_coin(recipient, combined_amount, clvm.alloc([recipient])),
            ])
        )
    ),
])
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
// Build spends for multiple CAT coins
emptyDelegated, _ := clvm.DelegatedSpend([]*sdk.Program{})
defer emptyDelegated.Close()

spend1, _ := clvm.StandardSpend(publicKey, emptyDelegated)
defer spend1.Close()

memos, _ := clvm.Alloc(sdk.ClvmList{sdk.ClvmBytes(recipient)})
defer memos.Close()

createCoin, _ := clvm.CreateCoin(recipient, combinedAmount, memos)
defer createCoin.Close()

delegated2, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin})
defer delegated2.Close()

spend2, _ := clvm.StandardSpend(publicKey, delegated2)
defer spend2.Close()

catSpend1, _ := sdk.NewCatSpend(cat1, spend1)
defer catSpend1.Close()

catSpend2, _ := sdk.NewCatSpend(cat2, spend2)
defer catSpend2.Close()

clvm.SpendCats([]*sdk.CatSpend{catSpend1, catSpend2})
```

  </TabItem>
</Tabs>

## Paying Fees

CATs cannot pay transaction fees directly. To pay fees when spending CATs, you must include an XCH spend in the same transaction and use `assert_concurrent_spend` to link them together:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();
let p2 = StandardLayer::new(public_key);

// Spend the CAT
let memos = ctx.hint(recipient_puzzle_hash)?;
let inner_spend = p2.spend_with_conditions(
    ctx,
    Conditions::new()
        .create_coin(recipient_puzzle_hash, cat.coin.amount, memos)
        .assert_concurrent_spend(xch_coin.coin_id()),  // Link to XCH spend
)?;

Cat::spend_all(ctx, &[CatSpend::new(cat, inner_spend)])?;

// Spend XCH to pay the fee
let fee = 100_000_000;  // 0.0001 XCH
let change = xch_coin.amount - fee;

let mut xch_conditions = Conditions::new()
    .reserve_fee(fee)
    .assert_concurrent_spend(cat.coin.coin_id());  // Link to CAT spend

if change > 0 {
    xch_conditions = xch_conditions.create_coin(
        my_puzzle_hash,
        change,
        ctx.hint(my_puzzle_hash)?,
    );
}

p2.spend(ctx, xch_coin, xch_conditions)?;

let coin_spends = ctx.take();
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
const clvm = new Clvm();

// Spend the CAT (linked to XCH spend)
clvm.spendCats([
  new CatSpend(
    cat,
    clvm.standardSpend(
      publicKey,
      clvm.delegatedSpend([
        clvm.createCoin(recipientPuzzleHash, cat.coin.amount, clvm.alloc([recipientPuzzleHash])),
        clvm.assertConcurrentSpend(xchCoin.coinId()),  // Link to XCH spend
      ])
    )
  ),
]);

// Spend XCH to pay the fee
const fee = 100_000_000n;  // 0.0001 XCH
const change = xchCoin.amount - fee;

const xchConditions = [
  clvm.reserveFee(fee),
  clvm.assertConcurrentSpend(cat.coin.coinId()),  // Link to CAT spend
];

if (change > 0n) {
  xchConditions.push(
    clvm.createCoin(myPuzzleHash, change, clvm.alloc([myPuzzleHash]))
  );
}

clvm.spendStandardCoin(xchCoin, publicKey, clvm.delegatedSpend(xchConditions));

const coinSpends = clvm.coinSpends();
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
clvm = Clvm()

# Spend the CAT (linked to XCH spend)
clvm.spend_cats([
    CatSpend(
        cat,
        clvm.standard_spend(
            public_key,
            clvm.delegated_spend([
                clvm.create_coin(recipient_puzzle_hash, cat.coin.amount, clvm.alloc([recipient_puzzle_hash])),
                clvm.assert_concurrent_spend(xch_coin.coin_id()),  # Link to XCH spend
            ])
        )
    ),
])

# Spend XCH to pay the fee
fee = 100_000_000  # 0.0001 XCH
change = xch_coin.amount - fee

xch_conditions = [
    clvm.reserve_fee(fee),
    clvm.assert_concurrent_spend(cat.coin.coin_id()),  # Link to CAT spend
]

if change > 0:
    xch_conditions.append(
        clvm.create_coin(my_puzzle_hash, change, clvm.alloc([my_puzzle_hash]))
    )

clvm.spend_standard_coin(xch_coin, public_key, clvm.delegated_spend(xch_conditions))

coin_spends = clvm.coin_spends()
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
clvm, _ := sdk.NewClvm()
defer clvm.Close()

catCoin, _ := cat.Coin()
defer catCoin.Close()

catCoinAmount, _ := catCoin.Amount()
catCoinId, _ := catCoin.CoinId()

xchCoinId, _ := xchCoin.CoinId()

// Spend the CAT (linked to XCH spend)
memos, _ := clvm.Alloc(sdk.ClvmList{sdk.ClvmBytes(recipientPuzzleHash)})
defer memos.Close()

createCoin, _ := clvm.CreateCoin(recipientPuzzleHash, catCoinAmount, memos)
defer createCoin.Close()

assertSpend, _ := clvm.AssertConcurrentSpend(xchCoinId) // Link to XCH spend
defer assertSpend.Close()

delegated, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin, assertSpend})
defer delegated.Close()

innerSpend, _ := clvm.StandardSpend(publicKey, delegated)
defer innerSpend.Close()

catSpend, _ := sdk.NewCatSpend(cat, innerSpend)
defer catSpend.Close()

clvm.SpendCats([]*sdk.CatSpend{catSpend})

// Spend XCH to pay the fee
var fee uint64 = 100_000_000 // 0.0001 XCH
xchAmount, _ := xchCoin.Amount()
change := xchAmount - fee

reserveFee, _ := clvm.ReserveFee(fee)
defer reserveFee.Close()

assertCatSpend, _ := clvm.AssertConcurrentSpend(catCoinId) // Link to CAT spend
defer assertCatSpend.Close()

xchConditions := []*sdk.Program{reserveFee, assertCatSpend}

if change > 0 {
	changeMemos, _ := clvm.Alloc(sdk.ClvmList{sdk.ClvmBytes(myPuzzleHash)})
	defer changeMemos.Close()

	changeCoin, _ := clvm.CreateCoin(myPuzzleHash, change, changeMemos)
	defer changeCoin.Close()

	xchConditions = append(xchConditions, changeCoin)
}

xchDelegated, _ := clvm.DelegatedSpend(xchConditions)
defer xchDelegated.Close()

clvm.SpendStandardCoin(xchCoin, publicKey, xchDelegated)

coinSpends, _ := clvm.CoinSpends()
```

  </TabItem>
</Tabs>

:::warning
Always use `assert_concurrent_spend` to link CAT and XCH spends together. Without this, an attacker could extract and submit only the XCH spend (with the fee) while discarding your CAT spend.
:::

## Lineage Proofs

CATs require lineage proofs to verify their authenticity. When parsing CATs from the blockchain, you'll need to track the parent information:

```rust
// A CAT with its lineage proof
let cat = Cat {
    coin,
    info: CatInfo {
        asset_id,
        inner_puzzle_hash,
    },
    lineage_proof: Some(LineageProof {
        parent_parent_coin_info: parent_coin.parent_coin_info,
        parent_inner_puzzle_hash: parent_inner_puzzle_hash,
        parent_amount: parent_coin.amount,
    }),
};
```

When issuing new CATs, the lineage proof is handled automatically by the SDK.

## Complete Example

Here's a full example of issuing a CAT and then spending it:

<Tabs>
  <TabItem value="rust" label="Rust" default>

```rust
use chia_wallet_sdk::prelude::*;

fn issue_and_spend_cat(
    issuer_coin: Coin,
    issuer_public_key: PublicKey,
    recipient_puzzle_hash: Bytes32,
    amount: u64,
) -> Result<(Bytes32, Vec<CoinSpend>), DriverError> {
    let ctx = &mut SpendContext::new();
    let p2 = StandardLayer::new(issuer_public_key);
    let issuer_puzzle_hash = StandardLayer::puzzle_hash(issuer_public_key);

    // Step 1: Issue the CAT
    let memos = ctx.hint(issuer_puzzle_hash)?;
    let issue_conditions = Conditions::new()
        .create_coin(issuer_puzzle_hash, amount, memos);

    let (issue_cat, cats) = Cat::issue_with_coin(
        ctx,
        issuer_coin.coin_id(),
        amount,
        issue_conditions,
    )?;

    p2.spend(ctx, issuer_coin, issue_cat)?;

    let asset_id = cats[0].info.asset_id;
    let cat = cats[0];

    // Step 2: Immediately spend the CAT to the recipient
    let transfer_memos = ctx.hint(recipient_puzzle_hash)?;
    let inner_spend = p2.spend_with_conditions(
        ctx,
        Conditions::new().create_coin(recipient_puzzle_hash, amount, transfer_memos),
    )?;

    Cat::spend_all(ctx, &[CatSpend::new(cat, inner_spend)])?;

    Ok((asset_id, ctx.take()))
}
```

  </TabItem>
  <TabItem value="nodejs" label="Node.js">

```typescript
import { Clvm, Coin, CatInfo, Cat, CatSpend, Simulator } from "chia-wallet-sdk";

function issueAndSpendCat(recipientPuzzleHash: Uint8Array, amount: bigint) {
  const clvm = new Clvm();
  const sim = new Simulator();
  const alice = sim.bls(amount);

  // Step 1: Create TAIL and issue CAT
  const tail = clvm.nil();
  const assetId = tail.treeHash();
  const catInfo = new CatInfo(assetId, null, alice.puzzleHash);

  // Issue the CAT
  clvm.spendStandardCoin(
    alice.coin,
    alice.pk,
    clvm.delegatedSpend([clvm.createCoin(catInfo.puzzleHash(), amount)])
  );

  // Create eve CAT
  const eveCat = new Cat(
    new Coin(alice.coin.coinId(), catInfo.puzzleHash(), amount),
    null,
    catInfo
  );

  // Step 2: Spend the CAT with TAIL reveal, then transfer
  clvm.spendCats([
    new CatSpend(
      eveCat,
      clvm.standardSpend(
        alice.pk,
        clvm.delegatedSpend([
          clvm.createCoin(recipientPuzzleHash, amount, clvm.alloc([recipientPuzzleHash])),
          clvm.runCatTail(tail, clvm.nil()),
        ])
      )
    ),
  ]);

  // Sign and validate
  sim.spendCoins(clvm.coinSpends(), [alice.sk]);

  return assetId;
}
```

  </TabItem>
  <TabItem value="python" label="Python">

```python
from chia_wallet_sdk import Clvm, Coin, CatInfo, Cat, CatSpend, Simulator

def issue_and_spend_cat(recipient_puzzle_hash: bytes, amount: int):
    clvm = Clvm()
    sim = Simulator()
    alice = sim.bls(amount)

    # Step 1: Create TAIL and issue CAT
    tail = clvm.nil()
    asset_id = tail.tree_hash()
    cat_info = CatInfo(asset_id, None, alice.puzzle_hash)

    # Issue the CAT
    clvm.spend_standard_coin(
        alice.coin,
        alice.pk,
        clvm.delegated_spend([clvm.create_coin(cat_info.puzzle_hash(), amount)])
    )

    # Create eve CAT
    eve_cat = Cat(
        Coin(alice.coin.coin_id(), cat_info.puzzle_hash(), amount),
        None,
        cat_info
    )

    # Step 2: Spend the CAT with TAIL reveal, then transfer
    clvm.spend_cats([
        CatSpend(
            eve_cat,
            clvm.standard_spend(
                alice.pk,
                clvm.delegated_spend([
                    clvm.create_coin(recipient_puzzle_hash, amount, clvm.alloc([recipient_puzzle_hash])),
                    clvm.run_cat_tail(tail, clvm.nil()),
                ])
            )
        ),
    ])

    # Sign and validate
    sim.spend_coins(clvm.coin_spends(), [alice.sk])

    return asset_id
```

  </TabItem>
  <TabItem value="go" label="Go">

```go
package main

import (
	"log"

	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

func issueAndSpendCat(recipientPuzzleHash []byte, amount uint64) ([]byte, error) {
	clvm, err := sdk.NewClvm()
	if err != nil {
		return nil, err
	}
	defer clvm.Close()

	sim, err := sdk.NewSimulator()
	if err != nil {
		return nil, err
	}
	defer sim.Close()

	alice, err := sim.Bls(amount)
	if err != nil {
		return nil, err
	}
	defer alice.Close()

	// Step 1: Create TAIL and issue CAT
	tail, _ := clvm.Nil()
	defer tail.Close()

	assetId, _ := tail.TreeHash()

	puzzleHash, _ := alice.PuzzleHash()

	catInfo, _ := sdk.NewCatInfo(assetId, nil, puzzleHash)
	defer catInfo.Close()

	catPuzzleHash, _ := catInfo.PuzzleHash()

	// Issue the CAT
	createCoin, _ := clvm.CreateCoin(catPuzzleHash, amount, nil)
	defer createCoin.Close()

	delegated, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin})
	defer delegated.Close()

	coin, _ := alice.Coin()
	defer coin.Close()

	pk, _ := alice.Pk()
	defer pk.Close()

	clvm.SpendStandardCoin(coin, pk, delegated)

	// Create eve CAT
	coinId, _ := coin.CoinId()

	eveCoin, _ := sdk.NewCoin(coinId, catPuzzleHash, amount)
	defer eveCoin.Close()

	eveCat, _ := sdk.NewCat(eveCoin, nil, catInfo)
	defer eveCat.Close()

	// Step 2: Spend the CAT with TAIL reveal, then transfer
	memos, _ := clvm.Alloc(sdk.ClvmList{sdk.ClvmBytes(recipientPuzzleHash)})
	defer memos.Close()

	transferCoin, _ := clvm.CreateCoin(recipientPuzzleHash, amount, memos)
	defer transferCoin.Close()

	nilSolution, _ := clvm.Nil()
	defer nilSolution.Close()

	runTail, _ := clvm.RunCatTail(tail, nilSolution)
	defer runTail.Close()

	innerDelegated, _ := clvm.DelegatedSpend([]*sdk.Program{transferCoin, runTail})
	defer innerDelegated.Close()

	innerSpend, _ := clvm.StandardSpend(pk, innerDelegated)
	defer innerSpend.Close()

	catSpend, _ := sdk.NewCatSpend(eveCat, innerSpend)
	defer catSpend.Close()

	clvm.SpendCats([]*sdk.CatSpend{catSpend})

	// Sign and validate
	sk, _ := alice.Sk()
	defer sk.Close()

	coinSpends, _ := clvm.CoinSpends()
	sim.SpendCoins(coinSpends, []*sdk.SecretKey{sk})

	return assetId, nil
}

func main() {
	assetId, err := issueAndSpendCat(make([]byte, 32), 1000)
	if err != nil {
		log.Fatal(err)
	}
	_ = assetId
}
```

  </TabItem>
</Tabs>

## API Reference

For the complete CAT API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Cat.html).
