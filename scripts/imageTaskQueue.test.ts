import assert from 'node:assert/strict';

type EnqueueImageTask = <T>(worker: () => Promise<T>) => Promise<T>;

let enqueueImageTask: EnqueueImageTask | undefined;
try {
  ({ enqueueImageTask } = await import('../src/imageTaskQueue'));
} catch {
  // The first TDD run intentionally exercises the missing module.
}

assert.equal(
  typeof enqueueImageTask,
  'function',
  'the global image task queue must export enqueueImageTask',
);

const enqueue = enqueueImageTask as EnqueueImageTask;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitFor = async (condition: () => boolean, message: string): Promise<void> => {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(condition(), true, message);
};

const testStrictFifoAndPeakConcurrency = async (): Promise<void> => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [false, false, false];
  const events: string[] = [];
  let active = 0;
  let peakActive = 0;

  const jobs = ['first', 'second', 'third'].map((name, index) => enqueue(async () => {
    started[index] = true;
    active += 1;
    peakActive = Math.max(peakActive, active);
    events.push(`start:${name}`);
    await gates[index].promise;
    events.push(`end:${name}`);
    active -= 1;
    return name;
  }));

  try {
    await waitFor(() => started[0], 'the first queued task must start');
    assert.deepEqual(started, [true, false, false], 'later tasks must remain queued');

    gates[0].resolve();
    await waitFor(() => started[1], 'the second task must start after the first settles');
    assert.deepEqual(events, ['start:first', 'end:first', 'start:second']);

    gates[1].resolve();
    await waitFor(() => started[2], 'the third task must start after the second settles');
    assert.deepEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
    ]);

    gates[2].resolve();
    assert.deepEqual(await Promise.all(jobs), ['first', 'second', 'third']);
    assert.equal(peakActive, 1, 'only one complete image task may run at a time');
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled(jobs);
  }
};

const testAsyncSaveStaysInsideQueue = async (): Promise<void> => {
  const saveGate = deferred();
  let secondStarted = false;
  const events: string[] = [];

  const first = enqueue(async () => {
    events.push('generate:first');
    events.push('save:start:first');
    await saveGate.promise;
    events.push('save:end:first');
    return 'saved-first';
  });
  const second = enqueue(async () => {
    secondStarted = true;
    events.push('generate:second');
    return 'saved-second';
  });

  await waitFor(
    () => events.includes('save:start:first'),
    'the first task must reach its asynchronous save step',
  );
  assert.equal(secondStarted, false, 'the next task must wait for asynchronous saving to finish');

  saveGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['saved-first', 'saved-second']);
  assert.deepEqual(events, [
    'generate:first',
    'save:start:first',
    'save:end:first',
    'generate:second',
  ]);
};

const testFailureReleasesNextTask = async (): Promise<void> => {
  const failureGate = deferred();
  const events: string[] = [];

  const failed = enqueue(async () => {
    events.push('start:failed');
    await failureGate.promise;
    events.push('fail:failed');
    throw new Error('simulated image task failure');
  });
  const recovered = enqueue(async () => {
    events.push('start:recovered');
    return 'recovered';
  });

  await waitFor(
    () => events.includes('start:failed'),
    'the failing task must start first',
  );
  assert.deepEqual(events, ['start:failed']);
  failureGate.resolve();

  await assert.rejects(failed, /simulated image task failure/u);
  assert.equal(await recovered, 'recovered');
  assert.deepEqual(events, ['start:failed', 'fail:failed', 'start:recovered']);
};

await testStrictFifoAndPeakConcurrency();
await testAsyncSaveStaysInsideQueue();
await testFailureReleasesNextTask();

console.log('global image task queue regression checks passed');
