---
title: Bindings
---

# Bindings

The Wallet SDK is written in Rust, but most of it is also available from JavaScript and Python. The
bindings are generated from one shared description of the API (the `chia-sdk-bindings` crate and its
`bindings/*.json` files), so the three packages expose the same classes and functions, adjusted to each
language's naming conventions. They are released together with the Rust crate and share its version
number.

| Package                                                                      | Language                                 | Built with                                                    | Install                            |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| [`chia-wallet-sdk`](https://www.npmjs.com/package/chia-wallet-sdk)           | Node.js (TypeScript types)               | [napi-rs](https://napi.rs), native addon                      | `npm install chia-wallet-sdk`      |
| [`chia-wallet-sdk-wasm`](https://www.npmjs.com/package/chia-wallet-sdk-wasm) | Browsers and bundlers (TypeScript types) | [wasm-bindgen](https://rustwasm.github.io/docs/wasm-bindgen/) | `npm install chia-wallet-sdk-wasm` |
| [`chia-wallet-sdk`](https://pypi.org/project/chia-wallet-sdk/)               | Python 3.8+ (`.pyi` stubs)               | [PyO3](https://pyo3.rs) and maturin                           | `pip install chia-wallet-sdk`      |

The Node.js package ships prebuilt binaries for Windows x64, macOS (x64 and Apple silicon) and Linux
(x64 and arm64). The Python package has prebuilt wheels for common platforms and imports as
`chia_wallet_sdk`. The WASM package runs anywhere WebAssembly does, including browsers, but it can't open
raw sockets, so it has a smaller networking surface.

Choose the Rust crate when you can. It has the complete API, including everything that isn't exported
to the bindings. Use the bindings when your application is already in JavaScript or Python and you need
to build, sign, parse or validate spends there.

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
| Primitive methods (`Cat::spend_all`, `Nft` minting, ...)                 | Methods on `Clvm`: `spendCats`, `mintNfts`, `spendNft`, `createEveDid`, `spendDid`, `mintVault`, `spendOption`, ...                                                     |
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

Structs such as `Coin`, `CoinSpend`, `SpendBundle` and `CatInfo` become classes with a constructor and
properties for their fields. Passing an object to a method doesn't consume it, so you can keep using it
afterwards.

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
`chia_wallet_sdk_wasm.d.ts` (WASM) and `chia_wallet_sdk.pyi` (Python).
