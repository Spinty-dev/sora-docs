import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'SORA',
  tagline: 'Signals Offensive Radio Auditor',
  favicon: 'img/favicon.ico',

  // GitHub pages deployment config.
  url: 'https://Spinty-dev.github.io',
  baseUrl: '/sora-docs/',
  organizationName: 'Spinty-dev',
  projectName: 'sora-docs',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  markdown: {
    mermaid: true,
  },

  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en', 'zh-Hans'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Spinty-dev/sora-docs/tree/main/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'SORA',
      logo: {
        alt: 'SORA Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Документация',
        },
        {
          href: 'https://github.com/Spinty-dev/SORA',
          label: 'GitHub (Core)',
          position: 'right',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Документация',
          items: [
            {label: 'Архитектура', to: '/docs/SORA_architecture_v4_4'},
            {label: 'Compliance', to: '/docs/COMPLIANCE'},
            {label: 'Disclaimer', to: '/docs/DISCLAIMER'},
          ],
        },
        {
          title: 'Сообщество',
          items: [
            {label: 'GitHub Issues', href: 'https://github.com/Spinty-dev/SORA/issues'},
          ],
        },
        {
          title: 'Инфо',
          items: [
            {label: 'GitHub', href: 'https://github.com/Spinty-dev/SORA'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Spinty. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['rust', 'python', 'bash'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
