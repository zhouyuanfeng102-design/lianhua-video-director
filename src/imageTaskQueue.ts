import { GenerationTaskCancelledError } from './generationTaskCancellation';

let imageTaskQueueTail: Promise<void> = Promise.resolve();

export const enqueueImageTask = <T>(
  worker: () => Promise<T>,
  options: { canStart?: () => boolean } = {},
): Promise<T> => {
  const result = imageTaskQueueTail.then(() => {
    if (options.canStart && !options.canStart()) throw new GenerationTaskCancelledError();
    return worker();
  });
  imageTaskQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};
