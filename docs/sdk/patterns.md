---
slug: /sdk/patterns
title: Application Patterns
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Application Patterns

This page covers common patterns for structuring applications that use the Wallet SDK.

## SpendContext Lifecycle

### Single Transaction Pattern

For simple operations, create a SpendContext, use it, and discard:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
func sendPayment(/* params */) (*sdk.SpendBundle, error) {
    clvm, _ := sdk.NewClvm()
    defer clvm.Close()

    // Build transaction
    spend, _ := clvm.DelegatedSpend(conditions)
    defer spend.Close()
    stdSpend, _ := clvm.StandardSpend(syntheticKey, spend)
    defer stdSpend.Close()
    clvm.SpendStandardCoin(coin, syntheticKey, stdSpend)

    // Extract, sign, return
    coinSpends, _ := clvm.CoinSpends()
    return signAndBundle(coinSpends)
}
```

  </TabItem>
</Tabs>

### Reusable Context Pattern

For multiple transactions, reuse the context to benefit from puzzle caching:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
type TransactionBuilder struct {
    clvm *sdk.Clvm
}

func NewTransactionBuilder() *TransactionBuilder {
    clvm, _ := sdk.NewClvm()
    return &TransactionBuilder{clvm: clvm}
}

func (b *TransactionBuilder) Close() error {
    return b.clvm.Close()
}

func (b *TransactionBuilder) BuildPayment(/* params */) ([]*sdk.CoinSpend, error) {
    // Use b.clvm for building
    spend, _ := b.clvm.DelegatedSpend(conditions)
    defer spend.Close()
    stdSpend, _ := b.clvm.StandardSpend(syntheticKey, spend)
    defer stdSpend.Close()
    b.clvm.SpendStandardCoin(coin, syntheticKey, stdSpend)

    // CoinSpends() returns accumulated spends and resets
    return b.clvm.CoinSpends()
}
```

  </TabItem>
</Tabs>

## Batching Transactions

### Multiple Independent Spends

When spending multiple coins, batch them in one transaction and link them with `assert_concurrent_spend`:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
clvm, _ := sdk.NewClvm()
defer clvm.Close()

// Collect all coin IDs for concurrent spend assertions
var coinIds [][]byte
for _, coin := range coins {
    id, _ := coin.CoinId()
    coinIds = append(coinIds, id)
}

// Spend multiple coins in one transaction
for i, coin := range coins {
    // Build conditions with create_coin
    var conditions []*sdk.Program
    cc, _ := sdk.NewCreateCoin(destination, coin.Amount(), memos)
    defer cc.Close()
    ccProg, _ := clvm.CreateCoin(cc)
    conditions = append(conditions, ccProg)

    // Link to all other coins in the transaction
    for j, otherId := range coinIds {
        if i != j {
            acs, _ := sdk.NewAssertConcurrentSpend(otherId)
            defer acs.Close()
            acsProg, _ := clvm.AssertConcurrentSpend(acs)
            conditions = append(conditions, acsProg)
        }
    }

    spend, _ := clvm.DelegatedSpend(conditions)
    defer spend.Close()
    stdSpend, _ := clvm.StandardSpend(syntheticKeys[i], spend)
    defer stdSpend.Close()
    clvm.SpendStandardCoin(coin, syntheticKeys[i], stdSpend)
}

coinSpends, _ := clvm.CoinSpends()
```

  </TabItem>
</Tabs>

:::warning
Always use `assert_concurrent_spend` to link coins in a multi-spend transaction. Without it, an attacker could extract individual spends from your signed bundle.
:::

### Dependent Spends

When spends depend on each other (e.g., parent-child), ensure proper ordering:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
clvm, _ := sdk.NewClvm()
defer clvm.Close()

// First spend creates a coin
// ... build conditions with CreateCoin for intermediate_ph, 1000
clvm.SpendStandardCoin(parentCoin, syntheticKey1, firstSpend)

// Calculate the created coin
parentId, _ := parentCoin.CoinId()
childCoin, _ := sdk.NewCoin(parentId, intermediatePh, 1000)
defer childCoin.Close()

// Second spend uses the created coin (ephemeral spend)
// ... build conditions with CreateCoin + ReserveFee
clvm.SpendStandardCoin(childCoin, syntheticKey2, secondSpend)

coinSpends, _ := clvm.CoinSpends()
```

  </TabItem>
</Tabs>

## Coin Management

### Coin Selection

When you have multiple coins, select appropriately:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
func selectCoins(available []*sdk.Coin, targetAmount uint64) []*sdk.Coin {
    var selected []*sdk.Coin
    var total uint64

    // Simple greedy selection
    for _, coin := range available {
        if total >= targetAmount {
            break
        }
        selected = append(selected, coin)
        amount, _ := coin.Amount()
        total += amount
    }

    return selected
}
```

  </TabItem>
</Tabs>

### Change Handling

Always account for change when the input exceeds the output:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
func buildWithChange(
    clvm *sdk.Clvm,
    coin *sdk.Coin,
    syntheticKey *sdk.PublicKey,
    sendAmount uint64,
    recipient []byte,
    fee uint64,
) error {
    amount, _ := coin.Amount()
    change := amount - sendAmount - fee

    var conditions []*sdk.Program
    // Create coin for recipient
    cc, _ := sdk.NewCreateCoin(recipient, sendAmount, nil)
    defer cc.Close()
    ccProg, _ := clvm.CreateCoin(cc)
    conditions = append(conditions, ccProg)

    // Reserve fee
    rf, _ := sdk.NewReserveFee(fee)
    defer rf.Close()
    rfProg, _ := clvm.ReserveFee(rf)
    conditions = append(conditions, rfProg)

    // Change output
    if change > 0 {
        changeCc, _ := sdk.NewCreateCoin(senderPh, change, nil)
        defer changeCc.Close()
        changeProg, _ := clvm.CreateCoin(changeCc)
        conditions = append(conditions, changeProg)
    }

    spend, _ := clvm.DelegatedSpend(conditions)
    defer spend.Close()
    stdSpend, _ := clvm.StandardSpend(syntheticKey, spend)
    defer stdSpend.Close()
    return clvm.SpendStandardCoin(coin, syntheticKey, stdSpend)
}
```

  </TabItem>
</Tabs>

## Error Handling

### Graceful Error Recovery

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
func tryBuildTransaction(/* params */) ([]*sdk.CoinSpend, error) {
    clvm, _ := sdk.NewClvm()
    defer clvm.Close() // Always cleaned up, even on error

    // Attempt to build
    if err := buildComplexSpend(clvm /* params */); err != nil {
        return nil, err
    }

    return clvm.CoinSpends()
}
```

  </TabItem>
</Tabs>

## Signing Patterns

### Collecting Required Signatures

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
func signSpends(
    coinSpends []*sdk.CoinSpend,
    secretKeys []*sdk.SecretKey,
) (*sdk.Signature, error) {
    // Sign each spend with the appropriate key
    var sigs []*sdk.Signature
    for _, sk := range secretKeys {
        msg := /* compute message for this key */
        sig, _ := sk.Sign(msg)
        sigs = append(sigs, sig)
    }

    // Aggregate signatures
    return sdk.NewSignatureAggregate(sigs)
}
```

  </TabItem>
</Tabs>

### Multi-Party Signing

When multiple parties need to sign:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
// Party 1 builds and partially signs
coinSpends := buildTransaction()
sig1, _ := signMyPortion(coinSpends, myKeys)

// Serialize and send to Party 2
// (serialize coinSpends and sig1 for transport)

// Party 2 adds their signature
sig2, _ := signMyPortion(coinSpends, theirKeys)

// Combine and broadcast
finalSig, _ := sdk.NewSignatureAggregate([]*sdk.Signature{sig1, sig2})
defer finalSig.Close()
bundle, _ := sdk.NewSpendBundle(coinSpends, finalSig)
defer bundle.Close()
```

  </TabItem>
</Tabs>

## State Tracking

### Tracking Coin State

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
type WalletState struct {
    coins         map[string]*sdk.Coin // keyed by hex coin ID
    pendingSpends map[string]bool
}

func (w *WalletState) MarkSpent(coinId []byte) {
    w.pendingSpends[hex.EncodeToString(coinId)] = true
}

func (w *WalletState) ConfirmSpent(coinId []byte) {
    key := hex.EncodeToString(coinId)
    if coin, ok := w.coins[key]; ok {
        coin.Close()
        delete(w.coins, key)
    }
    delete(w.pendingSpends, key)
}

func (w *WalletState) AvailableCoins() []*sdk.Coin {
    var available []*sdk.Coin
    for id, coin := range w.coins {
        if !w.pendingSpends[id] {
            available = append(available, coin)
        }
    }
    return available
}
```

  </TabItem>
</Tabs>

### Tracking NFT/CAT State

For singletons and CATs, track the current coin after each spend:

<Tabs groupId="language">
  <TabItem value="rust" label="Rust" default>

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

  </TabItem>
  <TabItem value="go" label="Go">

```go
type NftTracker struct {
    nft *sdk.Nft
}

func (t *NftTracker) AfterTransfer(newNft *sdk.Nft) {
    if t.nft != nil {
        t.nft.Close()
    }
    t.nft = newNft
}

func (t *NftTracker) CurrentCoin() (*sdk.Coin, error) {
    return t.nft.Coin()
}

func (t *NftTracker) Close() error {
    if t.nft != nil {
        return t.nft.Close()
    }
    return nil
}
```

  </TabItem>
</Tabs>

## Best Practices

1. **Link multi-coin spends** - Always use `assert_concurrent_spend` when spending multiple coins
2. **Validate locally first** - Use the simulator before mainnet
3. **Handle change** - Never lose funds to missing change outputs
4. **Use hints** - Include memos for wallet discovery
5. **Batch when possible** - Reduce fees by combining spends
6. **Track state** - Keep your local view synchronized
7. **Reuse SpendContext** - Benefit from puzzle caching
8. **Handle errors gracefully** - SpendContext cleanup is automatic
