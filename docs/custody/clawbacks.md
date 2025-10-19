# Clawbacks

A clawback is a custody puzzle that allows the sender to claw back a payment that was sent to the wrong address. Only after the clawback period expires, can the recipient spend the coin.

There are two different clawback standards:

1. **Clawback v1** - This is the original clawback standard, which is used by the Chia reference client. The sender may always claw back the coin, and the recipient must explicitly claim the coin after the clawback period expires to prevent the sender from clawing it back.
2. **Clawback v2** - This is a new clawback standard, which is used by [Sage](https://sagewallet.net/) and [Cloud Wallet](https://vault.chia.net/). The sender can only claw back the coin before the clawback period expires. Afterward, the recipient automatically gains custody over the coin and does not need to claim it.

While the original clawback standard has some merits, such as preventing certain edge cases where the sender forgot to claw back the coin and the recipient is unable to spend it, the behavior of the new clawback standard is more intuitive for users.

This documentation will focus on a high level overview of the new clawback standard, since it's more widely supported. You can read more about the specification in [CHIP-0044](https://github.com/Chia-Network/chips/blob/5d06b7b77d18c4e1c4d8393ec9e0506e14ce57ca/CHIPs/chip-0044.md).

## Puzzles

Clawbacks are made up of the following puzzles:

1. [**P2 1-of-N**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/p2_1_of_n.clsp) - Used to allow multiple ways to spend the same coin.
2. [**Augmented Condition**](https://github.com/Chia-Network/chia_puzzles/blob/d122456feeef55708d354a065623037bfa010714/puzzles/augmented_condition.clsp) - Used to prepend the timelock conditions to the output of the sender and receiver puzzles.

There are 3 spend paths:

1. **Sender** - The sender's p2 puzzle hash augmented with the `ASSERT_BEFORE_SECONDS_ABSOLUTE` condition to prevent clawing back after the clawback period expires.
2. **Receiver** - The receiver's p2 puzzle hash augmented with the `ASSERT_SECONDS_ABSOLUTE` condition to allow spending after the clawback period expires.
3. **Push Through** - A static list of the `ASSERT_SECONDS_ABSOLUTE` and `CREATE_COIN` conditions to allow anyone to send the coin to the receiver after the clawback period expires.

The specific layout of these conditions and the memos needed to hint the clawback puzzle are specified in [CHIP-0044](https://github.com/Chia-Network/chips/blob/5d06b7b77d18c4e1c4d8393ec9e0506e14ce57ca/CHIPs/chip-0044.md) and the Wallet SDK implementation.
