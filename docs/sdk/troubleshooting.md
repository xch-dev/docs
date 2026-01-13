---
slug: /sdk/troubleshooting
title: Troubleshooting
---

# Troubleshooting

This page covers common issues when working with the Wallet SDK and how to resolve them.

## My spend failed to validate

### Symptoms

- Simulator returns an error
- Transaction rejected by full node
- CLVM execution fails

### Common Causes

**Incorrect puzzle hash**

The puzzle hash used to create a coin must match the puzzle used to spend it:

```rust
// When creating a coin
let puzzle_hash = StandardLayer::puzzle_hash(public_key);
conditions.create_coin(puzzle_hash, amount, memos);

// When spending, use the same key
StandardLayer::new(public_key).spend(ctx, coin, conditions)?;
```

**Mismatched amounts**

Output amounts must not exceed input amounts:

```rust
// Input: 1000 mojos
let coin_amount = 1000;

// Outputs must sum to <= 1000
let send_amount = 900;
let fee = 100;
// Total: 900 + 100 = 1000 ✓
```

**Missing lineage proof**

CATs and singletons require valid lineage proofs:

```rust
// Ensure CAT has lineage proof set
let cat = Cat {
    coin,
    info,
    lineage_proof: Some(lineage_proof), // Required for spending
};
```

---

## Signature invalid

### Symptoms

- `AggSig validation failed`
- Transaction rejected with signature error
- Spend bundle won't aggregate

### Common Causes

**Wrong key used for signing**

Ensure you sign with the key that matches the puzzle:

```rust
// The public key in the puzzle
let p2 = StandardLayer::new(alice.pk);
p2.spend(ctx, coin, conditions)?;

// Must sign with the corresponding secret key
sim.spend_coins(spends, &[alice.sk])?;  // Not bob.sk!
```

**Missing signatures**

Multi-input transactions may require multiple signatures:

```rust
// If spending coins from different keys
StandardLayer::new(alice.pk).spend(ctx, coin1, conditions1)?;
StandardLayer::new(bob.pk).spend(ctx, coin2, conditions2)?;

// Both keys must sign
sim.spend_coins(spends, &[alice.sk, bob.sk])?;
```

**Incorrect AGG_SIG_ME data**

When signing manually, ensure you use the correct AGG_SIG_ME additional data:

```rust
// AGG_SIG_ME includes coin_id + genesis_challenge
// Make sure you're using the right network's genesis challenge
```

---

## Coin not found

### Symptoms

- `Coin not in database`
- `Unknown coin`
- Spend references non-existent coin

### Common Causes

**Coin already spent**

A coin can only be spent once. Check if it's already been used:

```rust
// Each coin has a unique ID
let coin_id = coin.coin_id();

// If this coin was spent in a previous transaction,
// you cannot spend it again
```

**Incorrect coin construction**

When computing child coins, ensure the values match:

```rust
// The child coin is determined by:
let child = Coin::new(
    parent_coin.coin_id(),  // Parent's coin ID
    puzzle_hash,            // Must match create_coin puzzle hash
    amount,                 // Must match create_coin amount
);
```

**Transaction not confirmed**

If depending on a recent transaction, ensure it's confirmed:

```rust
// In simulation, spends are instant
// On mainnet, wait for block confirmation before using outputs
```

---

## Announcement assertion failed

### Symptoms

- `ASSERT_COIN_ANNOUNCEMENT_FAIL`
- `ASSERT_PUZZLE_ANNOUNCEMENT_FAIL`
- Announcements don't match

### Common Causes

**Incorrect announcement ID calculation**

Coin announcements include the coin ID:

```rust
// Coin announcement ID = sha256(coin_id + message)
// Puzzle announcement ID = sha256(puzzle_hash + message)

// When asserting, the ID must match exactly
conditions
    .create_coin_announcement(message)
    .assert_coin_announcement(expected_announcement_id);
```

**Missing announcement creation**

Every assertion needs a corresponding creation:

```rust
// Spend 1: Create the announcement
let conditions1 = Conditions::new()
    .create_coin_announcement(b"hello");

// Spend 2: Assert the announcement
let announcement_id = /* calculate from coin_id + message */;
let conditions2 = Conditions::new()
    .assert_coin_announcement(announcement_id);
```

**Different message bytes**

Ensure message bytes match exactly:

```rust
// These are different!
b"hello"      // [104, 101, 108, 108, 111]
"hello"       // String, needs .as_bytes()
```

---

## Insufficient fee

### Symptoms

- Transaction sits in mempool
- `Fee too low`
- Transaction eventually dropped

### Common Causes

**No fee specified**

Always include a fee for mainnet transactions:

```rust
let conditions = Conditions::new()
    .create_coin(recipient, amount, memos)
    .reserve_fee(fee);  // Don't forget this
```

**Fee calculation**

Fees are in mojos. During high demand, fees may need to be higher:

```rust
// Minimum fee depends on network conditions
// Check current fee estimates from a full node
let fee = 100_000_000;  // 0.0001 XCH = 100M mojos
```

**Fee in wrong spend**

If batching multiple spends, fee can be in any one of them:

```rust
// This is fine - fee in second spend
StandardLayer::new(pk1).spend(ctx, coin1, Conditions::new()
    .create_coin(dest, amount1, memos))?;

StandardLayer::new(pk2).spend(ctx, coin2, Conditions::new()
    .create_coin(dest, amount2, memos)
    .reserve_fee(fee))?;  // Fee here covers both
```

---

## CAT amount mismatch

### Symptoms

- CAT spend fails validation
- `CAT amount mismatch`
- Lineage verification fails

### Common Causes

**Input/output imbalance**

CAT amounts must balance (no creation or destruction):

```rust
// If spending 1000 CAT, must output 1000 CAT
let cat_spends = [CatSpend::new(
    cat,  // 1000 CAT input
    inner_spend_with_conditions,  // Must create exactly 1000 CAT output
)];
```

:::info
CATs cannot pay transaction fees directly. Fees must be paid with XCH in a separate spend within the same transaction.
:::

---

## Spends can be separated / Partial bundle attack

### Symptoms

- Multi-coin transaction behaves unexpectedly
- Funds lost when only some spends execute
- Attacker extracts individual spends from your bundle

### Common Causes

**Missing `assert_concurrent_spend`**

When spending multiple coins together, you must link them:

```rust
// WRONG: Spends can be separated
let conditions1 = Conditions::new()
    .create_coin(recipient, 1000, memos);
StandardLayer::new(pk1).spend(ctx, coin1, conditions1)?;

let conditions2 = Conditions::new()
    .reserve_fee(100);
StandardLayer::new(pk2).spend(ctx, coin2, conditions2)?;

// RIGHT: Spends are linked and atomic
let conditions1 = Conditions::new()
    .create_coin(recipient, 1000, memos)
    .assert_concurrent_spend(coin2.coin_id());  // Link to coin2
StandardLayer::new(pk1).spend(ctx, coin1, conditions1)?;

let conditions2 = Conditions::new()
    .reserve_fee(100)
    .assert_concurrent_spend(coin1.coin_id());  // Link to coin1
StandardLayer::new(pk2).spend(ctx, coin2, conditions2)?;
```

:::warning
Without `assert_concurrent_spend`, an attacker can take your signed spend bundle, remove some spends, and submit only the ones beneficial to them. Always link all spends in a multi-coin transaction.
:::

---

## General Debugging Tips

### Use the Simulator

Always test with the simulator first:

```rust
let mut sim = Simulator::new();
// Setup state...
let result = sim.spend_coins(spends, &keys);

if let Err(e) = result {
    println!("Spend failed: {:?}", e);
}
```

### Check Puzzle Hashes

Verify puzzle hashes match:

```rust
println!("Expected: {}", StandardLayer::puzzle_hash(pk));
println!("Actual: {}", coin.puzzle_hash);
```

### Verify Amounts

Ensure amounts balance:

```rust
let total_input: u64 = coins.iter().map(|c| c.amount).sum();
let total_output: u64 = /* sum of create_coin amounts + fee */;

assert_eq!(total_input, total_output, "Amount mismatch");
```

### Inspect Conditions

Print conditions before spending:

```rust
let conditions = Conditions::new()
    .create_coin(ph, amount, memos)
    .reserve_fee(fee);

println!("Conditions: {:?}", conditions);
```

## Getting Help

If you're stuck:

1. Check the [SDK rustdocs](https://docs.rs/chia-wallet-sdk) for API details
2. Review the [examples](https://github.com/Chia-Network/chia-wallet-sdk/tree/main/examples)
3. Search existing issues on [GitHub](https://github.com/Chia-Network/chia-wallet-sdk/issues)
4. Ask in the Chia developer community
