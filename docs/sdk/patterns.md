---
slug: /sdk/patterns
title: Application Patterns
---

# Application Patterns

This page covers common patterns for structuring applications that use the Wallet SDK.

## SpendContext Lifecycle

### Single Transaction Pattern

For simple operations, create a SpendContext, use it, and discard:

```rust
fn send_payment(/* params */) -> Result<SpendBundle> {
    let ctx = &mut SpendContext::new();

    // Build transaction
    StandardLayer::new(pk).spend(ctx, coin, conditions)?;

    // Extract, sign, return
    let spends = ctx.take();
    sign_and_bundle(spends)
}
```

### Reusable Context Pattern

For multiple transactions, reuse the context to benefit from puzzle caching:

```rust
struct TransactionBuilder {
    ctx: SpendContext,
}

impl TransactionBuilder {
    fn new() -> Self {
        Self {
            ctx: SpendContext::new(),
        }
    }

    fn build_payment(&mut self, /* params */) -> Result<Vec<CoinSpend>> {
        // Use self.ctx for building
        StandardLayer::new(pk).spend(&mut self.ctx, coin, conditions)?;

        // take() empties the context but preserves puzzle cache
        Ok(self.ctx.take())
    }
}
```

## Batching Transactions

### Multiple Independent Spends

When spending multiple coins, batch them in one transaction and link them with `assert_concurrent_spend`:

```rust
let ctx = &mut SpendContext::new();
let coins: Vec<(Coin, PublicKey)> = /* your coins */;

// Collect all coin IDs for concurrent spend assertions
let coin_ids: Vec<Bytes32> = coins.iter().map(|(c, _)| c.coin_id()).collect();

// Spend multiple coins in one transaction
for (i, (coin, pk)) in coins.iter().enumerate() {
    let mut conditions = Conditions::new()
        .create_coin(destination, coin.amount, Memos::None);

    // Link to all other coins in the transaction
    for (j, other_id) in coin_ids.iter().enumerate() {
        if i != j {
            conditions = conditions.assert_concurrent_spend(*other_id);
        }
    }

    StandardLayer::new(*pk).spend(ctx, *coin, conditions)?;
}

let spends = ctx.take();
```

:::warning
Always use `assert_concurrent_spend` to link coins in a multi-spend transaction. Without it, an attacker could extract individual spends from your signed bundle.
:::

### Dependent Spends

When spends depend on each other (e.g., parent-child), ensure proper ordering:

```rust
let ctx = &mut SpendContext::new();

// First spend creates a coin
let conditions = Conditions::new()
    .create_coin(intermediate_ph, 1000, Memos::None);
StandardLayer::new(pk1).spend(ctx, parent_coin, conditions)?;

// Calculate the created coin
let child_coin = Coin::new(parent_coin.coin_id(), intermediate_ph, 1000);

// Second spend uses the created coin (ephemeral spend)
let conditions = Conditions::new()
    .create_coin(final_destination, 900, Memos::None)
    .reserve_fee(100);
StandardLayer::new(pk2).spend(ctx, child_coin, conditions)?;

let spends = ctx.take();
```

## Coin Management

### Coin Selection

When you have multiple coins, select appropriately:

```rust
fn select_coins(
    available: &[Coin],
    target_amount: u64,
) -> Vec<Coin> {
    let mut selected = Vec::new();
    let mut total = 0;

    // Simple greedy selection
    for coin in available {
        if total >= target_amount {
            break;
        }
        selected.push(*coin);
        total += coin.amount;
    }

    selected
}
```

### Change Handling

Always account for change when the input exceeds the output:

```rust
fn build_with_change(
    ctx: &mut SpendContext,
    coin: Coin,
    pk: PublicKey,
    send_amount: u64,
    recipient: Bytes32,
    fee: u64,
) -> Result<()> {
    let sender_ph = StandardLayer::puzzle_hash(pk);
    let change = coin.amount.saturating_sub(send_amount).saturating_sub(fee);

    let mut conditions = Conditions::new()
        .create_coin(recipient, send_amount, ctx.hint(recipient)?)
        .reserve_fee(fee);

    if change > 0 {
        conditions = conditions.create_coin(sender_ph, change, ctx.hint(sender_ph)?);
    }

    StandardLayer::new(pk).spend(ctx, coin, conditions)?;
    Ok(())
}
```

## Error Handling

### Graceful Error Recovery

```rust
fn try_build_transaction(/* params */) -> Result<Vec<CoinSpend>> {
    let ctx = &mut SpendContext::new();

    // Attempt to build
    match build_complex_spend(ctx, /* params */) {
        Ok(()) => Ok(ctx.take()),
        Err(e) => {
            // Context can be safely dropped
            // No cleanup needed
            Err(e)
        }
    }
}
```

### Validation Before Broadcast

Always validate before broadcasting to mainnet:

```rust
fn safe_broadcast(
    spends: Vec<CoinSpend>,
    secret_keys: &[SecretKey],
) -> Result<()> {
    // Validate with simulator first
    let mut sim = Simulator::new();
    // ... setup sim state to match expected blockchain state ...

    sim.spend_coins(spends.clone(), secret_keys)?;

    // Only broadcast if simulation succeeds
    broadcast_to_network(spends)
}
```

## Signing Patterns

### Collecting Required Signatures

```rust
fn sign_spends(
    coin_spends: &[CoinSpend],
    secret_keys: &[SecretKey],
    agg_sig_data: &[u8],
) -> Result<Signature> {
    // Calculate what needs to be signed
    let required = RequiredSignature::from_coin_spends(
        coin_spends,
        agg_sig_data,
    )?;

    // Sign each requirement
    let mut signatures = Vec::new();
    for req in required {
        let sk = find_key_for_pk(&req.public_key, secret_keys)?;
        signatures.push(sign(&sk, &req.message));
    }

    // Aggregate signatures
    Ok(aggregate(&signatures))
}
```

### Multi-Party Signing

When multiple parties need to sign:

```rust
// Party 1 builds and partially signs
let spends = build_transaction()?;
let sig1 = sign_my_portion(&spends, &my_keys)?;

// Serialize and send to Party 2
let partial = PartialTransaction { spends, signatures: vec![sig1] };

// Party 2 adds their signature
let sig2 = sign_my_portion(&partial.spends, &their_keys)?;
partial.signatures.push(sig2);

// Combine and broadcast
let final_sig = aggregate(&partial.signatures);
let bundle = SpendBundle::new(partial.spends, final_sig);
```

## State Tracking

### Tracking Coin State

```rust
struct WalletState {
    coins: HashMap<Bytes32, Coin>,
    pending_spends: HashSet<Bytes32>,
}

impl WalletState {
    fn mark_spent(&mut self, coin_id: Bytes32) {
        self.pending_spends.insert(coin_id);
    }

    fn confirm_spent(&mut self, coin_id: Bytes32) {
        self.coins.remove(&coin_id);
        self.pending_spends.remove(&coin_id);
    }

    fn available_coins(&self) -> impl Iterator<Item = &Coin> {
        self.coins.values()
            .filter(|c| !self.pending_spends.contains(&c.coin_id()))
    }
}
```

### Tracking NFT/CAT State

For singletons and CATs, track the current coin after each spend:

```rust
struct NftTracker {
    nft: Nft<NftMetadata>,
}

impl NftTracker {
    fn after_transfer(&mut self, new_nft: Nft<NftMetadata>) {
        self.nft = new_nft;
    }

    fn current_coin(&self) -> &Coin {
        &self.nft.coin
    }
}
```

## Best Practices

1. **Link multi-coin spends** - Always use `assert_concurrent_spend` when spending multiple coins
2. **Validate locally first** - Use the simulator before mainnet
3. **Handle change** - Never lose funds to missing change outputs
4. **Use hints** - Include memos for wallet discovery
5. **Batch when possible** - Reduce fees by combining spends
6. **Track state** - Keep your local view synchronized
7. **Reuse SpendContext** - Benefit from puzzle caching
8. **Handle errors gracefully** - SpendContext cleanup is automatic
