import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The seeded property and genome-scale tests take 1-3 s each on an idle machine and pass
    // Vitest's default 5 s only barely when the full suite runs in parallel on a loaded machine.
    // Their speed requirements are asserted inside the tests (explicit time budgets per
    // operation); this limit only catches hangs.
    testTimeout: 30_000,
  },
});
