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
  ],
};

export default sidebars;
