import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
import apiSidebarModule from "./docs/sage/rpc/sidebar";

const sidebars: SidebarsConfig = {
  sidebar: [
    { type: "doc", id: "getting-started" },
    {
      type: "category",
      label: "Sage",
      items: [
        { type: "doc", id: "sage/index" },
        { type: "doc", id: "sage/files" },
        { type: "doc", id: "sage/config" },
        { type: "doc", id: "sage/rpc" },
        {
          type: "category",
          label: "RPC API",
          items: [...apiSidebarModule.slice(1)],
        },
      ],
    },
    {
      type: "category",
      label: "Coin Set Model",
      items: [
        { type: "doc", id: "coin-set/index" },
        { type: "doc", id: "coin-set/coins" },
        { type: "doc", id: "coin-set/puzzles" },
      ],
    },
    {
      type: "category",
      label: "Custody",
      items: [
        { type: "doc", id: "custody/standard-transaction" },
        { type: "doc", id: "custody/mips" },
        { type: "doc", id: "custody/clawbacks" },
        { type: "doc", id: "custody/revocation" },
      ],
    },
    {
      type: "category",
      label: "Primitives",
      items: [
        { type: "doc", id: "primitives/cats" },
        { type: "doc", id: "primitives/nfts" },
        { type: "doc", id: "primitives/dids" },
        { type: "doc", id: "primitives/option-contracts" },
        { type: "doc", id: "primitives/vaults" },
      ],
    },
    {
      type: "category",
      label: "Wallet SDK",
      items: [{ type: "doc", id: "wallet-sdk/index" }],
    },
    {
      type: "category",
      label: "Bindings",
      items: [{ type: "doc", id: "bindings/index" }],
    },
  ],
};

export default sidebars;
