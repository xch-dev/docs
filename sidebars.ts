import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
import apiSidebarModule from "./docs/rpc/sidebar";

const sidebars: SidebarsConfig = {
  sidebar: [
    { type: "doc", id: "index" },
    { type: "doc", id: "files" },
    { type: "doc", id: "config" },
    {
      type: "category",
      label: "RPC",
      items: [{ type: "doc", id: "rpc-setup" }, ...apiSidebarModule.slice(1)],
    },
    {
      type: "category",
      label: "Wallet SDK",
      items: [
        { type: "doc", id: "sdk/index", label: "Quick Start" },
        { type: "doc", id: "sdk/spend-context", label: "SpendContext" },
        { type: "doc", id: "sdk/actions", label: "Action System" },
        { type: "doc", id: "sdk/connectivity", label: "Connectivity" },
        {
          type: "category",
          label: "Primitives",
          items: [
            { type: "doc", id: "sdk/primitives/standard", label: "Standard (XCH)" },
            { type: "doc", id: "sdk/primitives/cat", label: "CAT" },
            { type: "doc", id: "sdk/primitives/nft", label: "NFT" },
            { type: "doc", id: "sdk/primitives/vault", label: "Vault" },
            { type: "doc", id: "sdk/primitives/other", label: "Other Primitives" },
          ],
        },
        { type: "doc", id: "sdk/offers", label: "Offers" },
        { type: "doc", id: "sdk/testing", label: "Testing" },
        { type: "doc", id: "sdk/patterns", label: "Application Patterns" },
        { type: "doc", id: "sdk/troubleshooting", label: "Troubleshooting" },
      ],
    },
  ],
};

export default sidebars;
