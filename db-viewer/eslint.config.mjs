import globals from 'globals';
export default [{ ignores: ['node_modules/**'] }, {
  files: ['**/*.mjs', 'public/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
}];
