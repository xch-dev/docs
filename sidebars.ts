import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  sidebar: [
    { type: "doc", id: "index" },
    {
      type: "category",
      label: "Sage Wallet",
      items: [
        { type: "doc", id: "sage/index" },
        { type: "doc", id: "sage/files" },
        { type: "doc", id: "sage/config" },
        {
          type: "category",
          label: "RPC",
          items: [
            { type: "doc", id: "sage/rpc/setup" },
            { type: "doc", id: "sage/rpc/types" },
            { type: "doc", id: "sage/rpc/offers" },
          ],
        },
      ],
    },
    {
      type: "category",
      label: "Wallet SDK",
      items: [
        { type: "doc", id: "wallet-sdk/index" },
      ],
    },
  ],
};

export default sidebars;
