---
title: CLVM Values
---

# CLVM Values

Every puzzle, solution, condition list and curried argument on Chia is a CLVM value: either an atom (a byte string) or a pair of two values. The Wallet SDK is built on three crates that handle these values in Rust:

| Crate         | Re-exported as                 | What it provides                                                                                     |
| ------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `clvmr`       | `chia_wallet_sdk::clvmr`       | The `Allocator` that stores CLVM values, `NodePtr` handles, serialization and the CLVM interpreter   |
| `clvm-traits` | `chia_wallet_sdk::clvm_traits` | The `ToClvm` and `FromClvm` traits, their derive macros, and the `clvm_list!` / `clvm_quote!` macros |
| `clvm-utils`  | `chia_wallet_sdk::clvm_utils`  | Tree hashing (`TreeHash`, `tree_hash`, `ToTreeHash`) and currying (`CurriedProgram`)                 |

The SDK adds the `Mod` trait, Chialisp and Rue compilation, and `run_puzzle` in `chia_wallet_sdk::types`. The most common items from all of these are in `chia_wallet_sdk::prelude`.

This page covers the CLVM building blocks. Most application code doesn't use an `Allocator` directly; it goes through [SpendContext](/sdk/concepts/spend-context), which wraps an allocator, caches puzzles and collects coin spends. Everything here still applies, because `SpendContext` dereferences to `Allocator`.

For background on CLVM itself, see the [Chialisp documentation](https://chialisp.com).

## Allocator and NodePtr

An `Allocator` is an arena that owns CLVM values. A `NodePtr` is a small, `Copy` handle to a value inside one specific allocator. A `NodePtr` doesn't carry its allocator with it, so it's only meaningful when used with the allocator that created it.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn allocator_basics() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    // Build the list (1 2 3) by hand.
    let one = allocator.new_small_number(1)?;
    let two = allocator.new_small_number(2)?;
    let three = allocator.new_small_number(3)?;
    let rest = allocator.new_pair(three, NodePtr::NIL)?;
    let rest = allocator.new_pair(two, rest)?;
    let list = allocator.new_pair(one, rest)?;

    // Walk it back.
    let SExp::Pair(first, _rest) = allocator.sexp(list) else {
        panic!("expected a pair");
    };
    assert_eq!(allocator.atom(first).as_ref(), &[1]);

    // Nil is the empty atom, and is also the canonical encoding of 0 and false.
    assert!(allocator.atom(NodePtr::NIL).as_ref().is_empty());

    Ok(())
}
```

Building values node by node is rarely necessary. The traits in the next section convert Rust values to and from CLVM for you.

## ToClvm and FromClvm

`ToClvm` allocates a Rust value as CLVM, and `FromClvm` parses CLVM back into a Rust value. Both are implemented for:

- Integers (`u8` through `u128`, `i8` through `i128`, `usize`, `isize`, and `num_bigint::BigInt`) and `bool`, using CLVM's minimal signed big-endian encoding
- `String` and `&str` (UTF-8 atoms), `Bytes`, `Bytes32` and other fixed-size byte arrays
- `PublicKey`, `Signature`, and the secp256k1/secp256r1 key and signature types
- `Vec<T>`, `[T; N]` and slices (nil-terminated lists), tuples `(A, B)` (a single pair) and `()` (nil)
- `Option<T>` (`None` is nil)
- `NodePtr` itself, so you can mix already-allocated values into typed structures
- `Program`, the serialized form described [below](#program-and-serialization)

The `clvm_list!`, `clvm_tuple!` and `clvm_quote!` macros build ad hoc structures without declaring a type:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::clvm_traits::{clvm_list, clvm_quote};

#[test]
fn to_and_from_clvm() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    // ("hello" 42 0xcafe)
    let ptr = clvm_list!("hello", 42, Bytes::new(vec![0xca, 0xfe])).to_clvm(&mut allocator)?;

    // Parse it back as a tuple-style list.
    let (name, (number, (bytes, ()))) =
        <(String, (u64, (Bytes, ())))>::from_clvm(&allocator, ptr)?;
    assert_eq!(name, "hello");
    assert_eq!(number, 42);
    assert_eq!(bytes.as_ref(), &[0xca, 0xfe]);

    // (q . (1 2 3)) is a program that returns (1 2 3) when run.
    let quoted = clvm_quote!([1, 2, 3]).to_clvm(&mut allocator)?;
    let output = run_puzzle(&mut allocator, quoted, NodePtr::NIL)?;
    assert_eq!(Vec::<u32>::from_clvm(&allocator, output)?, vec![1, 2, 3]);

    Ok(())
}
```

### Deriving ToClvm and FromClvm

For puzzle solutions, curried arguments and memos, define a struct and derive both traits. The `#[clvm(...)]` attribute picks the representation:

| Representation     | CLVM shape                                               | Typical use                              |
| ------------------ | -------------------------------------------------------- | ---------------------------------------- |
| `list`             | `(a b c)`, extra trailing items are ignored when parsing | Solutions and on-chain data you parse    |
| `proper_list`      | `(a b c)`, must be nil-terminated exactly                | Strict formats                           |
| `curry`            | `(c (q . a) (c (q . b) 1))`                              | Curried puzzle arguments                 |
| `transparent`      | Same as the single inner field                           | Newtypes                                 |
| `atom` (enums)     | The discriminant as an integer                           | Simple enums, combine with `#[repr(u8)]` |
| `untagged` (enums) | Tries each variant in order                              | Values with several possible shapes      |

Field attributes refine this: `#[clvm(rest)]` on the last field consumes the remainder of the list (no nil terminator), `#[clvm(default)]` or `#[clvm(default = ...)]` makes the last field optional, and `#[clvm(constant = ...)]` together with `#[apply_constants]` encodes a fixed value that isn't a Rust field.

```rust
use chia_wallet_sdk::prelude::*;

/// The solution to some puzzle: `(amount recipient . memos)`.
#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(list)]
pub struct PaymentSolution {
    pub amount: u64,
    pub recipient: Bytes32,
    #[clvm(rest)]
    pub memos: Vec<Bytes>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(atom)]
#[repr(u8)]
pub enum Mode {
    Pay = 1,
    Refund = 2,
}

#[test]
fn derived_types() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    let solution = PaymentSolution {
        amount: 1_000,
        recipient: Bytes32::new([1; 32]),
        memos: vec![Bytes::new(b"invoice-17".to_vec())],
    };

    let ptr = solution.to_clvm(&mut allocator)?;
    assert_eq!(PaymentSolution::from_clvm(&allocator, ptr)?, solution);

    let mode = Mode::Refund.to_clvm(&mut allocator)?;
    assert_eq!(allocator.atom(mode).as_ref(), &[2]);

    Ok(())
}
```

The derive macros generate code that refers to the `clvm_traits` crate by name. `use chia_wallet_sdk::prelude::*;` brings that name into scope, so derives work without adding `clvm-traits` as a direct dependency. If you don't import the prelude, add `use chia_wallet_sdk::clvm_traits;` or pass `#[clvm(crate_name = chia_wallet_sdk::clvm_traits)]`.

Use `NodePtr` as a field type (or a generic parameter that you later set to `NodePtr`) to leave part of a value unparsed. Most SDK solution types, like `StandardSolution<P, S>` and `CatSolution<I>`, are generic for exactly this reason.

## Program and serialization

On the wire and inside a `CoinSpend`, CLVM values are serialized bytes. `Program` (from `chia_protocol`) is a wrapper around those bytes. Convert between the two forms with `ToClvm` and `FromClvm`, or with the `clvmr::serde` functions directly:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::clvmr::serde::{node_from_bytes, node_to_bytes};

#[test]
fn programs() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    // (q . 42) serialized
    let program = Program::from(hex::decode("ff012a")?);

    // Program -> NodePtr
    let ptr = program.to_clvm(&mut allocator)?;
    let output = run_puzzle(&mut allocator, ptr, NodePtr::NIL)?;
    assert_eq!(u8::from_clvm(&allocator, output)?, 42);

    // NodePtr -> Program
    let roundtrip = Program::from_clvm(&allocator, ptr)?;
    assert_eq!(roundtrip, program);

    // The same thing with raw bytes.
    let ptr = node_from_bytes(&mut allocator, &hex::decode("ff012a")?)?;
    assert_eq!(hex::encode(node_to_bytes(&allocator, ptr)?), "ff012a");

    Ok(())
}
```

`clvmr::serde` also has `node_to_bytes_backrefs`, which compresses repeated subtrees. Current full nodes accept back references in puzzle reveals and solutions, and `SpendContext::serialize_with_backrefs` uses this encoding.

## Tree hashing

The tree hash of a CLVM value is its SHA-256 based structural hash. A puzzle's tree hash is its puzzle hash, which is what a coin commits to. `TreeHash` is a 32-byte newtype that converts to and from `Bytes32`.

There are two ways to compute a tree hash:

- `tree_hash(&allocator, ptr)` hashes a value that's already allocated.
- `value.tree_hash()` (the `ToTreeHash` trait) hashes any `ToClvm` value without allocating it, using the `TreeHasher` encoder. This is how the SDK computes puzzle hashes cheaply.

```rust
use chia_wallet_sdk::prelude::*;

#[test]
fn tree_hashes() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    let value = ("hello".to_string(), 42u64);
    let ptr = value.to_clvm(&mut allocator)?;

    // Both methods agree.
    assert_eq!(tree_hash(&allocator, ptr), value.tree_hash());

    // A pair hashes as sha256(2, first, rest), and an atom as sha256(1, bytes).
    let expected = tree_hash_pair(tree_hash_atom(b"hello"), tree_hash_atom(&[42]));
    assert_eq!(value.tree_hash(), expected);

    // TreeHash and Bytes32 convert freely.
    let puzzle_hash: Bytes32 = expected.into();
    assert_eq!(TreeHash::from(puzzle_hash), expected);

    Ok(())
}
```

A `TreeHash` can stand in for a value it's the hash of. This is the basis for computing curried puzzle hashes: you only need the hash of the inner puzzle, not the inner puzzle itself.

## Currying

Currying fixes some of a puzzle's arguments ahead of time, producing a new puzzle with a different puzzle hash. See [Currying](https://docs.chia.net/guides/chialisp-currying) for how it works in CLVM.

In Rust, a curried puzzle is a `CurriedProgram { program, args }`, where `args` is a struct with the `#[clvm(curry)]` representation. The same type works with three kinds of `program`:

- A `NodePtr` to build the actual puzzle in an allocator
- A `TreeHash` of the mod to compute the curried puzzle hash without allocating anything
- Either one when parsing, to split a puzzle back into its mod and arguments

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::clvmr::serde::node_from_bytes;

#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct AddArgs {
    pub amount: u64,
}

#[test]
fn currying() -> anyhow::Result<()> {
    let mut allocator = Allocator::new();

    // (+ 2 5): adds the first and second arguments.
    let mod_bytes = hex::decode("ff10ff02ff0580")?;
    let mod_ptr = node_from_bytes(&mut allocator, &mod_bytes)?;
    let mod_hash = tree_hash(&allocator, mod_ptr);

    // Curry in the first argument.
    let args = AddArgs { amount: 100 };
    let puzzle = CurriedProgram { program: mod_ptr, args: args.clone() }.to_clvm(&mut allocator)?;

    // The puzzle hash can be computed from the mod hash alone.
    let puzzle_hash = CurriedProgram { program: mod_hash, args: args.clone() }.tree_hash();
    assert_eq!(tree_hash(&allocator, puzzle), puzzle_hash);

    // Running it adds the curried amount to the solution's first item.
    let solution = [5].to_clvm(&mut allocator)?;
    let output = run_puzzle(&mut allocator, puzzle, solution)?;
    assert_eq!(u64::from_clvm(&allocator, output)?, 105);

    // Uncurry it again.
    let curried = CurriedProgram::<NodePtr, AddArgs>::from_clvm(&allocator, puzzle)?;
    assert_eq!(curried.args, args);
    assert_eq!(tree_hash(&allocator, curried.program), mod_hash);

    Ok(())
}
```

## The Mod trait

`Mod` (in `chia_wallet_sdk::types`) ties a curried-arguments type to the puzzle it belongs to. It has two required methods, `mod_reveal()` (the serialized uncurried puzzle) and `mod_hash()`, and provides `curry_tree_hash()` to compute the puzzle hash of a set of arguments directly:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::chia::puzzle_types::{cat::CatArgs, standard::StandardArgs};

#[test]
fn mod_trait() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();
    let public_key = SecretKey::from_seed(&[1; 32]).public_key();

    // The puzzle hash of a standard XCH address for this key.
    let p2_puzzle_hash = StandardArgs::new(public_key).curry_tree_hash();

    // The puzzle hash of a CAT held by that address.
    let asset_id = Bytes32::new([2; 32]);
    let cat_puzzle_hash = CatArgs::new(asset_id, p2_puzzle_hash).curry_tree_hash();

    // SpendContext::curry allocates the mod (cached by hash) and curries the arguments.
    let puzzle = ctx.curry(StandardArgs::new(public_key))?;
    assert_eq!(ctx.tree_hash(puzzle), p2_puzzle_hash);

    // The uncurried mod is available too.
    let mod_ptr = ctx.alloc_mod::<StandardArgs>()?;
    assert_eq!(ctx.tree_hash(mod_ptr), StandardArgs::mod_hash());
    assert_ne!(cat_puzzle_hash, p2_puzzle_hash);

    Ok(())
}
```

`Mod` is implemented for the argument types of the standard puzzles from `chia_wallet_sdk::chia::puzzle_types` (`StandardArgs`, `CatArgs`, `SingletonArgs`, `DidArgs`, the NFT layers, and the TAILs), and for every puzzle in `chia_wallet_sdk::types::puzzles`. Puzzles without curried arguments, such as `SingletonLauncher` and `SettlementPayment`, implement `Mod` on a marker struct. The raw puzzle bytes and hashes themselves come from the `chia_puzzles` crate, re-exported as `chia_wallet_sdk::puzzles`.

To use your own puzzle with the SDK, implement `Mod` on its arguments type. If you have the compiled bytes, embed them:

```rust
use std::borrow::Cow;

use chia_wallet_sdk::prelude::*;
use hex_literal::hex;

/// `(mod (AMOUNT n) (+ AMOUNT n))` compiled.
pub const ADD_PUZZLE: [u8; 7] = hex!("ff10ff02ff0580");

#[derive(Debug, Clone, Copy, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct AddArgs {
    pub amount: u64,
}

impl Mod for AddArgs {
    fn mod_reveal() -> Cow<'static, [u8]> {
        Cow::Borrowed(&ADD_PUZZLE)
    }

    fn mod_hash() -> TreeHash {
        // Precompute this in real code; computing it here keeps the example short.
        chia_wallet_sdk::clvm_utils::tree_hash_from_bytes(&ADD_PUZZLE).unwrap()
    }
}

#[test]
fn custom_mod() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();

    let puzzle = ctx.curry(AddArgs { amount: 7 })?;
    assert_eq!(ctx.tree_hash(puzzle), AddArgs { amount: 7 }.curry_tree_hash());

    let solution = ctx.alloc(&[3])?;
    let output = ctx.run(puzzle, solution)?;
    assert_eq!(ctx.extract::<u64>(output)?, 10);

    Ok(())
}
```

## Compiling Chialisp and Rue

The SDK can compile puzzles from source at runtime. `compile_chialisp(path, include_paths)` compiles a `.clsp` file, and `compile_rue(path, debug, export_name)` compiles a [Rue](https://rue-lang.com) file or project (a directory with `Rue.toml` or `main.rue`). Both return a `Compilation` with the serialized `reveal` and its tree `hash`.

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::clvmr::serde::node_from_bytes;

#[test]
fn compile_from_source() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join("sdk-docs-compile-example");
    std::fs::create_dir_all(&dir)?;

    let clsp = dir.join("double.clsp");
    std::fs::write(&clsp, "(mod (N) (* N 2))")?;
    let chialisp = compile_chialisp(&clsp, &[])?;

    let rue = dir.join("double.rue");
    std::fs::write(&rue, "fn main(n: Int) -> Int { n * 2 }")?;
    let rue = compile_rue(&rue, false, None)?;

    let mut allocator = Allocator::new();
    for compiled in [chialisp, rue] {
        let puzzle = node_from_bytes(&mut allocator, &compiled.reveal)?;
        assert_eq!(tree_hash(&allocator, puzzle), compiled.hash);

        let solution = [21].to_clvm(&mut allocator)?;
        let output = run_puzzle(&mut allocator, puzzle, solution)?;
        assert_eq!(u64::from_clvm(&allocator, output)?, 42);
    }

    Ok(())
}
```

The `compile_chialisp!` and `compile_rue!` macros combine compilation with a `Mod` implementation. They create a lazily-compiled static and implement `Mod` for your arguments type, so the source is compiled the first time the puzzle is used:

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::types::{compile_chialisp, compile_rue};

#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct MultiplyArgs {
    pub factor: u64,
}

// Search paths are "." and "include", relative to the working directory.
compile_chialisp!(MultiplyArgs = MULTIPLY_MOD, "puzzles/multiply.clsp");

#[derive(Debug, Clone, PartialEq, Eq, ToClvm, FromClvm)]
#[clvm(curry)]
pub struct LockArgs<T> {
    pub inner_puzzle: T,
}

// `debug` keeps debug information, and the optional last argument picks an exported function.
compile_rue!(debug LockArgs<T> = LOCK_MOD, "puzzles/lock", "lock");
```

:::warning
Paths passed to these macros are resolved against the process working directory when the puzzle is first used, not relative to the source file, and compilation errors panic at that point. Both macros also expect `Compilation` to be in scope (the prelude includes it). For published puzzles, compile once and embed the bytes and hash as constants instead. Compiling at runtime is slow, and a compiler upgrade could change the output and therefore the puzzle hash.
:::

## Running puzzles

`run_puzzle(&mut allocator, puzzle, solution)` runs a program with the mainnet maximum block cost and returns its output. `run_puzzle_with_cost` lets you pass a cost limit and enable mempool mode, and returns a `Reduction` with the cost and output. `SpendContext::run` is a shortcut for `run_puzzle`.

Running a puzzle with its solution is how you find out what a spend does. The output of a coin's puzzle is its list of conditions, which you can parse with `Vec<Condition>` or `Conditions` (see [Conditions](/sdk/concepts/conditions#parsing-conditions)):

```rust
use chia_wallet_sdk::prelude::*;
use chia_wallet_sdk::clvm_traits::clvm_quote;

#[test]
fn run_and_parse() -> anyhow::Result<()> {
    let ctx = &mut SpendContext::new();

    let conditions = Conditions::new().reserve_fee(100).assert_height_absolute(1_000);
    let puzzle = ctx.alloc(&clvm_quote!(conditions))?;

    let output = ctx.run(puzzle, NodePtr::NIL)?;
    let parsed = ctx.extract::<Vec<Condition>>(output)?;

    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].as_reserve_fee().map(|fee| fee.amount), Some(100));

    Ok(())
}
```

In debug builds and tests, puzzles run under Rue's debug dialect, which records debug messages emitted by Rue programs compiled with `debug`. Release builds use the normal Chia dialect unless the `DEBUG_CLVM` environment variable is set to `true`, `yes` or `1` at compile time.

## HashedPtr

`HashedPtr` (in `chia_wallet_sdk::driver`) is a `NodePtr` bundled with its precomputed tree hash. It implements `ToClvm`, `FromClvm` and `ToTreeHash`, and compares by hash. The SDK uses it for values like NFT metadata, where you often need both the value and its hash. Create one with `HashedPtr::from_ptr(&allocator, ptr)` or `SpendContext::alloc_hashed`.

## Gotchas

- **Pointers belong to one allocator.** Using a `NodePtr` with a different `Allocator` (or after `SpendContext::reset`) doesn't fail loudly; it points at whatever is at that index. Keep a single `SpendContext` per transaction you build.
- **Zero is nil.** `0u64`, `false`, `None`, `()` and an empty string all encode to the same nil atom, so `Option<u64>` can't distinguish `Some(0)` from `None`.
- **`list` is lenient, `proper_list` is strict.** `#[clvm(list)]` ignores extra trailing items when parsing. That's usually what you want for solutions and conditions, but it means a round trip doesn't preserve them.
- **Integer parsing only checks the length.** `FromClvm` for integers fails if the atom is too long for the type, but doesn't check for a minimal encoding or, for unsigned types, the sign bit. The atom `0x80` is -128 in CLVM but parses as `128u8`. When the exact value matters for security, compare against the encoding the puzzle itself would see, or parse as `Bytes`.
- **Tree hashes aren't SHA-256 of the serialized bytes.** Always use `tree_hash`, `ToTreeHash` or `tree_hash_from_bytes` to get a puzzle hash.
