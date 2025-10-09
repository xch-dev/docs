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
  ],
};

export default sidebars;
