import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";
import apiSidebarModule from "./docs/sage/rpc/sidebar";

const sidebars: SidebarsConfig = {
  sage: [
    { type: "doc", id: "sage/index" },
    { type: "doc", id: "sage/files" },
    { type: "doc", id: "sage/config" },
    {
      type: "category",
      label: "RPC",
      items: [
        apiSidebarModule[0],
        { type: "doc", id: "sage/rpc-setup" },
        ...apiSidebarModule.slice(1),
      ],
    },
  ],
  sdk: [
    { type: "doc", id: "sdk/index", label: "Introduction" },
    { type: "doc", id: "sdk/quick-start", label: "Quick Start" },
    {
      type: "category",
      label: "Core Concepts",
      items: [
        { type: "doc", id: "sdk/concepts/clvm", label: "CLVM Values" },
        {
          type: "doc",
          id: "sdk/concepts/spend-context",
          label: "SpendContext",
        },
        { type: "doc", id: "sdk/concepts/conditions", label: "Conditions" },
        { type: "doc", id: "sdk/concepts/layers", label: "Layers & Puzzles" },
        { type: "doc", id: "sdk/concepts/signing", label: "Keys & Signing" },
      ],
    },
    {
      type: "category",
      label: "Action System",
      link: { type: "doc", id: "sdk/action-system/index" },
      items: [
        {
          type: "doc",
          id: "sdk/action-system/actions",
          label: "Action Reference",
        },
        {
          type: "doc",
          id: "sdk/action-system/custom-spends",
          label: "Custom Spends",
        },
      ],
    },
    {
      type: "category",
      label: "Primitives",
      link: { type: "doc", id: "sdk/primitives/index" },
      items: [
        { type: "doc", id: "sdk/primitives/standard", label: "Standard (XCH)" },
        { type: "doc", id: "sdk/primitives/cat", label: "CAT" },
        { type: "doc", id: "sdk/primitives/singletons", label: "Singletons" },
        { type: "doc", id: "sdk/primitives/nft", label: "NFT" },
        { type: "doc", id: "sdk/primitives/did", label: "DID" },
        {
          type: "doc",
          id: "sdk/primitives/options",
          label: "Option Contracts",
        },
        { type: "doc", id: "sdk/primitives/vaults", label: "Vaults & MIPS" },
        { type: "doc", id: "sdk/primitives/clawback", label: "Clawback" },
        {
          type: "doc",
          id: "sdk/primitives/streaming",
          label: "Streamed Assets",
        },
        { type: "doc", id: "sdk/primitives/bulletin", label: "Bulletins" },
        { type: "doc", id: "sdk/primitives/datalayer", label: "DataLayer" },
        {
          type: "doc",
          id: "sdk/primitives/action-layer",
          label: "Action Layer",
        },
        {
          type: "doc",
          id: "sdk/primitives/partial-offers",
          label: "Partial Offers",
        },
        { type: "doc", id: "sdk/primitives/auctions", label: "Auctions" },
        { type: "doc", id: "sdk/primitives/splitter", label: "Splitter" },
        { type: "doc", id: "sdk/primitives/fusion", label: "NFT Fusion" },
        {
          type: "doc",
          id: "sdk/primitives/secure-the-bag",
          label: "Secure the Bag",
        },
      ],
    },
    { type: "doc", id: "sdk/offers", label: "Offers" },
    { type: "doc", id: "sdk/clear-signing", label: "Clear Signing" },
    {
      type: "category",
      label: "Networking",
      items: [
        { type: "doc", id: "sdk/networking/peer", label: "Peer Protocol" },
        { type: "doc", id: "sdk/networking/rpc", label: "RPC Clients" },
        { type: "doc", id: "sdk/networking/daemon", label: "Daemon" },
      ],
    },
    {
      type: "category",
      label: "Testing",
      link: { type: "doc", id: "sdk/testing/index" },
      items: [
        {
          type: "doc",
          id: "sdk/testing/peer-simulator",
          label: "Peer Simulator",
        },
        {
          type: "doc",
          id: "sdk/testing/full-node-simulator",
          label: "Full Node Simulator",
        },
      ],
    },
    { type: "doc", id: "sdk/utilities", label: "Utilities" },
    { type: "doc", id: "sdk/bindings", label: "Bindings" },
    {
      type: "category",
      label: "Guides",
      items: [
        { type: "doc", id: "sdk/patterns", label: "Application Patterns" },
        { type: "doc", id: "sdk/troubleshooting", label: "Troubleshooting" },
      ],
    },
  ],
};

export default sidebars;
