// Reuse the complete App/controller/Worker harness and extend its cancellation
// scenarios with atomic batch deletion, disabled running batches and retained media.
process.argv.push('--batch-delete');
await import('./videoCancellationUiQa.mjs');
