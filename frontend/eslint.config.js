import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Project conventions — see .github/instructions/frontend.instructions.md
      // Set to 'warn' for now (existing code has ~250 violations); promote to 'error' after migration.
      'no-alert': 'warn',
      'no-restricted-syntax': [
        'warn',
        {
          // Disallow Tailwind rounded-* and rose-* classes in JSX className strings.
          // Allowed exceptions (avatars, status dots) should use an eslint-disable-next-line with reason.
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/(^|\\s)(rounded(-(none|sm|md|lg|xl|2xl|3xl|full))?|rose-(50|100|200|300|400|500|600|700|800|900))(\\s|$)/]",
          message:
            'Use square corners (no rounded-*) and blue-500 (no rose-*) per frontend.instructions.md. Add eslint-disable-next-line with reason for avatars/status dots.',
        },
        {
          selector:
            "JSXAttribute[name.name='className'] TemplateElement[value.raw=/(^|\\s)(rounded(-(none|sm|md|lg|xl|2xl|3xl|full))?|rose-(50|100|200|300|400|500|600|700|800|900))(\\s|$)/]",
          message:
            'Use square corners (no rounded-*) and blue-500 (no rose-*) per frontend.instructions.md.',
        },
      ],
      'no-restricted-globals': [
        'warn',
        { name: 'confirm', message: 'Use in-app confirmation UI, not window.confirm.' },
        { name: 'prompt', message: 'Use in-app input UI, not window.prompt.' },
      ],
    },
  },
])
