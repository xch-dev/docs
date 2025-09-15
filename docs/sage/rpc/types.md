---
slug: /rpc-types
---

# Types

## Amount

All amounts in the RPC are represented using mojos, however you can use either a number or a string as needed in the request. If an amount is too large to fit in the maximum safe JavaScript integer (2^53-1), then it will be returned as a string.

## Assets

Represents the assets in the side of an offer.

| Field | Type                       | Required | Description                                 |
| ----- | -------------------------- | -------- | ------------------------------------------- |
| xch   | [Amount](#amount)          | true     | The amount of XCH involved in the offer.    |
| cats  | [CatAmount](#cat-amount)[] | true     | A list of CAT assets involved in the offer. |
| nfts  | string[]                   | true     | A list of NFT ids involved in the offer.    |

## CatAmount {#cat-amount}

<!-- #[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct Assets {
    pub xch: Amount,
    pub cats: Vec<CatAmount>,
    pub nfts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct CatAmount {
    pub asset_id: String,
    pub amount: Amount,
} -->
