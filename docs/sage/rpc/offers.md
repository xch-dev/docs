---
slug: /rpc-offers
---

# Offers

## make_offer

**Request**

| Parameter         | Type                         | Required | Description                                                    |
| ----------------- | ---------------------------- | -------- | -------------------------------------------------------------- |
| offered_assets    | [Assets](./rpc-types#assets) | true     | The assets being spent to make the offer.                      |
| requested_assets  | [Assets](./rpc-types#assets) | true     | The assets that must be paid to fulfill the offer.             |
| fee               | [Amount](./rpc-types#amount) | true     | The amount of mojos to pay as the fee once the offer is taken. |
| receive_address   | string                       | false    | Overrides the address the requested assets will be sent to.    |
| expires_at_second | number                       | false    | The seconds since UNIX epoch at which the offer expires.       |
| auto_import       | boolean                      | false    | Whether the app should import and track the offer's status.    |

**Response**

| Parameter | Type   | Description                                                       |
| --------- | ------ | ----------------------------------------------------------------- |
| offer     | string | The bech32m encoded offer string.                                 |
| offer_id  | string | An offer id that is compatible with [Dexie](https://dexie.space). |

## take_offer

**Request**

| Parameter   | Type                         | Required | Description                                                 |
| ----------- | ---------------------------- | -------- | ----------------------------------------------------------- |
| offer       | string                       | true     | The bech32m encoded offer string.                           |
| fee         | [Amount](./rpc-types#amount) | true     | The amount of additional mojos to add to the maker's fee.   |
| auto_submit | boolean                      | false    | Whether the transaction should be submitted to the mempool. |

**Response**

| Parameter      | Type               | Description                                            |
| -------------- | ------------------ | ------------------------------------------------------ |
| summary        | TransactionSummary | The inputs and outputs in the transaction.             |
| spend_bundle   | SpendBundle        | The spend bundle representing the transaction.         |
| transaction_id | string             | The hash of the spend bundle submitted to the mempool. |

<!--
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct CombineOffers {
    pub offers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct CombineOffersResponse {
    pub offer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct ViewOffer {
    pub offer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct ViewOfferResponse {
    pub offer: OfferSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct ImportOffer {
    pub offer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct ImportOfferResponse {
    pub offer_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct GetOffers {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct GetOffersResponse {
    pub offers: Vec<OfferRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct GetOffer {
    pub offer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct GetOfferResponse {
    pub offer: OfferRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct DeleteOffer {
    pub offer_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct DeleteOfferResponse {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct CancelOffer {
    pub offer_id: String,
    pub fee: Amount,
    #[serde(default)]
    pub auto_submit: bool,
}

pub type CancelOfferResponse = TransactionResponse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "tauri", derive(specta::Type))]
pub struct CancelOffers {
    pub offer_ids: Vec<String>,
    pub fee: Amount,
    #[serde(default)]
    pub auto_submit: bool,
}

pub type CancelOffersResponse = TransactionResponse;

fn yes() -> bool {
    true
} -->
