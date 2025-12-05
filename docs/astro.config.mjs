import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://setupcz.github.io',
  base: '/rivermeet-tui',
  integrations: [
    starlight({
      title: 'Rivermeet TUI',
      description: 'A terminal user interface for reading and editing Confluence pages',
      head: [],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/setupcz/rivermeet-tui' },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Getting Started', slug: 'guides/getting-started' },
          ],
        },
        {
          label: 'Configuration',
          items: [
            { label: 'Environment Variables', slug: 'guides/environment' },
            { label: 'Config File', slug: 'guides/configuration' },
          ],
        },
        {
          label: 'Usage',
          items: [
            { label: 'Keybindings', slug: 'guides/keybindings' },
            { label: 'Views & Navigation', slug: 'guides/views' },
          ],
        },
      ],
    }),
  ],
});
