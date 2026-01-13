---
slug: /sdk/primitives/vault
title: Vault
---

# Vault

Vaults provide multi-signature custody for Chia assets. They enable secure storage patterns where multiple parties or conditions must be satisfied to spend funds.

## Overview

A Vault in the Chia Wallet SDK implements a custody pattern where:

- Funds are locked in a singleton that tracks custody state
- Spending requires satisfying the vault's custody conditions
- The vault maintains its identity across spends (like NFTs)

Vaults are particularly useful for:

- Multi-signature wallets requiring M-of-N approval
- Time-locked custody arrangements
- Institutional custody solutions
- Escrow patterns

## Key Types

| Type | Description |
|------|-------------|
| `Vault` | A vault singleton with its custody info |
| `MipsSpend` | Multi-input puzzle spend for vault operations |

## Vault Structure

Vaults are singleton-based, meaning they maintain a persistent identity through a launcher ID. The vault's custody conditions are defined by a custody hash that determines what's required to spend.

```rust
use chia_wallet_sdk::prelude::*;

// A vault with its custody configuration
let vault = Vault {
    coin,
    launcher_id,
    proof,
    custody_hash,
};
```

## Spending from Vaults

To spend from a vault, you need to provide a `MipsSpend` that satisfies the vault's custody requirements:

```rust
use chia_wallet_sdk::prelude::*;

let ctx = &mut SpendContext::new();

// Create the vault spend
vault.spend(ctx, &mips_spend)?;

let coin_spends = ctx.take();
```

The `MipsSpend` contains the puzzle reveal and solution that satisfies the vault's custody conditions.

## Computing Child Vaults

After a vault spend, you can compute the resulting vault:

```rust
// Compute the child vault after a spend
let child_vault = vault.child(new_custody_hash, new_amount);
```

This is essential for tracking the vault's state across multiple operations.

## Multi-Signature Patterns

Vaults typically implement multi-signature patterns where multiple keys must sign. The custody hash encodes these requirements:

```rust
// Example: 2-of-3 multi-sig pattern
// The custody_hash would encode the requirement for
// 2 signatures from a set of 3 possible public keys

// The MipsSpend would contain:
// - The multi-sig puzzle reveal
// - Solution with the required signatures
```

## Security Considerations

When working with vaults:

:::warning
- Always verify the custody hash matches your expected security requirements
- Ensure all required signers are available before initiating spends
- Test vault configurations thoroughly in simulation before mainnet use
:::

## Clear Signing

The SDK provides clear signing support for vault transactions, making it easier to verify what a vault spend will do before signing:

```rust
use chia_wallet_sdk::prelude::*;

// VaultTransaction provides human-readable spend information
// ParsedPayment and ParsedNftTransfer help verify transaction contents
```

This is particularly important for hardware wallet integrations where users need to verify transactions on limited displays.

## Complete Example

Here's a basic vault spend pattern:

```rust
use chia_wallet_sdk::prelude::*;

fn spend_vault(
    vault: Vault,
    mips_spend: MipsSpend,
) -> Result<Vec<CoinSpend>, DriverError> {
    let ctx = &mut SpendContext::new();

    // Spend the vault with the provided custody solution
    vault.spend(ctx, &mips_spend)?;

    Ok(ctx.take())
}

fn track_vault_state(
    vault: Vault,
    new_custody_hash: TreeHash,
    new_amount: u64,
) -> Vault {
    // After spending, compute the new vault state
    vault.child(new_custody_hash, new_amount)
}
```

## Use Cases

### Institutional Custody

Vaults enable institutional-grade custody where:

- Multiple executives must approve large transfers
- Time delays can be enforced for security
- Recovery mechanisms can be built in

### Escrow

Vaults can implement escrow patterns:

- Funds locked until conditions are met
- Multi-party approval for release
- Automatic refunds after timeout

### Cold Storage

For enhanced security:

- Require multiple hardware wallet signatures
- Enforce time delays between initiation and execution
- Support recovery paths for lost keys

## API Reference

For the complete Vault API, see [docs.rs](https://docs.rs/chia-sdk-driver/latest/chia_sdk_driver/struct.Vault.html).
