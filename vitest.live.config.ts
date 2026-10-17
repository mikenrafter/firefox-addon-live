import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/live/**/*.live.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
	},
})
