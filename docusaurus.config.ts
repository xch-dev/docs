import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import type * as OpenApiPlugin from "docusaurus-plugin-openapi-docs";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "xch.dev",
  tagline: "Build our decentralized future on the Chia blockchain",
  favicon: "img/favicon.ico",
  url: "https://xch.dev",
  baseUrl: "/",
  organizationName: "xch-dev",
  projectName: "docs",
  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "",
          // Skip RPC pages generated at docs/rpc before the Sage docs moved to
          // docs/sage, so stale local output isn't built alongside the new pages.
          exclude: [
            "**/_*.{js,jsx,ts,tsx,md,mdx}",
            "**/_*/**",
            "**/*.test.{js,jsx,ts,tsx}",
            "**/__tests__/**",
            "rpc/**",
          ],
          docItemComponent: "@theme/ApiItem",
          // Generated RPC pages have no source file to edit.
          editUrl: ({ docPath }) =>
            docPath.startsWith("sage/rpc/")
              ? undefined
              : `https://github.com/xch-dev/docs/tree/main/docs/${docPath}`,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: [{ from: "/sage", to: "/sage/getting-started" }],
        // Sage pages used to be served without the /sage prefix.
        createRedirects: (existingPath: string) =>
          existingPath.startsWith("/sage/")
            ? [existingPath.slice("/sage".length)]
            : undefined,
      },
    ],
    [
      "docusaurus-plugin-openapi-docs",
      {
        id: "api",
        docsPluginId: "classic",
        config: {
          sage_rpc: {
            specPath: "src/openapi.json",
            outputDir: "docs/sage/rpc/",
            sidebarOptions: {
              groupPathsBy: "tag",
            },
          } satisfies OpenApiPlugin.Options,
        },
      },
    ],
  ],
  themes: [
    "docusaurus-theme-openapi-docs",
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsRouteBasePath: "/",
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: "xch.dev",
      logo: {
        alt: "xch.dev Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "sage",
          position: "left",
          label: "Sage",
        },
        {
          type: "docSidebar",
          sidebarId: "sdk",
          position: "left",
          label: "Wallet SDK",
        },
        {
          href: "https://github.com/xch-dev/docs",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Learn",
          items: [
            {
              label: "Chia Docs",
              href: "https://docs.chia.net",
            },
            {
              label: "Chialisp Docs",
              href: "https://chialisp.com",
            },
            {
              label: "Rue Docs",
              href: "https://rue-lang.com",
            },
          ],
        },
        {
          title: "Social",
          items: [
            {
              label: "Discord",
              href: "https://discord.gg/sagewallet",
            },
            {
              label: "X",
              href: "https://x.com/sage_wallet",
            },
          ],
        },
        {
          title: "Contribute",
          items: [
            {
              label: "Wallet SDK",
              href: "https://github.com/xch-dev/chia-wallet-sdk",
            },
            {
              label: "Sage",
              href: "https://github.com/xch-dev/sage",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Rigid Network LLC`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["toml"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
