import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    {
      type: 'category',
      label: 'Введение (Overview)',
      items: [
        'index',
        'architecture/packet_lifecycle',
      ],
    },
    {
      type: 'category',
      label: 'Комплаенс (Legal & Compliance)',
      items: [
        'DISCLAIMER',
        'COMPLIANCE',
        'LICENSE',
        'plugins/LICENSE'
      ],
    },
    {
      type: 'category',
      label: 'Ядро и Сеть (Rust Layer)',
      items: [
        'rust/overview',
        'rust/packet_engine',
        'rust/tx_queue',
        'rust/nl80211',
        'rust/adapter_layer',
        'rust/security',
      ],
    },
    {
      type: 'category',
      label: 'Оркестрация (Python Layer)',
      items: [
        'python/overview',
        'python/fsm',
        'python/config_manager',
        'python/persistence',
        'python/tui_internals',
      ],
    },
    {
      type: 'category',
      label: 'Связь (IPC)',
      items: [
        'ipc/architecture',
        'ipc/error_bridge',
      ],
    },
    {
      type: 'category',
      label: 'Плагины (NDJSON Events)',
      items: [
        'plugins/overview',
        'plugins/ndjson_api',
        'plugins/creating_plugin',
      ],
    },
    {
      type: 'category',
      label: 'Диагностика (Advanced)',
      items: [
        'debugging',
        'profiling',
      ],
    },
  ],
};

export default sidebars;
