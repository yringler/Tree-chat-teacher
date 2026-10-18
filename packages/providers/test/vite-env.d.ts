// Vite's `import.meta.glob`, as recorded.test.ts uses it: the package's tsconfig has no
// vite/client types, and only this one form is needed.
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>;
}
