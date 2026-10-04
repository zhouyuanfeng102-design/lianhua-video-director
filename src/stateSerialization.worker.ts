import { handleStateSerializationRequest, type StateSerializationRequest, type StateSerializationReply } from './stateSerialization';

// No DOM, application catalogs, storage normalization, Node integration or SAB.
const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<StateSerializationRequest>) => void;
  postMessage: (message: StateSerializationReply) => void;
};
workerScope.onmessage = (event) => {
  workerScope.postMessage(handleStateSerializationRequest(event.data));
};
