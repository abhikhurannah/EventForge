// Fix: package.json's "lint" script runs `eslint . --ext ts,tsx --max-warnings 0`, and
// GitHub Actions runs that script on every push -- but no eslint config file existed
// anywhere in the repo. With ESLint 9's flat-config requirement, that means `npm run lint`
// (and therefore CI) failed immediately with "no configuration found", before test or
// build ever ran.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
