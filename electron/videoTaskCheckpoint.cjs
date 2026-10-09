const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const rank = { preparing: 1, 'post-started': 2, acknowledged: 3 };
const tailPhases = new Set(['waiting', 'extracting', 'ready', 'blocked', 'cancelled']);
const tailRoles = new Set(['first-frame', 'composition', 'general']);
const tailDefinitionKeys = new Set(['version', 'predecessorTaskId', 'predecessorItemKey', 'predecessorRequestFingerprint',
  'sequencePlanId', 'predecessorSegmentId', 'predecessorSegmentIndex', 'segmentId', 'segmentIndex',
  'referenceIndex', 'referenceRole', 'reservedFrameAssetId', 'selectionMode', 'requireAiSelection', 'aiMaxAttempts']);
const tailProgressKeys = new Set(['phase', 'revision', 'sourceVideoAssetId', 'sourceRelativePath', 'sourceChecksum', 'errorCode', 'message', 'selection']);
const tailAttemptKeys = ['run', 'attempt', 'maxAttempts', 'maxTokens'];
const tailSelectionKeys = new Set(['status', ...tailAttemptKeys, 'source', 'selectedId', 'reason', 'warning', 'offsetFromEndSec', 'selectedTimeSec', 'lastFrameTimeSec', 'candidateCount', 'frame']);
const tailFrameKeys = new Set(['fileName', 'relativePath', 'checksum', 'sizeBytes', 'mediaType', 'mimeType', 'managed', 'missing', 'url',
  'checksumMismatch', 'timeSec', 'frameIndex', 'width', 'height', 'role']);
const locatorKeys = ['sourceVideoAssetId', 'sourceRelativePath', 'sourceChecksum'];
const identityText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const mediaPath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/^[\\/]|[:\u0000]/u.test(value)
  && value.replace(/\\/gu, '/').split('/').every((part) => part && part !== '.' && part !== '..');
const hasOwn = (value, name) => record(value) && Object.prototype.hasOwnProperty.call(value, name);
const continuationError = () => new Error('视频续跑认领或来源记录无效；已停止新建任务，避免重复生成');
const validateVideoBatchContinuation = (task) => {
  const snapshot = task.videoJob?.snapshot;
  const claim = task.videoJob?.batchContinuation;
  const source = snapshot?.continuedFrom;
  if (claim === undefined && source === undefined) return;
  const validId = (value) => identityText(value) && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!record(snapshot) || !validId(task.id) || !validId(task.batchId) || !validId(task.requestFingerprint)
    || !validId(snapshot.projectId) || !validId(snapshot.clientId)) throw continuationError();
  if (claim !== undefined && (!record(claim) || claim.version !== 1
    || Object.keys(claim).some((name) => !['version', 'planId', 'batchId', 'taskId', 'revision', 'released'].includes(name))
    || !validId(claim.planId) || !validId(claim.batchId) || !validId(claim.taskId)
    || claim.taskId === task.id || claim.batchId === task.batchId
    || !Number.isSafeInteger(claim.revision) || claim.revision < 1
    || claim.released !== undefined && claim.released !== true)) throw continuationError();
  if (source !== undefined && (!record(source) || source.version !== 1
    || Object.keys(source).some((name) => !['version', 'planId', 'batchId', 'taskId', 'requestFingerprint'].includes(name))
    || !validId(source.planId) || !validId(source.batchId) || !validId(source.taskId) || !validId(source.requestFingerprint)
    || source.taskId === task.id || source.batchId === task.batchId)) throw continuationError();
};
const dependencyError = () => new Error('视频尾帧依赖记录无效或版本不受支持；已停止自动提交，不能改为无参考图生成');
const chainSnapshot = (snapshot) => ['batchCompletionOrder', 'previousTail', 'batchPredecessorTaskId'].some((name) => hasOwn(snapshot, name));
const selectionText = (value) => typeof value === 'string' && value.length <= 8192
  && !/data:[^,\r\n]*;base64,/iu.test(value);
/** Only persistence structure and local-file identity are checked here. AI's
 * explanation is ordinary text: no face/body/species/quality acceptance gate. */
const validTailSelection = (definition, tail, image) => {
  const selection = tail.selection;
  if (selection === undefined) return definition.selectionMode !== 'ai-assisted'
    || tail.phase !== 'ready' && image.freezeState !== 'frozen';
  if (definition.selectionMode !== 'ai-assisted' || !record(selection)
    || Object.keys(selection).some((name) => !tailSelectionKeys.has(name))
    || !['extracting', 'ready', 'blocked', 'cancelled'].includes(tail.phase)
    || locatorKeys.some((name) => tail[name] === undefined)) return false;
  if (tailAttemptKeys.some((name) => selection[name] !== undefined)
    && (!tailAttemptKeys.every((name) => Number.isSafeInteger(selection[name]) && selection[name] >= 1)
      || selection.maxAttempts > 4 || selection.attempt > selection.maxAttempts)) return false;
  if (selection.status === 'started') return Object.keys(selection).every((name) => name === 'status' || tailAttemptKeys.includes(name))
    && tail.phase !== 'ready' && image.freezeState !== 'frozen';
  if (selection.status !== 'completed' || !['ai', 'last-frame'].includes(selection.source)
    || definition.requireAiSelection === true && selection.source !== 'ai'
    || !identityText(selection.selectedId) || !selectionText(selection.reason)
    || selection.warning !== undefined && !selectionText(selection.warning)
    || !['offsetFromEndSec', 'selectedTimeSec', 'lastFrameTimeSec'].every((name) => Number.isFinite(selection[name]) && selection[name] >= 0)
    || !Number.isSafeInteger(selection.candidateCount) || selection.candidateCount < 1) return false;
  const frame = selection.frame;
  if (!record(frame) || Object.keys(frame).some((name) => !tailFrameKeys.has(name))
    || !mediaPath(frame.relativePath) || !identityText(frame.checksum)
    || !identityText(frame.fileName) || /[\\/\u0000]/u.test(frame.fileName)
    || frame.mediaType !== 'image' || frame.managed !== true || frame.missing !== false
    || frame.checksumMismatch !== undefined && frame.checksumMismatch !== false
    || frame.mimeType !== undefined && frame.mimeType !== 'image/png'
    || frame.url !== undefined && frame.url !== '' && frame.url !== `lianhua-asset://local/${frame.relativePath}`
      && frame.url !== `lianhua-asset://local/${String(frame.relativePath).split('/').map(encodeURIComponent).join('/')}`
    || !['first-frame', 'last-frame', 'custom-frame'].includes(frame.role)
    || !['width', 'height', 'sizeBytes'].every((name) => Number.isSafeInteger(frame[name]) && frame[name] > 0)
    || frame.frameIndex !== undefined && (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0)
    || !Number.isFinite(frame.timeSec) || frame.timeSec < 0
    || Math.abs(frame.timeSec - selection.selectedTimeSec) > 0.000001
    || selection.selectedTimeSec > selection.lastFrameTimeSec + 0.000001
    || Math.abs(selection.offsetFromEndSec - Math.max(0, selection.lastFrameTimeSec - selection.selectedTimeSec)) > 0.000001
    || [...Object.values(selection), ...Object.values(frame)].some((value) => typeof value === 'string' && !selectionText(value))) return false;
  return image.freezeState !== 'frozen' || image.relativePath === frame.relativePath && image.checksum === frame.checksum;
};
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const key = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('视频提交记录缺少有效任务标识');
  return createHash('sha256').update(value).digest('hex');
};
const rejectCredentials = (value, field = '') => {
  if (Array.isArray(value)) return value.forEach((item) => rejectCredentials(item));
  if (record(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (/^(?:api[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret|password)$/i.test(name)
        && item != null && item !== '' && item !== false) throw new Error('视频提交记录不能包含连接密钥');
      rejectCredentials(item, name);
    }
  } else if (typeof value === 'string' && ['workflowJson', 'requestTemplate'].includes(field)) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { return; }
    rejectCredentials(parsed);
  }
};

/** Shape validation is fail-closed: an invalid declared dependency is never
 * normalized away into an ordinary ready-to-submit task. Only immutable IDs
 * and file locators are stored, never a recursively embedded predecessor task. */
const validateVideoTaskDependency = (task) => {
  const job = task.videoJob;
  const snapshot = job?.snapshot;
  if (!record(snapshot)) return;
  const ordered = hasOwn(snapshot, 'batchCompletionOrder');
  const hasPredecessor = hasOwn(snapshot, 'batchPredecessorTaskId');
  const declared = hasOwn(snapshot, 'previousTail');
  if (ordered && snapshot.batchCompletionOrder !== true) throw dependencyError();
  if (ordered && ['parentTask', 'predecessorTask', 'previousTask'].some((name) => hasOwn(snapshot, name))) throw dependencyError();
  if ((ordered || hasPredecessor || declared) && (!identityText(task.batchId) || !identityText(task.batchItemKey)
    || !identityText(task.requestFingerprint) || !identityText(snapshot.projectId) || !identityText(snapshot.clientId)
    || !Number.isSafeInteger(task.batchIndex) || task.batchIndex < 1
    || !Number.isSafeInteger(task.batchTotal) || task.batchTotal < task.batchIndex
    || !Number.isSafeInteger(task.batchConcurrency) || task.batchConcurrency < 1)) throw dependencyError();
  if (ordered && (task.batchIndex === 1 ? hasPredecessor : !hasPredecessor)) throw dependencyError();
  if (hasPredecessor && (snapshot.batchCompletionOrder !== true || !identityText(snapshot.batchPredecessorTaskId)
    || snapshot.batchPredecessorTaskId === task.id)) throw dependencyError();
  if (!declared) {
    if (hasOwn(job, 'tailPreparation')) throw dependencyError();
    return;
  }
  const definition = snapshot.previousTail;
  const tail = job.tailPreparation;
  if (snapshot.batchCompletionOrder !== true || !record(definition) || definition.version !== 1
    || Object.keys(definition).some((name) => !tailDefinitionKeys.has(name))
    || definition.selectionMode !== undefined && definition.selectionMode !== 'ai-assisted'
    || definition.requireAiSelection !== undefined && definition.requireAiSelection !== true
    || definition.requireAiSelection === true && definition.selectionMode !== 'ai-assisted'
    || definition.aiMaxAttempts !== undefined && (definition.selectionMode !== 'ai-assisted'
      || !Number.isSafeInteger(definition.aiMaxAttempts) || definition.aiMaxAttempts < 1 || definition.aiMaxAttempts > 4)
    || !record(tail) || Object.keys(tail).some((name) => !tailProgressKeys.has(name))
    || !tailPhases.has(tail.phase) || !Number.isSafeInteger(tail.revision) || tail.revision < 0) throw dependencyError();
  for (const name of ['predecessorTaskId', 'predecessorItemKey', 'predecessorRequestFingerprint', 'sequencePlanId',
    'predecessorSegmentId', 'segmentId', 'reservedFrameAssetId']) if (!identityText(definition[name])) throw dependencyError();
  if (definition.predecessorTaskId === task.id || definition.predecessorTaskId !== snapshot.batchPredecessorTaskId
    || definition.predecessorItemKey === task.batchItemKey || definition.predecessorSegmentId === definition.segmentId
    || !Number.isSafeInteger(definition.predecessorSegmentIndex) || definition.predecessorSegmentIndex < 1
    || !Number.isSafeInteger(definition.segmentIndex) || definition.segmentIndex !== definition.predecessorSegmentIndex + 1
    || !Number.isSafeInteger(definition.referenceIndex) || definition.referenceIndex < 0
    || !tailRoles.has(definition.referenceRole)) throw dependencyError();
  const source = snapshot.draft?.source;
  if (!record(source) || source.sequencePlanId !== definition.sequencePlanId || source.segmentId !== definition.segmentId
    || source.segmentIndex !== definition.segmentIndex
    || task.sequencePlanId !== definition.sequencePlanId || task.segmentId !== definition.segmentId
    || task.segmentIndex !== definition.segmentIndex) throw dependencyError();
  const references = snapshot.draft?.references;
  const images = snapshot.images;
  const reference = references?.[definition.referenceIndex];
  const image = images?.[definition.referenceIndex];
  if (!Array.isArray(references) || !Array.isArray(images) || references.length !== images.length
    || reference?.assetId !== definition.reservedFrameAssetId || reference.role !== definition.referenceRole
    || image?.assetId !== definition.reservedFrameAssetId || image.role !== definition.referenceRole
    || references.filter((item) => item?.assetId === definition.reservedFrameAssetId).length !== 1) throw dependencyError();
  const locatorCount = locatorKeys.filter((name) => tail[name] !== undefined).length;
  if (locatorCount && (locatorCount !== locatorKeys.length || !identityText(tail.sourceVideoAssetId)
    || tail.sourceVideoAssetId === definition.reservedFrameAssetId || !mediaPath(tail.sourceRelativePath)
    || !identityText(tail.sourceChecksum))) throw dependencyError();
  if (['extracting', 'ready'].includes(tail.phase) && locatorCount !== locatorKeys.length) throw dependencyError();
  const frozen = image.freezeState === 'frozen';
  if (!frozen && image.freezeState !== 'pending') throw dependencyError();
  if (frozen && !['ready', 'blocked', 'cancelled'].includes(tail.phase)) throw dependencyError();
  // A future reference is an empty reserved slot, never placeholder pixels.
  if (!frozen && ['relativePath', 'checksum', 'dataUrl', 'url'].some((name) => image[name] !== undefined)) throw dependencyError();
  if (['errorCode', 'message'].some((name) => tail[name] !== undefined && typeof tail[name] !== 'string')) throw dependencyError();
  const postBoundary = job.preparation?.phase === 'post-started' || job.preparation?.phase === 'acknowledged';
  if (postBoundary && !['ready', 'cancelled'].includes(tail.phase)) throw dependencyError();
  if ((frozen || tail.phase === 'ready' || postBoundary) && (locatorCount !== locatorKeys.length
    || image.freezeState !== 'frozen' || !mediaPath(image.relativePath) || !identityText(image.checksum))) throw dependencyError();
  if (!validTailSelection(definition, tail, image)) throw dependencyError();
};

const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const selectionIdentity = (selection) => selection?.frame ? { ...selection,
  frame: { ...selection.frame, fileName: undefined, url: undefined } } : selection;
const tailProgressIdentity = (tail) => ({ ...tail, selection: selectionIdentity(tail.selection) });
/** Attempts describe paid-request boundaries, not visual acceptance. Old
 * status-only records stay readable; a live bounded run cannot go backwards or
 * lose its counters, and a new explicit run starts at the first attempt. */
const validTailAttemptProgress = (previous, incoming) => {
  if (previous?.run === undefined) return incoming?.run === undefined || incoming.run === 1 && incoming.attempt === 1;
  if (!incoming || incoming.run === undefined) return false;
  if (incoming.run === previous.run) return incoming.maxAttempts === previous.maxAttempts
    && (incoming.attempt === previous.attempt && incoming.maxTokens === previous.maxTokens
      || incoming.status === 'started' && incoming.attempt === previous.attempt + 1);
  return incoming.status === 'started' && incoming.run === previous.run + 1 && incoming.attempt === 1;
};
const immutableChainIdentity = (task) => {
  const snapshot = task.videoJob.snapshot;
  return {
    previousTail: snapshot.previousTail, batchCompletionOrder: snapshot.batchCompletionOrder,
    batchPredecessorTaskId: snapshot.batchPredecessorTaskId, clientId: snapshot.clientId, draft: snapshot.draft,
    kind: task.kind, requestFingerprint: task.requestFingerprint, targetId: task.targetId, storyboardId: task.storyboardId,
    sequencePlanId: task.sequencePlanId, segmentId: task.segmentId, segmentIndex: task.segmentIndex,
    batchId: task.batchId, batchItemKey: task.batchItemKey, batchIndex: task.batchIndex,
    batchTotal: task.batchTotal, batchConcurrency: task.batchConcurrency,
  };
};
const tailBinding = (task) => {
  const index = task.videoJob.snapshot.previousTail?.referenceIndex;
  if (index === undefined) return undefined;
  const image = task.videoJob.snapshot.images[index];
  // Preview URLs and names can be normalized independently. The managed file
  // and its checksum are the authoritative pixels that the uploader verifies.
  return image && { assetId: image.assetId, role: image.role, relativePath: image.relativePath, checksum: image.checksum,
    freezeState: image.freezeState };
};
const validTailTransition = (from, to) => ({
  waiting: ['waiting', 'extracting', 'blocked', 'cancelled'],
  extracting: ['extracting', 'ready', 'blocked', 'cancelled'],
  blocked: ['blocked', 'waiting', 'extracting', 'ready', 'cancelled'],
  ready: ['ready', 'blocked', 'cancelled'],
  cancelled: ['cancelled'],
}[from] || []).includes(to);
const resultSelectionKeys = ['resultAssetIds', 'resultSelectionRequired', 'resultArchiveFileName'];
const hasResultSelection = (job) => resultSelectionKeys.some((name) => hasOwn(job, name) && job[name] !== undefined);
const resultSelectionError = () => new Error('视频成片清单或选择记录无效；已停止自动衔接，不会重新生成，请恢复任务记录后再选择成片');
/** Output IDs are not permission to regenerate or an implicit choice of the
 * first member of a ZIP. Keep the complete list and the explicit selection as
 * one durable state transition. Legacy single-result tasks have no new fields. */
const validateVideoResultSelection = (task) => {
  const job = task?.videoJob;
  if (!hasResultSelection(job)) return;
  const ids = job.resultAssetIds;
  const validId = (value) => identityText(value) && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 128 || ids.some((id) => !validId(id))
    || new Set(ids).size !== ids.length
    || job.resultSelectionRequired !== undefined && typeof job.resultSelectionRequired !== 'boolean'
    || job.resultArchiveFileName !== undefined && (typeof job.resultArchiveFileName !== 'string'
      || !job.resultArchiveFileName.trim() || job.resultArchiveFileName.length > 1024
      || /[\\/\u0000-\u001f\u007f]/u.test(job.resultArchiveFileName))) throw resultSelectionError();
  if (job.resultSelectionRequired === true) {
    if (ids.length < 2 || task.resultAssetId !== undefined) throw resultSelectionError();
  } else if (!validId(task.resultAssetId) || !ids.includes(task.resultAssetId)) throw resultSelectionError();
};
const audioError = () => new Error('参考音频冻结绑定或上传回执无效；已停止提交，不能丢弃音频后生成');
const audioIdentity = (audio) => Object.fromEntries(['bindingId', 'assetId', 'slotIndex', 'target', 'retainMode', 'notes'].map((name) => [name, audio?.[name]]));
const audioFileName = (value) => {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 4096) return false;
  try {
    const decoded = decodeURIComponent(value);
    return !/[\u0000-\u001f\u007f?#]/u.test(decoded) && mediaPath(decoded);
  } catch { return false; }
};
const validateVideoAudioInputs = (task) => {
  const snapshot = task.videoJob?.snapshot, references = snapshot?.draft?.audioReferences, audios = snapshot?.audios;
  const uploaded = task.videoJob?.preparation?.uploadedAudios;
  if (references === undefined && audios === undefined && uploaded === undefined) return;
  if (references !== undefined && !Array.isArray(references) || audios !== undefined && !Array.isArray(audios)
    || uploaded !== undefined && !Array.isArray(uploaded)) throw audioError();
  const refs = references || [], files = audios || [], receipts = uploaded || [];
  if (refs.length !== files.length || files.length > 256 || receipts.length > files.length
    || files.length && (snapshot.connection?.backend !== 'api' || snapshot.connection.api?.provider !== 'runninghub')) throw audioError();
  const slots = new Set(), bindings = new Set();
  for (const [index, audio] of files.entries()) {
    const reference = refs[index], target = audio?.target;
    if (!record(audio) || !record(reference) || !same(audioIdentity(audio), audioIdentity(reference))
      || !identityText(audio.bindingId) || !identityText(audio.assetId) || !Number.isSafeInteger(audio.slotIndex) || audio.slotIndex < 0
      || slots.has(audio.slotIndex) || bindings.has(audio.bindingId)
      || !record(target) || !['character', 'voiceover', 'ambience'].includes(target.kind)
      || target.kind === 'character' && !identityText(target.characterId)
      || !['reference', 'fully_copy', 'partially_copy', 'weak_reference'].includes(audio.retainMode)
      || !['pending', 'frozen'].includes(audio.freezeState)
      || audio.notes !== undefined && typeof audio.notes !== 'string') throw audioError();
    slots.add(audio.slotIndex); bindings.add(audio.bindingId);
    if (audio.freezeState === 'frozen' && (!/^[a-f0-9]{64}$/u.test(audio.checksum || '')
      || !(mediaPath(audio.relativePath) || typeof audio.dataUrl === 'string' && /^data:audio\/[a-z0-9.+-]+;base64,/iu.test(audio.dataUrl)))) throw audioError();
    if (receipts[index] != null && (!audioFileName(receipts[index]) || audio.freezeState !== 'frozen')) throw audioError();
  }
  if (task.videoJob.preparation.phase !== 'preparing' && files.some((audio, index) => audio.freezeState !== 'frozen' || !audioFileName(receipts[index]))) throw audioError();
};
const validate = (task, expectedId) => {
  if (!record(task) || typeof task.id !== 'string' || (expectedId && task.id !== expectedId)
    || !record(task.videoJob) || !record(task.videoJob.snapshot)
    || !task.videoJob.snapshot.projectId || !record(task.videoJob.snapshot.connection)
    || task.videoJob.preparation?.version !== 1 || !Object.prototype.hasOwnProperty.call(rank, task.videoJob.preparation.phase)) {
    throw new Error('视频提交记录无效；停止自动提交，避免重复生成');
  }
  key(task.id);
  if (task.videoJob.remoteGenerationEnded !== undefined && task.videoJob.remoteGenerationEnded !== true) {
    throw new Error('视频远端结束记录无效，不能据此释放生成名额');
  }
  rejectCredentials(task);
  validateVideoTaskDependency(task);
  validateVideoResultSelection(task);
  validateVideoBatchContinuation(task);
  validateVideoAudioInputs(task);
  return task;
};

/** A separate atomic journal survives an older debounced project save. It can
 * advance to POST-started, never roll that safety boundary back to preparing. */
const createVideoTaskCheckpointJournal = ({ directory, atomicWriteFile }) => {
  const fileFor = (taskId) => path.join(directory, `${key(taskId)}.json`);
  const get = (taskId) => {
    const file = fileFor(taskId);
    if (!fs.existsSync(file)) return null;
    try { return validate(JSON.parse(fs.readFileSync(file, 'utf8')), taskId); }
    catch { throw new Error('视频提交记录损坏，无法确认是否已经提交；不会自动重新生成'); }
  };
  return {
    get,
    save(task) {
      validate(task);
      const existing = get(task.id);
      if (existing) {
        if (existing.videoJob.remoteGenerationEnded === true && task.videoJob.remoteGenerationEnded !== true) {
          throw new Error('已确认的远端生成结束记录不能被旧记录清空');
        }
        const left = existing.videoJob.snapshot;
        const right = task.videoJob.snapshot;
        if (!same(left.draft?.audioReferences || [], right.draft?.audioReferences || [])
          || !same((left.audios || []).map(audioIdentity), (right.audios || []).map(audioIdentity))) throw audioError();
        for (const [index, audio] of (left.audios || []).entries()) {
          if (audio.freezeState === 'frozen' && !same(audio, right.audios?.[index])) throw audioError();
          const receipt = existing.videoJob.preparation.uploadedAudios?.[index];
          if (receipt && rank[existing.videoJob.preparation.phase] <= rank[task.videoJob.preparation.phase]
            && receipt !== task.videoJob.preparation.uploadedAudios?.[index]) throw audioError();
        }
        if (left.projectId !== right.projectId || existing.createdAt !== task.createdAt
          || JSON.stringify(canonical(left.connection)) !== JSON.stringify(canonical(right.connection))) {
          throw new Error('视频提交记录与原任务身份或接口不一致；不会覆盖原记录');
        }
        if ((chainSnapshot(left) || chainSnapshot(right)) && !same(immutableChainIdentity(existing), immutableChainIdentity(task))) {
          throw new Error('视频提交记录的批次顺序或尾帧依赖定义已改变；不会覆盖原记录');
        }
        if (!same(left.continuedFrom, right.continuedFrom)) throw new Error('已保存的续跑来源不能被清空或替换；不会覆盖原记录');
        const previousClaim = existing.videoJob.batchContinuation;
        const incomingClaim = task.videoJob.batchContinuation;
        if (previousClaim) {
          if (!incomingClaim || incomingClaim.revision < previousClaim.revision
            || incomingClaim.revision === previousClaim.revision && !same(previousClaim, incomingClaim)) {
            throw new Error('已保存的续跑认领不能被旧记录清空、回退或替换；不会重复生成');
          }
          if (incomingClaim.revision > previousClaim.revision) {
            const sameOwner = same([previousClaim.planId, previousClaim.batchId, previousClaim.taskId],
              [incomingClaim.planId, incomingClaim.batchId, incomingClaim.taskId]);
            if (incomingClaim.revision !== previousClaim.revision + 1
              || sameOwner && (previousClaim.released || incomingClaim.released !== true)
              || !sameOwner && (!previousClaim.released || incomingClaim.released)) {
              throw new Error('续跑认领必须先安全释放未创建的准备，再允许新的确认；不会覆盖已有后续任务');
            }
          }
        }
        if (hasResultSelection(existing.videoJob)) {
          if (!same(existing.videoJob.resultAssetIds, task.videoJob.resultAssetIds)
            || existing.videoJob.resultArchiveFileName !== task.videoJob.resultArchiveFileName) {
            throw new Error('已保存的视频成片清单不能被旧记录清空或替换；不会重新下载或重新生成');
          }
          if (existing.videoJob.resultSelectionRequired !== true
            && (task.videoJob.resultSelectionRequired === true || existing.resultAssetId !== task.resultAssetId)) {
            throw new Error('已确认的成片选择不能被迟到记录回退或替换；请保留原选择');
          }
        }
        if (rank[existing.videoJob.preparation.phase] > rank[task.videoJob.preparation.phase]) {
          if (chainSnapshot(left)) throw new Error('此链式任务已越过提交边界，不能用旧准备记录再次授权生成');
          return { persisted: true };
        }
        if (chainSnapshot(left)) {
          const previous = existing.videoJob.tailPreparation;
          const incoming = task.videoJob.tailPreparation;
          const wasCancelled = existing.videoJob.batchQueueState === 'cancelled'
            && existing.videoJob.preparation.phase === 'preparing' || previous?.phase === 'cancelled';
          const isCancelled = task.videoJob.batchQueueState === 'cancelled'
            && task.videoJob.preparation.phase === 'preparing' || incoming?.phase === 'cancelled';
          if (wasCancelled && !isCancelled) throw new Error('此批次任务已取消，不能用迟到的准备结果恢复自动提交');
          if (previous && incoming) {
            if (incoming.revision < previous.revision) throw new Error('视频尾帧准备修订号已过期，不能用旧记录恢复自动提交');
            if (incoming.revision === previous.revision && (!same(tailProgressIdentity(previous), tailProgressIdentity(incoming)) || !same(tailBinding(existing), tailBinding(task)))) {
              throw new Error('视频尾帧准备记录在相同修订号下发生冲突；不会覆盖已保存的状态');
            }
            if (incoming.revision > previous.revision) {
              if (!validTailTransition(previous.phase, incoming.phase)) throw new Error('视频尾帧准备进展不能回退；不会覆盖已保存的尾帧或取消状态');
              if (previous.selection && (!incoming.selection
                || previous.selection.status === 'completed' && !same(selectionIdentity(previous.selection), selectionIdentity(incoming.selection)))) {
                throw new Error('已保存的 AI 选帧进展不能被清空、回退或替换；不会重复调用 AI');
              }
              if (!validTailAttemptProgress(previous.selection, incoming.selection)) {
                throw new Error('AI 选帧尝试次数不能回退、跳过或清空；不会自动重复已记录的请求');
              }
              if (locatorKeys.some((name) => previous[name] !== undefined && previous[name] !== incoming[name])) {
                throw new Error('视频尾帧准备记录不能更换已锁定的原视频；请创建新任务');
              }
              if (tailBinding(existing)?.freezeState === 'frozen' && !same(tailBinding(existing), tailBinding(task))) {
                throw new Error('已保存的真实尾帧不能被另一张图片替换；请创建新任务');
              }
            }
          }
        }
      }
      fs.mkdirSync(directory, { recursive: true });
      atomicWriteFile(fileFor(task.id), JSON.stringify(task));
      return { persisted: true };
    },
    delete(taskId) {
      const file = fileFor(taskId);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },
  };
};

/** Frozen input files are still part of a project after their original image
 * or task record is removed. Include only the explicitly exported project. */
const collectVideoFrozenAssets = (project) => {
  const result = new Map();
  const tasks = [...(project?.generationTasks || []), ...(project?.assets || []).map((asset) => asset.videoSourceTask).filter(Boolean)];
  for (const task of tasks) {
    const snapshot = task.videoJob?.snapshot;
    if (!snapshot || snapshot.projectId !== project.id) continue;
    (Array.isArray(snapshot.images) ? snapshot.images : []).forEach((image, index) => {
      if (typeof image.relativePath !== 'string' || !image.relativePath) return;
      if (!result.has(image.relativePath)) result.set(image.relativePath, {
        id: `video-input:${task.id}:${index}`, relativePath: image.relativePath, checksum: image.checksum,
      });
    });
    (Array.isArray(snapshot.audios) ? snapshot.audios : []).forEach((audio, index) => {
      if (audio.freezeState !== 'frozen' || !mediaPath(audio.relativePath) || !identityText(audio.checksum)) return;
      if (!result.has(audio.relativePath)) result.set(audio.relativePath, {
        id: `video-audio-input:${task.id}:${index}`, relativePath: audio.relativePath, checksum: audio.checksum,
      });
    });
    // Selection is checkpointed before its image slot is bound. Export those
    // exact pixels too, including tasks retained only by asset provenance.
    const selection = task.videoJob?.tailPreparation?.selection;
    if (selection?.status === 'completed' && mediaPath(selection.frame?.relativePath)
      && identityText(selection.frame.checksum) && !result.has(selection.frame.relativePath)) {
      result.set(selection.frame.relativePath, { id: `video-tail-selection:${task.id}`,
        relativePath: selection.frame.relativePath, checksum: selection.frame.checksum });
    }
  }
  return [...result.values()];
};

module.exports = { createVideoTaskCheckpointJournal, collectVideoFrozenAssets, validateVideoTaskDependency, validateVideoResultSelection, validateVideoBatchContinuation, validateVideoAudioInputs };
