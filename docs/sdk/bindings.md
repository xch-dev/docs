---
title: Bindings
---

# Bindings

The Wallet SDK is written in Rust, but most of it is also available from JavaScript, Python, Go, .NET
and C++. The bindings are generated from one shared description of the API (the `chia-sdk-bindings`
crate and its `bindings/*.json` files), so every package exposes the same classes and functions, adjusted
to each language's naming conventions. The packages are released together with the Rust crate and share its
version number. The C++ bindings are built from source.

| Package                                                                                            | Language                                 | Built with                                                           | Install                                        |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| [`chia-wallet-sdk`](https://www.npmjs.com/package/chia-wallet-sdk)                                 | Node.js (TypeScript types)               | [napi-rs](https://napi.rs), native addon                             | `npm install chia-wallet-sdk`                  |
| [`chia-wallet-sdk-wasm`](https://www.npmjs.com/package/chia-wallet-sdk-wasm)                       | Browsers and bundlers (TypeScript types) | [wasm-bindgen](https://rustwasm.github.io/docs/wasm-bindgen/)        | `npm install chia-wallet-sdk-wasm`             |
| [`chia-wallet-sdk`](https://pypi.org/project/chia-wallet-sdk/)                                     | Python 3.8+ (`.pyi` stubs)               | [PyO3](https://pyo3.rs) and maturin                                  | `pip install chia-wallet-sdk`                  |
| [`github.com/xch-dev/chia-wallet-sdk/go`](https://github.com/xch-dev/chia-wallet-sdk/tree/main/go) | Go (cgo)                                 | [UniFFI](https://mozilla.github.io/uniffi-rs/) and uniffi-bindgen-go | `go get github.com/xch-dev/chia-wallet-sdk/go` |
| [`ChiaWalletSdk`](https://www.nuget.org/packages/ChiaWalletSdk)                                    | .NET 8                                   | UniFFI and uniffi-bindgen-cs                                         | `dotnet add package ChiaWalletSdk`             |
| [C++](https://github.com/xch-dev/chia-wallet-sdk/tree/main/cpp)                                    | C++20                                    | UniFFI and uniffi-bindgen-cpp                                        | Build from source                              |

The Node.js package ships prebuilt binaries for Windows x64, macOS (x64 and Apple silicon) and Linux
(x64 and arm64). The Python package has prebuilt wheels for common platforms and imports as
`chia_wallet_sdk`. The WASM package runs anywhere WebAssembly does, including browsers, but it can't open
raw sockets, so it has a smaller networking surface.

The Go, .NET and C++ bindings are generated with [UniFFI](https://mozilla.github.io/uniffi-rs/) from a
single library crate. Each release of the Go module (tagged `go/v<version>`) includes the generated
bindings and prebuilt static libraries for Linux (amd64, arm64), macOS (amd64, arm64), Windows (amd64,
arm64) and Android (arm64), so it doesn't need a Rust toolchain, only a C compiler for cgo. The NuGet
package includes native libraries for Linux (x64, arm64), macOS (x64, arm64) and Windows (x64). The C++
bindings aren't packaged: run `cpp/generate.sh` in the SDK repository to build the library and generate
the header and source file, then compile them into your project.

Choose the Rust crate when you can. It has the complete API, including everything that isn't exported
to the bindings. Use the bindings when your application is in another language and you need to build,
sign, parse or validate spends there.

## How the bindings map to Rust

The bindings follow the Rust API closely, so the rest of these docs apply once you know the
translation:

| Rust                                                                     | Bindings                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`SpendContext`](/sdk/concepts/spend-context)                            | `Clvm`. It owns the CLVM allocator and collects coin spends. `coinSpends()` / `coin_spends()` returns and clears them, like `ctx.take()`                                |
| `NodePtr`                                                                | `Program`, a value allocated in a `Clvm`. Use `serialize()` for bytes and `treeHash()` / `tree_hash()` for its hash                                                     |
| `ctx.alloc(&value)` (`ToClvm`)                                           | `clvm.alloc(value)`, which converts numbers, strings, bytes, keys, arrays/lists and condition objects to a `Program`                                                    |
| `Conditions` builder                                                     | An array/list of condition `Program`s from methods like `clvm.createCoin(...)` and `clvm.reserveFee(...)`. Parse them back with `program.parseCreateCoin()` and similar |
| `StandardLayer::new(pk).spend(ctx, coin, conditions)`                    | `clvm.spendStandardCoin(coin, pk, clvm.delegatedSpend(conditions))`                                                                                                     |
| `StandardLayer::new(pk).spend_with_conditions(...)`                      | `clvm.standardSpend(pk, clvm.delegatedSpend(conditions))`, which returns a `Spend` to use as an inner spend (for example in `clvm.spendNft(nft, spend)`)                |
| Primitive methods (`Cat::spend_all`, `Nft` minting, ...)                 | Methods on `Clvm`: `spendCats`, `mintNfts`, `spendNft`, `createEveDid`, `spendDid`, `mintVault`, `spendOption`, `mintPlotNft`, ...                                      |
| [Action system](/sdk/action-system) (`Spends`, `Action`, `Id`, `Deltas`) | The same names, with `spends.apply(actions)`, `spends.prepare(deltas)` and `finished.spend()`                                                                           |
| `Simulator`, `BlsPair`, `K1Pair`, `R1Pair`                               | The same names. Key pairs are created with `BlsPair.fromSeed(seed)`                                                                                                     |
| `CoinsetClient` and `FullNodeClient`                                     | One `RpcClient` class: `new RpcClient(url)`, `RpcClient.mainnet()`, `RpcClient.testnet11()`, `RpcClient.local(cert, key)`                                               |

Types are converted at the boundary:

| Rust                      | Node.js                                        | WASM                | Python                           |
| ------------------------- | ---------------------------------------------- | ------------------- | -------------------------------- |
| `Bytes32`, `Bytes`        | `Uint8Array` in, `Buffer` out                  | `Uint8Array`        | `bytes`                          |
| `u64`, `u128`, `BigInt`   | `bigint` (`1000n`)                             | `bigint`            | `int`                            |
| `u8`, `u16`, `u32`        | `number`                                       | `number`            | `int`                            |
| `Option<T>`               | `T` or `null` (inputs also accept `undefined`) | `T` or `undefined`  | `T` or `None`                    |
| `Vec<T>`                  | Array                                          | Array               | `list`                           |
| `Result<T, E>`            | Returns `T`, throws an `Error`                 | Returns `T`, throws | Returns `T`, raises `ValueError` |
| `async fn`                | Returns a `Promise`                            | Returns a `Promise` | Awaitable (use with `asyncio`)   |
| `snake_case` method names | `camelCase`                                    | `camelCase`         | `snake_case`                     |

The UniFFI bindings convert types like this:

| Rust                      | Go                           | .NET                                | C++                             |
| ------------------------- | ---------------------------- | ----------------------------------- | ------------------------------- |
| `Bytes32`, `Bytes`        | `[]byte`                     | `byte[]`                            | `std::vector<uint8_t>`          |
| `u64`                     | `uint64`                     | `ulong`                             | `uint64_t`                      |
| `u128`, `BigInt`          | Decimal `string`             | Decimal `string`                    | Decimal `std::string`           |
| `Option<T>`               | Pointer (`nil` when absent)  | Nullable                            | `std::optional`, or `nullptr`   |
| `Result<T, E>`            | Returns `(T, error)`         | Returns `T`, throws `ChiaException` | Returns `T`, throws `ChiaError` |
| `async fn`                | Blocks the calling goroutine | Returns a `Task`                    | Blocks the calling thread       |
| `snake_case` method names | `PascalCase`                 | `PascalCase`                        | `snake_case`                    |

Structs such as `Coin`, `CoinSpend`, `SpendBundle` and `CatInfo` become classes with a constructor and
properties for their fields. Passing an object to a method doesn't consume it, so you can keep using it
afterwards.

In the UniFFI bindings, fields are read and written through methods (`coin.Amount()` and
`coin.SetAmount(...)` in Go and .NET, `coin->amount()` in C++), and setters change the object in place.
Use `Clone()` to copy an object. Static methods are free functions prefixed with the class name, such as
`ConstantsCatPuzzleHash()` in Go, `Sdk.ConstantsCatPuzzleHash()` in .NET and
`chiawalletsdk::constants_cat_puzzle_hash()` in C++. `clvm.Alloc` takes a `ClvmType` value, which covers
nil, booleans, integers, atoms, strings and the binding classes, but not lists; use `clvm.List(...)` for
those.

## Node.js

```ts
import {
  Address,
  BlsPair,
  Clvm,
  Simulator,
  standardPuzzleHash,
} from "chia-wallet-sdk";

const sim = new Simulator();
const clvm = new Clvm();

// A key pair with a 1,000 mojo standard coin, and a recipient.
const alice = sim.bls(1000n);
const bob = BlsPair.fromSeed(1n);
const bobPuzzleHash = standardPuzzleHash(bob.pk);

// 900 mojos to Bob, hinted so his wallet can find it, and a 100 mojo fee.
clvm.spendStandardCoin(
  alice.coin,
  alice.pk,
  clvm.delegatedSpend([
    clvm.createCoin(bobPuzzleHash, 900n, clvm.alloc([bobPuzzleHash])),
    clvm.reserveFee(100n),
  ]),
);

// Sign with Alice's key and validate the transaction.
sim.spendCoins(clvm.coinSpends(), [alice.sk]);

const [coin] = sim.unspentCoins(bobPuzzleHash, false);
console.log(coin.amount); // 900n
console.log(new Address(bobPuzzleHash, "txch").encode());
```

Networking calls are asynchronous. This example starts the HTTP
[full node simulator](/sdk/testing/full-node-simulator) and talks to it with `RpcClient`, exactly as you
would talk to Coinset or a full node:

```ts
import {
  Clvm,
  CoinSpend,
  FullNodeSimulator,
  RpcClient,
  Signature,
  SpendBundle,
} from "chia-wallet-sdk";

const sim = new FullNodeSimulator();
const server = await sim.startServer();

try {
  // Against mainnet you'd use `RpcClient.mainnet()` instead.
  const rpc = new RpcClient(server.url);

  // An anyone-can-spend coin: the puzzle `1` returns its solution as conditions.
  const clvm = new Clvm();
  const puzzle = clvm.parse("1");
  const coin = sim.newCoin(puzzle.treeHash(), 100n);

  const solution = clvm.list([clvm.createCoin(puzzle.treeHash(), 99n)]);
  const spendBundle = new SpendBundle(
    [new CoinSpend(coin, puzzle.serialize(), solution.serialize())],
    Signature.infinity(),
  );

  const pushed = await rpc.pushTx(spendBundle);
  if (!pushed.success) throw new Error(pushed.error ?? "push_tx failed");

  sim.farmBlock(1);

  const { coinRecord } = await rpc.getCoinRecordByName(coin.coinId());
  console.log(coinRecord?.spent, coinRecord?.spentBlockIndex); // true 2
} finally {
  server.close();
}
```

The Node.js package also has a `Peer` class for the [peer protocol](/sdk/networking/peer), using a
`Connector` built from a `Certificate` (`Certificate.load(certPath, keyPath)` or
`Certificate.generate()`), with native TLS:

```ts
import { Certificate, Connector, Peer, PeerOptions } from "chia-wallet-sdk";

const connector = new Connector(Certificate.generate());
const peer = await Peer.connect(
  "mainnet",
  "203.0.113.10:8444",
  connector,
  new PeerOptions(),
);

// Events (new peaks and coin state updates) are read one at a time.
const event = await peer.next();
console.log(event?.newPeakWallet?.height);
```

The binding `Peer` covers state requests (`requestCoinState`, `requestPuzzleState`,
`requestPuzzleAndSolution`), subscription removal and events. It throws when the node rejects a request
instead of returning the rejection. It has no `sendTransaction`, so submit transactions with
`RpcClient.pushTx`.

## WASM

The WASM package has the same API as the Node.js package, minus anything that needs sockets or native
TLS. Call `setPanicHook()` once at startup so that a Rust panic shows up as a readable JavaScript error
instead of `unreachable`.

```ts
import {
  Address,
  BlsPair,
  Clvm,
  Simulator,
  setPanicHook,
  standardPuzzleHash,
} from "chia-wallet-sdk-wasm";

// Turns Rust panics into readable JavaScript errors.
setPanicHook();

const sim = new Simulator();
const clvm = new Clvm();

const alice = sim.bls(1000n);
const bob = BlsPair.fromSeed(1n);
const bobPuzzleHash = standardPuzzleHash(bob.pk);

clvm.spendStandardCoin(
  alice.coin,
  alice.pk,
  clvm.delegatedSpend([
    clvm.createCoin(bobPuzzleHash, 900n, clvm.alloc([bobPuzzleHash])),
    clvm.reserveFee(100n),
  ]),
);

sim.spendCoins(clvm.coinSpends(), [alice.sk]);

const [coin] = sim.unspentCoins(bobPuzzleHash, false);
console.log(coin.amount); // 900n
console.log(new Address(bobPuzzleHash, "txch").encode());
```

The differences from the Node.js package:

- There's no `Peer`, `Connector` or `Certificate`, and no `RpcClient.local` / `localWithUrl`.
  `RpcClient` works with Coinset or any other HTTPS endpoint through `fetch`, subject to the server's CORS
  policy.
- `FullNodeSimulator` is available, but `startServer` isn't.
- Byte values are always plain `Uint8Array`s, never `Buffer`s, and missing values are `undefined`.
- Objects live in WebAssembly memory. Each class has a `free()` method that releases it immediately;
  otherwise it's released when the JavaScript object is garbage collected.

The published package is built for bundlers (`wasm-pack build`'s default target), so import it through a
bundler with WebAssembly support, such as Vite with `vite-plugin-wasm` or webpack with
`experiments.asyncWebAssembly`.

## Python

```python
from chia_wallet_sdk import Address, BlsPair, Clvm, Simulator, standard_puzzle_hash

sim = Simulator()
clvm = Clvm()

# A key pair with a 1,000 mojo standard coin, and a recipient.
alice = sim.bls(1000)
bob = BlsPair.from_seed(1)
bob_puzzle_hash = standard_puzzle_hash(bob.pk)

# 900 mojos to Bob, hinted so his wallet can find it, and a 100 mojo fee.
clvm.spend_standard_coin(
    alice.coin,
    alice.pk,
    clvm.delegated_spend(
        [
            clvm.create_coin(bob_puzzle_hash, 900, clvm.alloc([bob_puzzle_hash])),
            clvm.reserve_fee(100),
        ]
    ),
)

# Sign with Alice's key and validate the transaction.
sim.spend_coins(clvm.coin_spends(), [alice.sk])

[coin] = sim.unspent_coins(bob_puzzle_hash, False)
print(coin.amount)  # 900
print(Address(bob_puzzle_hash, "txch").encode())
```

Networking methods are coroutines:

```python
import asyncio

from chia_wallet_sdk import RpcClient


async def main() -> None:
    rpc = RpcClient.mainnet()
    response = await rpc.get_blockchain_state()
    if response.blockchain_state is None:
        raise RuntimeError(response.error)
    print(response.blockchain_state.peak.height)


asyncio.run(main())
```

The Python package has the same networking classes as Node.js: `RpcClient`, `Peer`, `Connector`,
`Certificate` and `FullNodeSimulator.start_server`.

The binding packages are built with every feature enabled, so partial offers, auctions, the splitter,
NFT fusion, Secure the Bag, plot NFTs and vault signed message verification are all available, with the same names
as the Rust types (for example `PartialOffer`, `Auction`, `Fusion` and `SecureTheBag`).

## Go

```go
package main

import (
	"fmt"

	sdk "github.com/xch-dev/chia-wallet-sdk/go/chiawalletsdk"
)

func main() {
	sim, _ := sdk.NewSimulator()
	clvm, _ := sdk.NewClvm()
	alice, _ := sim.Bls(1000)

	createCoin, _ := clvm.CreateCoin(alice.PuzzleHash(), 900, nil)
	reserveFee, _ := clvm.ReserveFee(100)
	spend, _ := clvm.DelegatedSpend([]*sdk.Program{createCoin, reserveFee})

	if err := clvm.SpendStandardCoin(alice.Coin(), alice.Pk(), spend); err != nil {
		panic(err)
	}

	coinSpends, _ := clvm.CoinSpends()

	if err := sim.SpendCoins(coinSpends, []*sdk.SecretKey{alice.Sk()}); err != nil {
		panic(err)
	}

	coins, _ := sim.UnspentCoins(alice.PuzzleHash(), false)
	fmt.Println("Created a coin with", coins[0].Amount(), "mojos")
}
```

Objects are backed by Rust memory, which a finalizer frees when they're garbage collected. Call
`Destroy()` to free one sooner; using an object after that panics. Objects are safe to share between
goroutines. Optional objects are pointers to pointers (such as `**Program`).

cgo uses `gcc` by default, which doesn't target every platform. For Windows arm64, set
`CC=aarch64-w64-mingw32-clang` from LLVM MinGW. For Android arm64, use the Android NDK's clang for API level
21 or later, along with `GOOS=android GOARCH=arm64 CGO_ENABLED=1`.

## .NET

```csharp
using ChiaWalletSdk;

using var sim = new Simulator();
using var clvm = new Clvm();
using var alice = sim.Bls(1000);

var spend = clvm.DelegatedSpend([
    clvm.CreateCoin(alice.PuzzleHash(), 900, null),
    clvm.ReserveFee(100),
]);

clvm.SpendStandardCoin(alice.Coin(), alice.Pk(), spend);
sim.SpendCoins(clvm.CoinSpends(), [alice.Sk()]);

var coins = sim.UnspentCoins(alice.PuzzleHash(), false);
Console.WriteLine($"Created a coin with {coins[0].Amount()} mojos");
```

Objects implement `IDisposable`, so `using` frees them deterministically. Otherwise a finalizer frees
them.

## C++

```cpp
#include <chiawalletsdk.hpp>
#include <iostream>

namespace sdk = chiawalletsdk;

int main() {
    auto sim = sdk::Simulator::init();
    auto clvm = sdk::Clvm::init();
    auto alice = sim->bls(1000);

    auto spend = clvm->delegated_spend(
        {clvm->create_coin(alice->puzzle_hash(), 900, nullptr), clvm->reserve_fee(100)});
    clvm->spend_standard_coin(alice->coin(), alice->pk(), spend);
    sim->spend_coins(clvm->coin_spends(), {alice->sk()});

    auto coins = sim->unspent_coins(alice->puzzle_hash(), false);
    std::cout << "Created a coin with " << coins[0]->amount() << " mojos" << std::endl;
}
```

Objects are `std::shared_ptr`s, and constructors are named `init`. Compile the generated
`chiawalletsdk.cpp` with C++20 and link it against the Rust library. The C++ generator doesn't support
async functions, so the library is built with the `blocking` feature, which turns networking calls into
blocking calls. Methods whose names are C++ keywords get a trailing underscore, such as `clvm->int_(...)`.

The Go, .NET and C++ bindings have the same networking classes as Node.js: `RpcClient`, `Peer`,
`Connector`, `Certificate` and `FullNodeSimulator` with `StartServer`.

## What isn't in the bindings

The bindings cover building, signing, parsing and validating spends for every primitive, offers, the
action system, clear signing, MIPS/vaults, the action layer registries, the simulators and the RPC
client. They don't include:

- `DaemonClient`, `Client`, `PeerSimulator` and the rate limiter types.
- Generic Rust APIs such as the `Layer` trait, `ToClvm`/`FromClvm` derives and custom puzzle drivers.
  You can still curry and run arbitrary puzzles with `Program` (`curry`, `uncurry`, `run`) and
  `clvm.parse`.
- A helper that works out required signatures. `Simulator.spendCoins` signs for you; for anything else,
  compute the messages from the `AGG_SIG_*` conditions and sign them with `SecretKey.sign`.

If you need one of these from another language, call it from Rust and expose it yourself, or open an
issue on the [Wallet SDK repository](https://github.com/xch-dev/chia-wallet-sdk).

For the complete API, read the type definitions that ship with each package: `index.d.ts` (Node.js),
`chia_wallet_sdk_wasm.d.ts` (WASM), `chia_wallet_sdk.pyi` (Python), the generated `chiawalletsdk`
package (Go), the `ChiaWalletSdk` assembly (.NET) and `chiawalletsdk.hpp` (C++).
