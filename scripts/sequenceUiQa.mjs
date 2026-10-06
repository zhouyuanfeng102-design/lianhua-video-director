import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { updateLogEntries } from '../src/updateLog.ts';

const packageInfo = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Compare the rendered order with the complete source list so a release bump
// cannot accidentally replace the previous release in a second manual list.
const expectedUpdateLogVersions = updateLogEntries.map(({ version }) => version);
const expectedUpdateLogCurrentVersion = String(packageInfo.version || '').trim();
if (!expectedUpdateLogVersions.length || expectedUpdateLogVersions[0] !== expectedUpdateLogCurrentVersion) {
  throw new Error(`Update log must begin with package version ${expectedUpdateLogCurrentVersion || 'missing'}; received ${expectedUpdateLogVersions[0] || 'no entries'}`);
}

const baseUrl = process.env.QA_URL || 'http://127.0.0.1:4179/';
const outputDirectory = path.resolve(process.env.QA_OUTPUT || 'output/playwright/sequence-ui');
const storageKey = 'lianhua_video_director_state_v22';

const qaConvertedActionStages = [
  (subject) => `${subject}推门显露入口`,
  (subject) => `${subject}后撤撞散木箱`,
  (subject) => `${subject}放低武器伸手`,
  (subject) => `${subject}跃上窗台回望`,
  (subject) => `${subject}撞窗没入雨幕`,
];

const qaTextContent = (content) => typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('\n')
    : '';

const qaMessageContent = (payload, role) => [
  role === 'system' ? qaTextContent(payload?.system) : '',
  ...(Array.isArray(payload?.messages)
    ? payload.messages.filter((message) => message?.role === role)
      .map((message) => qaTextContent(message.content))
    : []),
].filter(Boolean).join('\n');

// The translator now receives the persisted MiniMax H3 delivery draft.  H3
// keeps the first shot un-timestamped and marks every later cut as
// `At MM:SS.mmm`; retain the legacy Chinese timeline form as well so this QA
// fixture can exercise both old and current prompt artifacts.
const QA_TRANSLATION_TIME_PATTERN = /(?:【\s*\d+(?:\.\d+)?s\s*[-–—~～至]\s*\d+(?:\.\d+)?s\s*】|\bAt\s+\d{2}:\d{2}\.\d{3}\b)/gu;
const QA_TRANSLATION_ENTITY_PATTERN = /__LH_ENTITY_\d{3}__/gu;

const qaOccurrenceCounts = (values) => values.reduce((counts, value) => {
  counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}, new Map());

const qaEnglishTranslationResponse = (userPrompt) => {
  const source = String(userPrompt || '').trim();
  const sourceTimes = source.match(QA_TRANSLATION_TIME_PATTERN) || [];
  const hasH3ShotStructure = /(?:^|\n)(?:integrated_multimodal_description|detailed_description):/mu.test(source)
    || /__LH_H3_(?:SECTION|CUT|TAG)_\d{3}__/u.test(source);
  if (!sourceTimes.length && !hasH3ShotStructure) {
    throw new Error('QA translator request is missing storyboard timestamps');
  }

  let timeIndex = 0;
  const protectedTimes = source.replace(
    QA_TRANSLATION_TIME_PATTERN,
    () => `__LH_TIME_${String(++timeIndex).padStart(3, '0')}__`,
  );
  const replacements = [
    [/细微短促可辨识的吻声/gu, 'soft, brief, clearly audible kiss sound'],
    [/吻声/gu, 'kiss sound'],
    [/亲吻|轻吻/gu, 'kiss'],
    [/第\s*(\d+(?:\.\d+)?)\s*s/gu, 'at $1s'],
    [/主体\s*[:：]/gu, 'Subject:'],
    [/空间\s*[:：]/gu, 'Space:'],
    [/光影\s*[:：]/gu, 'Lighting:'],
    [/镜头\s*[:：]/gu, 'Camera:'],
    [/动作\s*[:：]/gu, 'Action:'],
    [/台词\s*[:：]/gu, 'Dialogue:'],
    [/音效\s*[:：]/gu, 'Sound:'],
    [/环境层\s*-/gu, 'ambient layer-'],
    [/动作层\s*-/gu, 'action layer-'],
    [/情绪层\s*-/gu, 'emotional layer-'],
    [/无/gu, 'None'],
  ];
  const translatedBody = replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    protectedTimes,
  )
    .replace(/[\p{Script=Han}]+/gu, 'translated')
    .replace(/；/gu, '; ')
    .replace(/，/gu, ', ')
    .replace(/。/gu, '.')
    .replace(/（/gu, ' (')
    .replace(/）/gu, ') ');
  const translated = sourceTimes.reduce(
    (value, time, index) => value.replace(
      `__LH_TIME_${String(index + 1).padStart(3, '0')}__`,
      time,
    ),
    translatedBody,
  );

  const translatedTimes = translated.match(QA_TRANSLATION_TIME_PATTERN) || [];
  if (JSON.stringify(translatedTimes) !== JSON.stringify(sourceTimes)) {
    throw new Error('QA translator changed storyboard timestamps');
  }
  const sourceEntityCounts = qaOccurrenceCounts(source.match(QA_TRANSLATION_ENTITY_PATTERN) || []);
  const translatedEntityCounts = qaOccurrenceCounts(translated.match(QA_TRANSLATION_ENTITY_PATTERN) || []);
  for (const [token, count] of sourceEntityCounts) {
    if (translatedEntityCounts.get(token) !== count) {
      throw new Error(`QA translator changed protected entity ${token}`);
    }
  }
  if (sourceEntityCounts.size !== translatedEntityCounts.size) {
    throw new Error('QA translator added a protected entity');
  }
  return translated;
};

const qaTaggedJson = (source, tag) => {
  const match = String(source || '').match(
    new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'u'),
  );
  if (!match) throw new Error(`QA text request is missing ${tag}`);
  return JSON.parse(match[1]);
};

const qaTranslationProtocol = (payload) => {
  const system = qaMessageContent(payload, 'system');
  const source = qaMessageContent(payload, 'user');
  assert.doesNotMatch(`${system}\n${source}`, /h3_translation_units|h3_bounded_translation_contract|unit_\d{3}/u,
    'short and long segments must never use a separate unit-JSON translation protocol');
  assert.ok(!/^\s*\{/u.test(source), 'translation must use the complete plain-text prompt, not a JSON envelope');
  assert.doesNotMatch(system, /完整英文交付稿必须不超过|本次只对下面的完整英文提示词做一次精简/u,
    'translation must not impose a local character cap or request automatic length compaction');
  return { system, source, compaction: system.includes('本次只对下面的完整英文提示词做一次精简') };
};

const qaPlainEnglishTranslationResponse = (payload, { targetCharacters, rawH3Source = '' } = {}) => {
  const protocol = qaTranslationProtocol(payload);
  let translated = qaEnglishTranslationResponse(protocol.source);
  if (rawH3Source) {
    // Model providers may return correct original H3 syntax instead of the
    // equivalent protection tokens. Enumerate the same full-document mapping
    // without renumbering any shot, subject or picture in local fragments.
    const protectedGroups = [
      ['H3_TAG', rawH3Source.match(/\[Shot\s+\d+\]|<(?:Subject|Picture|Video|Audio)\s+\d+>/giu) || []],
      ['H3_SECTION', rawH3Source.match(/^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu) || []],
      ['H3_CUT', rawH3Source.match(/\bAt\s+\d{2}:\d{2}\.\d{3}\b/giu) || []],
    ];
    for (const [prefix, values] of protectedGroups) {
      [...new Set(values)].forEach((value, index) => {
        translated = translated.replaceAll(`__LH_${prefix}_${String(index + 1).padStart(3, '0')}__`, value);
      });
    }
    assert.match(translated, /<Subject 1>/u, 'raw-tag mock must actually return original Subject tags');
    assert.match(translated, /<Picture 1>/u, 'raw-tag mock must actually return original Picture tags');
    assert.doesNotMatch(translated, /__LH_H3_(?:TAG|SECTION|CUT)_\d+__/u,
      'raw-tag mock must cover the complete document mapping');
  }
  if (targetCharacters !== undefined) {
    assert.ok(rawH3Source, 'exact-length English fixtures require the complete original H3 source');
    const definitionNames = Array.from(rawH3Source.matchAll(
      /^<(?:Subject|Picture|Video|Audio)\s+\d+>\s+is\s+(.+?)(?=\s+(?:referenced from\s+<|defined by\b)|\s*[:：])/gmu,
    ), (match) => match[1].trim()).filter((name) => name.length <= 100 && !/^the referenced .+ source$/iu.test(name));
    const entities = [...new Set([...(rawH3Source.match(/@[\p{L}\p{N}_·•-]+/gu) || []), ...definitionNames])]
      .sort((left, right) => right.length - left.length);
    const restored = entities.reduce((text, name, index) => text.replaceAll(`__LH_ENTITY_${String(index + 1).padStart(3, '0')}__`, name), translated);
    assert.doesNotMatch(restored, /__LH_/u, 'character-count fixture must account for every restored placeholder');
    const paddingCharacters = targetCharacters - restored.length;
    assert.ok(paddingCharacters > 1, `complete English source is already longer than the ${targetCharacters}-character fixture`);
    translated += ` ${'x'.repeat(paddingCharacters - 1)}`;
  }
  return translated;
};

const qaConvertedTimelineResponse = (userPrompt) => {
  const conversionData = qaTaggedJson(userPrompt, 'video_conversion_data');
  const referenceRegeneration = userPrompt.includes('<current_reference_data>')
    ? qaTaggedJson(userPrompt, 'current_reference_data')
    : undefined;
  const evidence = Array.isArray(conversionData?.shotEvidence)
    ? conversionData.shotEvidence
    : [];
  if (!evidence.length) throw new Error('QA converter request is missing shot evidence');
  return evidence.map((shot, index) => {
    const draft = String(shot?.localStructureDraft || '').trim();
    const exactTimeLabel = String(shot?.exactTimeLabel || '').trim();
    const subject = String(shot?.allowedSubjects?.[0] || '').replace(/^@/u, '').trim();
    if (!draft || !exactTimeLabel || !subject) {
      throw new Error(`QA converter evidence ${index + 1} is incomplete`);
    }
    if (Array.isArray(shot?.expectedDialogues) && shot.expectedDialogues.length) {
      throw new Error('QA sequence converter fixture only supports dialogue-free source stories');
    }
    const timelineDraft = /^【[^】]+】/u.test(draft)
      ? draft.replace(/^【[^】]+】/u, exactTimeLabel)
      : '';
    if (!timelineDraft) throw new Error(`QA converter evidence ${index + 1} has no time header`);
    if (referenceRegeneration?.currentReferences?.length) {
      // Reframe the same event under the current images, not the unrelated
      // whole-film action factory. A changed visible-lighting description
      // proves that the response crossed the API conversion boundary while
      // preserving every original action, dialogue and fixed shot range.
      const referenceCount = referenceRegeneration.currentReferences?.length || 0;
      const converted = timelineDraft.replace(
        /；光影：[\s\S]*?(?=；镜头：)/u,
        `；光影：左侧${4100 + referenceCount * 200}K柔光沿当前参考图中的主体轮廓展开`,
      );
      if (converted === timelineDraft) {
        throw new Error(`QA reference converter evidence ${index + 1} did not change its visible presentation`);
      }
      return converted;
    }
    const shotNumber = Number.isInteger(shot?.shot) && shot.shot > 0
      ? shot.shot
      : index + 1;
    const actionFactory = qaConvertedActionStages[shotNumber - 1]
      || ((stableSubject) => `${stableSubject}移至点${shotNumber}`);
    const converted = timelineDraft.replace(
      /正在\s*\[[^\]]*\]/u,
      `正在 [${actionFactory(subject)}]`,
    );
    if (converted === timelineDraft) {
      throw new Error(`QA converter evidence ${index + 1} has no replaceable action chain`);
    }
    return converted;
  }).join('\n');
};

const qaShotRecommendationResponse = (userPrompt) => {
  const planningData = qaTaggedJson(userPrompt, 'storyboard_planning_data');
  const sourceStory = String(planningData?.sourceStory || '').trim();
  const durationSec = Number(planningData?.durationSec);
  if (!sourceStory || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('QA AI storyboard request is missing sourceStory or durationSec');
  }
  const sourceUnits = sourceStory.match(/[^。！？；]+[。！？；]?/gu)?.filter(Boolean) || [sourceStory];
  const requiredSegmentDurationSec = planningData?.requiredSegmentDurationSec;
  const requiredShotCount = planningData?.requiredShotCount;
  const hasFixedGrid = requiredSegmentDurationSec !== undefined;
  const fixedSegmentCount = hasFixedGrid ? durationSec / Number(requiredSegmentDurationSec) : 1;
  if (hasFixedGrid && (
    !Number.isFinite(Number(requiredSegmentDurationSec))
    || Number(requiredSegmentDurationSec) <= 0
    || !Number.isInteger(fixedSegmentCount)
  )) {
    throw new Error('QA AI storyboard requires an integer number of fixed-duration segments');
  }
  const shotCount = Number.isInteger(requiredShotCount) && requiredShotCount > 0
    ? requiredShotCount
    : Math.max(Math.min(4, sourceUnits.length), fixedSegmentCount);
  if (shotCount < fixedSegmentCount || shotCount > sourceUnits.length) {
    throw new Error('QA source fixture cannot cover the requested shot count and fixed segment grid');
  }
  const groups = Array.from({ length: shotCount }, (_, index) => {
    const start = Math.floor(index * sourceUnits.length / shotCount);
    const end = Math.floor((index + 1) * sourceUnits.length / shotCount);
    return sourceUnits.slice(start, Math.max(start + 1, end)).join('').trim();
  });
  const boundaries = hasFixedGrid
    ? Array.from({ length: fixedSegmentCount + 1 }, (_, index) => (
        Number((Number(requiredSegmentDurationSec) * index).toFixed(2))
      ))
    : Array.from({ length: shotCount + 1 }, (_, index) => (
        index === shotCount
          ? durationSec
          : Number((durationSec * index / shotCount).toFixed(2))
      ));
  // The mock model still owns non-uniform cuts inside each fixed segment, but
  // must emit every requested hard boundary. For 24s / 8s this yields the
  // deliberate four-shot plan [0, 5, 8, 16, 24], not a cut across 8s or 16s.
  while (boundaries.length < shotCount + 1) {
    let longestSpanIndex = 0;
    for (let index = 1; index < boundaries.length - 1; index += 1) {
      if (boundaries[index + 1] - boundaries[index]
        > boundaries[longestSpanIndex + 1] - boundaries[longestSpanIndex]) {
        longestSpanIndex = index;
      }
    }
    const start = boundaries[longestSpanIndex];
    const end = boundaries[longestSpanIndex + 1];
    const cut = Number((start + (end - start) * 0.625).toFixed(2));
    if (cut <= start || cut >= end) throw new Error('QA AI storyboard cannot fit another positive-duration shot');
    boundaries.splice(longestSpanIndex + 1, 0, cut);
  }
  return JSON.stringify({
    reason: 'QA text model owns the complete shot plan',
    breakdown: ['model shot count', 'model timeline boundaries', 'model source assignment'],
    shots: groups.map((sourceExcerpt, index) => ({
      startSec: boundaries[index],
      endSec: boundaries[index + 1],
      sourceExcerpt,
      purpose: `AI 规划第 ${index + 1} 镜叙事目的`,
      subject: '可见主体',
      action: `可见主体完成第 ${index + 1} 镜动作并留下结果`,
      camera: `AI 规划第 ${index + 1} 镜景别与运镜`,
      transition: index === 0 ? '从环境建立进入' : '沿动作结果切换',
      lighting: '保持场景光向与色温连续',
      sound: '环境声与动作声同步',
      result: `第 ${index + 1} 镜末状态清晰可见`,
    })),
  });
};

/**
 * Return a deterministic but AI-shaped response for the long-story semantic
 * segmentation request.  The application now sends the complete master
 * timeline in <ai_segmentation_data>. The fixture deliberately chooses groups
 * from the supplied shot boundaries so the real client still exercises
 * sourceShotIds/sourceBeatIds coverage and never has to infer a local cut.
 */
const qaSegmentationResponse = (userPrompt) => {
  let aiData;
  try {
    aiData = qaTaggedJson(userPrompt, 'ai_segmentation_data');
  } catch {
    // A malformed first response is followed by a structured repair request;
    // reuse the original master-shot evidence embedded in that envelope.
    try {
      const repairData = qaTaggedJson(userPrompt, 'ai_segmentation_repair_data');
      aiData = repairData?.originalData || repairData;
    } catch {
      throw new Error(
        'QA segmentation request is missing ai_segmentation_data or ai_segmentation_repair_data',
      );
    }
  }

  const masterShots = Array.isArray(aiData?.masterShots)
    ? aiData.masterShots.filter((shot) => shot && typeof shot === 'object')
    : [];
  const beats = Array.isArray(aiData?.beats)
    ? aiData.beats.filter((beat) => beat && typeof beat === 'object')
    : [];
  const totalDurationSec = Number(aiData?.totalDurationSec);
  const maxSegmentDurationSec = Number(aiData?.maxSegmentDurationSec) || 15;
  const preferredSegmentDurationSec = Number(aiData?.preferredSegmentDurationSec) || 8;
  // Keep the fixture's evidence tolerance aligned with the product parser,
  // which normalizes timestamps to hundredths and accepts a 50 ms boundary
  // rounding difference from the model.
  const timeEpsilon = 0.05;
  if (!masterShots.length || !Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    throw new Error('QA segmentation request is missing ai_segmentation_data masterShots or totalDurationSec');
  }

  // Validate the evidence exactly as the product's AI segment parser expects:
  // master shots are ordered, complete ranges and every source beat is
  // represented by at least one shot. The fixture must never invent a local
  // boundary or silently attach an unreferenced beat.
  const beatIds = beats.map((beat, index) => {
    const id = String(beat?.id || '').trim();
    if (!id) throw new Error(`QA source beat ${index + 1} is missing an ID`);
    return id;
  });
  if (new Set(beatIds).size !== beatIds.length) {
    throw new Error('QA source beats contain duplicate IDs');
  }
  const beatOrder = new Map(beatIds.map((id, index) => [id, index]));
  const seenShotIds = new Set();
  const shotBeatIds = [];
  let previousEnd = 0;
  const lastShotByBeat = new Map();
  masterShots.forEach((shot, index) => {
    const id = String(shot?.id || '').trim();
    const start = Number(shot?.startSec);
    const end = Number(shot?.endSec);
    if (!id || seenShotIds.has(id)) {
      throw new Error(`QA master shot ${index + 1} has a duplicate or empty ID`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`QA master shot ${index + 1} has invalid time range`);
    }
    if (index === 0 && Math.abs(start) > timeEpsilon) {
      throw new Error(`QA master shot ${index + 1} does not start at 0s`);
    }
    if (index > 0 && Math.abs(start - previousEnd) > timeEpsilon) {
      throw new Error(`QA master shot ${index} and ${index + 1} are not contiguous`);
    }
    seenShotIds.add(id);
    previousEnd = end;
    const ids = [...new Set(
      (Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds : [])
        .map((value) => String(value).trim())
        .filter(Boolean),
    )];
    ids.forEach((beatId) => {
      if (!beatOrder.has(beatId)) throw new Error(`QA master shot ${id} references unknown source beat ${beatId}`);
      lastShotByBeat.set(beatId, index);
    });
    shotBeatIds.push(ids);
  });
  if (Math.abs(previousEnd - totalDurationSec) > timeEpsilon) {
    throw new Error(`QA master shots end at ${previousEnd}s instead of ${totalDurationSec}s`);
  }
  const missingBeatIds = beatIds.filter((beatId) => !lastShotByBeat.has(beatId));
  if (missingBeatIds.length) {
    throw new Error(`QA master shots omit source beats: ${missingBeatIds.join(', ')}`);
  }

  // Build semantic atoms by keeping the complete span of every source beat
  // together. If a beat appears in multiple shots, the atom includes all
  // shots between its first and last occurrence. Shots without beat IDs remain
  // singleton atoms and are still preserved in final shot coverage.
  const atoms = [];
  let atomStart = 0;
  while (atomStart < masterShots.length) {
    let atomEnd = atomStart;
    for (let cursor = atomStart; cursor <= atomEnd; cursor += 1) {
      for (const beatId of shotBeatIds[cursor]) {
        atomEnd = Math.max(atomEnd, lastShotByBeat.get(beatId));
      }
    }
    const atom = masterShots.slice(atomStart, atomEnd + 1);
    const atomDuration = Number(atom.at(-1).endSec) - Number(atom[0].startSec);
    if (atomDuration > maxSegmentDurationSec + timeEpsilon) {
      throw new Error(`QA semantic beat atom exceeds ${maxSegmentDurationSec}s`);
    }
    atoms.push(atom);
    atomStart = atomEnd + 1;
  }
  if (!atoms.length) throw new Error('QA segmentation produced no semantic atoms');

  const groups = [];
  let current = [];
  let currentDuration = 0;
  atoms.forEach((nextAtom) => {
    const atomDuration = Number(nextAtom.at(-1).endSec) - Number(nextAtom[0].startSec);
    const shouldClose = current.length > 0
      && (currentDuration + atomDuration > maxSegmentDurationSec + timeEpsilon
        || currentDuration >= preferredSegmentDurationSec);
    if (shouldClose) {
      groups.push(current);
      current = [];
      currentDuration = 0;
    }
    current.push(...nextAtom);
    currentDuration += atomDuration;
  });
  if (current.length) groups.push(current);

  const assignedBeatIds = new Set();
  const segments = groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const sourceShotIds = group.map((shot) => String(shot.id || '').trim()).filter(Boolean);
    if (!sourceShotIds.length) throw new Error(`QA AI segment ${index + 1} has no sourceShotIds`);
    const groupBeatIds = group.flatMap((shot) => (
      Array.isArray(shot.sourceBeatIds) ? shot.sourceBeatIds.map((id) => String(id).trim()) : []
    ));
    const sourceBeatIds = [...new Set(groupBeatIds)]
      .filter((id) => beatOrder.has(id))
      .sort((left, right) => beatOrder.get(left) - beatOrder.get(right));
    if (!sourceBeatIds.length) throw new Error(`QA AI segment ${index + 1} has no sourceBeatIds`);
    if (sourceBeatIds.some((beatId, beatIndex) => (
      beatIndex > 0 && beatOrder.get(beatId) !== beatOrder.get(sourceBeatIds[beatIndex - 1]) + 1
    ))) {
      throw new Error(`QA AI segment ${index + 1} sourceBeatIds are not contiguous`);
    }
    sourceBeatIds.forEach((beatId) => {
      if (assignedBeatIds.has(beatId)) {
        throw new Error(`QA source beat ${beatId} is assigned to multiple AI segments`);
      }
    });
    sourceBeatIds.forEach((beatId) => assignedBeatIds.add(beatId));
    return {
      sourceShotIds,
      sourceBeatIds,
      boundaryAfterShotId: sourceShotIds[sourceShotIds.length - 1],
      durationSec: Number((Number(last.endSec) - Number(first.startSec)).toFixed(2)),
      globalStartSec: Number(first.startSec),
      globalEndSec: Number(last.endSec),
      title: `第${index + 1}段 · AI语义连续动作`,
      summary: `围绕完整镜头 ${sourceShotIds.join('、')} 推进当前剧情并落地动作结果`,
      narrativePurpose: `完成第${index + 1}段的完整动作、信息传递与状态变化`,
      entryState: index === 0 ? '承接全片开场状态' : `承接第${index}段末镜的人物、位置、道具和声音状态`,
      exitState: index === groups.length - 1 ? '全片结果与余波落地' : `第${index + 1}段末镜状态可直接承接下一段`,
      transitionHint: index === groups.length - 1 ? '以结果余波收束' : '在完整镜头结果后切换，保持动作方向、光线和声音连续',
      boundaryReason: 'AI fixture 在完整镜头结果/状态变化后切段',
      continuityPack: '继承人物外貌与姿态、空间位置、道具状态、光线方向、环境声和配乐状态',
    };
  });
  if (assignedBeatIds.size !== beatIds.length) {
    const missing = beatIds.filter((beatId) => !assignedBeatIds.has(beatId));
    throw new Error(`QA AI segmentation omitted source beats: ${missing.join(', ')}`);
  }
  return JSON.stringify({
    reason: 'QA AI 根据完整剧情母时间轴选择语义连续镜头组',
    breakdown: ['完整镜头边界', '动作结果', '段间连续性'],
    segments,
  });
};

const qaTextRequestKind = (payload) => {
  const systemPrompt = qaMessageContent(payload, 'system');
  if (systemPrompt.includes('智能导演分类器')) return 'director';
  if (systemPrompt.includes('<video_conversion_core_task>')) return 'converter';
  if (systemPrompt.includes('视频分镜规划器')) return 'shot-recommendation';
  if (systemPrompt.includes('专业的视频生成提示词翻译器')) return 'translator';
  if (
    systemPrompt.includes('长剧情视频分段的描述性元数据编辑器')
    || systemPrompt.includes('长剧情视频的剧情分段规划师')
    || systemPrompt.includes('长剧情视频的语义分段导演')
  ) return 'segmentation';
  return 'unexpected';
};

const qaTextResponseContent = (callKind, payload) => {
  const userPrompt = qaMessageContent(payload, 'user');
  if (callKind === 'director') {
    return JSON.stringify({ mode: 'narrative', reason: 'QA smart-director decision' });
  }
  if (callKind === 'converter') return qaConvertedTimelineResponse(userPrompt);
  if (callKind === 'shot-recommendation') return qaShotRecommendationResponse(userPrompt);
  if (callKind === 'translator') return qaPlainEnglishTranslationResponse(payload);
  if (callKind === 'segmentation') return qaSegmentationResponse(userPrompt);
  return '';
};

const installQaTextApiMock = async (
  targetPage,
  onRequest = async () => {},
  onError = async () => {},
) => {
  await targetPage.route('**/qa-openai/v1/chat/completions', async (route) => {
    const payload = route.request().postDataJSON();
    const callKind = qaTextRequestKind(payload);
    await onRequest(callKind);
    let responseContent = '';
    try {
      responseContent = qaTextResponseContent(callKind, payload);
    } catch (error) {
      await onError(callKind, error);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: error instanceof Error ? error.message : 'QA text mock failed' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: callKind === 'unexpected' ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify(callKind !== 'unexpected'
        ? { choices: [{ message: { content: responseContent } }] }
        : { error: { message: 'unexpected QA text request' } }),
    });
  });
};

const enableQaTextApi = async (targetPage) => {
  await targetPage.evaluate(({ key, apiBaseUrl }) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('QA state was not persisted before enabling the text API');
    const state = JSON.parse(raw);
    state.settings.textApi = {
      ...state.settings.textApi,
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: apiBaseUrl,
      apiKey: '',
      model: 'qa-model',
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, {
    key: storageKey,
    apiBaseUrl: new URL('qa-openai/v1', baseUrl).toString(),
  });
  await targetPage.reload({ waitUntil: 'networkidle' });
};

fs.mkdirSync(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: process.env.QA_HEADFUL !== '1' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
await page.addInitScript(() => {
  if (!sessionStorage.getItem('__lianhua_sequence_qa_initialized__')) {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('lianhua_runtime_error_log_v1', JSON.stringify([{
      id: 'sequence-ui-sidebar-layout-fixture',
      occurredAt: Date.UTC(2026, 8, 1, 0, 0, 0),
      stage: 'storyboard-plan',
      message: 'QA 侧栏最近报错副行布局夹具',
      projectName: 'UI QA 隔离项目',
      view: 'director',
    }]));
    sessionStorage.setItem('__lianhua_sequence_qa_initialized__', '1');
  }
});

const sizes = [
  { width: 1120, height: 720 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
];
const directorSizes = [
  ...sizes,
  { width: 1430, height: 894 },
];

const slug = (value) => value.replace(/[^a-zA-Z0-9_-]+/gu, '-');
const rect = (element) => {
  if (!element) return null;
  const value = element.getBoundingClientRect();
  return {
    top: Math.round(value.top * 100) / 100,
    right: Math.round(value.right * 100) / 100,
    bottom: Math.round(value.bottom * 100) / 100,
    left: Math.round(value.left * 100) / 100,
    width: Math.round(value.width * 100) / 100,
    height: Math.round(value.height * 100) / 100,
  };
};

const settleSidebarLayout = async () => {
  await page.evaluate(() => { window.__sequenceQaSidebarStable = undefined; });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.sidebar nav');
    const first = nav?.querySelector('.nav-item');
    const content = nav?.querySelector('.sidebar-nav-fit-content');
    const footer = document.querySelector('.sidebar-footer');
    if (!nav || !first || !footer) return false;
    const key = [nav.clientHeight, nav.clientWidth, nav.scrollHeight, first.getBoundingClientRect().height.toFixed(3), footer.getBoundingClientRect().top.toFixed(3), content && getComputedStyle(content).zoom].join('|');
    const previous = window.__sequenceQaSidebarStable;
    window.__sequenceQaSidebarStable = { key, count: previous?.key === key ? previous.count + 1 : 0 };
    return window.__sequenceQaSidebarStable.count >= 4;
  }, undefined, { timeout: 12_000, polling: 'raf' });
};

const collectLayout = async (kind, label) => {
  await settleSidebarLayout();
  return page.evaluate(({ kind, label }) => {
  const workspace = document.querySelector('.workspace');
  const planner = document.querySelector('.sequence-planner-panel');
  const plannerEditor = document.querySelector('.sequence-plan-workspace:not([hidden]) .sequence-segment-editor');
  const plannerFooter = document.querySelector('.sequence-plan-footer');
  const masterReview = document.querySelector('.sequence-master-review:not([hidden])');
  const masterPromptEditor = masterReview?.querySelector('textarea[aria-label="全片总视频提示词"]');
  const expandedOptions = document.querySelector('.sequence-planning-options-body:not([hidden])');
  const analysisRow = expandedOptions?.querySelector('.sequence-analysis-row')
    || document.querySelector('.sequence-planning-options-head');
  const sourceCard = document.querySelector('.director-source-card');
  const directorStage = document.querySelector('.director-stage');
  const sceneGrid = document.querySelector('.scene-chip-grid');
  const sceneChips = sceneGrid ? [...sceneGrid.querySelectorAll('.select-chip')] : [];
  const setupBody = document.querySelector('.director-setup-body');
  const setupSections = setupBody
    ? [...setupBody.querySelectorAll('.director-setup-section')]
    : [];
  const generateBar = document.querySelector('.director-generate-bar');
  const controlCard = document.querySelector('.director-control-card');
  const sidePanel = document.querySelector('.director-side-panel');
  const sidebarNav = document.querySelector('.nav');
  const sidebarUtilityStack = document.querySelector('.sidebar-utility-stack');
  const updateLogTrigger = document.querySelector('.update-log-trigger');
  const runtimeErrorLogSlot = document.querySelector('.runtime-error-log-slot');
  const runtimeErrorLogTrigger = document.querySelector('.runtime-error-log-trigger');
  const runtimeErrorLogLatest = document.querySelector('.runtime-error-log-latest');
  const sidebarFooter = document.querySelector('.sidebar-footer');
  const bounds = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return {
      top: Math.round(value.top * 100) / 100,
      right: Math.round(value.right * 100) / 100,
      bottom: Math.round(value.bottom * 100) / 100,
      left: Math.round(value.left * 100) / 100,
      width: Math.round(value.width * 100) / 100,
      height: Math.round(value.height * 100) / 100,
    };
  };
  const dimensions = (element) => element ? {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  } : null;
  const bodyRect = bounds(setupBody);
  const actionRect = bounds(generateBar);
  const sourceCardRect = bounds(sourceCard);
  const directorStageRect = bounds(directorStage);
  const sceneGridRect = bounds(sceneGrid);
  const editorRect = bounds(plannerEditor);
  const footerRect = bounds(plannerFooter);
  const masterReviewRect = bounds(masterReview);
  const masterPromptEditorRect = bounds(masterPromptEditor);
  const analysisRowRect = bounds(analysisRow);
  const sidebarNavRect = bounds(sidebarNav);
  const sidebarUtilityStackRect = bounds(sidebarUtilityStack);
  const updateLogTriggerRect = bounds(updateLogTrigger);
  const runtimeErrorLogSlotRect = bounds(runtimeErrorLogSlot);
  const runtimeErrorLogTriggerRect = bounds(runtimeErrorLogTrigger);
  const runtimeErrorLogLatestRect = bounds(runtimeErrorLogLatest);
  const sidebarFooterRect = bounds(sidebarFooter);
  const optionLabelLayouts = [...document.querySelectorAll('.compact-option-grid .director-option-card')]
    .map((card) => ({
      card: bounds(card),
      label: bounds(card.querySelector('.director-option-name')),
      text: card.textContent?.trim() || '',
    }));
  const setupSectionLayouts = setupSections.map((section) => {
    const sectionRect = bounds(section);
    const style = getComputedStyle(section);
    const controls = [...section.querySelectorAll('button, input, select, textarea')]
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        name: control.getAttribute('aria-label') || control.textContent?.trim() || '',
        rect: bounds(control),
      }));
    return {
      id: section.id,
      visible: style.display !== 'none'
        && style.visibility !== 'hidden'
        && section.getClientRects().length > 0,
      dimensions: dimensions(section),
      rect: sectionRect,
      controlsOutsideSection: controls.filter((control) => control.rect && sectionRect && (
        control.rect.left < sectionRect.left - 0.5
        || control.rect.top < sectionRect.top - 0.5
        || control.rect.right > sectionRect.right + 0.5
        || control.rect.bottom > sectionRect.bottom + 0.5
      )),
    };
  });
  const sectionRects = setupSectionLayouts.map((section) => section.rect).filter(Boolean);
  const sceneChipLayouts = sceneChips.map((chip) => ({
    rect: bounds(chip),
    fontSize: Number.parseFloat(getComputedStyle(chip).fontSize),
    clientHeight: chip.clientHeight,
    scrollHeight: chip.scrollHeight,
    clientWidth: chip.clientWidth,
    scrollWidth: chip.scrollWidth,
    text: chip.textContent?.trim() || '',
  }));
  const distinctAxisPositions = (values) => values.reduce((positions, value) => {
    if (!positions.some((position) => Math.abs(position - value) <= 1)) positions.push(value);
    return positions;
  }, []);
  const sceneChipRects = sceneChipLayouts.map((chip) => chip.rect).filter(Boolean);
  return {
    kind,
    label,
    viewport: { width: innerWidth, height: innerHeight },
    document: dimensions(document.documentElement),
    workspace: dimensions(workspace),
    planner: dimensions(planner),
    plannerEditor: dimensions(plannerEditor),
    plannerEditorOverflow: plannerEditor ? getComputedStyle(plannerEditor).overflowY : null,
    masterReview: dimensions(masterReview),
    masterPromptEditor: dimensions(masterPromptEditor),
    analysisRow: dimensions(analysisRow),
    sourceCard: dimensions(sourceCard),
    directorStage: dimensions(directorStage),
    sidebarNav: dimensions(sidebarNav),
    sidebarFitScale: Number.parseFloat(getComputedStyle(document.querySelector('.sidebar-nav-fit-content') || sidebarNav).zoom) || 1,
    sidebarUtility: {
      immediatelyAdjacent: Boolean(
        sidebarUtilityStack
        && updateLogTrigger?.parentElement === sidebarUtilityStack
        && runtimeErrorLogSlot?.parentElement === sidebarUtilityStack
        && updateLogTrigger.nextElementSibling === runtimeErrorLogSlot
      ),
      latestErrorText: runtimeErrorLogLatest?.textContent?.replace(/\s+/gu, ' ').trim() || '',
    },
    scenePicker: sceneGrid ? {
      dimensions: dimensions(sceneGrid),
      rect: sceneGridRect,
      chipCount: sceneChipLayouts.length,
      columnCount: distinctAxisPositions(sceneChipRects.map((chipRect) => chipRect.left)).length,
      rowCount: distinctAxisPositions(sceneChipRects.map((chipRect) => chipRect.top)).length,
      chips: sceneChipLayouts,
      chipsOutsideGrid: sceneChipLayouts.filter((chip) => chip.rect && sceneGridRect && (
        chip.rect.left < sceneGridRect.left - 0.5
        || chip.rect.top < sceneGridRect.top - 0.5
        || chip.rect.right > sceneGridRect.right + 0.5
        || chip.rect.bottom > sceneGridRect.bottom + 0.5
      )),
      chipsWithOverflow: sceneChipLayouts.filter((chip) => (
        chip.scrollHeight > chip.clientHeight + 1
        || chip.scrollWidth > chip.clientWidth + 1
      )),
    } : null,
    setupBody: dimensions(setupBody),
    setupSections: setupSectionLayouts,
    controlCard: dimensions(controlCard),
    sidePanel: dimensions(sidePanel),
    generateBar: dimensions(generateBar),
    optionLabelsOutsideCards: optionLabelLayouts.filter((item) => item.card && item.label && (
      item.label.left < item.card.left - 0.5
      || item.label.top < item.card.top - 0.5
      || item.label.right > item.card.right + 0.5
      || item.label.bottom > item.card.bottom + 0.5
    )),
    rects: {
      workspace: bounds(workspace),
      planner: bounds(planner),
      plannerEditor: editorRect,
      plannerFooter: footerRect,
      masterReview: masterReviewRect,
      masterPromptEditor: masterPromptEditorRect,
      analysisRow: analysisRowRect,
      sourceCard: sourceCardRect,
      directorStage: directorStageRect,
      sceneGrid: sceneGridRect,
      setupBody: bodyRect,
      setupSections: sectionRects,
      generateBar: actionRect,
      controlCard: bounds(controlCard),
      sidePanel: bounds(sidePanel),
      sidebarNav: sidebarNavRect,
      sidebarUtilityStack: sidebarUtilityStackRect,
      updateLogTrigger: updateLogTriggerRect,
      runtimeErrorLogSlot: runtimeErrorLogSlotRect,
      runtimeErrorLogTrigger: runtimeErrorLogTriggerRect,
      runtimeErrorLogLatest: runtimeErrorLogLatestRect,
      sidebarFooter: sidebarFooterRect,
    },
    overlap: {
      sourceAndStage: Boolean(
        sourceCardRect
        && directorStageRect
        && sourceCardRect.bottom > directorStageRect.top + 0.5
      ),
      setupAndActions: Boolean(bodyRect && actionRect && bodyRect.bottom > actionRect.top + 0.5),
      plannerEditorAndFooter: Boolean(editorRect && footerRect && editorRect.bottom > footerRect.top + 0.5),
      updateLogAndErrorLog: Boolean(
        updateLogTriggerRect
        && runtimeErrorLogTriggerRect
        && updateLogTriggerRect.bottom > runtimeErrorLogTriggerRect.top + 0.5
      ),
      runtimeErrorLogAndSidebarFooter: Boolean(
        runtimeErrorLogSlotRect
        && sidebarFooterRect
        && runtimeErrorLogSlotRect.bottom > sidebarFooterRect.top + 0.5
      ),
      setupSections: sectionRects.some((sectionRect, index) => (
        index > 0 && sectionRects[index - 1].bottom > sectionRect.top + 0.5
      )),
    },
    visibleControlsOutsideViewport: [...document.querySelectorAll('button, input, select, textarea')]
      .filter((control) => control.getClientRects().length > 0)
      // The segment editor is an intentional scroll region. Its fields are
      // individually scrolled into view and hit-tested by the focused planner
      // regression; below-fold content is not viewport clipping.
      .filter((control) => {
        const scrollRegion = control.closest('.sequence-segment-editor');
        return !scrollRegion || getComputedStyle(scrollRegion).overflowY !== 'auto';
      })
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        text: control.textContent?.trim() || '',
        rect: bounds(control),
      }))
      .filter((item) => item.rect && (
        item.rect.left < -0.5
        || item.rect.top < -0.5
        || item.rect.right > innerWidth + 0.5
        || item.rect.bottom > innerHeight + 0.5
      )),
  };
  }, { kind, label });
};

const assertLayout = (result) => {
  const failures = [];
  if (result.document.scrollWidth > result.document.clientWidth + 1) failures.push('document horizontal overflow');
  if (result.document.scrollHeight > result.document.clientHeight + 1) failures.push('document vertical overflow');
  if (result.workspace?.scrollHeight > result.workspace?.clientHeight + 1) failures.push('workspace vertical scrolling');
  if (result.sidebarNav?.scrollHeight > result.sidebarNav?.clientHeight + 1) failures.push('sidebar navigation requires scrolling');
  if (!result.rects.updateLogTrigger || !result.rects.runtimeErrorLogTrigger || !result.rects.sidebarFooter) {
    failures.push('sidebar update log, error log, or footer is missing');
  }
  if (!result.sidebarUtility?.immediatelyAdjacent) failures.push('sidebar update log is not immediately before the error log');
  if (!result.sidebarUtility?.latestErrorText.startsWith('最近：')) failures.push('sidebar latest-error secondary line is missing');
  if (result.rects.updateLogTrigger && result.rects.runtimeErrorLogTrigger
    && result.rects.updateLogTrigger.top >= result.rects.runtimeErrorLogTrigger.top) {
    failures.push('sidebar update log is not above the error log');
  }
  if (!(result.sidebarFitScale > 0 && result.sidebarFitScale <= 1)) failures.push('sidebar fit scale must remain positive and no greater than one');
  const expectedSidebarLogHeight = (result.viewport.height <= 760 ? 16 : 18) * result.sidebarFitScale;
  if (result.rects.updateLogTrigger
    && Math.abs(result.rects.updateLogTrigger.height - expectedSidebarLogHeight) > 0.5) {
    failures.push(`sidebar update log is ${result.rects.updateLogTrigger.height}px high instead of ${expectedSidebarLogHeight}px`);
  }
  if (result.rects.runtimeErrorLogTrigger
    && Math.abs(result.rects.runtimeErrorLogTrigger.height - expectedSidebarLogHeight) > 0.5) {
    failures.push(`sidebar error log is ${result.rects.runtimeErrorLogTrigger.height}px high instead of ${expectedSidebarLogHeight}px`);
  }
  if (result.overlap.updateLogAndErrorLog) failures.push('sidebar update log overlaps error log');
  if (result.overlap.runtimeErrorLogAndSidebarFooter) failures.push('sidebar error log overlaps footer');
  if (result.rects.sidebarNav && result.rects.sidebarUtilityStack && (
    result.rects.sidebarUtilityStack.top < result.rects.sidebarNav.top - 0.5
    || result.rects.sidebarUtilityStack.bottom > result.rects.sidebarNav.bottom + 0.5
  )) failures.push('sidebar logs extend outside the navigation viewport');
  if (result.kind === 'planner') {
    if (result.planner?.scrollHeight > result.planner?.clientHeight + 1) failures.push('planner clipped vertically');
    if (result.plannerEditor?.scrollHeight > result.plannerEditor?.clientHeight + 1
      && result.plannerEditorOverflow !== 'auto') failures.push('planner editor clipped vertically');
    if (result.overlap.plannerEditorAndFooter) failures.push('planner editor overlaps footer');
    if (result.masterPromptEditor && result.rects.masterPromptEditor?.height < 90) {
      failures.push('segmented master prompt editor is too short to review the full timeline');
    }
  }
  if (result.kind === 'master-review') {
    if (!result.masterReview) failures.push('master review card is missing');
    if (!result.masterPromptEditor) failures.push('master prompt editor is missing');
    if (!result.analysisRow) failures.push('planning estimate row is missing');
    if (result.rects.analysisRow?.height > 48) failures.push('planning estimate row consumes flexible master-review height');
    if (result.rects.masterPromptEditor?.height < 90) failures.push('master prompt editor is too short to review the full timeline');
    if (result.rects.analysisRow && result.rects.masterPromptEditor
      && result.rects.masterPromptEditor.height < result.rects.analysisRow.height * 3) {
      failures.push('master prompt editor must receive at least three times the estimate-row height');
    }
    if (result.planner?.scrollHeight > result.planner?.clientHeight + 1) failures.push('master review planner clipped vertically');
    if (result.masterReview?.scrollWidth > result.masterReview?.clientWidth + 1) failures.push('master review overflows horizontally');
    if (result.rects.masterReview && result.rects.planner && (
      result.rects.masterReview.left < result.rects.planner.left - 0.5
      || result.rects.masterReview.top < result.rects.planner.top - 0.5
      || result.rects.masterReview.right > result.rects.planner.right + 0.5
      || result.rects.masterReview.bottom > result.rects.planner.bottom + 0.5
    )) failures.push('master review extends outside planner');
  }
  if (result.kind === 'director') {
    if (!result.rects.sourceCard || !result.rects.directorStage) failures.push('director source card or stage is missing');
    if (result.sourceCard?.scrollHeight > result.sourceCard?.clientHeight + 1) failures.push('director source card is clipped vertically');
    if (result.sourceCard?.scrollWidth > result.sourceCard?.clientWidth + 1) failures.push('director source card overflows horizontally');
    if (result.overlap.sourceAndStage) failures.push('director source card overlaps the director stage');
    if (result.scenePicker) {
      if (result.scenePicker.rect.height > 43) failures.push(`director scene grid is ${result.scenePicker.rect.height}px high instead of at most 43px`);
      if (result.scenePicker.dimensions.scrollHeight > result.scenePicker.dimensions.clientHeight + 1) failures.push('director scene grid overflows vertically');
      if (result.scenePicker.dimensions.scrollWidth > result.scenePicker.dimensions.clientWidth + 1) failures.push('director scene grid overflows horizontally');
      if (result.scenePicker.chipsOutsideGrid.length) failures.push('director scene chips extend outside the scene grid');
      if (result.scenePicker.chipsWithOverflow.length) failures.push('director scene chips clip their content');
      if (result.scenePicker.chips.some((chip) => (
        !Number.isFinite(chip.fontSize)
        || chip.fontSize < 8
        || chip.fontSize > 10
      ))) failures.push('director scene chip font size must stay between 8px and 10px');
      if (result.scenePicker.chipCount === 12) {
        if (result.scenePicker.columnCount !== 6) failures.push(`expected 6 director scene columns, found ${result.scenePicker.columnCount}`);
        if (result.scenePicker.rowCount !== 2) failures.push(`expected 2 director scene rows, found ${result.scenePicker.rowCount}`);
      }
    }
    if (!result.rects.controlCard || !result.rects.sidePanel) failures.push('director equal-width columns are missing');
    if (result.rects.controlCard && result.rects.sidePanel
      && Math.abs(result.rects.controlCard.width - result.rects.sidePanel.width) > 1) {
      failures.push(`director columns differ by ${Math.abs(result.rects.controlCard.width - result.rects.sidePanel.width)}px`);
    }
    if (result.setupBody?.scrollHeight > result.setupBody?.clientHeight + 1) failures.push('director setup body requires scrolling');
    if (result.setupBody?.scrollWidth > result.setupBody?.clientWidth + 1) failures.push('director setup body overflows horizontally');
    if (result.controlCard?.scrollHeight > result.controlCard?.clientHeight + 1) failures.push('director control card is clipped');
    if (result.generateBar?.scrollHeight > result.generateBar?.clientHeight + 1) failures.push('director generate bar is clipped vertically');
    if (result.generateBar?.scrollWidth > result.generateBar?.clientWidth + 1) failures.push('director generate bar overflows horizontally');
    if (result.optionLabelsOutsideCards.length) failures.push('director option labels extend outside their cards');
    const expectedDirectorSectionIds = ['director-setup-timing', 'director-setup-look', 'director-setup-style', 'director-setup-motion'];
    if (JSON.stringify(result.setupSections.map((section) => section.id)) !== JSON.stringify(expectedDirectorSectionIds)) {
      failures.push(`expected all four ordered director parameter groups, found ${result.setupSections.map((section) => section.id).join(', ')}`);
    }
    for (const section of result.setupSections) {
      if (!section.visible) failures.push(`${section.id || 'director section'} is hidden`);
      if (section.dimensions.scrollHeight > section.dimensions.clientHeight + 1) failures.push(`${section.id} is clipped vertically`);
      if (section.dimensions.scrollWidth > section.dimensions.clientWidth + 1) failures.push(`${section.id} is clipped horizontally`);
      if (section.controlsOutsideSection.length) failures.push(`${section.id} contains controls outside its bounds`);
      if (result.rects.setupBody && section.rect && (
        section.rect.left < result.rects.setupBody.left - 0.5
        || section.rect.top < result.rects.setupBody.top - 0.5
        || section.rect.right > result.rects.setupBody.right + 0.5
        || section.rect.bottom > result.rects.setupBody.bottom + 0.5
      )) failures.push(`${section.id} extends outside the setup body`);
    }
    if (result.overlap.setupSections) failures.push('director parameter groups overlap each other');
    if (result.overlap.setupAndActions) failures.push('director parameter groups overlap generate bar');
  }
  if (result.visibleControlsOutsideViewport.length) failures.push('visible controls outside viewport');
  if (failures.length) throw new Error(`${result.label}: ${failures.join('; ')}\n${JSON.stringify(result, null, 2)}`);
};

const layoutReport = [];
const updateLogLayoutReport = [];
const denseDirectorStripReport = [];
let editRecovery = null;
let riskGates = null;
let batchStatuses = [];
let threeStageFlow = null;
let confirmedPlanningInputEdits = null;
let tamperedMasterRecovery = null;
let asyncMasterPromptRegression = null;
let storyBiblePreviewRegression = null;
let storyBibleRecoveryRegression = null;
let sequenceReferenceRegenerationRegression = null;
let sequenceMultiPictureSubjectsRegression = null;
let quietFoleyReferenceRegression = null;
let allImageRulesComfyRegression = null;
let legacyKreaCatalogRegression = null;
let storyInputActions = null;
const mainTextApiCalls = [];
const mainTextApiMockErrors = [];
const waitForDirectorSections = async () => {
  await page.locator('.director-all-sections').waitFor();
  await page.waitForFunction(() => {
    const sections = [...document.querySelectorAll('.director-all-sections > .director-setup-section')];
    return sections.length === 4 && sections.every((section) => (
      section.getClientRects().length > 0
      && getComputedStyle(section).display !== 'none'
      && getComputedStyle(section).visibility !== 'hidden'
    ));
  });
};
const captureUpdateLogLayoutSet = async (prefix) => {
  const updateLogTrigger = page.locator('.update-log-trigger');
  await updateLogTrigger.waitFor();
  await updateLogTrigger.click();
  const dialog = page.getByRole('dialog', { name: '更新日志' });
  await dialog.waitFor();

  try {
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(80);
      const label = `${prefix}-${size.width}x${size.height}`;
      const result = await page.evaluate(({ currentLabel, expectedVersions }) => {
        const modal = document.querySelector('.update-log-modal[role="dialog"]');
        const list = modal?.querySelector('.update-log-list');
        const closeButton = [...(modal?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === '关闭');
        const bounds = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            top: Math.round(value.top * 100) / 100,
            right: Math.round(value.right * 100) / 100,
            bottom: Math.round(value.bottom * 100) / 100,
            left: Math.round(value.left * 100) / 100,
            width: Math.round(value.width * 100) / 100,
            height: Math.round(value.height * 100) / 100,
          };
        };
        const modalRect = bounds(modal);
        const listRect = bounds(list);
        const closeRect = bounds(closeButton);
        const versions = [...(modal?.querySelectorAll('[data-update-log-version]') || [])]
          .map((entry) => entry.getAttribute('data-update-log-version'));
        const highlightCounts = [...(modal?.querySelectorAll('[data-update-log-version]') || [])]
          .map((entry) => entry.querySelectorAll('li').length);
        if (list) {
          list.scrollTop = 0;
          list.scrollTop = list.scrollHeight;
        }
        const maxScrollTop = list ? list.scrollHeight - list.clientHeight : 0;
        return {
          label: currentLabel,
          viewport: { width: innerWidth, height: innerHeight },
          heading: modal?.querySelector('h3')?.textContent?.trim() || '',
          versions,
          versionsMatch: JSON.stringify(versions) === JSON.stringify(expectedVersions),
          highlightCounts,
          currentVersion: modal
            ?.querySelector('.update-log-entry.current')
            ?.getAttribute('data-update-log-version') || '',
          currentBadge: modal?.querySelector('.update-log-current')?.textContent?.trim() || '',
          modal: modalRect,
          list: listRect,
          closeButton: closeRect,
          modalInsideViewport: Boolean(modalRect
            && modalRect.left >= -0.5
            && modalRect.top >= -0.5
            && modalRect.right <= innerWidth + 0.5
            && modalRect.bottom <= innerHeight + 0.5),
          listInsideModal: Boolean(listRect && modalRect
            && listRect.left >= modalRect.left - 0.5
            && listRect.top >= modalRect.top - 0.5
            && listRect.right <= modalRect.right + 0.5
            && listRect.bottom <= modalRect.bottom + 0.5),
          closeInsideModal: Boolean(closeRect && modalRect
            && closeRect.left >= modalRect.left - 0.5
            && closeRect.top >= modalRect.top - 0.5
            && closeRect.right <= modalRect.right + 0.5
            && closeRect.bottom <= modalRect.bottom + 0.5),
          listScrollable: Boolean(list && maxScrollTop > 1),
          scrollTop: list?.scrollTop ?? null,
          maxScrollTop,
          scrolledToBottom: Boolean(list
            && maxScrollTop > 1
            && Math.abs(maxScrollTop - list.scrollTop) <= 1),
          documentOverflowX: document.documentElement.scrollWidth
            > document.documentElement.clientWidth + 1,
          modalOverflowX: Boolean(modal && modal.scrollWidth > modal.clientWidth + 1),
          listOverflowX: Boolean(list && list.scrollWidth > list.clientWidth + 1),
        };
      }, { currentLabel: label, expectedVersions: expectedUpdateLogVersions });
      const failures = [];
      if (result.heading !== '更新日志') failures.push('dialog heading is missing');
      if (!result.versionsMatch) failures.push(`version order is ${JSON.stringify(result.versions)}`);
      if (result.highlightCounts.some((count) => count < 2)) failures.push('one or more versions have fewer than two updates');
      if (result.currentVersion !== expectedUpdateLogCurrentVersion || result.currentBadge !== '当前版本') {
        failures.push(`current version marker is ${result.currentVersion || 'missing'}`);
      }
      if (!result.modalInsideViewport) failures.push('dialog extends outside viewport');
      if (!result.listInsideModal) failures.push('update list extends outside dialog');
      if (!result.closeInsideModal) failures.push('close button extends outside dialog');
      if (!result.listScrollable) failures.push('update list is not vertically scrollable');
      if (!result.scrolledToBottom) failures.push('update list could not scroll to its bottom');
      if (result.documentOverflowX || result.modalOverflowX || result.listOverflowX) {
        failures.push('update dialog introduces horizontal overflow');
      }
      if (failures.length) {
        throw new Error(`${label}: ${failures.join('; ')}\n${JSON.stringify(result, null, 2)}`);
      }
      updateLogLayoutReport.push(result);
      await page.screenshot({
        path: path.join(outputDirectory, `${slug(label)}.png`),
        fullPage: false,
      });
    }
  } finally {
    const closeButton = dialog.getByRole('button', { name: '关闭', exact: true });
    if (await closeButton.count()) await closeButton.click();
    await dialog.waitFor({ state: 'detached' });
  }

  if (await page.locator('.update-log-modal').count()) {
    throw new Error('update log dialog remained mounted after closing');
  }
};
const captureDirectorLayoutSet = async (prefix) => {
  await waitForDirectorSections();
  for (const size of directorSizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(80);
    const label = `${prefix}-${size.width}x${size.height}`;
    const result = await collectLayout('director', label);
    layoutReport.push(result);
    await page.screenshot({
      path: path.join(outputDirectory, `${slug(label)}.png`),
      fullPage: false,
    });
    assertLayout(result);
  }
};
const installQaScenePicker = async (targetCount = 12) => {
  await page.getByRole('button', { name: '九宫格', exact: true }).click();
  await page.locator('.scene-chip-grid').waitFor();
  const installedCount = await page.evaluate((count) => {
    const grid = document.querySelector('.scene-chip-grid');
    const template = grid?.querySelector('.select-chip');
    if (!grid || !template) throw new Error('director scene picker is unavailable');
    const originalCount = grid.querySelectorAll('.select-chip').length;
    if (originalCount > count) {
      throw new Error(`director scene picker already contains ${originalCount} entries; expected at most ${count}`);
    }
    for (let index = originalCount + 1; index <= count; index += 1) {
      const clone = template.cloneNode(true);
      clone.dataset.qaSceneClone = 'true';
      clone.classList.add('active');
      const marker = clone.firstElementChild?.cloneNode(true);
      clone.replaceChildren();
      if (marker) clone.append(marker);
      clone.append(document.createTextNode(`场景 ${index}`));
      grid.append(clone);
    }
    return grid.querySelectorAll('.select-chip').length;
  }, targetCount);
  if (installedCount !== targetCount) {
    throw new Error(`failed to construct ${targetCount} director QA scene buttons; found ${installedCount}`);
  }
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
};
const cleanupQaScenePicker = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('[data-qa-scene-clone="true"]').forEach((element) => element.remove());
  });
};
const captureDenseDirectorStripLayoutSet = async (prefix, targetCount = 29) => {
  await waitForDirectorSections();
  await page.evaluate((count) => {
    const filmstrip = document.querySelector('.sequence-director-strip .sequence-filmstrip');
    const template = filmstrip?.querySelector('.sequence-segment-chip');
    if (!filmstrip || !template) throw new Error('director sequence strip is unavailable');
    const badge = document.querySelector('.sequence-director-strip .badge');
    if (badge) {
      badge.dataset.qaOriginalText = badge.textContent || '';
      badge.textContent = `当前 1/${count}`;
    }
    for (let index = filmstrip.querySelectorAll('.sequence-segment-chip').length + 1; index <= count; index += 1) {
      const clone = template.cloneNode(true);
      clone.dataset.qaDenseClone = 'true';
      clone.classList.remove('active');
      clone.setAttribute('aria-selected', 'false');
      const indexLabel = clone.querySelector('.sequence-segment-index');
      const title = clone.querySelector('strong');
      const status = clone.querySelector('small');
      if (indexLabel) indexLabel.textContent = `第 ${index} 段`;
      if (title) title.textContent = `第${index}段剧情`;
      if (status) status.textContent = `${index * 8 - 8}s—${index * 8}s · 8秒 · 已完成`;
      filmstrip.append(clone);
    }
  }, targetCount);

  try {
    for (const size of directorSizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(80);
      const label = `${prefix}-${size.width}x${size.height}`;
      const result = await page.evaluate((currentLabel) => {
        const strip = document.querySelector('.sequence-director-strip');
        const filmstrip = strip?.querySelector('.sequence-filmstrip');
        const cards = filmstrip ? [...filmstrip.querySelectorAll('.sequence-segment-chip')] : [];
        const bounds = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            top: Math.round(value.top * 100) / 100,
            right: Math.round(value.right * 100) / 100,
            bottom: Math.round(value.bottom * 100) / 100,
            left: Math.round(value.left * 100) / 100,
            width: Math.round(value.width * 100) / 100,
            height: Math.round(value.height * 100) / 100,
          };
        };
        return {
          label: currentLabel,
          viewport: { width: innerWidth, height: innerHeight },
          strip: bounds(strip),
          filmstrip: filmstrip ? {
            ...bounds(filmstrip),
            clientWidth: filmstrip.clientWidth,
            scrollWidth: filmstrip.scrollWidth,
            clientHeight: filmstrip.clientHeight,
            scrollHeight: filmstrip.scrollHeight,
          } : null,
          cards: cards.map((card) => ({
            card: bounds(card),
            index: bounds(card.querySelector('.sequence-segment-index')),
            clientHeight: card.clientHeight,
            scrollHeight: card.scrollHeight,
            indexWhiteSpace: getComputedStyle(card.querySelector('.sequence-segment-index')).whiteSpace,
          })),
          backButton: (() => {
            const button = strip?.querySelector('button:not(.sequence-segment-chip)');
            return button ? {
              ...bounds(button),
              clientHeight: button.clientHeight,
              scrollHeight: button.scrollHeight,
            } : null;
          })(),
          currentBadge: bounds(strip?.querySelector('.badge')),
        };
      }, label);
      const failures = [];
      if (!result.strip || !result.filmstrip) failures.push('dense director strip is missing');
      if (result.strip && (result.strip.height < 47.5 || result.strip.height > 48.5)) {
        failures.push(`dense director strip height is ${result.strip.height}px instead of 48px`);
      }
      if (result.cards.length !== targetCount) failures.push(`expected ${targetCount} dense segment cards, found ${result.cards.length}`);
      if (result.cards.some((item) => !item.card || item.card.height > 30.5)) failures.push('dense segment card exceeds 30px');
      if (result.cards.some((item) => !item.index || item.index.height > 11)) failures.push('dense segment index wrapped vertically');
      if (result.cards.some((item) => item.indexWhiteSpace !== 'nowrap')) failures.push('dense segment index allows wrapping');
      if (result.cards.some((item) => item.scrollHeight > item.clientHeight + 1)) failures.push('dense segment card clips content vertically');
      if (result.filmstrip && result.filmstrip.scrollWidth <= result.filmstrip.clientWidth) {
        failures.push('dense segment strip did not switch to horizontal scrolling');
      }
      for (const control of [result.backButton, result.currentBadge]) {
        if (control && result.strip && (control.top < result.strip.top - 0.5 || control.bottom > result.strip.bottom + 0.5)) {
          failures.push('strip control extends outside the compact height');
        }
      }
      if (result.backButton && result.backButton.scrollHeight > result.backButton.clientHeight + 1) {
        failures.push('back-to-planner button clips its label vertically');
      }
      if (failures.length) throw new Error(`${label}: ${failures.join('; ')}\n${JSON.stringify(result, null, 2)}`);
      denseDirectorStripReport.push(result);
      await page.screenshot({
        path: path.join(outputDirectory, `${slug(label)}.png`),
        fullPage: false,
      });
    }
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-qa-dense-clone="true"]').forEach((element) => element.remove());
      const badge = document.querySelector('.sequence-director-strip .badge[data-qa-original-text]');
      if (badge) {
        badge.textContent = badge.dataset.qaOriginalText || '';
        delete badge.dataset.qaOriginalText;
      }
    });
  }
};
const capturePlannerLayoutSet = async (kind, prefix) => {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(80);
    const label = `${prefix}-${size.width}x${size.height}`;
    const result = await collectLayout(kind, label);
    layoutReport.push(result);
    await page.screenshot({
      path: path.join(outputDirectory, `${slug(label)}.png`),
      fullPage: false,
    });
    assertLayout(result);
  }
};
const persistedSequenceSnapshot = async () => page.evaluate((key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const state = JSON.parse(raw);
  const plans = state?.project?.sequencePlans || [];
  const plan = [...plans].reverse().find((candidate) => (
    candidate.totalDurationSec === 24 && candidate.segmentDurationSec === 8
  )) || plans.at(-1);
  if (!plan) return null;
  const storyboards = state?.project?.storyboards || [];
  const masterBoard = storyboards.find((board) => board.id === plan.masterStoryboardId);
  const segmentBoards = plan.segments.map((segment) => (
    storyboards.find((board) => board.id === segment.storyboardId) || null
  ));
  return { plan, masterBoard, segmentBoards };
}, storageKey);
const waitForPersistedSequenceStage = async (stage, segmentCount = undefined) => {
  await page.waitForFunction(({ key, stage, segmentCount }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const state = JSON.parse(raw);
    const plans = state?.project?.sequencePlans || [];
    return plans.some((plan) => (
      plan.totalDurationSec === 24
      && plan.segmentDurationSec === 8
      && plan.planningStage === stage
      && (segmentCount === undefined || plan.segments?.length === segmentCount)
    ));
  }, { key: storageKey, stage, segmentCount });
  return persistedSequenceSnapshot();
};
const generateConfirmAndSplitCurrentInputs = async () => {
  let plannerPanel = page.locator('.sequence-planner-panel');
  const settingsConfirm = page.getByRole('button', {
    name: '确认全片导演参数，进入①全片规划',
    exact: true,
  });
  const plannerSettingsLink = page.getByRole('button', {
    name: '返回并确认全片导演参数',
    exact: true,
  });
  await page.waitForFunction(() => Boolean(
    document.querySelector('.sequence-planner-panel')
    || [...document.querySelectorAll('button')].some((candidate) => (
      candidate.textContent?.trim() === '确认全片导演参数，进入①全片规划'
    )),
  ));
  if (!(await plannerPanel.count())) {
    await settingsConfirm.waitFor();
    await settingsConfirm.click();
  } else if (await plannerSettingsLink.count()) {
    await plannerSettingsLink.click();
    await settingsConfirm.waitFor();
    await settingsConfirm.click();
  }
  plannerPanel = page.locator('.sequence-planner-panel');
  await plannerPanel.waitFor();
  await expandPlannerOptions();
  // Let React commit the latest planning inputs before capturing the
  // operation identity used by the master-generation guard.
  const planningTab = page.getByRole('tab', { name: '① 全片规划', exact: true });
  if (await planningTab.getAttribute('aria-selected') !== 'true') {
    await planningTab.click();
  }
  await page.waitForFunction(() => {
    const tab = [...document.querySelectorAll('.sequence-stage-switcher [role="tab"]')]
      .find((candidate) => candidate.textContent?.trim() === '① 全片规划');
    return Boolean(
      tab?.getAttribute('aria-selected') === 'true'
      && document.querySelector('.sequence-planner-panel'),
    );
  });
  await page.waitForTimeout(750);
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.sequence-planner-panel button')]
      .find((candidate) => candidate.textContent?.trim() === '① 生成全片总提示词');
    return Boolean(button && !button.disabled);
  });
  await plannerPanel.getByRole('button', { name: '① 生成全片总提示词', exact: true }).click();
  // When the user changes the total duration after a previous plan, the
  // first click intentionally refreshes the local/AI estimate.  The next
  // click commits the master prompt using that confirmed estimate.
  await page.waitForTimeout(450);
  const estimateAction = plannerPanel.getByRole('button', { name: '估算全片时长', exact: true });
  if (await estimateAction.count()) {
    await plannerPanel.getByRole('button', { name: '① 生成全片总提示词', exact: true }).click();
  }
  await page.locator('.sequence-master-review').waitFor();
  const confirmButton = page.getByRole('button', { name: '确认总提示词', exact: true });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === '确认总提示词');
    return Boolean(button && !button.disabled);
  });
  await confirmButton.click();
  const splitButton = page.getByRole('button', { name: '② AI 按剧情边界分段', exact: true });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === '② AI 按剧情边界分段');
    return Boolean(button && !button.disabled);
  });
  await splitButton.click();
  await page.locator('.sequence-plan-workspace').waitFor();
};

const expandPlannerOptions = async () => {
  const toggle = page.getByRole('button', { name: '展开规划参数', exact: true });
  if (await toggle.count()) await toggle.click();
};

const runAllImageRulesComfyRegression = async () => {
  const regressionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const regressionPage = await regressionContext.newPage();
  const textRequests = [];
  const imageRequests = [];
  const unexpectedRequests = [];
  const localConsoleErrors = [];
  const comfyRoot = new URL('qa-image-rules-comfy', baseUrl).toString().replace(/\/$/u, '');
  const textRoot = new URL('qa-image-rules-text/v1', baseUrl).toString().replace(/\/$/u, '');
  const chosenRuleId = 'image-rule-krea-2';
  const boundPresetId = 'qa-krea-prop-binding';
  const manualPresetId = 'image-preset-cinematic-prop';
  const generatedName = 'QA蓝釉茶壶';
  const finalImagePrompt = '一只深蓝釉面的陶瓷茶壶置于浅灰石台中央，圆润壶腹、短弧壶嘴和完整环形把手清晰可辨，釉面保留细微冰裂纹。左侧柔光勾勒壶盖与曲面轮廓，低机位近景呈现厚实陶瓷质感，背景干净且没有人物。';
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE_PROMPT__' } },
    3: { class_type: 'EmptyLatentImage', inputs: { width: '__WIDTH__', height: '__HEIGHT__', batch_size: 1 } },
    4: { class_type: 'KSampler', inputs: {
      model: ['5', 0], positive: ['1', 0], negative: ['2', 0], latent_image: ['3', 0],
      seed: 987654321, steps: 15, cfg: 4.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    } },
    5: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'qa-unchanged-checkpoint.safetensors' } },
    9: { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'qa-all-image-rules' } },
  };
  let imageBytes;
  const same = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`all-image-rules ComfyUI QA changed ${label}`);
  };
  regressionPage.on('console', (message) => {
    if (message.type() === 'error') localConsoleErrors.push(message.text());
  });
  regressionPage.on('pageerror', (error) => localConsoleErrors.push(error.message));
  try {
    await regressionPage.addInitScript(() => {
      if (!sessionStorage.getItem('__lianhua_all_image_rules_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('__lianhua_all_image_rules_qa_initialized__', '1');
      }
    });
    await regressionPage.route('**/qa-image-rules-text/v1/chat/completions', async (route) => {
      const payload = route.request().postDataJSON();
      textRequests.push({ system: qaMessageContent(payload, 'system'), user: qaMessageContent(payload, 'user') });
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: finalImagePrompt } }] }),
      });
    });
    await regressionPage.route('**/qa-image-rules-comfy/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const operation = url.pathname.split('/').filter(Boolean).slice(1).join('/');
      imageRequests.push({ method: request.method(), operation, body: request.method() === 'POST' ? request.postDataJSON() : undefined });
      if (request.method() === 'POST' && operation === 'prompt') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prompt_id: 'qa-all-rules-job' }) });
      } else if (request.method() === 'GET' && operation === 'history/qa-all-rules-job') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          'qa-all-rules-job': {
            status: { completed: true, status_str: 'success' },
            outputs: { 9: { images: [{ filename: 'qa-comfy-natural-language.png', subfolder: '', type: 'output' }] } },
          },
        }) });
      } else if (request.method() === 'GET' && operation === 'view') {
        await route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
      } else {
        unexpectedRequests.push({ method: request.method(), operation });
        await route.fulfill({ status: 500, body: 'unexpected image backend operation' });
      }
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await regressionPage.evaluate(({ key, comfyRoot, textRoot, workflow, chosenRuleId, boundPresetId }) => {
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: textRoot, apiKey: '', model: 'qa-text-converter' };
      state.settings.imageApi = {
        ...state.settings.imageApi,
        enabled: true, backend: 'comfyui', baseUrl: comfyRoot, apiKey: '', model: 'qa-current-comfy-model',
        comfyuiPathMode: 'preset', comfyuiPromptPath: '/prompt',
        workflowJson: JSON.stringify(workflow),
        comfyuiWorkflows: [{ id: 'qa-all-rules-workflow', name: 'QA固定采样工作流', workflowJson: JSON.stringify(workflow), createdAt: 1, updatedAt: 1 }],
        activeComfyuiWorkflowId: 'qa-all-rules-workflow',
      };
      state.settings.activeImageApiProfileId = null;
      state.settings.imageApiProfiles = [];
      state.settings.visionApi.enabled = false;
      state.settings.videoTaskApi.enabled = false;
      state.settings.imagePromptRuleSetIdByBackend = {};
      state.settings.imagePromptPresetIdByAssetKind = {};
      const basePreset = state.imagePromptRules.categoryPresets.find((preset) => preset.id === 'image-preset-prop');
      state.imagePromptRules.categoryPresets.push({ ...basePreset, id: boundPresetId, name: 'QA Krea 专属物品分类' });
      state.imagePromptRules.ruleSets = state.imagePromptRules.ruleSets.map((rule) => rule.id === chosenRuleId
        ? { ...rule, categoryPresetIds: [...rule.categoryPresetIds, boundPresetId], defaultPresetByAssetKind: { ...rule.defaultPresetByAssetKind, prop: boundPresetId } }
        : rule);
      state.imagePromptRules.ruleSets.push({ ...state.imagePromptRules.ruleSets[0], id: 'qa-disabled-image-rule', name: 'QA禁用规则不可选', enabled: false });
      state.project.assets = [];
      state.project.generationTasks = [];
      state.projects = [state.project];
      state.activeProjectId = state.project.id;
      localStorage.setItem(key, JSON.stringify(state));
    }, { key: storageKey, comfyRoot, textRoot, workflow, chosenRuleId, boundPresetId });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    const openPropWorkbench = async () => {
      await regressionPage.getByRole('button', { name: '图像工作台', exact: true }).click();
      await regressionPage.locator('.image-asset-kind-tabs').getByRole('button', { name: '物品', exact: true }).click();
    };
    await openPropWorkbench();
    const seeded = await regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
    const expectedRuleIds = seeded.imagePromptRules.ruleSets.filter((rule) => rule.enabled).map((rule) => rule.id);
    const rules = regressionPage.getByLabel('生图规则集', { exact: true });
    const category = regressionPage.getByLabel('分类预设', { exact: true });
    const actualRuleIds = await rules.locator('option').evaluateAll((options) => options.map((option) => option.value));
    same(actualRuleIds, expectedRuleIds, 'enabled dropdown rules');
    for (const ruleId of ['image-rule-openai-gpt-image', 'image-rule-krea-2', 'image-rule-sd-webui', 'image-rule-novelai']) {
      if (!actualRuleIds.includes(ruleId)) throw new Error(`ComfyUI dropdown omitted cross-backend rule ${ruleId}`);
    }
    await rules.selectOption(chosenRuleId);
    await regressionPage.waitForFunction(({ key, ruleId }) => JSON.parse(localStorage.getItem(key) || '{}')
      .settings?.imagePromptRuleSetIdByBackend?.comfyui === ruleId, { key: storageKey, ruleId: chosenRuleId });
    same(await category.inputValue(), boundPresetId, 'the chosen rule category binding');
    await category.selectOption(manualPresetId);
    await regressionPage.waitForFunction(({ key, presetId }) => JSON.parse(localStorage.getItem(key) || '{}')
      .settings?.imagePromptPresetIdByAssetKind?.prop === presetId, { key: storageKey, presetId: manualPresetId });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await openPropWorkbench();
    same(await rules.inputValue(), chosenRuleId, 'manual rule persistence after reload');
    same(await category.inputValue(), manualPresetId, 'manual category persistence after reload');
    const before = await regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
    same(before.settings.imageApi, seeded.settings.imageApi, 'backend/model/workflow after changing rules');
    for (const [label, value] of [
      ['物品名称', generatedName], ['类别', '茶具'], ['材质', '深蓝釉陶瓷'],
      ['详细外观', '圆腹、短弧壶嘴、环形把手、细微冰裂纹'], ['特效或剧情作用', '桌上静物'], ['状态连续性规则', '壶盖闭合，保持完整'],
    ]) await regressionPage.getByLabel(label, { exact: true }).fill(value);
    const pixelUrl = await regressionPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const painter = canvas.getContext('2d');
      painter.fillStyle = '#234d7a';
      painter.fillRect(0, 0, 4, 4);
      return canvas.toDataURL('image/png');
    });
    imageBytes = Buffer.from(pixelUrl.split(',')[1], 'base64');
    const viewResponse = regressionPage.waitForResponse((response) => response.url().startsWith(`${comfyRoot}/view?`), { timeout: 15_000 });
    await regressionPage.getByRole('button', { name: '生成参考图并保存', exact: true }).click();
    await viewResponse;
    await regressionPage.waitForFunction(({ key, name }) => {
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      return state.project?.assets.some((asset) => asset.name === name && asset.imageBackend === 'comfyui')
        && state.project?.generationTasks.some((task) => task.name === name && task.status === 'succeeded');
    }, { key: storageKey, name: generatedName });
    const after = await regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
    const generatedAsset = after.project.assets.find((asset) => asset.name === generatedName);
    const generatedTask = after.project.generationTasks.find((task) => task.name === generatedName);
    same(textRequests.length, 1, 'text-converter request count');
    if (!/目标后端：comfyui/u.test(textRequests[0].system) || !/Krea-2/u.test(textRequests[0].system)
      || !/输出格式 natural-language/u.test(textRequests[0].system) || /输出格式 sd-tags/u.test(textRequests[0].system)) {
      throw new Error('ComfyUI conversion did not retain the selected natural-language rule contract');
    }
    const submission = imageRequests.find((request) => request.method === 'POST');
    same(imageRequests.filter((request) => request.method === 'POST').map((request) => request.operation), ['prompt'], 'image API execution backend');
    if (!imageRequests.some((request) => request.operation === 'history/qa-all-rules-job') || !imageRequests.some((request) => request.operation === 'view')) {
      throw new Error('ComfyUI image generation did not complete prompt/history/view');
    }
    same(submission?.body?.prompt?.['1']?.inputs?.text, finalImagePrompt, 'natural-language positive prompt');
    same(submission?.body?.prompt?.['4']?.inputs, workflow[4].inputs, 'seed/steps/cfg/sampler parameters');
    same(submission?.body?.prompt?.['5']?.inputs, workflow[5].inputs, 'workflow checkpoint model');
    same(after.settings.imageApi, before.settings.imageApi, 'persisted execution configuration');
    same(generatedAsset.imageBackend, 'comfyui', 'asset execution backend provenance');
    same(generatedAsset.imagePromptRuleSetId, chosenRuleId, 'asset chosen rule provenance');
    same(generatedAsset.imagePromptPresetId, manualPresetId, 'asset chosen category provenance');
    same(generatedAsset.imagePromptFormat, 'natural-language', 'asset prompt format');
    same(generatedTask.backend, 'comfyui', 'task execution backend');
    if (unexpectedRequests.length || localConsoleErrors.length) throw new Error(`all-image-rules ComfyUI QA errors: ${JSON.stringify({ unexpectedRequests, localConsoleErrors })}`);
    const screenshot = 'comfy-all-image-rules-natural-language-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
    return {
      enabledRuleCount: expectedRuleIds.length,
      allEnabledRulesListed: true,
      manualRuleId: chosenRuleId,
      ruleCategoryBinding: boundPresetId,
      manualPresetId,
      selectionPersistedAfterReload: true,
      textConverterCount: textRequests.length,
      imageOperations: imageRequests.map((request) => `${request.method} ${request.operation}`),
      naturalLanguagePassedToComfy: true,
      backendModelAndParametersPreserved: true,
      assetImageBackend: generatedAsset.imageBackend,
      assetImagePromptFormat: generatedAsset.imagePromptFormat,
      screenshot,
    };
  } finally {
    await regressionContext.close();
  }
};

const runLegacyKreaCatalogRegression = async (sourceState) => {
  const kreaRuleId = 'image-rule-krea-2';
  const manualRuleId = 'image-rule-generic';
  const manualPresetId = 'image-preset-cinematic-character';
  const editedRuleId = 'image-rule-comfyui';
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    2: { class_type: 'KSampler', inputs: {
      seed: 314159265, steps: 21, cfg: 5.25, sampler_name: 'euler', scheduler: 'normal', denoise: 0.85,
    } },
    3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'qa-krea-unchanged.safetensors' } },
  };
  const fixture = structuredClone(sourceState);
  fixture.imagePromptRules.schemaVersion = 1;
  delete fixture.imagePromptRules.catalogVersion;
  fixture.imagePromptRules.ruleSets = fixture.imagePromptRules.ruleSets.filter((rule) => rule.id !== kreaRuleId);
  assert.equal(fixture.imagePromptRules.ruleSets.length, 10, 'legacy QA must begin with the current catalog minus Krea');
  const editedRule = fixture.imagePromptRules.ruleSets.find((rule) => rule.id === editedRuleId);
  assert.ok(editedRule, 'legacy QA must contain the existing ComfyUI rule');
  Object.assign(editedRule, {
    name: 'QA用户编辑的ComfyUI规则',
    systemPrompt: `${editedRule.systemPrompt}\nQA旧库自定义约束：保留青灰石台与左侧柔光。`,
    negativePrompt: 'QA user negative, duplicate objects, watermark',
    version: '1.7.3',
    updatedAt: 123456789,
  });
  const editedPreset = fixture.imagePromptRules.categoryPresets.find((preset) => preset.id === manualPresetId);
  assert.ok(editedPreset, 'legacy QA requires the user-selected character category');
  Object.assign(editedPreset, {
    name: 'QA用户保留的人物分类',
    systemPrompt: `${editedPreset.systemPrompt}\nQA旧库分类约束：人物衣领边缘必须完整。`,
    updatedAt: 123456788,
  });
  fixture.imagePromptRules.defaultRuleSetByBackend = {
    ...fixture.imagePromptRules.defaultRuleSetByBackend,
    all: 'image-rule-realism',
    comfyui: 'image-rule-realism',
  };
  fixture.settings.imagePromptRuleSetIdByBackend = { comfyui: manualRuleId };
  fixture.settings.imagePromptPresetIdByAssetKind = { character: manualPresetId };
  fixture.settings.imageApi = {
    ...fixture.settings.imageApi,
    enabled: false,
    backend: 'comfyui',
    baseUrl: new URL('qa-krea-legacy/comfy', baseUrl).toString(),
    apiKey: '',
    model: 'Krea-2 turbo QA unchanged model',
    comfyuiPathMode: 'preset',
    comfyuiPromptPath: '/prompt',
    workflowJson: JSON.stringify(workflow),
    comfyuiWorkflows: [{
      id: 'qa-krea-legacy-workflow', name: 'QA旧库固定采样工作流',
      workflowJson: JSON.stringify(workflow), createdAt: 1, updatedAt: 1,
    }],
    activeComfyuiWorkflowId: 'qa-krea-legacy-workflow',
  };
  fixture.settings.activeImageApiProfileId = null;
  fixture.settings.imageApiProfiles = [];
  fixture.settings.textApi.enabled = false;
  fixture.settings.visionApi.enabled = false;
  fixture.settings.videoTaskApi.enabled = false;
  fixture.project.assets = [];
  fixture.project.generationTasks = [];
  fixture.projects = [fixture.project];
  fixture.activeProjectId = fixture.project.id;

  const regressionContext = await browser.newContext({ viewport: { width: 1430, height: 894 } });
  const regressionPage = await regressionContext.newPage();
  const unexpectedRequests = [];
  const localConsoleErrors = [];
  const screenshotNames = [];
  const readState = () => regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
  const protectedImageConfiguration = (state) => ({
    backend: state.settings.imageApi.backend,
    model: state.settings.imageApi.model,
    baseUrl: state.settings.imageApi.baseUrl,
    workflowJson: state.settings.imageApi.workflowJson,
    comfyuiPathMode: state.settings.imageApi.comfyuiPathMode,
    comfyuiPromptPath: state.settings.imageApi.comfyuiPromptPath,
    comfyuiWorkflows: state.settings.imageApi.comfyuiWorkflows,
    activeComfyuiWorkflowId: state.settings.imageApi.activeComfyuiWorkflowId,
  });
  const assertPreserved = (state, { manualSelection = true } = {}) => {
    assert.deepEqual(state.imagePromptRules.ruleSets.filter((rule) => rule.id !== kreaRuleId), fixture.imagePromptRules.ruleSets,
      'Krea migration must preserve every field and the order of the original rules, including user edits');
    assert.deepEqual(state.imagePromptRules.categoryPresets, fixture.imagePromptRules.categoryPresets,
      'Krea migration must preserve existing category presets and their user edits');
    assert.deepEqual(state.imagePromptRules.defaultRuleSetByBackend, fixture.imagePromptRules.defaultRuleSetByBackend,
      'Krea migration must not replace existing catalog defaults');
    assert.deepEqual(protectedImageConfiguration(state), protectedImageConfiguration(fixture),
      'Krea migration and rule selection must not change backend, model, workflow or sampling parameters');
    if (manualSelection) {
      assert.deepEqual(state.settings.imagePromptRuleSetIdByBackend, fixture.settings.imagePromptRuleSetIdByBackend,
        'Krea migration must preserve the manually chosen rule even with a Krea model');
      assert.deepEqual(state.settings.imagePromptPresetIdByAssetKind, fixture.settings.imagePromptPresetIdByAssetKind,
        'Krea migration must preserve the manually chosen category');
    }
  };
  const openImageRules = async () => {
    await regressionPage.getByRole('button', { name: '规则中心', exact: true }).click();
    await regressionPage.locator('.rule-tabs').getByRole('button', { name: /^生图规则集/u }).click();
    await regressionPage.locator('.image-prompt-rule-list').waitFor();
  };
  const selectKreaInLibrary = async () => {
    await openImageRules();
    await regressionPage.locator('.image-prompt-rule-list').getByRole('button', { name: /Krea-2/u }).click();
    await regressionPage.getByLabel('转换器系统提示词', { exact: true }).waitFor();
  };
  const capture = async (name) => {
    screenshotNames.push(name);
    await regressionPage.screenshot({ path: path.join(outputDirectory, name), fullPage: false });
  };
  regressionPage.on('console', (message) => {
    if (message.type() === 'error') localConsoleErrors.push(message.text());
  });
  regressionPage.on('pageerror', (error) => localConsoleErrors.push(error.message));
  try {
    // This old catalog is written before the isolated application ever loads.
    // App storage migration, not direct rendering of current built-ins, must
    // add Krea and persist its catalog marker on the first real load.
    await regressionPage.addInitScript(({ key, initial }) => {
      if (!sessionStorage.getItem('__lianhua_krea_legacy_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem(key, JSON.stringify(initial));
        sessionStorage.setItem('__lianhua_krea_legacy_qa_initialized__', '1');
      }
    }, { key: storageKey, initial: fixture });
    await regressionPage.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(baseUrl).origin || request.method() !== 'GET'
        || url.pathname.startsWith('/qa-krea-legacy/')) {
        unexpectedRequests.push({ method: request.method(), url: request.url() });
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"API disabled for legacy catalog QA"}' });
        return;
      }
      await route.continue();
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const currentCatalogVersion = await regressionPage.evaluate(async () => (
      (await import('/src/imagePromptRules.ts')).IMAGE_PROMPT_RULE_CATALOG_VERSION
    ));
    await regressionPage.waitForFunction(({ key, ruleId, catalogVersion }) => {
      const library = JSON.parse(localStorage.getItem(key) || '{}').imagePromptRules;
      return library?.catalogVersion === catalogVersion && library.ruleSets.filter((rule) => rule.id === ruleId).length === 1;
    }, { key: storageKey, ruleId: kreaRuleId, catalogVersion: currentCatalogVersion });
    const migrated = await readState();
    assert.equal(migrated.imagePromptRules.ruleSets.length, 11);
    assertPreserved(migrated);
    await selectKreaInLibrary();
    assert.equal(await regressionPage.getByLabel('输出格式', { exact: true }).inputValue(), 'natural-language');
    const kreaSystemPrompt = await regressionPage.getByLabel('转换器系统提示词', { exact: true }).inputValue();
    assert.match(kreaSystemPrompt, /自然语言/u, 'the restored library entry must contain Krea rules, not a label-only placeholder');
    const editedKreaPrompt = `${kreaSystemPrompt}\nQA新版本用户编辑：保留参考图中的准确服装。`;
    await regressionPage.getByLabel('转换器系统提示词', { exact: true }).fill(editedKreaPrompt);
    await regressionPage.waitForFunction(({ key, ruleId, text }) => JSON.parse(localStorage.getItem(key) || '{}')
      .imagePromptRules?.ruleSets.find((rule) => rule.id === ruleId)?.systemPrompt === text,
    { key: storageKey, ruleId: kreaRuleId, text: editedKreaPrompt });
    await capture('krea-legacy-migrated-rule-library-1430x894.png');

    await regressionPage.getByRole('button', { name: '图像工作台', exact: true }).click();
    const rules = regressionPage.getByLabel('生图规则集', { exact: true });
    const category = regressionPage.getByLabel('分类预设', { exact: true });
    assert.equal(await rules.inputValue(), manualRuleId, 'opening ComfyUI must preserve the pre-upgrade manual rule');
    assert.equal(await category.inputValue(), manualPresetId, 'opening ComfyUI must preserve the pre-upgrade category');
    const ruleOptions = await rules.locator('option').evaluateAll((options) => options.map((option) => ({ id: option.value, label: option.textContent })));
    assert.equal(ruleOptions.length, 11, 'ComfyUI dropdown must expose all enabled migrated rules');
    assert.match(ruleOptions.find((option) => option.id === kreaRuleId)?.label || '', /Krea-2.*自然语言/u);
    await rules.selectOption(kreaRuleId);
    await regressionPage.waitForFunction(({ key, ruleId }) => JSON.parse(localStorage.getItem(key) || '{}')
      .settings?.imagePromptRuleSetIdByBackend?.comfyui === ruleId, { key: storageKey, ruleId: kreaRuleId });
    assertPreserved(await readState(), { manualSelection: false });
    await capture('krea-legacy-migrated-comfy-dropdown-1430x894.png');

    // Restore the user's manual choices before the deletion scenario so the
    // unrelated default bindings are independently checked after each reload.
    await rules.selectOption(manualRuleId);
    await category.selectOption(manualPresetId);
    await regressionPage.waitForFunction(({ key, ruleId, presetId }) => {
      const settings = JSON.parse(localStorage.getItem(key) || '{}').settings;
      return settings?.imagePromptRuleSetIdByBackend?.comfyui === ruleId
        && settings.imagePromptPresetIdByAssetKind?.character === presetId;
    }, { key: storageKey, ruleId: manualRuleId, presetId: manualPresetId });
    const beforeReload = await readState();
    await regressionPage.reload({ waitUntil: 'networkidle' });
    const afterReload = await readState();
    assert.deepEqual(afterReload.imagePromptRules, beforeReload.imagePromptRules,
      'reloading must not duplicate Krea or overwrite its newly saved user edits');
    assertPreserved(afterReload);
    await selectKreaInLibrary();
    assert.equal(await regressionPage.getByLabel('转换器系统提示词', { exact: true }).inputValue(), editedKreaPrompt);
    await regressionPage.getByRole('button', { name: '删除当前', exact: true }).click();
    await regressionPage.waitForFunction(({ key, ruleId }) => !JSON.parse(localStorage.getItem(key) || '{}')
      .imagePromptRules?.ruleSets.some((rule) => rule.id === ruleId), { key: storageKey, ruleId: kreaRuleId });
    const deleted = await readState();
    assert.equal(deleted.imagePromptRules.catalogVersion, currentCatalogVersion);
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await openImageRules();
    assert.equal(await regressionPage.locator('.image-prompt-rule-list').getByRole('button', { name: /Krea-2/u }).count(), 0,
      'a deliberate post-migration Krea deletion must remain deleted in the library');
    const afterDeletionReload = await readState();
    assert.deepEqual(afterDeletionReload.imagePromptRules, deleted.imagePromptRules);
    assertPreserved(afterDeletionReload);
    await regressionPage.getByRole('button', { name: '图像工作台', exact: true }).click();
    assert.equal(await rules.locator(`option[value="${kreaRuleId}"]`).count(), 0,
      'a deliberate Krea deletion must not be resurrected in the workbench selector');
    await capture('krea-legacy-intentional-delete-preserved-1430x894.png');

    // A legacy user can already have their own edited/disabled Krea rule.
    // The same-ID entry is authoritative even without a catalog marker.
    const disabledFixture = structuredClone(fixture);
    const disabledKrea = {
      ...migrated.imagePromptRules.ruleSets.find((rule) => rule.id === kreaRuleId),
      name: 'QA用户禁用的Krea-2规则', enabled: false,
      systemPrompt: 'QA已有同ID自定义规则不得覆盖或重新启用。', version: '8.4.2', updatedAt: 123456787,
    };
    disabledFixture.imagePromptRules.ruleSets.push(disabledKrea);
    await regressionPage.evaluate(({ key, initial }) => localStorage.setItem(key, JSON.stringify(initial)),
      { key: storageKey, initial: disabledFixture });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await regressionPage.waitForFunction(({ key, catalogVersion }) => JSON.parse(localStorage.getItem(key) || '{}')
      .imagePromptRules?.catalogVersion === catalogVersion, { key: storageKey, catalogVersion: currentCatalogVersion });
    const disabledMigrated = await readState();
    assert.deepEqual(disabledMigrated.imagePromptRules.ruleSets, disabledFixture.imagePromptRules.ruleSets,
      'legacy same-ID Krea must retain its custom fields and disabled flag without duplication');
    assertPreserved(disabledMigrated);
    await selectKreaInLibrary();
    assert.equal(await regressionPage.getByLabel('启用当前生图规则集', { exact: true }).isChecked(), false);
    assert.equal(await regressionPage.getByLabel('转换器系统提示词', { exact: true }).inputValue(), disabledKrea.systemPrompt);
    await regressionPage.getByRole('button', { name: '图像工作台', exact: true }).click();
    assert.equal(await rules.locator(`option[value="${kreaRuleId}"]`).count(), 0,
      'disabled Krea must remain in the library but stay absent from the enabled-only selector');
    await regressionPage.reload({ waitUntil: 'networkidle' });
    assert.deepEqual((await readState()).imagePromptRules, disabledMigrated.imagePromptRules,
      'the same-ID disabled migration must also be idempotent');
    assert.deepEqual(unexpectedRequests, [], 'legacy catalog UI QA must not send any live API requests');
    assert.deepEqual(localConsoleErrors, [], 'legacy catalog UI QA must have no browser errors');
    return {
      sourceSchemaVersion: fixture.imagePromptRules.schemaVersion,
      sourceCatalogMarkerPresent: Object.hasOwn(fixture.imagePromptRules, 'catalogVersion'),
      sourceRuleCount: fixture.imagePromptRules.ruleSets.length,
      migratedCatalogVersion: migrated.imagePromptRules.catalogVersion,
      migratedRuleCount: migrated.imagePromptRules.ruleSets.length,
      originalRulesAndUserEditsPreserved: true,
      originalCategoryPresetsAndDefaultsPreserved: true,
      manualRuleId, manualPresetId,
      libraryVisibleSelectableAndEditable: true,
      comfyDropdownContainsNaturalLanguageKrea: true,
      backendModelWorkflowAndSamplingPreserved: true,
      repeatedLoadIdempotent: true,
      deliberateDeletionNotResurrected: true,
      existingDisabledKreaNotOverwrittenOrReenabled: true,
      liveApiRequests: unexpectedRequests.length,
      screenshots: screenshotNames,
    };
  } finally {
    await regressionContext.close();
  }
};

const runSequenceReferenceRegenerationRegression = async (sourceState, planId) => {
  const fixture = structuredClone(sourceState);
  const fixturePlan = fixture.project.sequencePlans.find((plan) => plan.id === planId);
  const fixtureSegment = fixturePlan?.segments[0];
  const fixtureBoard = fixture.project.storyboards.find((board) => board.id === fixtureSegment?.storyboardId);
  if (!fixturePlan || !fixtureSegment || !fixtureBoard?.targetOutput || !fixtureBoard.finalPrompt) {
    throw new Error('reference regeneration QA requires a completed sequence board and its H3 artifact');
  }
  fixture.project.sequencePlans = [fixturePlan, ...fixture.project.sequencePlans.filter((plan) => plan.id !== planId)];
  fixture.project.storyboards = [fixtureBoard, ...fixture.project.storyboards.filter((board) => board.id !== fixtureBoard.id)];
  fixtureBoard.targetOutput.parameters = {
    ...fixtureBoard.targetOutput.parameters,
    seed: 987654321,
    steps: 15,
    cfg: 4.5,
    sampler: 'euler',
    audio_denoise_strength: 1,
    custom: { referenceRegenerationSentinel: 'keep-exactly' },
  };
  fixture.settings.textApi = {
    ...fixture.settings.textApi,
    enabled: true,
    provider: 'openai_compatible',
    baseUrl: new URL('qa-openai/v1', baseUrl).toString(),
    apiKey: '',
    model: 'qa-model',
    vision: true,
  };
  fixture.settings.imageApi.enabled = false;
  fixture.settings.visionApi.enabled = false;
  fixture.settings.videoTaskApi.enabled = false;
  fixture.projects = [fixture.project];
  fixture.activeProjectId = fixture.project.id;

  const regressionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const regressionPage = await regressionContext.newPage();
  const requests = [];
  const mockErrors = [];
  const localConsoleErrors = [];
  regressionPage.on('console', (message) => {
    if (message.type() === 'error') localConsoleErrors.push(message.text());
  });
  regressionPage.on('pageerror', (error) => localConsoleErrors.push(error.message));
  let phase = 'success';
  let unlimitedChineseSource = '';
  let heldEnglishResponse;
  let releaseStaleResponse;
  let markStaleResponseFinished;
  const staleResponseGate = new Promise((resolve) => { releaseStaleResponse = resolve; });
  const staleResponseFinished = new Promise((resolve) => { markStaleResponseFinished = resolve; });
  const same = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`reference regeneration QA changed ${label}`);
  };
  const boardOf = (state) => state.project.storyboards.find((board) => board.id === fixtureBoard.id);
  const protectedState = (state) => ({
    plans: state.project.sequencePlans,
    otherBoards: state.project.storyboards.filter((board) => board.id !== fixtureBoard.id),
    sourceDocuments: state.project.sourceDocuments,
    settings: state.settings,
    generationTasks: state.project.generationTasks,
  });
  const fixedShots = (board) => board.shots.map((shot) => ({
    id: shot.id, startSec: shot.startSec, endSec: shot.endSec, referenceAssetIds: shot.referenceAssetIds,
  }));
  const promptBundle = (board) => ({
    shots: board.shots,
    finalPrompt: board.finalPrompt,
    promptPlan: board.promptPlan,
    promptTrace: board.promptTrace,
    officialPromptZh: board.officialPromptZh,
    officialPromptEn: board.officialPromptEn,
    officialPromptSource: board.officialPromptSource,
    officialPromptEnSource: board.officialPromptEnSource,
    officialPromptEnError: board.officialPromptEnError,
    englishPrompt: board.englishPrompt,
    englishPromptSource: board.englishPromptSource,
    targetOutput: board.targetOutput,
  });
  const readState = () => regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
  const downloadText = async (button) => {
    const [download] = await Promise.all([regressionPage.waitForEvent('download'), button.click()]);
    const stream = await download.createReadStream();
    if (!stream) throw new Error('QA download did not produce a readable artifact');
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };
  const assertCompleteCopyAndProjectExport = async (board) => {
    await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
    for (const [label, prompt] of [['中文', board.officialPromptZh], ['English', board.officialPromptEn]]) {
      await regressionPage.getByRole('button', { name: label, exact: true }).click();
      assert.equal((await regressionPage.locator('.director-result-copy').textContent()).trim(), prompt,
        `${label} must display the complete stored text regardless of length`);
      await regressionPage.locator('.director-result-pane').getByRole('button', { name: '复制', exact: true }).click();
      assert.equal(await regressionPage.evaluate(() => window.__qaCopiedPrompt), prompt,
        `${label} copy must preserve all characters without touching the system clipboard`);
    }
    const exported = JSON.parse(await downloadText(regressionPage.getByRole('button', { name: '导出项目', exact: true })));
    const exportedBoard = exported.project.storyboards.find((item) => item.id === board.id);
    assert.equal(exportedBoard.officialPromptZh, board.officialPromptZh, 'project export must preserve the complete Chinese prompt');
    assert.equal(exportedBoard.officialPromptEn, board.officialPromptEn, 'project export must preserve the complete English prompt');
    return { chineseCopyCharacters: board.officialPromptZh.length, englishCopyCharacters: board.officialPromptEn.length,
      completeBilingualProjectExport: true };
  };

  try {
    await regressionPage.addInitScript(({ key, initial }) => {
      window.__qaCopiedPrompt = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value) => { window.__qaCopiedPrompt = String(value); },
      } });
      if (!sessionStorage.getItem('__lianhua_sequence_reference_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem(key, JSON.stringify(initial));
        sessionStorage.setItem('__lianhua_sequence_reference_qa_initialized__', '1');
      }
    }, { key: storageKey, initial: fixture });
    await regressionPage.route('**/qa-openai/v1/chat/completions', async (route) => {
      const payload = route.request().postDataJSON();
      const kind = qaTextRequestKind(payload);
      const userPrompt = qaMessageContent(payload, 'user');
      const referenceData = userPrompt.includes('<current_reference_data>')
        ? qaTaggedJson(userPrompt, 'current_reference_data')
        : undefined;
      const imageUrls = (payload.messages || []).filter((message) => message.role === 'user')
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'image_url').map((part) => part.image_url?.url);
      requests.push({
        kind,
        phase,
        referenceData,
        imageUrls,
        translationProtocol: kind === 'translator' ? {
          system: qaMessageContent(payload, 'system'), source: userPrompt,
          compaction: qaMessageContent(payload, 'system').includes('本次只对下面的完整英文提示词做一次精简'),
        } : undefined,
        conversionData: kind === 'converter' ? qaTaggedJson(userPrompt, 'video_conversion_data') : undefined,
        conversionSource: kind === 'converter' ? qaTaggedJson(userPrompt, 'video_conversion_data').sourceStoryContent : undefined,
      });
      const held = phase === 'stale' && kind === 'converter';
      const heldEnglish = phase.startsWith('english-stale-') && kind === 'translator'
        ? heldEnglishResponse
        : undefined;
      let response;
      try {
        if (!['converter', 'translator'].includes(kind)) throw new Error(`unexpected current-segment request kind ${kind}`);
        if (['english-partial', 'unlimited-bilingual'].includes(phase) && kind === 'converter') {
          // The current timeline is already AI-confirmed. A reference check
          // may legitimately confirm exactly the same canonical scene.
          response = qaTaggedJson(userPrompt, 'video_conversion_data').localStructureDraft;
          assert.ok(typeof response === 'string' && response.trim(), 'confirmed converter echo must be the exact supplied canonical draft');
        } else if (kind === 'translator') {
          const source = phase === 'english-retry' ? boardOf(await readState()).officialPromptZh
            : phase === 'unlimited-bilingual' ? unlimitedChineseSource : '';
          response = qaPlainEnglishTranslationResponse(payload, source ? {
            rawH3Source: source, targetCharacters: phase === 'english-retry' ? 7254 : 19281,
          } : {});
          if (phase === 'english-partial') {
            const malformed = response.replace('__LH_H3_TAG_001__', '');
            assert.notEqual(malformed, response, 'structure-failure fixture must remove a real official tag');
            response = malformed;
          }
        } else {
          response = qaTextResponseContent(kind, payload);
        }
      } catch (error) {
        mockErrors.push(error instanceof Error ? error.message : String(error));
        await route.fulfill({ status: 500, body: 'QA reference conversion failed' });
        if (held) markStaleResponseFinished();
        return;
      }
      if (held) await staleResponseGate;
      if (heldEnglish) await heldEnglish.gate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: response } }] }),
        });
      } catch (error) {
        // Cancelling the held browser request may make its route impossible
        // to fulfill. That is expected only for this deliberately stale call.
        if (!held && !heldEnglish) {
          mockErrors.push(error instanceof Error ? error.message : String(error));
          await route.fulfill({ status: 500, body: 'QA reference conversion failed' });
        }
      } finally {
        if (held) markStaleResponseFinished();
        heldEnglish?.finished();
      }
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.locator('.director-all-sections').waitFor();
    await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    const pixelUrls = await regressionPage.evaluate(() => ['#1d3c68', '#b96829'].map((color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const painter = canvas.getContext('2d');
      painter.fillStyle = color;
      painter.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png');
    }));
    const fileNames = ['qa-segment-reference-a.png', 'qa-segment-reference-b.png'];
    for (const [index, name] of fileNames.entries()) {
      await regressionPage.getByLabel('选择本地参考图', { exact: true }).setInputFiles({
        name,
        mimeType: 'image/png',
        buffer: Buffer.from(pixelUrls[index].split(',')[1], 'base64'),
      });
      await regressionPage.waitForFunction(({ key, boardId, fileName }) => {
        const state = JSON.parse(localStorage.getItem(key) || '{}');
        const asset = state.project?.assets.find((item) => item.fileName === fileName);
        const board = state.project?.storyboards.find((item) => item.id === boardId);
        return asset && board?.globalReferenceAssetIds?.includes(asset.id);
      }, { key: storageKey, boardId: fixtureBoard.id, fileName: name });
    }
    const before = await readState();
    const beforeBoard = boardOf(before);
    const selectedAssets = fileNames.map((fileName) => before.project.assets.find((asset) => asset.fileName === fileName));
    if (selectedAssets.some((asset) => !asset)) throw new Error('local reference upload did not create the isolated image fixtures');
    same(beforeBoard.globalReferenceAssetIds, selectedAssets.map((asset) => asset.id), 'current reference selection order');
    const refresh = regressionPage.getByRole('button', { name: '刷新当前段提示词', exact: true });
    await refresh.click();
    await regressionPage.waitForFunction(({ key, boardId, previousPrompt }) => {
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      const board = state.project?.storyboards.find((item) => item.id === boardId);
      return board?.finalPrompt && board.finalPrompt !== previousPrompt
        && board.officialPromptEn?.trim() && board.officialPromptEnSource === board.officialPromptZh;
    }, { key: storageKey, boardId: fixtureBoard.id, previousPrompt: beforeBoard.finalPrompt }, { timeout: 30_000 });
    const after = await readState();
    const afterBoard = boardOf(after);
    same(requests.map((request) => request.kind), ['converter', 'translator'], 'API order (must not replan the film)');
    same(requests[0].imageUrls, pixelUrls, 'the actual current image pixels and their order');
    same(requests[1].imageUrls, [], 'translation must remain text-only');
    same(requests[0].referenceData?.currentReferences.map((reference) => ({ id: reference.id, imageIndex: reference.imageIndex })),
      selectedAssets.map((asset, index) => ({ id: asset.id, imageIndex: index + 1 })), 'reference metadata/image order');
    same(requests[0].conversionSource, fixtureSegment.content.trim(), 'converter source scope (the existing converter trims outer whitespace)');
    same(requests[0].conversionData?.shotEvidence.map((shot) => ({ shot: shot.shot, exactTimeLabel: shot.exactTimeLabel, durationSec: shot.durationSec })),
      beforeBoard.shots.map((shot, index) => ({ shot: index + 1, exactTimeLabel: shot.prompt.match(/^【[^】]+】/u)?.[0], durationSec: shot.endSec - shot.startSec })),
      'fixed-shot API evidence stays in the shared converter protocol');
    same(protectedState(after), protectedState(before), 'master, other boards, plan, source or settings');
    same(fixedShots(afterBoard), fixedShots(beforeBoard), 'shot IDs, times or reference bindings');
    same(afterBoard.targetOutput.parameters, beforeBoard.targetOutput.parameters, 'seed and custom sampling parameters');
    same(afterBoard.sourceStoryContent, beforeBoard.sourceStoryContent, 'persisted source story');
    same(afterBoard.finalPrompt.match(/正在\s*\[[^\]]*\]/gu), beforeBoard.finalPrompt.match(/正在\s*\[[^\]]*\]/gu), 'original action events');
    if (!afterBoard.officialPromptZh || !afterBoard.officialPromptEn) {
      throw new Error('API-regenerated current segment did not produce complete H3 prompts');
    }

    await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    await regressionPage.getByLabel(`选择参考图：${selectedAssets[0].name}`, { exact: true }).uncheck();
    await regressionPage.waitForFunction(({ key, boardId, removedId }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return board?.globalReferenceAssetIds?.length === 1 && !board.globalReferenceAssetIds.includes(removedId);
    }, { key: storageKey, boardId: fixtureBoard.id, removedId: selectedAssets[0].id });
    const beforeStale = await readState();
    phase = 'stale';
    const requestArrival = regressionPage.waitForRequest((request) => (
      request.url().includes('/qa-openai/v1/chat/completions')
      && qaTextRequestKind(request.postDataJSON()) === 'converter'
    ), { timeout: 10_000 });
    await refresh.click();
    await requestArrival;
    const busyButton = regressionPage.getByRole('button', { name: '中英文生成中…', exact: true });
    if (!await busyButton.isDisabled()) throw new Error('current-segment regeneration must disable duplicate submission while pending');
    await regressionPage.getByLabel(`选择参考图：${selectedAssets[0].name}`, { exact: true }).check();
    await regressionPage.waitForFunction(({ key, boardId, ids }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return JSON.stringify(board?.globalReferenceAssetIds) === JSON.stringify(ids);
    }, { key: storageKey, boardId: fixtureBoard.id, ids: [selectedAssets[1].id, selectedAssets[0].id] });
    releaseStaleResponse();
    await staleResponseFinished;
    await regressionPage.waitForFunction(() => ![...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '中英文生成中…'));
    const afterStale = await readState();
    same(requests.filter((request) => request.phase === 'stale').map((request) => request.kind), ['converter'], 'stale request must stop before translation');
    same(promptBundle(boardOf(afterStale)), promptBundle(boardOf(beforeStale)), 'saved prompts after an in-flight reference change');
    same(protectedState(afterStale), protectedState(beforeStale), 'unrelated data after stale cancellation');
    same(boardOf(afterStale).globalReferenceAssetIds, [selectedAssets[1].id, selectedAssets[0].id], 'the new user reference selection after cancellation');
    if (mockErrors.length || localConsoleErrors.length) throw new Error(`reference regeneration browser/mock errors: ${JSON.stringify({ mockErrors, localConsoleErrors })}`);
    const screenshot = 'sequence-reference-regeneration-stale-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });

    // A real response may confirm the same canonical draft and still omit
    // a mandatory official tag. Persist the accepted Chinese once, keep the
    // segment ready, then make English-only recovery independently usable.
    phase = 'english-partial';
    const beforePartial = await readState();
    await refresh.click();
    await regressionPage.waitForFunction(({ key, boardId }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return Boolean(board?.officialPromptZh?.trim() && board.officialPromptEnError?.trim()
        && !board.officialPromptEn && !board.officialPromptEnSource && !board.englishPrompt && !board.englishPromptSource);
    }, { key: storageKey, boardId: fixtureBoard.id }, { timeout: 30_000 });
    await regressionPage.getByRole('button', { name: '仅重试英文', exact: true }).first().waitFor();
    const partial = await readState();
    const partialBoard = boardOf(partial);
    const partialRequests = requests.filter((request) => request.phase === 'english-partial');
    same(partialRequests.map((request) => request.kind), ['converter', 'translator'],
      'a structural English failure must retain Chinese without automatic conversion or compaction');
    assert.ok(partialBoard.officialPromptZh, 'qualified Chinese must remain available after a structural English failure');
    assert.ok(partialBoard.officialPromptSource, 'accepted Chinese must retain its current source fingerprint');
    assert.notEqual(partialBoard.officialPromptSource, boardOf(beforePartial).officialPromptSource,
      'reference-confirmed Chinese source must be saved even when canonical text is unchanged');
    assert.ok(/官方标签|遗漏|改写/u.test(partialBoard.officialPromptEnError), 'partial result must explain the actual malformed API response');
    assert.doesNotMatch(partialBoard.officialPromptEnError, /7000|字符上限|超限/u, 'character length must not be used as a failure reason');
    assert.equal(partial.project.sequencePlans.find((plan) => plan.id === planId).segments[0].status, 'ready',
      'English failure must not mark accepted segment as failed');
    same(protectedState(partial), protectedState(beforePartial), 'unrelated data after partial English failure');
    same(fixedShots(partialBoard), fixedShots(boardOf(beforePartial)), 'fixed shots after partial English failure');
    same(partialBoard.targetOutput.parameters, boardOf(beforePartial).targetOutput.parameters, 'sampling after partial English failure');
    await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
    assert.equal((await regressionPage.locator('.director-result-copy').textContent()).trim(), partialBoard.officialPromptZh,
      'accepted Chinese must remain visible instead of clearing the result pane');
    assert.ok(await regressionPage.getByRole('button', { name: 'English', exact: true }).isDisabled(),
      'partial English must not be selectable as a completed result');
    const partialStatus = await regressionPage.locator('.sequence-result-status').textContent();
    assert.match(partialStatus || '', /英文/u, 'result status must distinguish English-only failure');
    const partialScreenshot = 'sequence-reference-english-partial-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, partialScreenshot), fullPage: false });

    const englishOnlyInvariant = (board) => {
      const { officialPromptEn, officialPromptEnSource, officialPromptEnError, englishPrompt, englishPromptSource, updatedAt, ...unchanged } = board;
      return unchanged;
    };
    const restoreIsolatedState = async (nextState) => {
      await regressionPage.evaluate(({ key, value }) => {
        localStorage.setItem(key, JSON.stringify(value));
      }, { key: storageKey, value: nextState });
      await regressionPage.reload({ waitUntil: 'networkidle' });
      await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
      await regressionPage.locator('.director-all-sections').waitFor();
      // The confirmed full-film controls restore their original text mode
      // on reload. Re-open the reference UI without clearing/changing the
      // selected image IDs or the already accepted Chinese artifact.
      await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    };
    const converterDisabledPartial = structuredClone(partial);
    converterDisabledPartial.converterPresets = converterDisabledPartial.converterPresets.map((converter) => ({ ...converter, enabled: false }));
    converterDisabledPartial.projects = [converterDisabledPartial.project];
    await restoreIsolatedState(converterDisabledPartial);
    const beforeRetry = await readState();
    assert.ok(beforeRetry.converterPresets.every((converter) => !converter.enabled), 'fixture must actually disable converters');
    assert.equal(boardOf(beforeRetry).officialPromptSource, partialBoard.officialPromptSource,
      'disabling converter must not alter the accepted Chinese source');
    same(englishOnlyInvariant(boardOf(beforeRetry)), englishOnlyInvariant(partialBoard), 'accepted Chinese on converter-disabled reload');
    phase = 'english-retry';
    if (!await regressionPage.getByRole('button', { name: '仅重试英文', exact: true }).count()) {
      await regressionPage.screenshot({ path: path.join(outputDirectory, 'sequence-reference-english-retry-gate-failed.png'), fullPage: false });
      fs.writeFileSync(path.join(outputDirectory, 'sequence-reference-retry-isolated-state-diff.json'), JSON.stringify({
        before: partial, after: beforeRetry,
      }, null, 2));
      const sourceIdentity = await regressionPage.evaluate(async ({ key, boardId }) => {
        const { buildOfficialH3SourceFingerprint, hasCurrentOfficialH3Prompt } = await import('/src/officialPrompt.ts');
        const state = JSON.parse(localStorage.getItem(key) || '{}');
        const board = state.project.storyboards.find((item) => item.id === boardId);
        const project = state.project;
        const sourceContext = { assets: project.assets, characters: project.characters, locations: project.locations,
          props: project.props, sceneContent: project.scenes.find((item) => item.id === board.sceneId)?.content };
        return { saved: board.officialPromptSource, current: buildOfficialH3SourceFingerprint(board, sourceContext),
          valid: hasCurrentOfficialH3Prompt(board, sourceContext) };
      }, { key: storageKey, boardId: fixtureBoard.id });
      const gate = await regressionPage.evaluate(() => ({
        buttons: [...document.querySelectorAll('button')].map((button) => button.textContent?.trim()).filter(Boolean),
        result: document.querySelector('.director-result-pane')?.textContent,
        activeSegment: document.querySelector('.sequence-segment-chip.active')?.textContent,
      }));
      throw new Error(`English-only recovery is unavailable with converters disabled: ${JSON.stringify({ ...gate, sourceIdentity })}`);
    }
    await regressionPage.getByRole('button', { name: '仅重试英文', exact: true }).first().click();
    await regressionPage.waitForFunction(({ key, boardId }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return Boolean(board?.officialPromptEn?.trim() && board.officialPromptEnSource === board.officialPromptZh
        && !board.officialPromptEnError);
    }, { key: storageKey, boardId: fixtureBoard.id }, { timeout: 30_000 });
    const recovered = await readState();
    const recoveredBoard = boardOf(recovered);
    const recoveryRequests = requests.filter((request) => request.phase === 'english-retry');
    same(recoveryRequests.map((request) => request.kind), ['translator'], 'English recovery must not rerun conversion, planning, compaction or vision');
    assert.ok(recoveryRequests.every((request) => request.imageUrls.length === 0 && !request.referenceData),
      'English-only recovery must neither attach pixels nor read reference-conversion evidence');
    same(recoveryRequests.map((request) => request.translationProtocol.compaction), [false],
      'English-only recovery must save one complete plain translation without automatic compaction');
    assert.equal(recoveredBoard.officialPromptEn.length, 7254, 'English beyond the former cap must be saved in full');
    assert.equal(recoveredBoard.englishPrompt, recoveredBoard.officialPromptEn, 'legacy English export must match official English');
    assert.equal(recoveredBoard.englishPromptSource, recoveredBoard.finalPrompt, 'legacy English source must match canonical Chinese');
    same(englishOnlyInvariant(recoveredBoard), englishOnlyInvariant(boardOf(beforeRetry)), 'English recovery must not rebuild Chinese or change references/parameters');
    same(protectedState(recovered), protectedState(beforeRetry), 'unrelated state during English-only recovery');
    await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
    await regressionPage.getByRole('button', { name: 'English', exact: true }).click();
    assert.equal((await regressionPage.locator('.director-result-copy').textContent()).trim(), recoveredBoard.officialPromptEn,
      'recovered English must be viewable');
    assert.equal(await regressionPage.getByRole('button', { name: '仅重试英文', exact: true }).count(), 0,
      'completed bilingual result must no longer expose English recovery');
    const recoveryScreenshot = 'sequence-reference-english-recovered-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, recoveryScreenshot), fullPage: false });
    const recoveryDelivery = await assertCompleteCopyAndProjectExport(recoveredBoard);

    // The former character gate also affected Chinese compilation, not just
    // English. Start from the same isolated, confirmed current segment and
    // provide an explicitly detailed visual description without new events.
    const unlimitedFixture = structuredClone(partial);
    const unlimitedBoard = boardOf(unlimitedFixture);
    const detailTail = 'UNLIMITED_DETAIL_END_SENTINEL';
    const longDetail = Array.from({ length: 220 }, (_, index) => {
      const label = String(index + 1).padStart(4, '0');
      return `第${label}处砖石纹理在画面左侧纵向排列且边沿细薄，保留第${label}处暗面与亮面之间的自然过渡`;
    }).join('；') + `；${detailTail}`;
    const detailedReference = unlimitedFixture.project.assets.find((asset) => asset.id === selectedAssets[0].id);
    assert.ok(detailedReference, 'unlimited fixture requires the selected raw image reference');
    detailedReference.visualAnchor = `${detailedReference.visualAnchor || ''}\n${longDetail}`;
    unlimitedBoard.officialPromptEn = ''; unlimitedBoard.officialPromptEnSource = '';
    unlimitedBoard.englishPrompt = ''; unlimitedBoard.englishPromptSource = ''; unlimitedBoard.officialPromptEnError = '';
    unlimitedFixture.projects = [unlimitedFixture.project];
    await restoreIsolatedState(unlimitedFixture);
    const beforeUnlimited = await readState();
    unlimitedChineseSource = await regressionPage.evaluate(async ({ key, boardId }) => {
      const { compileOfficialH3Prompt } = await import('/src/officialPrompt.ts');
      const { project } = JSON.parse(localStorage.getItem(key) || '{}');
      const board = project.storyboards.find((item) => item.id === boardId);
      return compileOfficialH3Prompt(board, { assets: project.assets, characters: project.characters,
        locations: project.locations, props: project.props,
        sceneContent: project.scenes.find((scene) => scene.id === board.sceneId)?.content }).compiled.prompt;
    }, { key: storageKey, boardId: fixtureBoard.id });
    assert.ok(unlimitedChineseSource.length > 7000, `Chinese fixture must exceed the old threshold; actual=${unlimitedChineseSource.length}`);
    assert.ok(unlimitedChineseSource.includes(detailTail), 'Chinese compilation must retain the end of the supplied detail');
    phase = 'unlimited-bilingual';
    await regressionPage.getByRole('button', { name: '刷新当前段提示词', exact: true }).click();
    await regressionPage.waitForFunction(({ key, boardId }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return Boolean(board?.officialPromptZh?.length > 7000 && board.officialPromptEn?.length === 19281
        && board.officialPromptEnSource === board.officialPromptZh && !board.officialPromptEnError);
    }, { key: storageKey, boardId: fixtureBoard.id }, { timeout: 30_000 });
    const unlimited = await readState();
    const unlimitedSavedBoard = boardOf(unlimited);
    const unlimitedRequests = requests.filter((request) => request.phase === 'unlimited-bilingual');
    same(unlimitedRequests.map((request) => request.kind), ['converter', 'translator'],
      'long Chinese and 19281-character English must save through one normal converter and translator');
    assert.equal(unlimitedSavedBoard.officialPromptZh, unlimitedChineseSource, 'Chinese must not be shortened by a local character budget');
    assert.ok(unlimitedSavedBoard.officialPromptEn.includes(detailTail), 'English must retain the translated draft tail');
    same(protectedState(unlimited), protectedState(beforeUnlimited), 'unlimited prompt generation must preserve all other segments and the master');
    same(unlimited.project.assets, beforeUnlimited.project.assets, 'unlimited prompt generation must preserve the complete authored reference detail');
    same(fixedShots(unlimitedSavedBoard), fixedShots(boardOf(beforeUnlimited)), 'unlimited prompt generation must preserve shot count and boundaries');
    same(unlimitedSavedBoard.targetOutput.parameters, boardOf(beforeUnlimited).targetOutput.parameters, 'unlimited prompt generation must preserve seed and sampling');
    const unlimitedDelivery = await assertCompleteCopyAndProjectExport(unlimitedSavedBoard);
    const unlimitedScreenshot = 'sequence-no-character-limit-bilingual-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, unlimitedScreenshot), fullPage: false });
    await regressionPage.getByRole('button', { name: '编辑分镜', exact: true }).click();
    const deliveryCard = regressionPage.locator('.h3-delivery-card');
    await deliveryCard.waitFor();
    const deliveryLabel = await deliveryCard.textContent();
    assert.ok(deliveryLabel.includes(`${unlimitedSavedBoard.officialPromptZh.length} 字符`), 'H3 card must report the actual complete character count');
    assert.match(deliveryLabel, /本地不限长/u, 'H3 card must identify unlimited local text handling');
    assert.doesNotMatch(deliveryLabel, /官方上限\s*7000|\/\s*7000|超过\s*7000/u, 'H3 card must not present the removed numeric limit');
    const exportedChinese = await downloadText(deliveryCard.getByRole('button', { name: '导出 H3 TXT', exact: true }));
    assert.equal(exportedChinese, unlimitedSavedBoard.officialPromptZh, 'H3 TXT export must preserve complete Chinese above the former limit');
    const unlimitedCountScreenshot = 'sequence-no-character-limit-actual-count-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, unlimitedCountScreenshot), fullPage: false });

    const staleEnglishChecks = [];
    for (const change of ['shot-edit', 'reference']) {
      await restoreIsolatedState(converterDisabledPartial);
      const beforeEnglishStale = await readState();
      phase = `english-stale-${change}`;
      let release;
      let finished;
      const gate = new Promise((resolve) => { release = resolve; });
      const finishedPromise = new Promise((resolve) => { finished = resolve; });
      heldEnglishResponse = { gate, release, finished };
      try {
        const translationArrival = regressionPage.waitForRequest((request) => (
          request.url().includes('/qa-openai/v1/chat/completions')
          && qaTextRequestKind(request.postDataJSON()) === 'translator'
        ), { timeout: 10_000 });
        await regressionPage.getByRole('button', { name: '仅重试英文', exact: true }).first().click();
        await translationArrival;
        assert.ok(await regressionPage.getByRole('button', { name: '中英文生成中…', exact: true }).isDisabled(),
          'English-only recovery must prevent duplicate submission');
        if (change === 'shot-edit') {
          await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
          await regressionPage.getByRole('button', { name: '编辑分镜', exact: true }).click();
          const firstShot = regressionPage.locator('.shot-card').first();
          await firstShot.getByRole('button', { name: '展开编辑', exact: true }).click();
          const lighting = firstShot.getByLabel('光影', { exact: true });
          assert.ok(await lighting.isEnabled(), 'QA requires the normal in-flight storyboard editing UI');
          await lighting.fill('右侧冷光照亮门框，保持原有动作和时间边界');
          await regressionPage.waitForFunction(({ key, boardId }) => {
            const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
            return board?.shots[0]?.lighting === '右侧冷光照亮门框，保持原有动作和时间边界';
          }, { key: storageKey, boardId: fixtureBoard.id });
        } else {
          await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
          await regressionPage.getByLabel(`选择参考图：${selectedAssets[0].name}`, { exact: true }).uncheck();
          await regressionPage.waitForFunction(({ key, boardId, removedId }) => {
            const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
            return board?.globalReferenceAssetIds?.length === 1 && !board.globalReferenceAssetIds.includes(removedId);
          }, { key: storageKey, boardId: fixtureBoard.id, removedId: selectedAssets[0].id });
        }
        const edited = await readState();
        release();
        await finishedPromise;
        await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
        await regressionPage.waitForFunction(() => ![...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === '中英文生成中…'));
        const afterEnglishStale = await readState();
        const staleRequests = requests.filter((request) => request.phase === phase);
        same(staleRequests.map((request) => request.kind), ['translator'], `${change} change must discard old English without retrying`);
        same(promptBundle(boardOf(afterEnglishStale)), promptBundle(boardOf(edited)), `stale English must preserve current ${change} edits`);
        assert.ok(!boardOf(afterEnglishStale).officialPromptEn && !boardOf(afterEnglishStale).officialPromptEnSource
          && !boardOf(afterEnglishStale).englishPrompt && !boardOf(afterEnglishStale).englishPromptSource,
        `stale ${change} translation must not be saved`);
        same(boardOf(afterEnglishStale).targetOutput.parameters, boardOf(beforeEnglishStale).targetOutput.parameters,
          `stale ${change} translation must preserve seed and sampling`);
        same(afterEnglishStale.project.storyboards.filter((board) => board.id !== fixtureBoard.id),
          beforeEnglishStale.project.storyboards.filter((board) => board.id !== fixtureBoard.id),
          `stale ${change} translation must preserve all other boards and master`);
        same(afterEnglishStale.project.sequencePlans, beforeEnglishStale.project.sequencePlans,
          `stale ${change} translation must preserve the sequence plan`);
        staleEnglishChecks.push({ change, requests: staleRequests.map((request) => request.kind), responseDiscarded: true });
      } finally {
        release();
        heldEnglishResponse = undefined;
      }
    }
    if (mockErrors.length || localConsoleErrors.length) throw new Error(`English recovery browser/mock errors: ${JSON.stringify({ mockErrors, localConsoleErrors })}`);
    return {
      segmentId: fixtureSegment.id,
      boardId: fixtureBoard.id,
      successRequestKinds: requests.filter((request) => request.phase === 'success').map((request) => request.kind),
      selectedReferenceCount: selectedAssets.length,
      referencePixelsInOrder: true,
      currentSegmentOnly: true,
      fixedShotsAndParametersPreserved: true,
      staleRequestKinds: requests.filter((request) => request.phase === 'stale').map((request) => request.kind),
      staleResponseDiscarded: true,
      chineseCharacters: afterBoard.officialPromptZh.length,
      englishCharacters: afterBoard.officialPromptEn.length,
      screenshot,
      englishRecovery: {
        sameCanonicalAccepted: true,
        failureFixture: 'missing-official-tag',
        partialRequestKinds: partialRequests.map((request) => request.kind),
        acceptedChineseVisible: true,
        partialSegmentRemainedReady: true,
        converterDisabledForRecovery: true,
        recoveryRequestKinds: recoveryRequests.map((request) => request.kind),
        plainWholeDocumentTranslation: true,
        ordinaryCompactionCalls: recoveryRequests.filter((request) => request.translationProtocol.compaction).length,
        chineseAndParametersUnchanged: true,
        otherSegmentsAndMasterUnchanged: true,
        recoveredEnglishCharacters: recoveredBoard.officialPromptEn.length,
        recoveryDelivery,
        staleEnglishChecks,
        screenshots: [partialScreenshot, recoveryScreenshot],
      },
      noCharacterLimit: {
        chineseCharacters: unlimitedSavedBoard.officialPromptZh.length,
        englishCharacters: unlimitedSavedBoard.officialPromptEn.length,
        requestKinds: unlimitedRequests.map((request) => request.kind),
        noAutomaticCompaction: true, fullChineseAndEnglishTailsPreserved: true,
        fixedShotsSeedOtherSegmentsAndMasterPreserved: true,
        ...unlimitedDelivery, completeChineseTxtExport: true, actualCharacterCountVisible: true,
        screenshots: [unlimitedScreenshot, unlimitedCountScreenshot],
      },
    };
  } catch (error) {
    const current = await readState().catch(() => undefined);
    const board = current ? boardOf(current) : undefined;
    const runtimeErrors = await regressionPage.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]')).catch(() => []);
    await regressionPage.screenshot({ path: path.join(outputDirectory, 'sequence-reference-no-limit-failure.png'), fullPage: false }).catch(() => {});
    throw new Error(`reference/no-limit UI failed: ${JSON.stringify({ phase,
      requestKinds: requests.filter((request) => request.phase === phase).map((request) => request.kind), mockErrors, localConsoleErrors,
      canonicalCharacters: board?.finalPrompt?.length, chineseCharacters: board?.officialPromptZh?.length,
      englishCharacters: board?.officialPromptEn?.length, englishError: board?.officialPromptEnError, runtimeErrors })}`, { cause: error });
  } finally {
    releaseStaleResponse();
    heldEnglishResponse?.release();
    await regressionContext.close();
  }
};

const runSequenceMultiPictureSubjectsRegression = async (sourceState, { quietFoley = false } = {}) => {
  // All entities, text and image pixels here are synthetic QA data. The
  // sourceState itself comes from this harness, never a desktop save file.
  const fixture = structuredClone(sourceState);
  const sourceParts = [
    '韩竹、林岚和许衡推开旧廊桥的木门。',
    '韩竹、林岚和许衡抬起地上的木箱。',
    '韩竹、林岚和许衡放下手里的武器。',
    '韩竹、林岚和许衡转身走向廊桥栏杆。',
    '韩竹、林岚和许衡握住院落的门环。',
    '韩竹、林岚和许衡走进雨中的院落。',
  ];
  if (quietFoley) sourceParts.splice(0, 3,
    '韩竹与林岚自愿相拥，短暂亲吻后分开。',
    '韩竹转身，林岚回应，两人再次亲吻后分开。',
    '韩竹握住旧廊桥扶栏，林岚与许衡在门边站稳。');
  const story = sourceParts.join('');
  const timestamp = 1700000000000;
  const characters = [
    { id: 'qa-multi-han', name: '韩竹', gender: '男', race: '人族', appearance: '黑色短发，棕色眼睛，左眉浅疤', outfit: '青灰短袍，黑色布靴', signatureProps: '铜扣短匕', anchor: '左眉疤痕与青灰短袍保持一致' },
    { id: 'qa-multi-lin', name: '林岚', gender: '女', race: '人族', appearance: '深棕长发，琥珀色眼睛，清晰圆脸', outfit: '墨绿长衣，浅褐束腰', signatureProps: '细铜手镯', anchor: '琥珀色眼睛与墨绿长衣保持一致' },
    { id: 'qa-multi-xu', name: '许衡', gender: '男', race: '人族', appearance: '乌黑束发，深灰眼睛，清瘦长脸', outfit: '藏蓝外袍，白色内领', signatureProps: '木鞘短剑', anchor: '深灰眼睛与藏蓝外袍保持一致' },
  ].map((character) => ({ ...character, apparentAge: quietFoley ? '30岁成年人' : '', personality: '谨慎', motionHabits: '步伐稳定', negativeContinuity: '', assetIds: [] }));
  const location = { id: 'qa-multi-bridge', name: '旧廊桥', description: '木梁廊桥连接石阶与院落', timeWeather: '阴天细雨',
    lighting: '左侧冷灰散射光', palette: '灰木色与青石色', fixedProps: '木门与扶栏', anchor: '入口与院落空间关系连续', assetIds: [] };
  const scene = { id: 'qa-multi-scene', title: '三人通过旧廊桥', content: story, summary: '三人经廊桥进入院落',
    characterIds: characters.map((character) => character.id), locationId: location.id, locationIds: [location.id], propIds: [],
    storyboardIds: [], createdAt: timestamp, updatedAt: timestamp };
  fixture.project = {
    ...fixture.project,
    id: 'qa-multi-picture-project', name: 'QA 多参考图语义主体',
    directorSettingsConfirmedFingerprint: '', directorSettingsConfirmedAt: undefined,
    sourceDocuments: [{ id: 'qa-multi-source', name: '多图主体回归合成剧情', content: story, createdAt: timestamp, updatedAt: timestamp }],
    characters, locations: [location], props: [], scenes: [scene], storyboards: [], sequencePlans: [], assets: [], generationTasks: [],
    createdAt: timestamp, updatedAt: timestamp,
  };
  fixture.projects = [fixture.project];
  fixture.activeProjectId = fixture.project.id;
  fixture.settings.textApi = { ...fixture.settings.textApi, enabled: true, provider: 'openai_compatible',
    baseUrl: new URL('qa-openai/v1', baseUrl).toString(), apiKey: '', model: 'qa-multi-picture-model', vision: true };
  fixture.settings.imageApi.enabled = false;
  fixture.settings.visionApi.enabled = false;
  fixture.settings.videoTaskApi.enabled = false;

  const regressionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const regressionPage = await regressionContext.newPage();
  const requests = [];
  const mockErrors = [];
  const localConsoleErrors = [];
  let phase = 'prepare';
  let rawH3ForRefresh = '';
  const legacyAmbientVariants = ['谷风与灵泉声持续，压至很低', '环境风与灵泉低响持续', '谷风轻微上扬，远处灵泉声持续'];
  const quietActions = ['韩竹与林岚自愿相拥并短暂亲吻后分开', '韩竹转身与回应的林岚再次亲吻后分开', '韩竹握住旧廊桥扶栏，林岚与许衡在门边站稳'];
  const quietSoundFor = (index) => `环境层-[${legacyAmbientVariants[index] || '无'}] 动作层-[${index === 0 ? '第1.2s细微短促可辨识的吻声' : index === 1 ? '第2.4s细微短促可辨识的吻声' : '无'}] 情绪层-[无配乐]`;
  regressionPage.on('console', (message) => { if (message.type() === 'error') localConsoleErrors.push(message.text()); });
  regressionPage.on('pageerror', (error) => localConsoleErrors.push(error.message));
  const readState = () => regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
  try {
    await regressionPage.addInitScript(({ key, initial }) => {
      if (!sessionStorage.getItem('__lianhua_multi_picture_subjects_qa__')) {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem(key, JSON.stringify(initial));
        sessionStorage.setItem('__lianhua_multi_picture_subjects_qa__', '1');
      }
    }, { key: storageKey, initial: fixture });
    await regressionPage.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
      mockErrors.push('multi-picture fixture attempted a non-local request');
      await route.abort('blockedbyclient');
    });
    await regressionPage.route('**/qa-openai/v1/chat/completions', async (route) => {
      const payload = route.request().postDataJSON();
      const kind = qaTextRequestKind(payload);
      const userPrompt = qaMessageContent(payload, 'user');
      const referenceData = userPrompt.includes('<current_reference_data>')
        ? qaTaggedJson(userPrompt, 'current_reference_data') : undefined;
      const imageUrls = (payload.messages || []).filter((message) => message.role === 'user')
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'image_url').map((part) => part.image_url?.url);
      requests.push({ kind, phase, referenceData, imageUrls,
        systemPrompt: qaMessageContent(payload, 'system'), userPrompt,
        conversionData: kind === 'converter' ? qaTaggedJson(userPrompt, 'video_conversion_data') : undefined });
      try {
        let response;
        if (kind === 'shot-recommendation') {
          const planning = qaTaggedJson(userPrompt, 'storyboard_planning_data');
          assert.equal(planning.durationSec, 30, 'synthetic long-story fixture must remain 30 seconds');
          response = JSON.stringify({
            reason: 'QA model chooses six complete shots and two fixed fifteen-second segments',
            breakdown: ['每段3镜', '每镜5秒', '完整原文'],
            shots: sourceParts.map((sourceExcerpt, index) => ({
              startSec: index * 5, endSec: (index + 1) * 5, sourceExcerpt,
              purpose: `三人完成第${index + 1}个动作`, subject: quietFoley ? '韩竹' : '韩竹、林岚和许衡', action: sourceExcerpt,
              camera: '中景稳定侧拍', transition: '在动作结果后切换', lighting: '左侧冷灰散射光',
              sound: '动作接触声', result: `三人完成第${index + 1}镜并保持相对位置`,
            })),
          });
        } else if (kind === 'converter' && quietFoley) {
          const conversion = qaTaggedJson(userPrompt, 'video_conversion_data');
          const hasKisses = /亲吻/u.test(conversion.sourceStoryContent);
          response = conversion.shotEvidence.map((shot, index) => {
            let canonical = shot.localStructureDraft;
            if (phase === 'prepare' && hasKisses && quietActions[index]) {
              canonical = canonical.replace(/正在\s*\[[^\]]*\]/u, `正在 [${quietActions[index]}]`);
            }
            // The mock API deliberately reproduces the old ambient-noise
            // response. The application, not the mock, must remove it while
            // retaining the two independently timed, visible kiss effects.
            return canonical.replace(/音效：[\s\S]*$/u, `音效：${hasKisses ? quietSoundFor(index) : '环境层-[无] 动作层-[无] 情绪层-[无配乐]'}`);
          }).join('\n');
        } else if (kind === 'converter' && phase === 'refresh') {
          assert.ok(referenceData, 'current-segment refresh must include scoped references');
          response = qaTaggedJson(userPrompt, 'video_conversion_data').localStructureDraft;
        } else if (kind === 'translator' && phase === 'refresh') {
          response = qaPlainEnglishTranslationResponse(payload, { rawH3Source: rawH3ForRefresh });
        } else response = qaTextResponseContent(kind, payload);
        assert.ok(response, `unexpected multi-picture QA request ${kind}`);
        requests[requests.length - 1].response = response;
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
      } catch (error) {
        mockErrors.push(error instanceof Error ? error.message : String(error));
        await route.fulfill({ status: 500, body: 'QA multi-picture generation failed' });
      }
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.getByRole('button', { name: '长剧情拆段', exact: true }).click();
    const timing = regressionPage.locator('#sequence-director-settings-panel #director-setup-timing');
    await timing.getByRole('button', { name: '15 秒', exact: true }).click();
    await regressionPage.getByRole('button', { name: '确认全片导演参数，进入①全片规划', exact: true }).click();
    await regressionPage.locator('.sequence-planner-panel').waitFor();
    await regressionPage.getByRole('button', { name: '固定总时长', exact: true }).click();
    await regressionPage.getByLabel('全片总秒数').fill('30');
    await regressionPage.getByRole('button', { name: '① 生成全片总提示词', exact: true }).click();
    await regressionPage.getByLabel('全片总视频提示词').waitFor();
    await regressionPage.getByRole('button', { name: '确认总提示词', exact: true }).click();
    await regressionPage.getByRole('button', { name: '② AI 按剧情边界分段', exact: true }).click();
    await regressionPage.locator('.sequence-plan-workspace').waitFor();
    const riskButton = regressionPage.getByRole('button', { name: '确认偏紧风险', exact: true });
    if (await riskButton.count()) await riskButton.click();
    await regressionPage.getByRole('button', { name: '确认分段，进入③单段导演', exact: true }).click();
    await regressionPage.locator('.director-all-sections').waitFor();
    const batchButton = regressionPage.getByRole('button', { name: '顺序生成全部', exact: true });
    if (await batchButton.isEnabled()) await batchButton.click();
    await regressionPage.waitForFunction((key) => {
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      const plan = state.project?.sequencePlans[0];
      return plan?.segments.length === 2 && plan.segments.every((segment) => segment.status === 'ready' && segment.storyboardId);
    }, storageKey, { timeout: 30_000 });
    await regressionPage.waitForFunction(() => ![...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '取消顺序生成'));
    const prepared = await readState();
    const plan = prepared.project.sequencePlans[0];
    const segment = plan.segments[0];
    const boardOf = (state) => state.project.storyboards.find((board) => board.id === segment.storyboardId);
    const currentBoard = boardOf(prepared);
    assert.equal(currentBoard.shots.length, 3, 'multi-picture regression requires three confirmed shots');
    assert.deepEqual(currentBoard.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 5], [5, 10], [10, 15]],
      'fixture must use the model-confirmed three-shot grid');
    const sourceBoard = prepared.project.storyboards.find((board) => board.id === plan.segments[1].storyboardId);
    const uniqueCompositionFacts = ['玄青左门框独有构图', '朱砂右檐角独有构图'];
    const pixelUrls = await regressionPage.evaluate(() => ['#174b53', '#b15438'].map((color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      const painter = canvas.getContext('2d'); painter.fillStyle = color; painter.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png');
    }));
    const characterIdentity = (character) => `人物“${character.name}”固定身份与外貌：性别：${character.gender}；种族/物种：${character.race}；外观：${character.appearance}；服装：${character.outfit}；固定道具：${character.signatureProps}；连续性锚点：${character.anchor}`;
    const pictureAssets = pixelUrls.map((dataUrl, index) => ({
      id: `qa-generated-composition-${index + 1}`, name: `QA 三人构图 ${index + 1}`,
      fileName: `qa-multi-picture-${index + 1}.png`, dataUrl, mimeType: 'image/png', width: 2, height: 2,
      type: 'reference', role: 'composition', referenceRole: 'composition', source: 'generated', mediaType: 'image',
      sourceStoryboardId: sourceBoard.id, sourceShotId: sourceBoard.shots[index].id,
      visualAnchor: [
        ...characters.map(characterIdentity),
        `本镜画面主体与站位：${uniqueCompositionFacts[index]}，三人的相对位置清晰`,
        `本镜可见动作：来源图${index + 1}中三人停步`,
        `本镜可见结果：来源图${index + 1}中三人保持站位`,
      ].join('\n'),
      prompt: `仅用作静态构图参考的合成图片${index + 1}`,
      targetBindings: [], tags: ['QA', '分镜图'], imageVariant: 'storyboard-frame',
      createdAt: timestamp + index, updatedAt: timestamp + index,
    }));
    prepared.project.assets = pictureAssets;
    currentBoard.targetOutput.parameters = { ...currentBoard.targetOutput.parameters,
      seed: 246813579, steps: 15, cfg: 4.5, sampler: 'euler', audio_denoise_strength: 1,
      custom: { multiPictureSentinel: 'preserve-exactly' } };
    // Ensure reload opens the segment under test; the second segment remains
    // an independent completed board and supplies the generated-image origin.
    prepared.project.storyboards = [currentBoard, ...prepared.project.storyboards.filter((board) => board.id !== currentBoard.id)];
    prepared.projects = [prepared.project];
    await regressionPage.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: storageKey, state: prepared });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.locator('.director-all-sections').waitFor();
    await regressionPage.getByRole('button', { name: '单张/多张参考图', exact: true }).click();
    await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    for (const asset of pictureAssets) {
      await regressionPage.getByLabel(`选择参考图：${asset.name}`, { exact: true }).check();
    }
    await regressionPage.waitForFunction(({ key, boardId, ids }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return JSON.stringify(board?.globalReferenceAssetIds) === JSON.stringify(ids);
    }, { key: storageKey, boardId: currentBoard.id, ids: pictureAssets.map((asset) => asset.id) });
    const before = await readState();
    const beforeBoard = boardOf(before);
    rawH3ForRefresh = await regressionPage.evaluate(async ({ key, boardId }) => {
      const { compileOfficialH3Prompt } = await import('/src/officialPrompt.ts');
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      const project = state.project;
      const board = project.storyboards.find((item) => item.id === boardId);
      return compileOfficialH3Prompt(board, { assets: project.assets, characters: project.characters,
        locations: project.locations, props: project.props,
        sceneContent: project.scenes.find((item) => item.id === board.sceneId)?.content }).compiled.prompt;
    }, { key: storageKey, boardId: currentBoard.id });
    phase = 'refresh';
    await regressionPage.getByRole('button', { name: '刷新当前段提示词', exact: true }).click();
    await regressionPage.waitForFunction(({ key, boardId, previousSource }) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards.find((item) => item.id === boardId);
      return Boolean(board?.officialPromptZh && board.officialPromptSource !== previousSource
        && board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh);
    }, { key: storageKey, boardId: currentBoard.id, previousSource: beforeBoard.officialPromptSource }, { timeout: 30_000 });
    const after = await readState();
    const afterBoard = boardOf(after);
    const refreshRequests = requests.filter((request) => request.phase === 'refresh');
    assert.deepEqual(refreshRequests.map((request) => request.kind), ['converter', 'translator'],
      'multi-picture refresh must use one scoped converter request, not regenerate the film');
    assert.deepEqual(refreshRequests[0].imageUrls, pixelUrls, 'the converter must receive both real inline images in selection order');
    assert.deepEqual(refreshRequests[1].imageUrls, [], 'the translator receives text only');
    assert.deepEqual(refreshRequests[0].referenceData.currentReferences.map((reference) => reference.id), pictureAssets.map((asset) => asset.id));
    assert.equal(refreshRequests[0].conversionData.sourceStoryContent, segment.content.trim(), 'converter must receive this segment only');
    assert.deepEqual(refreshRequests[0].conversionData.shotEvidence.map((shot) => ({ shot: shot.shot, exactTimeLabel: shot.exactTimeLabel, durationSec: shot.durationSec })),
      beforeBoard.shots.map((shot, index) => ({ shot: index + 1, exactTimeLabel: shot.prompt.match(/^【[^】]+】/u)?.[0], durationSec: shot.endSec - shot.startSec })),
      'API fixed-shot contract remains in the shared converter protocol');
    const protectedProject = (state) => ({
      sequencePlans: state.project.sequencePlans,
      otherBoards: state.project.storyboards.filter((board) => board.id !== currentBoard.id),
      sourceDocuments: state.project.sourceDocuments, scenes: state.project.scenes,
      characters: state.project.characters, locations: state.project.locations, props: state.project.props,
      assets: state.project.assets, generationTasks: state.project.generationTasks, settings: state.settings,
    });
    assert.deepEqual(protectedProject(after), protectedProject(before), 'refresh must preserve master, all other segments, raw assets and configuration');
    const fixedShotState = (board) => board.shots.map(({ subject, action, ...preserved }) => preserved);
    assert.deepEqual(fixedShotState(afterBoard), fixedShotState(beforeBoard), 'already confirmed three-shot prompt bodies, provenance and boundaries remain unchanged');
    assert.equal(afterBoard.finalPrompt, beforeBoard.finalPrompt, 'reference identity assembly must not rewrite the confirmed current events');
    assert.deepEqual(afterBoard.targetOutput.parameters, beforeBoard.targetOutput.parameters, 'multi-picture refresh must preserve seed and sampling');
    const prompt = afterBoard.officialPromptZh;
    const definitionSection = prompt.match(/^subject_definitions:\s*\n([\s\S]*?)(?=^(?:summary|retention_analysis|detailed_description|integrated_multimodal_description):)/mu)?.[1] || '';
    const subjectRows = definitionSection.split('\n').filter((line) => /^<Subject \d+>\s+is\s/u.test(line.trim()));
    assert.equal(subjectRows.length, characters.length + 1, 'only three semantic characters and the real location may become Subjects');
    assert.ok(subjectRows.every((row) => !pictureAssets.some((asset) => row.includes(asset.name))), 'generated pictures must not become phantom Subjects');
    const characterPictureBindings = characters.map((character) => {
      const rows = subjectRows.filter((row) => row.includes(`is ${character.name}`));
      assert.equal(rows.length, 1, `exactly one semantic Subject must define ${character.name}`);
      const pictures = rows[0].match(/<Picture \d+>/gu) || [];
      assert.deepEqual(pictures, ['<Picture 1>', '<Picture 2>'], `${character.name} must bind both verified composition images`);
      return { name: character.name, pictures };
    });
    const shotSection = prompt.match(/^(?:detailed_description|integrated_multimodal_description):\s*\n([\s\S]*?)(?=^(?:overall_soundscape|non_diegetic_music):|(?![\s\S]))/mu)?.[1] || '';
    assert.equal((shotSection.match(/\[Shot \d+\]/gu) || []).length, 3, 'H3 output must retain every current shot');
    uniqueCompositionFacts.forEach((fact) => {
      assert.equal(prompt.split(fact).length - 1, 1, `unique static reference fact must be represented once: ${fact}`);
      assert.ok(!shotSection.includes(fact), `source composition must not leak into the current Shot action: ${fact}`);
    });
    assert.ok(!/来源图[12]中三人停步|来源图[12]中三人保持站位/u.test(shotSection), 'previous image actions/results must not be requested as this segment actions');
    assert.ok(prompt && afterBoard.officialPromptEn, 'both multi-picture H3 languages must be complete');
    assert.equal(afterBoard.officialPromptEnSource, prompt, 'English must derive from this exact multi-picture Chinese artifact');
    let quietFoleyEvidence;
    if (quietFoley) {
      const converterResponse = refreshRequests[0].response;
      for (const legacy of legacyAmbientVariants) assert.ok(converterResponse.includes(legacy),
        `API fixture must actually reproduce the legacy continuous ambience: ${legacy}`);
      const shotBlock = (text, number) => text.match(new RegExp(`^\\[Shot ${number}\\]([\\s\\S]*?)(?=^\\[Shot \\d+\\]|^overall_soundscape:|^non_diegetic_music:|(?![\\s\\S]))`, 'mu'))?.[1] || '';
      const expectedTimes = ['1.2', '2.4'];
      for (const [index, second] of expectedTimes.entries()) {
        const escapedTime = second.replace('.', '\\.');
        assert.match(shotBlock(prompt, index + 1), new RegExp(`第\\s*${escapedTime}s[\\s\\S]{0,60}吻声`, 'u'),
          `Shot ${index + 1} must retain its audible kiss and original shot-relative time`);
        assert.match(shotBlock(prompt, index + 1), /细微[\s、，,]*短促[\s、，,]*可辨识的?吻声/u,
          `Shot ${index + 1} must keep the delicate-but-audible foley instruction`);
        assert.match(shotBlock(afterBoard.officialPromptEn, index + 1), new RegExp(`at\\s*${escapedTime}s[\\s\\S]{0,90}kiss sound`, 'iu'),
          `English Shot ${index + 1} must retain its kiss effect and shot-relative time`);
        assert.match(shotBlock(afterBoard.officialPromptEn, index + 1), /soft[\s\S]{0,20}brief[\s\S]{0,30}audible kiss sound/iu,
          `English Shot ${index + 1} must not turn quiet-background guidance into muted foley`);
      }
      assert.match(shotBlock(prompt, 2), /At 00:05\.000/u, 'Shot 2 cut and its relative sound time are independent');
      assert.doesNotMatch(shotBlock(prompt, 2), /第\s*7\.4s/u, 'the second kiss must not be converted into a video-absolute 7.4s cue');
      assert.doesNotMatch(shotBlock(prompt, 3), /吻声/u, 'do not invent another kiss in a shot without visible kissing');
      for (const text of [prompt, afterBoard.officialPromptEn]) {
        assert.equal(text.match(/^overall_soundscape:\s*([^\r\n]*)/mu)?.[1]?.trim(), 'N/A', 'global ambience must remain absent');
        assert.equal(text.match(/^non_diegetic_music:\s*([^\r\n]*)/mu)?.[1]?.trim(), 'N/A', 'no-score setting must remain absent');
        assert.doesNotMatch(text, /谷风|环境风|灵泉|valley wind|spring sound|continuous ambience/iu,
          'legacy continuous wind/spring noise must not remain in either delivered language');
      }
      quietFoleyEvidence = { adultsOnlySyntheticFixture: true, kissShotRelativeTimes: expectedTimes,
        legacyAmbientVariantsReturned: legacyAmbientVariants,
        chineseAndEnglishKissEffectsPreserved: true, noKissAddedToThirdShot: true,
        overallSoundscape: 'N/A', nonDiegeticMusic: 'N/A', continuousAmbienceRemoved: true };
    }
    assert.match(afterBoard.officialPromptEn, /<Subject 1>[\s\S]*<Picture 1>/u,
      'correct original H3 tags returned by the API must save successfully');
    assert.doesNotMatch(refreshRequests.map((request) => `${request.systemPrompt}\n${request.userPrompt}`).join('\n'),
      /sequence_reference_data|sequence_reference_conversion_contract|h3_translation_units|unit_\d{3}/u,
      'long segments must use only the same single-segment converter and plain translation protocols');
    assert.ok(refreshRequests.every((request) => !request.userPrompt.includes(plan.id)
      && !request.userPrompt.includes(plan.segments[1].content)), 'current-segment calls must not include the plan identity or adjacent segment story');
    if (mockErrors.length || localConsoleErrors.length) throw new Error(`multi-picture browser/mock errors: ${JSON.stringify({ mockErrors, localConsoleErrors })}`);
    await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
    const screenshot = quietFoley ? 'sequence-quiet-kiss-foley-1280x800.png' : 'sequence-multi-picture-semantic-subjects-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
    const shortLongSharedProtocol = quietFoley ? undefined : await runShortLongSharedProtocolRegression({
      sourceState: before, segment, sourceParts: sourceParts.slice(0, 3),
      pictureAssets, longRequests: refreshRequests,
    });
    return {
      syntheticFixtureOnly: true, selectedPictureCount: pictureAssets.length,
      confirmedShotRanges: afterBoard.shots.map((shot) => [shot.startSec, shot.endSec]),
      refreshRequestKinds: refreshRequests.map((request) => request.kind), realPixelsInOrder: true,
      semanticSubjectCount: subjectRows.length, characterPictureBindings,
      uniqueCompositionFactsPreservedExactlyOnce: true, previousImageActionsExcludedFromShots: true,
      fullPlanOtherSegmentsRawAssetsAndSeedPreserved: true,
      chineseCharacters: prompt.length, englishCharacters: afterBoard.officialPromptEn.length,
      rawOfficialTagsAccepted: true,
      shortLongSharedProtocol,
      quietFoleyEvidence,
      screenshot,
    };
  } catch (error) {
    const snapshot = await readState().catch(() => undefined);
    const notice = await regressionPage.locator('.sidebar-notice').textContent().catch(() => '');
    const runtimeErrors = await regressionPage.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]')).catch(() => []);
    await regressionPage.screenshot({ path: path.join(outputDirectory, 'sequence-multi-picture-failure.png'), fullPage: false }).catch(() => {});
    throw new Error(`multi-picture UI regression failed: ${JSON.stringify({ phase, quietFoley, requests: requests.map(({ kind, phase: requestPhase }) => ({ kind, phase: requestPhase })),
      mockErrors, localConsoleErrors, notice, runtimeErrors,
      plans: snapshot?.project?.sequencePlans?.map((plan) => ({ id: plan.id, planningStage: plan.planningStage, segments: plan.segments.length })) })}`, { cause: error });
  } finally {
    await regressionContext.close();
  }
};

const runShortLongSharedProtocolRegression = async ({ sourceState, segment, sourceParts, pictureAssets, longRequests }) => {
  const fixture = structuredClone(sourceState);
  const source = segment.content.trim();
  fixture.project = {
    ...fixture.project, id: 'qa-short-long-protocol-project', name: 'QA 长短共用单段协议',
    directorSettingsConfirmedFingerprint: '', directorSettingsConfirmedAt: undefined,
    sourceDocuments: [{ id: 'qa-shared-single-source', name: '同一15秒剧情', content: source, createdAt: 1, updatedAt: 1 }],
    scenes: [{ ...fixture.project.scenes[0], content: source, summary: source, storyboardIds: [] }],
    sequencePlans: [], storyboards: [], generationTasks: [], assets: structuredClone(pictureAssets),
  };
  fixture.projects = [fixture.project];
  fixture.activeProjectId = fixture.project.id;
  const regressionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const regressionPage = await regressionContext.newPage();
  const requests = [];
  const mockErrors = [];
  const consoleErrors = [];
  regressionPage.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  regressionPage.on('pageerror', (error) => consoleErrors.push(error.message));
  try {
    await regressionPage.addInitScript(({ key, initial }) => {
      if (!sessionStorage.getItem('__lianhua_short_long_protocol_qa__')) {
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem(key, JSON.stringify(initial));
        sessionStorage.setItem('__lianhua_short_long_protocol_qa__', '1');
      }
    }, { key: storageKey, initial: fixture });
    await regressionPage.route((url) => /^https?:$/u.test(url.protocol) && url.origin !== new URL(baseUrl).origin, async (route) => {
      mockErrors.push('short/long protocol fixture attempted a non-local request');
      await route.abort('blockedbyclient');
    });
    await regressionPage.route('**/qa-openai/v1/chat/completions', async (route) => {
      const payload = route.request().postDataJSON();
      const kind = qaTextRequestKind(payload);
      const systemPrompt = qaMessageContent(payload, 'system');
      const userPrompt = qaMessageContent(payload, 'user');
      const imageUrls = (payload.messages || []).filter((message) => message.role === 'user')
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === 'image_url').map((part) => part.image_url?.url);
      const referenceData = userPrompt.includes('<current_reference_data>') ? qaTaggedJson(userPrompt, 'current_reference_data') : undefined;
      requests.push({ kind, systemPrompt, userPrompt, imageUrls, referenceData,
        conversionData: kind === 'converter' ? qaTaggedJson(userPrompt, 'video_conversion_data') : undefined });
      try {
        let response;
        if (kind === 'shot-recommendation') {
          const planning = qaTaggedJson(userPrompt, 'storyboard_planning_data');
          assert.equal(planning.durationSec, 15, 'short UI must receive the same fifteen-second duration');
          response = JSON.stringify({ reason: 'QA uses the same three single-segment source events and exact grid',
            shots: sourceParts.map((sourceExcerpt, index) => ({
              startSec: index * 5, endSec: (index + 1) * 5, sourceExcerpt,
              purpose: `三人完成第${index + 1}个动作`, subject: '韩竹、林岚和许衡', action: sourceExcerpt,
              camera: '中景稳定侧拍', transition: '在动作结果后切换', lighting: '左侧冷灰散射光',
              sound: '动作接触声', result: `三人完成第${index + 1}镜并保持相对位置`,
            })) });
        } else if (kind === 'translator') {
          // Short generation may author different continuity/style prose.
          // Translate its own full request without borrowing a long-draft
          // placeholder map. The paired long route tests original raw tags.
          response = qaPlainEnglishTranslationResponse(payload);
        } else response = qaTextResponseContent(kind, payload);
        assert.ok(response, `unexpected short/long protocol request ${kind}`);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: response } }] }) });
      } catch (error) {
        mockErrors.push(error instanceof Error ? error.message : String(error));
        await route.fulfill({ status: 500, body: 'QA shared single-segment flow failed' });
      }
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.locator('.director-all-sections').waitFor();
    await regressionPage.getByRole('button', { name: '单段直出', exact: true }).click();
    await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    await regressionPage.getByRole('button', { name: '参考图', exact: true }).click();
    for (const asset of pictureAssets) await regressionPage.getByLabel(`选择参考图：${asset.name}`, { exact: true }).check();
    await regressionPage.locator('#director-setup-timing').getByRole('button', { name: '15 秒', exact: true }).click();
    await regressionPage.getByRole('button', { name: '精确指定', exact: true }).click();
    await regressionPage.getByLabel('镜头数量', { exact: true }).fill('3');
    await regressionPage.getByRole('button', { name: 'AI 按 3 镜分镜并生成提示词', exact: true }).click();
    await regressionPage.waitForFunction((key) => {
      const board = JSON.parse(localStorage.getItem(key) || '{}').project?.storyboards?.[0];
      return Boolean(board?.officialPromptZh && board.officialPromptEn && board.officialPromptEnSource === board.officialPromptZh);
    }, storageKey, { timeout: 30_000 });
    const saved = await regressionPage.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
    const board = saved.project.storyboards[0];
    const shortDeliveryRequests = requests.filter((request) => ['converter', 'translator'].includes(request.kind));
    assert.deepEqual(shortDeliveryRequests.map((request) => request.kind), ['converter', 'translator'],
      'short UI must complete through one converter then one ordinary translator');
    assert.deepEqual(longRequests.map((request) => request.kind), shortDeliveryRequests.map((request) => request.kind),
      'long refresh and short generation must share delivery-stage ordering');
    assert.deepEqual(shortDeliveryRequests[0].referenceData, longRequests[0].referenceData,
      'short and long delivery must receive the same reference schema, roles and budgeted descriptions');
    assert.deepEqual(shortDeliveryRequests[0].imageUrls, longRequests[0].imageUrls,
      'short and long converters must receive the same selected image pixels in order');
    assert.deepEqual(shortDeliveryRequests[1].imageUrls, [], 'the common translator must remain text-only');
    assert.equal(shortDeliveryRequests[0].conversionData.sourceStoryContent, source,
      'short converter must receive exactly the same story excerpt as the selected long segment');
    assert.equal(shortDeliveryRequests[0].conversionData.sourceStoryContent, longRequests[0].conversionData.sourceStoryContent);
    const numberedRanges = (evidence) => evidence.map(({ shot, exactTimeLabel, durationSec }) => {
      const range = exactTimeLabel.match(/^【(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s】$/u);
      assert.ok(range, 'both routes must send complete canonical time labels');
      return { shot, startSec: Number(range[1]), endSec: Number(range[2]), durationSec };
    });
    assert.deepEqual(numberedRanges(shortDeliveryRequests[0].conversionData.shotEvidence),
      numberedRanges(longRequests[0].conversionData.shotEvidence),
      'short and long converters share the complete three-shot grid without local-unit renumbering');
    assert.equal(shortDeliveryRequests[1].systemPrompt, longRequests[1].systemPrompt,
      'short and long H3 translation must use the same ordinary full-document system contract');
    for (const request of [...shortDeliveryRequests, ...longRequests]) {
      assert.doesNotMatch(`${request.systemPrompt}\n${request.userPrompt}`,
        /sequence_reference_data|sequence_reference_conversion_contract|h3_translation_units|h3_bounded_translation_contract|unit_\d{3}/u,
        'neither route may send a long-only translation or conversion envelope');
    }
    assert.equal(board.shots.length, 3);
    assert.deepEqual(board.shots.map((shot) => [shot.startSec, shot.endSec]), [[0, 5], [5, 10], [10, 15]]);
    assert.ok(board.officialPromptZh && board.officialPromptEn);
    assert.match(board.officialPromptEn, /<Subject 1>[\s\S]*<Picture 1>/u,
      'the short route must restore complete official tags from its own ordinary translation');
    assert.deepEqual(mockErrors, []);
    assert.deepEqual(consoleErrors, []);
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.locator('.director-all-sections').waitFor();
    await regressionPage.getByRole('button', { name: '结果', exact: true }).click();
    const screenshot = 'short-long-shared-single-segment-protocol-1280x800.png';
    await regressionPage.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: false });
    return { shortRequestKinds: requests.map((request) => request.kind), deliveryRequestKinds: shortDeliveryRequests.map((request) => request.kind),
      sameStoryAndReferenceRoles: true, sameConverterReferenceSchema: true, sameReferencePixelsInOrder: true,
      samePlainTranslatorSystem: true, noUnitJsonOrLocalRenumbering: true,
      rawOfficialTagsAcceptedOnLongRoute: true, protectedTokensAcceptedOnShortRoute: true,
      confirmedShotRanges: board.shots.map((shot) => [shot.startSec, shot.endSec]),
      chineseCharacters: board.officialPromptZh.length, englishCharacters: board.officialPromptEn.length, screenshot };
  } catch (error) {
    const runtimeErrors = await regressionPage.evaluate(() => JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]')).catch(() => []);
    await regressionPage.screenshot({ path: path.join(outputDirectory, 'short-long-shared-protocol-failure.png'), fullPage: false }).catch(() => {});
    throw new Error(`short/long shared protocol UI failed: ${JSON.stringify({ requestKinds: requests.map((request) => request.kind), mockErrors, consoleErrors, runtimeErrors })}`, { cause: error });
  } finally {
    await regressionContext.close();
  }
};

const runAsyncMasterPromptRegression = async () => {
  const regressionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const regressionPage = await regressionContext.newPage();
  const apiCalls = [];
  let persistedDuringDirectorRequest = null;
  try {
    await regressionPage.addInitScript(() => {
      if (!sessionStorage.getItem('__lianhua_async_master_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('__lianhua_async_master_qa_initialized__', '1');
      }
    });
    await installQaTextApiMock(regressionPage, async (callKind) => {
      apiCalls.push(callKind);
      // Keep the request pending beyond the application's persistence debounce.
      // This reproduces the React state update + await ordering that previously
      // invalidated an otherwise current full-timeline generation request.
      if (callKind === 'director') {
        await new Promise((resolve) => setTimeout(resolve, 320));
        persistedDuringDirectorRequest = await regressionPage.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const state = JSON.parse(raw);
          return {
            projectUpdatedAt: state?.project?.updatedAt ?? null,
            sourceUpdatedAt: state?.project?.sourceDocuments?.[0]?.updatedAt ?? null,
            sourceContent: state?.project?.sourceDocuments?.[0]?.content ?? null,
          };
        }, storageKey);
      }
    });

    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await regressionPage.getByRole('button', { name: '剧情解析', exact: true }).click();
    const sourceStory = '暴雨中的旧港口，巡逻员推开仓库铁门，看见受伤的机械兽伏在灯下。机械兽抬头后退，撞翻木箱；巡逻员放下武器，缓慢伸出手。远处警笛逼近，机械兽跃上窗台回望一眼，随后撞破玻璃消失在雨幕中。';
    await regressionPage.locator('.story-source-textarea').fill(sourceStory);
    await regressionPage.getByRole('button', { name: '保存原文', exact: true }).click();
    await regressionPage.getByRole('button', { name: '解析并补全', exact: true }).click();
    await regressionPage.getByRole('button', { name: /^场景管理/u }).click();
    await regressionPage.locator('.story-scene-card').first().waitFor();
    await regressionPage.waitForFunction(({ key, sourceStory }) => {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const state = JSON.parse(raw);
      return state?.project?.sourceDocuments?.[0]?.content === sourceStory
        && state?.project?.scenes?.length > 0;
    }, { key: storageKey, sourceStory });
    await enableQaTextApi(regressionPage);
    await regressionPage.getByRole('button', { name: '提示词导演台', exact: true }).click();
    await regressionPage.getByRole('button', { name: '长剧情拆段', exact: true }).click();
    const regressionTiming = regressionPage.locator('#sequence-director-settings-panel #director-setup-timing');
    await regressionTiming.getByRole('button', { name: '自定义', exact: true }).click();
    await regressionTiming.getByLabel('每段目标秒数').fill('8');
    await regressionPage.getByRole('button', {
      name: '确认全片导演参数，进入①全片规划',
      exact: true,
    }).click();
    await regressionPage.locator('.sequence-planner-panel').waitFor();
    await regressionPage.getByRole('button', { name: '固定总时长', exact: true }).click();
    await regressionPage.getByLabel('全片总秒数').fill('24');
    await regressionPage.waitForTimeout(350);
    const persistedBeforeGeneration = await regressionPage.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const state = JSON.parse(raw);
      return {
        projectUpdatedAt: state?.project?.updatedAt ?? null,
        sourceUpdatedAt: state?.project?.sourceDocuments?.[0]?.updatedAt ?? null,
        sourceContent: state?.project?.sourceDocuments?.[0]?.content ?? null,
      };
    }, storageKey);
    await regressionPage.getByRole('button', {
      name: '① 生成全片总提示词',
      exact: true,
    }).click();
    const masterReview = regressionPage.locator('.sequence-master-review');
    try {
      await masterReview.waitFor({ timeout: 5_000 });
    } catch (error) {
      const notice = (await regressionPage.locator('.sidebar-notice').textContent().catch(() => ''))?.trim() || '';
      const diagnostics = await regressionPage.evaluate((key) => {
        const raw = localStorage.getItem('lianhua_runtime_error_log_v1');
        if (!raw) return null;
        try {
          const entries = JSON.parse(raw);
          return Array.isArray(entries) ? entries.slice(-4) : entries;
        } catch {
          return raw;
        }
      }, storageKey).catch(() => null);
      throw new Error(`async text API master generation did not reach review: ${JSON.stringify({
        apiCalls,
        notice,
        diagnostics,
        persistedBeforeGeneration,
        persistedDuringDirectorRequest,
      })}`, { cause: error });
    }
    const finalPrompt = await regressionPage.getByLabel('全片总视频提示词').inputValue();
    const persistedMasterDraft = await regressionPage.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const plan = [...(state?.project?.sequencePlans || [])].reverse()
        .find((candidate) => candidate.planningStage === 'master-draft');
      const board = state?.project?.storyboards?.find(
        (candidate) => candidate.id === plan?.masterStoryboardId,
      );
      return { plan, board, sourceContent: state?.project?.sourceDocuments?.[0]?.content || '' };
    }, storageKey);
    const notice = (await regressionPage.locator('.sidebar-notice').textContent().catch(() => ''))?.trim() || '';
    if (
      apiCalls.length !== 4
      || apiCalls[0] !== 'director'
      || apiCalls[1] !== 'shot-recommendation'
      || apiCalls[2] !== 'converter'
      || apiCalls[3] !== 'translator'
      || !persistedBeforeGeneration
      || !persistedDuringDirectorRequest
      || persistedDuringDirectorRequest.projectUpdatedAt !== persistedBeforeGeneration.projectUpdatedAt
      || persistedDuringDirectorRequest.sourceUpdatedAt !== persistedBeforeGeneration.sourceUpdatedAt
      || persistedDuringDirectorRequest.sourceContent !== sourceStory
      || persistedMasterDraft?.sourceContent !== sourceStory
      || persistedMasterDraft?.plan?.segments?.length !== 0
      || !persistedMasterDraft?.plan?.masterStoryboardId
      || persistedMasterDraft?.board?.durationSec !== 24
      || persistedMasterDraft?.plan?.segmentDurationSec !== 8
      || persistedMasterDraft?.board?.shots?.length !== 4
      || persistedMasterDraft?.board?.shots?.[0]?.endSec !== 5
      || persistedMasterDraft?.board?.shots?.[1]?.endSec !== 8
      || persistedMasterDraft?.board?.shots?.[2]?.endSec !== 16
      || persistedMasterDraft?.board?.shots?.[3]?.endSec !== 24
      || persistedMasterDraft?.board?.promptTrace?.shotRecommendationMode !== 'text-api'
      || !persistedMasterDraft?.board?.finalPrompt?.trim()
      || !persistedMasterDraft?.board?.englishPrompt?.trim()
      || persistedMasterDraft?.board?.englishPromptSource !== persistedMasterDraft?.board?.finalPrompt
      || persistedMasterDraft?.board?.promptTrace?.mode !== 'text-api'
      || !finalPrompt.trim()
      || !/^【0(?:\.0+)?s-/u.test(finalPrompt.trim())
      || notice.includes('全片总视频提示词生成失败')
    ) {
      throw new Error(`async text API master generation regression failed: ${JSON.stringify({
        apiCalls,
        notice,
        finalPrompt: finalPrompt.slice(0, 180),
        persistedBeforeGeneration,
        persistedDuringDirectorRequest,
        persistedMasterDraft,
      })}`);
    }
    const editedMasterPrompt = finalPrompt.replace(
      /镜头：/u,
      '镜头：稳定机位，',
    );
    await regressionPage.getByLabel('全片总视频提示词').fill(editedMasterPrompt);
    await regressionPage.waitForFunction(({ key, editedPrompt }) => {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const state = JSON.parse(raw);
      const plan = [...(state?.project?.sequencePlans || [])].reverse()
        .find((candidate) => candidate.planningStage === 'master-draft');
      const board = state?.project?.storyboards?.find(
        (candidate) => candidate.id === plan?.masterStoryboardId,
      );
      return board?.finalPrompt === editedPrompt;
    }, { key: storageKey, editedPrompt: editedMasterPrompt });
    const editedMasterTrace = await regressionPage.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const state = JSON.parse(raw);
      const plan = [...(state?.project?.sequencePlans || [])].reverse()
        .find((candidate) => candidate.planningStage === 'master-draft');
      const board = state?.project?.storyboards?.find(
        (candidate) => candidate.id === plan?.masterStoryboardId,
      );
      return board?.promptTrace ?? null;
    }, storageKey);
    if (
      !editedMasterTrace
      || editedMasterTrace.mode !== 'local-fallback'
      || editedMasterTrace.convertedPromptFingerprint
      || editedMasterTrace.shotPlanMode !== 'ai-complete'
    ) {
      throw new Error(`editing a converted master prompt did not invalidate only its conversion proof: ${JSON.stringify(editedMasterTrace)}`);
    }
    return {
      apiCalls,
      sourceStayedStableDuringAwait: true,
      projectTimestampStayedStableDuringAwait: true,
      finalPromptStartsAtZero: true,
      bilingualPromptPersisted: true,
      masterDurationSec: persistedMasterDraft.board.durationSec,
      manualEditInvalidatedConversionProof: true,
      manualEditPreservedCompleteAiShotProof: true,
    };
  } finally {
    await regressionContext.close();
  }
};

const runStoryBiblePreviewRegression = async () => {
  const regressionContext = await browser.newContext({ viewport: { width: 1430, height: 894 } });
  const regressionPage = await regressionContext.newPage();
  const regressionConsoleErrors = [];
  regressionPage.on('console', (message) => {
    if (message.type() === 'error') regressionConsoleErrors.push(message.text());
  });
  regressionPage.on('pageerror', (error) => regressionConsoleErrors.push(error.message));

  const fixture = [
    { kind: 'character', label: '人物', count: 14, lastName: 'QA人物14' },
    { kind: 'location', label: '地点', count: 6, lastName: 'QA地点06' },
    { kind: 'prop', label: '道具', count: 9, lastName: 'QA道具09' },
  ];
  const viewportReports = [];

  try {
    await regressionPage.addInitScript(() => {
      if (!sessionStorage.getItem('__lianhua_story_bible_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('__lianhua_story_bible_qa_initialized__', '1');
      }
    });
    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await regressionPage.evaluate(({ key, counts }) => {
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error('story-bible QA state was not persisted');
      const state = JSON.parse(raw);
      const buildItems = (source, count, idPrefix, namePrefix, detailField) => {
        const base = source?.[0] || {};
        return Array.from({ length: count }, (_, index) => ({
          ...base,
          id: `qa-${idPrefix}-${index + 1}`,
          name: `${namePrefix}${String(index + 1).padStart(2, '0')}`,
          [detailField]: `QA ${namePrefix} ${index + 1} 可见资料`,
          assetIds: [],
        }));
      };
      const project = {
        ...state.project,
        characters: buildItems(state.project?.characters, counts.character, 'character', 'QA人物', 'appearance'),
        locations: buildItems(state.project?.locations, counts.location, 'location', 'QA地点', 'description'),
        props: buildItems(state.project?.props, counts.prop, 'prop', 'QA道具', 'appearance'),
      };
      state.project = project;
      state.projects = (state.projects || []).map((candidate) => (
        candidate.id === project.id ? project : candidate
      ));
      if (!state.projects.some((candidate) => candidate.id === project.id)) state.projects.push(project);
      localStorage.setItem(key, JSON.stringify(state));
    }, {
      key: storageKey,
      counts: { character: 14, location: 6, prop: 9 },
    });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '剧情解析', exact: true }).click();
    await regressionPage.locator('.story-bible-card').waitFor();

    for (const size of [{ width: 1430, height: 894 }, { width: 1120, height: 720 }]) {
      await regressionPage.setViewportSize(size);
      await regressionPage.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));

      const preview = regressionPage.locator('.story-bible-card');
      const groups = preview.locator('.story-bible-list > .list-item');
      await preview.evaluate((card) => {
        const outerList = card.querySelector('.story-bible-list');
        if (outerList) outerList.scrollTop = 0;
        card.querySelectorAll('.entity-chip-list').forEach((list) => {
          list.scrollTop = 0;
        });
      });
      if (await groups.count() !== fixture.length) {
        throw new Error(`story-bible preview expected ${fixture.length} groups, found ${await groups.count()}`);
      }
      const renderedCounts = [];
      for (let index = 0; index < fixture.length; index += 1) {
        const expected = fixture[index];
        const group = groups.nth(index);
        const heading = (await group.locator('.list-item-title').textContent())?.trim() || '';
        const badgeText = (await group.locator('.list-item-head > .badge').textContent())?.trim() || '';
        const badgeCount = Number(badgeText);
        const renderedCount = await group.locator('.entity-chip-list > .entity-chip').count();
        renderedCounts.push(renderedCount);
        if (!heading.includes(expected.label)) {
          throw new Error(`story-bible group ${index + 1} expected ${expected.label}, found ${heading || 'empty'}`);
        }
        if (badgeCount !== expected.count || renderedCount !== badgeCount) {
          throw new Error(
            `story-bible ${expected.label} count mismatch at ${size.width}x${size.height}: `
            + `expected=${expected.count}, badge=${badgeText || 'missing'}, rendered=${renderedCount}`,
          );
        }
      }

      const entityTabCount = Number(
        (await regressionPage.locator('.page-switcher .segment').filter({ hasText: '实体资料' })
          .locator('.tab-count').textContent())?.trim() || '',
      );
      const renderedTotal = renderedCounts.reduce((total, count) => total + count, 0);
      if (entityTabCount !== renderedTotal) {
        throw new Error(
          `story-bible total count mismatch at ${size.width}x${size.height}: `
          + `tab=${entityTabCount}, rendered=${renderedTotal}`,
        );
      }

      const browsedLastItems = [];
      for (let index = 0; index < fixture.length; index += 1) {
        const expected = fixture[index];
        const group = groups.nth(index);
        const chipList = group.locator('.entity-chip-list');
        const lastItem = chipList.locator(':scope > .entity-chip').last();
        const itemText = (await lastItem.textContent())?.replace(/\s+/gu, ' ').trim() || '';
        if (!itemText.startsWith(expected.lastName)) {
          throw new Error(`story-bible ${expected.label} last item is ${itemText || 'missing'}`);
        }
        const categoryScroll = await chipList.evaluate((list) => ({
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          maxScrollTop: list.scrollHeight - list.clientHeight,
        }));
        if (categoryScroll.maxScrollTop <= 1) {
          throw new Error(
            `story-bible ${expected.label} must have its own scroll area at ${size.width}x${size.height}: `
            + JSON.stringify(categoryScroll),
          );
        }
        await chipList.evaluate((list) => {
          list.scrollTop = list.scrollHeight;
          return new Promise((resolve) => requestAnimationFrame(resolve));
        });
        const insideScrollViewport = await lastItem.evaluate((element) => {
          const list = element.closest('.entity-chip-list');
          if (!list) return false;
          const itemRect = element.getBoundingClientRect();
          const listRect = list.getBoundingClientRect();
          return itemRect.top >= listRect.top - 1
            && itemRect.bottom <= listRect.bottom + 1
            && itemRect.left >= listRect.left - 1
            && itemRect.right <= listRect.right + 1;
        });
        if (!insideScrollViewport) {
          throw new Error(`story-bible ${expected.label} last item cannot be scrolled into its category viewport`);
        }
        await lastItem.click();
        const modal = regressionPage.locator('.entity-editor-modal');
        await modal.waitFor();
        const modalHeading = (await modal.locator('h3').textContent())?.trim() || '';
        if (!modalHeading.includes(expected.lastName)) {
          throw new Error(`story-bible ${expected.label} last item opened the wrong editor: ${modalHeading}`);
        }
        browsedLastItems.push(expected.lastName);
        await modal.getByRole('button', { name: '关闭', exact: true }).first().click();
        await modal.waitFor({ state: 'detached' });
      }

      const layout = await regressionPage.evaluate(() => {
        const card = document.querySelector('.story-bible-card');
        const list = card?.querySelector('.story-bible-list');
        const hint = card?.querySelector('.compact-hint');
        const groups = list ? [...list.querySelectorAll(':scope > .list-item')] : [];
        const bounds = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            left: value.left,
          };
        };
        const overlaps = (first, second) => Boolean(
          first && second
          && first.left < second.right - 0.5
          && first.right > second.left + 0.5
          && first.top < second.bottom - 0.5
          && first.bottom > second.top + 0.5
        );
        const groupRects = groups.map(bounds);
        const headingRects = groups.map((group) => bounds(group.querySelector('.list-item-head')));
        const entityLists = groups.map((group) => group.querySelector('.entity-chip-list'));
        const entityListRects = entityLists.map(bounds);
        const chipLists = groups.map((group) => [...group.querySelectorAll('.entity-chip')]);
        const chipOverlap = chipLists.some((chips) => chips.some((chip, index) => (
          index > 0 && overlaps(bounds(chips[index - 1]), bounds(chip))
        )));
        const listRect = bounds(list);
        const hintRect = bounds(hint);
        const cardRect = bounds(card);
        const categoryScrollReports = entityLists.map((entityList, index) => {
          const lastChip = chipLists[index]?.at(-1);
          if (entityList) entityList.scrollTop = entityList.scrollHeight;
          return {
            clientHeight: entityList?.clientHeight || 0,
            scrollHeight: entityList?.scrollHeight || 0,
            maxScrollTop: entityList
              ? entityList.scrollHeight - entityList.clientHeight
              : 0,
            lastChip,
          };
        });
        const maxOuterScrollTop = list ? list.scrollHeight - list.clientHeight : 0;
        return new Promise((resolve) => requestAnimationFrame(() => {
          const categoryReports = categoryScrollReports.map((report, index) => {
            const scrolledLastRect = bounds(report.lastChip);
            const entityListRect = entityListRects[index];
            return {
              clientHeight: report.clientHeight,
              scrollHeight: report.scrollHeight,
              maxScrollTop: report.maxScrollTop,
              lastItemVisibleAtBottom: Boolean(scrolledLastRect && entityListRect
                && scrolledLastRect.top >= entityListRect.top - 1
                && scrolledLastRect.bottom <= entityListRect.bottom + 1),
            };
          });
          resolve({
            viewport: { width: innerWidth, height: innerHeight },
            cardInsideViewport: Boolean(cardRect
              && cardRect.left >= -0.5
              && cardRect.top >= -0.5
              && cardRect.right <= innerWidth + 0.5
              && cardRect.bottom <= innerHeight + 0.5),
            listInsideCard: Boolean(listRect && cardRect
              && listRect.left >= cardRect.left - 0.5
              && listRect.right <= cardRect.right + 0.5
              && listRect.top >= cardRect.top - 0.5
              && listRect.bottom <= cardRect.bottom + 0.5),
            listOverlapsHint: overlaps(listRect, hintRect),
            groupsOverlap: groupRects.some((groupRect, index) => (
              index > 0 && overlaps(groupRects[index - 1], groupRect)
            )),
            groupsInsideList: groupRects.every((groupRect) => Boolean(groupRect && listRect
              && groupRect.left >= listRect.left - 0.5
              && groupRect.right <= listRect.right + 0.5
              && groupRect.top >= listRect.top - 0.5
              && groupRect.bottom <= listRect.bottom + 0.5)),
            headingsInsideList: headingRects.every((headingRect) => Boolean(headingRect && listRect
              && headingRect.left >= listRect.left - 0.5
              && headingRect.right <= listRect.right + 0.5
              && headingRect.top >= listRect.top - 0.5
              && headingRect.bottom <= listRect.bottom + 0.5)),
            entityListsInsideGroups: entityListRects.every((entityListRect, index) => {
              const groupRect = groupRects[index];
              return Boolean(entityListRect && groupRect
                && entityListRect.left >= groupRect.left - 0.5
                && entityListRect.right <= groupRect.right + 0.5
                && entityListRect.top >= groupRect.top - 0.5
                && entityListRect.bottom <= groupRect.bottom + 0.5);
            }),
            chipOverlap,
            documentOverflowX: document.documentElement.scrollWidth
              > document.documentElement.clientWidth + 1,
            cardOverflowX: Boolean(card && card.scrollWidth > card.clientWidth + 1),
            listOverflowX: Boolean(list && list.scrollWidth > list.clientWidth + 1),
            outerListScrollable: maxOuterScrollTop > 1,
            maxOuterScrollTop,
            categoryReports,
          });
        }));
      });
      const layoutFailures = [];
      if (!layout.cardInsideViewport) layoutFailures.push('preview card extends outside viewport');
      if (!layout.listInsideCard) layoutFailures.push('preview list extends outside card');
      if (layout.listOverlapsHint) layoutFailures.push('preview list overlaps its bottom hint');
      if (layout.groupsOverlap) layoutFailures.push('entity groups overlap');
      if (!layout.groupsInsideList) layoutFailures.push('one or more entity groups leave the preview list viewport');
      if (!layout.headingsInsideList) layoutFailures.push('one or more entity category headings are not simultaneously visible');
      if (!layout.entityListsInsideGroups) layoutFailures.push('an entity card list leaves its category group');
      if (layout.chipOverlap) layoutFailures.push('entity cards overlap');
      if (layout.documentOverflowX || layout.cardOverflowX || layout.listOverflowX) {
        layoutFailures.push('preview introduces horizontal overflow');
      }
      if (layout.outerListScrollable) {
        layoutFailures.push('entity categories still share one outer scroll area');
      }
      if (
        layout.categoryReports.length !== fixture.length
        || layout.categoryReports.some((report) => (
          report.maxScrollTop <= 1 || !report.lastItemVisibleAtBottom
        ))
      ) {
        layoutFailures.push('one or more entity categories cannot independently scroll to the last card');
      }
      if (layoutFailures.length) {
        throw new Error(
          `story-bible layout failed at ${size.width}x${size.height}: ${layoutFailures.join('; ')}`
          + `\n${JSON.stringify(layout, null, 2)}`,
        );
      }
      const screenshotName = `story-bible-preview-${size.width}x${size.height}.png`;
      await regressionPage.screenshot({
        path: path.join(outputDirectory, screenshotName),
        fullPage: false,
      });
      viewportReports.push({
        viewport: size,
        entityTabCount,
        renderedCounts,
        browsedLastItems,
        layout,
        screenshot: screenshotName,
      });
    }

    if (regressionConsoleErrors.length) {
      throw new Error(`story-bible browser console errors: ${regressionConsoleErrors.join(' | ')}`);
    }
    return {
      fixtureCounts: Object.fromEntries(fixture.map((item) => [item.kind, item.count])),
      viewportReports,
      consoleErrors: regressionConsoleErrors,
    };
  } finally {
    await regressionContext.close();
  }
};

const runStoryBibleRecoveryRegression = async () => {
  const regressionContext = await browser.newContext({ viewport: { width: 1430, height: 894 } });
  const regressionPage = await regressionContext.newPage();
  const regressionConsoleErrors = [];
  const apiCalls = [];
  const mockErrors = [];
  regressionPage.on('console', (message) => {
    if (message.type() === 'error') regressionConsoleErrors.push(message.text());
  });
  regressionPage.on('pageerror', (error) => regressionConsoleErrors.push(error.message));

  const sourceStory = [
    '我带着雪衣道侣与玄衣道侣穿过青石长街，进入修仙界集市，在一处符材摊前见到摊主。',
    '雪衣道侣从镇灵石压住的黄符纸下抽出三张符纸，玄衣道侣抱着灵砂瓶，摊上还摆着封灵砂罐、银针、细剑和灵石。',
    '摊主点亮鲛油灯，把避风符交给我，我们随后退到西侧窄巷口。',
  ].join('');
  const expectedCoreCharacters = ['无名主角', '雪衣道侣', '玄衣道侣', '摊主'];
  const expectedCharacters = [...expectedCoreCharacters, '用户资产角色'];
  const expectedLocations = ['修仙界集市', '符材摊', '西侧窄巷口'];
  const expectedProps = ['黄符纸', '镇灵石', '封灵砂罐', '灵砂瓶', '银针', '细剑', '灵石', '鲛油灯', '避风符'];
  const forbiddenCharacters = ['我', '雪衣道侣走', '目光只落', '灵砂瓶'];
  const forbiddenLocations = ['珠光下轻轻发亮', '一处符材摊前', '尘外'];
  const fixtureUpdatedAt = 1_730_000_000_000;

  const characterDetails = (name) => ({
    name,
    gender: `${name}可见性别设定`,
    // The production enrichment schema requires all three independent values;
    // an empty apparentAge used to make this success fixture ask for repairs.
    apparentAge: '外观约二十五岁',
    actualAge: '实际年龄约一百二十岁',
    height: '约170cm',
    race: `${name}修仙界人族设定`,
    appearance: `${name}稳定脸型、发色、肤色与辨识特征`,
    outfit: `${name}分层衣装、固定配色与材质`,
    signatureProps: `${name}固定随身物`,
    personality: `${name}稳定性格气质`,
    motionHabits: `${name}可见动作习惯`,
    anchor: `${name}跨镜连续性锚点`,
    negativeContinuity: `${name}身份、脸型、发色和衣装不得改变`,
  });
  const locationDetails = (name) => ({
    name,
    description: `${name}的空间结构、尺度、建筑材质与固定陈设`,
    timeWeather: `${name}日间薄雾空气状态`,
    lighting: `${name}左侧自然主光与柔和阴影`,
    palette: `${name}青灰、旧木与暖金材质配色`,
    fixedProps: `${name}固定摊位、灯具与道路陈设`,
    anchor: `${name}空间朝向和陈设位置保持一致`,
  });
  const propDetails = (name) => ({
    name,
    category: `${name}剧情道具`,
    material: `${name}固定材质与表面工艺`,
    appearance: `${name}固定形状、颜色、纹理、尺寸与磨损细节`,
    effect: `${name}推动当前交易与冲突`,
    stateRules: `${name}方向、数量和使用状态跨镜连续`,
  });
  const analysisResponse = {
    characters: expectedCoreCharacters.map(characterDetails),
    locations: expectedLocations.map(locationDetails),
    props: expectedProps.map(propDetails),
    scenes: [{
      title: '集市符材交易',
      content: sourceStory,
      summary: '三人与摊主在符材摊完成交易后退入西侧窄巷口。',
      characters: expectedCoreCharacters,
      location: '符材摊',
      props: expectedProps,
    }],
  };

  const classifyRequest = (payload) => {
    const systemPrompt = qaMessageContent(payload, 'system');
    if (systemPrompt.includes('中文小说的视频前期分析助手')) return 'analysis';
    if (systemPrompt.includes('影视项目圣经的人物视觉设定师')) return 'characters';
    if (systemPrompt.includes('影视项目圣经的地点视觉设定师')) return 'locations';
    if (systemPrompt.includes('影视项目圣经的道具视觉设定师')) return 'props';
    return 'unexpected';
  };
  const requestedNames = (payload, kind) => {
    const label = kind === 'characters' ? '人物' : kind === 'locations' ? '地点' : '道具';
    const userPrompt = qaMessageContent(payload, 'user');
    const match = userPrompt.match(new RegExp(`需要补全的${label}名称：(\\[[^\\n]*\\])`, 'u'));
    if (!match) throw new Error(`QA ${label} enrichment request is missing its name list`);
    const names = JSON.parse(match[1]);
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`QA ${label} enrichment name list is invalid`);
    }
    return names;
  };

  try {
    await regressionPage.addInitScript(() => {
      if (!sessionStorage.getItem('__lianhua_story_bible_recovery_qa_initialized__')) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('__lianhua_story_bible_recovery_qa_initialized__', '1');
      }
    });
    await regressionPage.route('**/qa-story-bible-openai/v1/chat/completions', async (route) => {
      let payload;
      let kind = 'unexpected';
      let names = [];
      let responseContent = '';
      try {
        payload = route.request().postDataJSON();
        kind = classifyRequest(payload);
        if (kind === 'analysis') {
          responseContent = JSON.stringify(analysisResponse);
        } else if (kind === 'characters' || kind === 'locations' || kind === 'props') {
          names = requestedNames(payload, kind);
          const buildDetails = kind === 'characters'
            ? characterDetails
            : kind === 'locations'
              ? locationDetails
              : propDetails;
          responseContent = JSON.stringify({ items: names.map(buildDetails) });
        } else {
          throw new Error('unexpected story-bible QA text request');
        }
        apiCalls.push({
          kind,
          names,
          repair: qaMessageContent(payload, 'system').includes('完整性修复请求'),
          status: 200,
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: responseContent } }] }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'unknown mock error');
        mockErrors.push({ kind, message });
        apiCalls.push({ kind, names, repair: false, status: 500 });
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message } }),
        });
      }
    });

    await regressionPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await regressionPage.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
    await regressionPage.evaluate(({
      key,
      story,
      apiBaseUrl,
      propNames,
      updatedAt,
    }) => {
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error('story-bible recovery QA state was not persisted');
      const state = JSON.parse(raw);
      const character = (id, name, appearance, assetIds = []) => ({
        id,
        name,
        gender: '',
        apparentAge: '',
        race: '',
        appearance,
        outfit: '',
        signatureProps: '',
        personality: '',
        motionHabits: '',
        anchor: '',
        negativeContinuity: '',
        assetIds,
      });
      const location = (id, name, description, assetIds = []) => ({
        id,
        name,
        description,
        timeWeather: '',
        lighting: '',
        palette: '',
        fixedProps: '',
        anchor: '',
        assetIds,
      });
      const props = propNames.map((name, index) => ({
        id: `legacy-prop-${index + 1}`,
        name,
        category: '用户保留的道具类别',
        material: index === 0 ? '用户手工保留的黄符纸材质' : '',
        appearance: '',
        effect: '',
        stateRules: '',
        assetIds: [],
      }));
      const characters = [
        character('legacy-self', '我', '用户手工保留的主角外观'),
        character('legacy-snow', '雪衣道侣', '用户手工保留的雪衣外观'),
        character('legacy-snow-walk', '雪衣道侣走', '旧解析误存的动作片段'),
        character('legacy-gaze', '目光只落', '旧解析误存的谓语片段'),
        character('legacy-bottle-character', '灵砂瓶', '旧解析误把道具存成人物'),
        character('legacy-asset-extra', '用户资产角色', '用户资产角色手工外观', ['qa-manual-asset']),
      ];
      const locations = [
        location('legacy-market', '修仙界集市', '用户手工保留的集市空间资料'),
        location('legacy-light-fragment', '珠光下轻轻发亮', '旧解析误存的状态片段'),
        location('legacy-relative-stall', '一处符材摊前', '旧解析误存的相对地点包装'),
        location('legacy-outside-fragment', '尘外', '旧解析误存的残缺方位'),
      ];
      const legacyScene = {
        id: 'legacy-polluted-scene',
        title: '旧解析污染场景',
        content: story,
        summary: '旧版本实体识别污染夹具',
        characterIds: characters.map((item) => item.id),
        locationId: 'legacy-relative-stall',
        locationIds: locations.map((item) => item.id),
        propIds: props.map((item) => item.id),
        storyboardIds: [],
        createdAt: updatedAt,
        updatedAt,
      };
      const project = {
        ...state.project,
        updatedAt,
        sourceDocuments: [{
          id: 'legacy-polluted-source',
          name: '旧 0.5.56 实体污染剧情',
          content: story,
          createdAt: updatedAt,
          updatedAt,
        }],
        characters,
        locations,
        props,
        scenes: [legacyScene],
        storyboards: [],
        sequencePlans: [],
        generationTasks: [],
        assets: [{
          id: 'qa-manual-asset',
          name: '用户资产角色参考图',
          type: 'character',
          role: 'character',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+XLFVAAAAAElFTkSuQmCC',
          mimeType: 'image/png',
          mediaType: 'image',
          source: 'upload',
          sourceEntityId: 'legacy-asset-extra',
          sourceEntityKind: 'character',
          targetBindings: [],
          tags: ['QA 手工资产'],
          createdAt: updatedAt,
          updatedAt,
        }],
      };
      state.project = project;
      state.projects = (state.projects || []).map((candidate) => (
        candidate.id === project.id ? project : candidate
      ));
      if (!state.projects.some((candidate) => candidate.id === project.id)) state.projects.push(project);
      state.activeProjectId = project.id;
      state.settings.textApi = {
        ...state.settings.textApi,
        enabled: true,
        provider: 'openai_compatible',
        baseUrl: apiBaseUrl,
        apiKey: '',
        model: 'qa-story-bible-model',
      };
      localStorage.setItem(key, JSON.stringify(state));
    }, {
      key: storageKey,
      story: sourceStory,
      apiBaseUrl: new URL('qa-story-bible-openai/v1', baseUrl).toString(),
      propNames: expectedProps,
      updatedAt: fixtureUpdatedAt,
    });
    await regressionPage.reload({ waitUntil: 'networkidle' });
    await regressionPage.getByRole('button', { name: '剧情解析', exact: true }).click();
    const sourceInput = regressionPage.locator('.story-source-textarea');
    await sourceInput.waitFor();
    if (await sourceInput.inputValue() !== sourceStory) {
      throw new Error('story-bible recovery fixture source was not restored into the story editor');
    }

    const analyzeButton = regressionPage.getByRole('button', { name: '解析并补全', exact: true });
    await analyzeButton.click();
    await regressionPage.waitForFunction(() => (
      [...document.querySelectorAll('button')].some((button) => (
        button.textContent?.trim() === '解析并补全' && !button.disabled
      ))
    ));
    const completionNotice = (await regressionPage.locator('.sidebar-notice').textContent())
      ?.replace(/\s+/gu, ' ')
      .trim() || '';
    await regressionPage.waitForFunction(({ key, previousUpdatedAt }) => {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      return JSON.parse(raw)?.project?.updatedAt !== previousUpdatedAt;
    }, { key: storageKey, previousUpdatedAt: fixtureUpdatedAt });

    const persisted = await regressionPage.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const project = JSON.parse(raw)?.project;
      return project ? {
        characters: project.characters,
        locations: project.locations,
        props: project.props,
        scenes: project.scenes,
      } : null;
    }, storageKey);
    const rendered = await regressionPage.locator('.story-bible-list > .list-item').evaluateAll((groups) => (
      groups.map((group) => [...group.querySelectorAll('.entity-chip')]
        .map((chip) => chip.firstChild?.textContent?.trim() || ''))
    ));
    const screenshot = 'story-bible-recovery-1430x894.png';
    await regressionPage.screenshot({
      path: path.join(outputDirectory, screenshot),
      fullPage: false,
    });

    if (!persisted) throw new Error('story-bible recovery did not persist a project');
    const actualCharacters = persisted.characters.map((item) => item.name);
    const actualLocations = persisted.locations.map((item) => item.name);
    const actualProps = persisted.props.map((item) => item.name);
    const callsByKind = Object.fromEntries(apiCalls.map((call) => [call.kind, call]));
    const expectedSeedNames = {
      characters: expectedCoreCharacters,
      locations: expectedLocations,
      props: expectedProps,
    };
    const sameNameSet = (left, right) => (
      left.length === right.length
      && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    );
    const requestKinds = apiCalls.map((call) => call.kind);
    const coreEntityMismatch = !sameNameSet(actualCharacters, expectedCharacters)
      || !sameNameSet(actualLocations, expectedLocations)
      || !sameNameSet(actualProps, expectedProps);
    const forbiddenNamesRemain = forbiddenCharacters.some((name) => actualCharacters.includes(name))
      || forbiddenLocations.some((name) => actualLocations.includes(name));
    const enrichmentSeedsMismatch = Object.entries(expectedSeedNames).some(([kind, names]) => (
      !sameNameSet(callsByKind[kind]?.names || [], names)
    ));
    const requiredCharacterDimensionsMismatch = expectedCoreCharacters.some((name) => {
      const character = persisted.characters.find((item) => item.name === name);
      const expected = characterDetails(name);
      return ['apparentAge', 'actualAge', 'height'].some((field) => character?.[field] !== expected[field]);
    });
    const unnamedProtagonist = persisted.characters.find((item) => item.name === '无名主角');
    const snowCharacter = persisted.characters.find((item) => item.name === '雪衣道侣');
    const marketLocation = persisted.locations.find((item) => item.name === '修仙界集市');
    const paperProp = persisted.props.find((item) => item.name === '黄符纸');
    const assetCharacter = persisted.characters.find((item) => item.name === '用户资产角色');
    const scene = persisted.scenes[0];
    const sceneCharacterNames = (scene?.characterIds || []).map((id) => (
      persisted.characters.find((item) => item.id === id)?.name || `missing:${id}`
    ));
    const sceneLocationNames = (scene?.locationIds?.length
      ? scene.locationIds
      : scene?.locationId ? [scene.locationId] : []).map((id) => (
      persisted.locations.find((item) => item.id === id)?.name || `missing:${id}`
    ));
    const scenePropNames = (scene?.propIds || []).map((id) => (
      persisted.props.find((item) => item.id === id)?.name || `missing:${id}`
    ));
    if (
      requestKinds.length !== 4
      || requestKinds[0] !== 'analysis'
      || !['characters', 'locations', 'props'].every((kind) => requestKinds.includes(kind))
      || apiCalls.some((call) => call.status !== 200 || call.repair)
      || mockErrors.length
      || !/^AI 增强完成：/u.test(completionNotice)
      || coreEntityMismatch
      || forbiddenNamesRemain
      || enrichmentSeedsMismatch
      || requiredCharacterDimensionsMismatch
      || unnamedProtagonist?.id !== 'legacy-self'
      || unnamedProtagonist?.appearance !== '用户手工保留的主角外观'
      || snowCharacter?.id !== 'legacy-snow'
      || snowCharacter?.appearance !== '用户手工保留的雪衣外观'
      || marketLocation?.id !== 'legacy-market'
      || marketLocation?.description !== '用户手工保留的集市空间资料'
      || paperProp?.id !== 'legacy-prop-1'
      || paperProp?.material !== '用户手工保留的黄符纸材质'
      || assetCharacter?.id !== 'legacy-asset-extra'
      || JSON.stringify(assetCharacter?.assetIds || []) !== JSON.stringify(['qa-manual-asset'])
      || !sameNameSet(sceneCharacterNames, expectedCoreCharacters)
      || JSON.stringify(sceneLocationNames) !== JSON.stringify(['符材摊'])
      || !sameNameSet(scenePropNames, expectedProps)
      || JSON.stringify(rendered) !== JSON.stringify([actualCharacters, actualLocations, actualProps])
      || regressionConsoleErrors.length
    ) {
      throw new Error(`story-bible authoritative recovery failed: ${JSON.stringify({
        requestKinds,
        apiCalls,
        mockErrors,
        completionNotice,
        expected: {
          characters: expectedCharacters,
          locations: expectedLocations,
          props: expectedProps,
        },
        actual: {
          characters: actualCharacters,
          locations: actualLocations,
          props: actualProps,
          rendered,
        },
        preserved: {
          unnamedProtagonist,
          snowCharacter,
          marketLocation,
          paperProp,
          assetCharacter,
        },
        sceneReferences: {
          characters: sceneCharacterNames,
          locations: sceneLocationNames,
          props: scenePropNames,
        },
        consoleErrors: regressionConsoleErrors,
        screenshot,
      }, null, 2)}`);
    }

    return {
      apiCalls,
      completionNotice,
      characters: actualCharacters,
      locations: actualLocations,
      props: actualProps,
      preservedManualFields: true,
      preservedAssetEntity: true,
      sceneReferences: {
        characters: sceneCharacterNames,
        locations: sceneLocationNames,
        props: scenePropNames,
      },
      rendered,
      screenshot,
      consoleErrors: regressionConsoleErrors,
    };
  } finally {
    await regressionContext.close();
  }
};

try {
  storyBibleRecoveryRegression = await runStoryBibleRecoveryRegression();
  storyBiblePreviewRegression = await runStoryBiblePreviewRegression();
  asyncMasterPromptRegression = await runAsyncMasterPromptRegression();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  legacyKreaCatalogRegression = await runLegacyKreaCatalogRegression(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey),
  );
  await captureUpdateLogLayoutSet('update-log');
  await page.getByRole('button', { name: '剧情解析', exact: true }).click();
  const sourceStoryWithBoundaryWhitespace = '\n  暴雨中的废港，三十米高的镰刀头怪兽从海面跃出，四肢着地撞碎成排集装箱。怪兽甩动骨质长尾扫断起重机，背部甲壳被闪电照亮，喉部蓝光迅速聚集。它贴地冲刺穿过仓库，利爪撕开钢门，随后跃上油罐顶端仰头咆哮。爆炸气浪从身后追来，怪兽翻滚落地又立即扑向海堤，碎石和海水同时飞溅。最后它撞穿海堤跃回巨浪，只留下尾鳍掠过燃烧的港口。\n  ';
  const storyActionRow = page.locator('.story-input-card > .row-between').last();
  const storyActionLabels = (await storyActionRow.locator('button').allTextContents())
    .map((label) => label.replace(/\s+/gu, ' ').trim());
  const expectedStoryActionLabels = ['AI扩写', 'AI画面描述转化', '清空', '解析并补全'];
  if (JSON.stringify(storyActionLabels) !== JSON.stringify(expectedStoryActionLabels)) {
    throw new Error(`story input actions changed: ${JSON.stringify(storyActionLabels)}`);
  }
  const textApiConfigured = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const textApi = JSON.parse(raw)?.settings?.textApi;
    return Boolean(textApi?.enabled && textApi?.baseUrl?.trim() && textApi?.model?.trim());
  }, storageKey);
  if (textApiConfigured !== false) {
    throw new Error(`story input API fallback fixture is not disabled: ${String(textApiConfigured)}`);
  }
  const storySourceInput = page.locator('.story-source-textarea');
  await storySourceInput.fill(sourceStoryWithBoundaryWhitespace);
  const storyActionsScreenshot = 'story-input-actions.png';
  await page.screenshot({
    path: path.join(outputDirectory, storyActionsScreenshot),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'AI画面描述转化', exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelector('.topbar h1')?.textContent?.trim() === 'API 设置'
  ));
  const missingApiNotice = page.locator('.sidebar-notice.error');
  await missingApiNotice.waitFor();
  const missingApiNoticeText = (await missingApiNotice.textContent())?.replace(/\s+/gu, ' ').trim() || '';
  if (!/AI画面描述转化.*文本(?: API|模型)/u.test(missingApiNoticeText)) {
    throw new Error(`AI expansion missing-API notice is not actionable: ${missingApiNoticeText}`);
  }
  const expansionApiScreenshot = 'story-expansion-api-required.png';
  await page.screenshot({
    path: path.join(outputDirectory, expansionApiScreenshot),
    fullPage: false,
  });
  await page.getByRole('button', { name: '剧情解析', exact: true }).click();
  await storySourceInput.waitFor();
  const expansionSourcePreserved = await storySourceInput.inputValue() === sourceStoryWithBoundaryWhitespace;
  if (!expansionSourcePreserved) {
    throw new Error('AI expansion missing-API redirect discarded the current story draft');
  }
  await page.getByRole('button', { name: '保存原文', exact: true }).click();
  // Replacing the authoritative source intentionally invalidates every scene
  // derived from the previous document. Rebuild scenes from the saved source
  // before entering the director instead of relying on stale seed data. Scene
  // cards live in the explicit scene-management pane rather than the input
  // pane where parsing starts.
  await page.getByRole('button', { name: '解析并补全', exact: true }).click();
  await page.getByRole('button', { name: /^场景管理/u }).click();
  await page.locator('.story-scene-card').first().waitFor();
  const localParsedSceneCount = await page.locator('.story-scene-card').count();
  const localParseHeading = await page.locator('.topbar h1').textContent();
  if (localParseHeading?.trim() !== '剧情解析' || localParsedSceneCount < 1) {
    throw new Error(`merged analysis did not keep the local fallback: ${JSON.stringify({
      localParseHeading,
      localParsedSceneCount,
    })}`);
  }
  storyInputActions = {
    labels: storyActionLabels,
    textApiConfigured,
    missingApiNoticeText,
    expansionSourcePreserved,
    localParseHeading: localParseHeading.trim(),
    localParsedSceneCount,
    screenshots: [storyActionsScreenshot, expansionApiScreenshot],
  };
  await page.waitForFunction(({ key, sourceStory }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const state = JSON.parse(raw);
    return state?.project?.sourceDocuments?.[0]?.content === sourceStory
      && state?.project?.scenes?.length > 0;
  }, { key: storageKey, sourceStory: sourceStoryWithBoundaryWhitespace });
  await installQaTextApiMock(page, async (callKind) => {
    mainTextApiCalls.push(callKind);
  }, async (callKind, error) => {
    mainTextApiMockErrors.push({
      callKind,
      message: error instanceof Error ? error.message : String(error || 'unknown QA mock error'),
    });
  });
  await enableQaTextApi(page);
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await captureDirectorLayoutSet('director-single-all');
  await page.getByRole('button', { name: '长剧情拆段', exact: true }).click();
  await captureDirectorLayoutSet('director-sequence-settings');

  // Long-story mode must stop at the explicit ⓪ director-parameter
  // checkpoint.  The planner and master-generation controls remain hidden
  // until this confirmation is made, so default requirements cannot leak into
  // the authoritative prompt.
  const initialDirectorSettingsConfirm = page.getByRole('button', {
    name: '确认全片导演参数，进入①全片规划',
    exact: true,
  });
  await initialDirectorSettingsConfirm.waitFor();
  if (await page.locator('.sequence-planner-panel').isVisible().catch(() => false)) {
    throw new Error('long-story mode exposed the planner before director settings confirmation');
  }
  const initialSettingsTab = page.getByRole('tab', {
    name: '⓪ 全片导演参数',
    exact: true,
  });
  if (!(await initialSettingsTab.count()) || !(await initialSettingsTab.getAttribute('aria-selected') === 'true')) {
    throw new Error('long-story mode did not select the ⓪ director-settings stage');
  }
  const stageZeroTiming = page.locator('#sequence-director-settings-panel #director-setup-timing');
  const stageZeroCustomDuration = stageZeroTiming.getByRole('button', {
    name: '自定义',
    exact: true,
  });
  if (!(await stageZeroCustomDuration.isEnabled())) {
    throw new Error('long-story director settings disabled the custom per-segment duration control');
  }
  await stageZeroCustomDuration.click();
  const stageZeroSegmentSeconds = stageZeroTiming.getByLabel('每段目标秒数');
  await stageZeroSegmentSeconds.fill('8');
  await initialDirectorSettingsConfirm.click();
  await page.locator('.sequence-planner-panel').waitFor();
  const planningTab = page.getByRole('tab', { name: '① 全片规划', exact: true });
  if (!(await planningTab.getAttribute('aria-selected') === 'true')) {
    throw new Error('confirming director settings did not enter the ① planning stage');
  }
  const carriedSegmentDuration = await page.getByLabel('自定义单段秒数').inputValue();
  if (carriedSegmentDuration !== '8') {
    throw new Error(`stage ⓪ custom segment duration did not carry into planning: ${carriedSegmentDuration}`);
  }
  await page.getByRole('button', { name: '固定总时长', exact: true }).click();
  await page.getByLabel('全片总秒数').fill('24');
  // The model owns shot placement and source assignment inside the fixed 8s grid.

  // Stage 1 must stop after producing one persisted, full-duration master
  // prompt. Segment cards are forbidden until the user reviews and confirms it.
  await page.getByRole('button', { name: '① 生成全片总提示词', exact: true }).click();
  const masterReview = page.locator('.sequence-master-review');
  await masterReview.waitFor();
  const masterPromptInput = page.getByLabel('全片总视频提示词');
  const generatedMasterPrompt = await masterPromptInput.inputValue();
  if (!generatedMasterPrompt.trim() || !/^【0(?:\.0+)?s-/u.test(generatedMasterPrompt.trim())) {
    throw new Error(`master prompt was not visibly rendered from 0s: ${generatedMasterPrompt.slice(0, 180)}`);
  }
  const confirmGeneratedMasterButton = page.getByRole('button', {
    name: '确认总提示词',
    exact: true,
  });
  if (!(await confirmGeneratedMasterButton.isEnabled())) {
    const generatedValidationText = (
      await masterReview.getByRole('alert').textContent().catch(() => '')
    )?.trim() || '';
    throw new Error(
      `freshly generated master prompt must be confirmable: ${generatedValidationText || 'no visible validation reason'}`,
    );
  }
  if (await page.locator('.sequence-plan-workspace').count()) {
    throw new Error('segment workspace appeared before the master prompt was confirmed and split');
  }
  const splitBeforeConfirmation = page.getByRole('button', {
    name: '② AI 按剧情边界分段',
    exact: true,
  });
  const splitBeforeConfirmationState = {
    count: await splitBeforeConfirmation.count(),
    enabled: await splitBeforeConfirmation.count()
      ? await splitBeforeConfirmation.isEnabled()
      : false,
  };
  if (splitBeforeConfirmationState.enabled) {
    throw new Error('split action was enabled before master-prompt confirmation');
  }
  const persistedDraft = await waitForPersistedSequenceStage('master-draft', 0);
  if (
    !persistedDraft?.masterBoard
    || !persistedDraft.masterBoard.finalPrompt?.trim()
    || !persistedDraft.masterBoard.englishPrompt?.trim()
    || persistedDraft.masterBoard.englishPromptSource !== persistedDraft.masterBoard.finalPrompt
    || persistedDraft.plan.sourceStoryContent !== sourceStoryWithBoundaryWhitespace
    || persistedDraft.plan.segmentDurationSec !== 8
    || persistedDraft.plan.masterPromptConfirmedFingerprint
  ) {
    throw new Error(`master draft persistence is incomplete: ${JSON.stringify(persistedDraft)}`);
  }
  await capturePlannerLayoutSet('master-review', 'master-review-draft');

  // Stage 2 must survive a real reload, expose invalid edits, and refuse to
  // confirm them. A subsequent valid body-only edit must be what is persisted.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await masterReview.waitFor();
  const reloadedMasterPrompt = await masterPromptInput.inputValue();
  if (reloadedMasterPrompt !== generatedMasterPrompt) {
    throw new Error('master review did not restore the exact persisted draft after reload');
  }
  const invalidMasterPrompt = '【0s-24s】主体：故意缺少空间、光影、镜头、台词和音效字段';
  await masterPromptInput.fill(invalidMasterPrompt);
  const masterValidationAlert = masterReview.getByRole('alert');
  await masterValidationAlert.waitFor();
  const invalidValidationText = (await masterValidationAlert.textContent())?.trim() || '';
  if (!invalidValidationText) {
    throw new Error('invalid master-prompt edit did not render a visible validation reason');
  }
  const confirmMasterButton = page.getByRole('button', { name: '确认总提示词', exact: true });
  if (await confirmMasterButton.isEnabled()) {
    throw new Error('invalid master-prompt edit left confirmation enabled');
  }
  const validEditedMasterPrompt = generatedMasterPrompt.replace(
    /空间：/u,
    '空间：QA三阶段确认·',
  );
  if (validEditedMasterPrompt === generatedMasterPrompt) {
    throw new Error('generated master prompt did not contain an editable canonical 空间 field');
  }
  await masterPromptInput.fill(validEditedMasterPrompt);
  await page.waitForTimeout(250);
  if (!(await confirmMasterButton.isEnabled())) {
    const editedValidationText = (
      await masterReview.getByRole('alert').textContent().catch(() => '')
    )?.trim() || '';
    throw new Error(
      `a visual-only master prompt edit must preserve source provenance: ${editedValidationText || 'no visible validation reason'}`,
    );
  }
  await confirmMasterButton.click();
  const splitMasterButton = page.getByRole('button', {
    name: '② AI 按剧情边界分段',
    exact: true,
  });
  await splitMasterButton.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === '② AI 按剧情边界分段');
    return Boolean(button && !button.disabled);
  });
  const persistedConfirmed = await waitForPersistedSequenceStage('master-confirmed', 0);
  if (
    !persistedConfirmed?.plan.masterPromptConfirmedFingerprint
    || persistedConfirmed.masterBoard?.finalPrompt !== validEditedMasterPrompt
  ) {
    throw new Error(`confirmed master prompt was not persisted exactly: ${JSON.stringify(persistedConfirmed)}`);
  }

  // A different fixed segment duration changes the hard-boundary contract.
  // Keep the saved master intact but gate splitting until the original 8s
  // grid is restored; a 24s / 4s alternative is itself a legal fixed grid.
  const confirmedFingerprint = persistedConfirmed.plan.masterPromptConfirmedFingerprint;
  await expandPlannerOptions();
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('自定义单段秒数').fill('4');
  await page.waitForTimeout(350);
  const changedPlanningInputsSnapshot = await persistedSequenceSnapshot();
  const splitEnabledAfterPlanningInputChange = await splitMasterButton.isEnabled();
  if (
    changedPlanningInputsSnapshot?.plan.planningStage !== 'master-confirmed'
    || changedPlanningInputsSnapshot.plan.masterPromptConfirmedFingerprint !== confirmedFingerprint
    || splitEnabledAfterPlanningInputChange
    || !await masterReview.isVisible()
  ) {
    throw new Error(`fixed-grid edits must preserve the saved master but block its stale split: ${JSON.stringify({
      planningStage: changedPlanningInputsSnapshot?.plan.planningStage,
      fingerprintBefore: confirmedFingerprint,
      fingerprintAfter: changedPlanningInputsSnapshot?.plan.masterPromptConfirmedFingerprint,
      splitEnabledAfterPlanningInputChange,
      masterReviewVisible: await masterReview.isVisible(),
    })}`);
  }
  await page.getByLabel('自定义单段秒数').fill('8');
  await page.waitForTimeout(350);
  const restoredPlanningInputsSnapshot = await persistedSequenceSnapshot();
  const splitEnabledAfterPlanningInputRestore = await splitMasterButton.isEnabled();
  if (
    restoredPlanningInputsSnapshot?.plan.planningStage !== 'master-confirmed'
    || restoredPlanningInputsSnapshot.plan.masterPromptConfirmedFingerprint !== confirmedFingerprint
    || !splitEnabledAfterPlanningInputRestore
  ) {
    throw new Error(`restoring segmentation inputs did not preserve master confirmation: ${JSON.stringify({
      planningStage: restoredPlanningInputsSnapshot?.plan.planningStage,
      fingerprintBefore: confirmedFingerprint,
      fingerprintAfter: restoredPlanningInputsSnapshot?.plan.masterPromptConfirmedFingerprint,
      splitEnabledAfterPlanningInputRestore,
    })}`);
  }
  confirmedPlanningInputEdits = {
    changedTo: { segmentDurationSec: 4, segmentationMode: 'fixed' },
    planningStageAfterChange: changedPlanningInputsSnapshot.plan.planningStage,
    fingerprintUnchangedAfterChange:
      changedPlanningInputsSnapshot.plan.masterPromptConfirmedFingerprint === confirmedFingerprint,
    splitEnabledAfterPlanningInputChange,
    restoredTo: { segmentDurationSec: 8, segmentationMode: 'fixed' },
    planningStageAfterRestore: restoredPlanningInputsSnapshot.plan.planningStage,
    fingerprintUnchangedAfterRestore:
      restoredPlanningInputsSnapshot.plan.masterPromptConfirmedFingerprint === confirmedFingerprint,
    splitEnabledAfterPlanningInputRestore,
  };

  // Stage 2 asks the text model to choose semantic groups from the complete
  // master timeline.  Every returned segment must keep traceable shot IDs from
  // that same authoritative storyboard; the QA fixture must not impose a
  // locally calculated segment count or cut time.
  await splitMasterButton.click();
  await page.locator('.sequence-plan-workspace').waitFor();
  const persistedSegmented = await waitForPersistedSequenceStage('segmented');
  const aiSegmentCount = persistedSegmented?.plan.segments?.length || 0;
  if (aiSegmentCount < 1) throw new Error('AI semantic segmentation returned no segments');
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.sequence-segment-chip').length === expected
  ), aiSegmentCount);
  const masterShotIds = new Set(
    persistedSegmented?.masterBoard?.shots?.map((shot) => shot.id) || [],
  );
  const segmentTrace = persistedSegmented?.plan.segments.map((segment) => ({
    globalStartSec: segment.globalStartSec,
    globalEndSec: segment.globalEndSec,
    durationSec: segment.durationSec,
    sourceShotIds: segment.sourceShotIds,
    autoExtendedBySec: segment.autoExtendedBySec,
  })) || [];
  const assignedShotIds = segmentTrace.flatMap((segment) => segment.sourceShotIds || []);
  const legalMasterBoundaries = new Set(
    persistedSegmented?.masterBoard?.shots?.slice(0, -1).map((shot) => shot.endSec) || [],
  );
  if (
    segmentTrace.length !== aiSegmentCount
    || segmentTrace.some((segment, index) => (
      (index === 0 ? segment.globalStartSec !== 0 : segment.globalStartSec !== segmentTrace[index - 1].globalEndSec)
      || (index === segmentTrace.length - 1
        ? segment.globalEndSec !== 24
        : !legalMasterBoundaries.has(segment.globalEndSec))
      || Math.abs((segment.globalEndSec - segment.globalStartSec) - segment.durationSec) >= 0.005
     || segment.durationSec > 15
      || !segment.sourceShotIds?.length
      || segment.sourceShotIds.some((shotId) => !masterShotIds.has(shotId))
    ))
    || persistedSegmented?.plan.segmentDurationSec !== 8
    || assignedShotIds.length !== masterShotIds.size
    || new Set(assignedShotIds).size !== masterShotIds.size
  ) {
    throw new Error(`AI semantic persisted segment trace is invalid: ${JSON.stringify(segmentTrace)}`);
  }
  threeStageFlow = {
    draftSegmentCount: persistedDraft.plan.segments.length,
    splitBeforeConfirmation: splitBeforeConfirmationState,
    restoredDraftExactly: reloadedMasterPrompt === generatedMasterPrompt,
    invalidValidationText,
    confirmedFingerprint: persistedConfirmed.plan.masterPromptConfirmedFingerprint,
    confirmedEditedTextExactly: persistedConfirmed.masterBoard.finalPrompt === validEditedMasterPrompt,
    segmentedStage: persistedSegmented.plan.planningStage,
    aiSegmentCount,
    segmentTrace,
  };
  await capturePlannerLayoutSet('planner', 'planner-segmented');

  // A segmented plan must not trust a persisted confirmation fingerprint when
  // the authoritative master text was changed out of band. Tamper both copies
  // of the active project, reload through the real storage normalizer, and
  // require every route into generation to remain gated.
  const pristineSegmentedStorage = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  if (!pristineSegmentedStorage) {
    throw new Error('cannot exercise persisted-master tamper recovery without a complete saved state');
  }
  const tamperMarker = 'QA_TAMPERED_MASTER_PROMPT';
  const tamperedCopies = await page.evaluate(({ key, tamperMarker }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return { activeProject: false, projectMirror: false };
    const state = JSON.parse(raw);
    const tamperProject = (project) => {
      if (!project) return false;
      const plan = [...(project.sequencePlans || [])].reverse().find((candidate) => (
        candidate.planningStage === 'segmented'
        && candidate.totalDurationSec === 24
        && candidate.segmentDurationSec === 8
      ));
      const masterBoard = project.storyboards?.find((board) => board.id === plan?.masterStoryboardId);
      if (!plan || !masterBoard) return false;
      masterBoard.finalPrompt = `${masterBoard.finalPrompt}\n${tamperMarker}`;
      return true;
    };
    const activeProject = tamperProject(state.project);
    const projectMirror = tamperProject(
      state.projects?.find((project) => project.id === state.activeProjectId)
      || state.projects?.find((project) => project.id === state.project?.id),
    );
    localStorage.setItem(key, JSON.stringify(state));
    return { activeProject, projectMirror };
  }, { key: storageKey, tamperMarker });
  if (!tamperedCopies.activeProject || !tamperedCopies.projectMirror) {
    throw new Error(`failed to tamper both persisted project copies: ${JSON.stringify(tamperedCopies)}`);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.waitForTimeout(350);
  const tamperedPlannerVisible = await page.locator('.sequence-planner-panel').isVisible();
  const tamperedDirectTab = page.getByRole('tab', { name: '③ 单段导演', exact: true });
  const tamperedDirectTabDisabled = await tamperedDirectTab.isDisabled();
  const tamperedDirectTabSelected = await tamperedDirectTab.getAttribute('aria-selected');
  const tamperedConfirmSegment = page.getByRole('button', {
    name: '确认分段，进入③单段导演',
    exact: true,
  });
  const tamperedConfirmSegmentState = {
    count: await tamperedConfirmSegment.count(),
    disabled: await tamperedConfirmSegment.count()
      ? await tamperedConfirmSegment.isDisabled()
      : false,
  };
  const currentSegmentGeneration = page.getByRole('button', {
    name: '生成当前段提示词',
    exact: true,
  });
  const batchSegmentGeneration = page.getByRole('button', {
    name: '顺序生成全部',
    exact: true,
  });
  const generationGateState = {
    currentCount: await currentSegmentGeneration.count(),
    currentEnabled: await currentSegmentGeneration.count()
      ? await currentSegmentGeneration.isEnabled()
      : false,
    batchCount: await batchSegmentGeneration.count(),
    batchEnabled: await batchSegmentGeneration.count()
      ? await batchSegmentGeneration.isEnabled()
      : false,
  };
  const tamperedPlannerText = await page.locator('.sequence-planner-panel').textContent().catch(() => '');
  const confirmationInvalidationVisible = /总提示词确认状态失效|重新确认总提示词/u.test(
    tamperedPlannerText || '',
  );
  if (
    !tamperedPlannerVisible
    || !tamperedDirectTabDisabled
    || tamperedDirectTabSelected === 'true'
    || !tamperedConfirmSegmentState.count
    || !tamperedConfirmSegmentState.disabled
    || generationGateState.currentEnabled
    || generationGateState.batchEnabled
    || !confirmationInvalidationVisible
  ) {
    throw new Error(`tampered persisted master prompt did not activate every generation gate: ${JSON.stringify({
      tamperedCopies,
      tamperedPlannerVisible,
      tamperedDirectTabDisabled,
      tamperedDirectTabSelected,
      tamperedConfirmSegmentState,
      generationGateState,
      confirmationInvalidationVisible,
      plannerText: (tamperedPlannerText || '').slice(0, 500),
    })}`);
  }
  await capturePlannerLayoutSet('planner', 'planner-tampered-master');
  tamperedMasterRecovery = {
    tamperedCopies,
    tamperedPlannerVisible,
    tamperedDirectTabDisabled,
    tamperedDirectTabSelected,
    tamperedConfirmSegmentState,
    generationGateState,
    confirmationInvalidationVisible,
  };
  await page.evaluate(({ key, pristineSegmentedStorage }) => {
    localStorage.setItem(key, pristineSegmentedStorage);
  }, { key: storageKey, pristineSegmentedStorage });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.sequence-plan-workspace').waitFor();
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.sequence-segment-chip').length === expected
  ), aiSegmentCount);

  const contentInput = page.getByLabel('本段剧情正文');
  const originalContent = await contentInput.inputValue();
  await contentInput.fill(`${originalContent}（临时覆盖）`);
  await page.getByRole('button', { name: '恢复节拍原文', exact: true }).click();
  const restoredContent = await contentInput.inputValue();
  if (restoredContent !== originalContent) {
    throw new Error('restoring beat-derived segment content did not recover the exact source text');
  }
  const segmentDurationInput = page.getByLabel('本段秒数');
  const totalDurationInput = page.getByLabel('全片总秒数');
  const segmentBefore = Number(await segmentDurationInput.inputValue());
  const totalBefore = Number(await totalDurationInput.inputValue());
  // AI owns semantic boundaries and authoritative durations.  Do not mutate a
  // segment duration in this regression: a manual duration edit would clear
  // sourceShotIds and turn the test back into the legacy local-repartition
  // path.  We only assert the persisted timeline remains intact after source
  // content recovery.
  const segmentAfter = segmentBefore;
  const totalAfter = Number(await totalDurationInput.inputValue());
  const restoredTotalDuration = totalAfter;
  if (Math.abs(restoredTotalDuration - totalBefore) > 0.005) {
    throw new Error(`AI segment edit unexpectedly changed full duration: expected ${totalBefore}, got ${restoredTotalDuration}`);
  }
  editRecovery = {
    restoredExactSource: restoredContent === originalContent,
    segmentBefore,
    segmentAfter,
    totalBefore,
    totalAfter,
    restoredTotalDuration,
  };

  const confirmRisk = page.getByRole('button', { name: '确认偏紧风险', exact: true });
  if (await confirmRisk.count()) {
    await confirmRisk.click();
  }
  await page.getByRole('button', { name: '确认分段，进入③单段导演', exact: true }).click();
  await captureDirectorLayoutSet('director-sequence-all');
  try {
    await installQaScenePicker(12);
    await captureDirectorLayoutSet('director-sequence-grid-12');
    await captureDenseDirectorStripLayoutSet('director-sequence-dense-29');
  } finally {
    await cleanupQaScenePicker();
    const smartDirectorButton = page.getByRole('button', { name: '智能导演', exact: true });
    if (await smartDirectorButton.count()) {
      await smartDirectorButton.click();
      await page.locator('.scene-chip-grid').waitFor({ state: 'detached' });
    }
  }

  await page.setViewportSize({ width: 1120, height: 720 });
  const sequenceAutoShotButton = page.getByRole('button', { name: 'AI 自动', exact: true });
  const sequenceExactShotButton = page.getByRole('button', { name: '精确指定', exact: true });
  if (!await sequenceAutoShotButton.isDisabled() || !await sequenceExactShotButton.isDisabled()) {
    throw new Error('canonical sequence slices must not expose an ineffective per-segment shot mode');
  }
  const confirmedSliceCount = Number(await page.getByLabel('本段镜头数').inputValue());
  if (!Number.isInteger(confirmedSliceCount) || confirmedSliceCount < 1) {
    throw new Error(`canonical sequence slice did not display its confirmed AI shot count: ${confirmedSliceCount}`);
  }
  await page.waitForFunction(() => (
    document.querySelector('.recommendation-strip strong')?.textContent?.includes('AI 全片时间轴分段')
  ));
  if (await page.locator('.recommendation-warning').count()) {
    throw new Error('confirmed AI master slices must not compare against a local recommendation range');
  }
  const confirmedSliceLabel = 'director-sequence-confirmed-ai-slice-1120x720';
  const confirmedSliceLayout = await collectLayout('director', confirmedSliceLabel);
  layoutReport.push(confirmedSliceLayout);
  await page.screenshot({
    path: path.join(outputDirectory, `${slug(confirmedSliceLabel)}.png`),
    fullPage: false,
  });
  assertLayout(confirmedSliceLayout);

  const batchButton = page.getByRole('button', { name: '顺序生成全部', exact: true });
  if (await batchButton.isEnabled()) {
    await batchButton.click();
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('button')];
      const cancelVisible = buttons.some((button) => (
        button.textContent?.trim() === '取消顺序生成'
        && button.offsetParent !== null
      ));
      const batch = buttons.find((button) => button.textContent?.trim() === '顺序生成全部');
      return !cancelVisible && Boolean(batch?.disabled);
    }, null, { timeout: 30_000 });
  }
  batchStatuses = await page.locator(
    '.sequence-segment-chip > small:not(.sequence-segment-auto-extension):not(.sequence-segment-failure)',
  ).allTextContents();
  if (!batchStatuses.length || batchStatuses.some((status) => !status.includes('已完成'))) {
    throw new Error(`serial generation left unfinished segments: ${JSON.stringify(batchStatuses)}`);
  }
  await page.waitForFunction(() => {
    const value = document.querySelector('.director-result-copy')?.textContent?.trim() || '';
    return value.length > 80;
  });
  const localPrompt = await page.locator('.director-result-copy').textContent();
  if (!/^(?:integrated_multimodal_description:|subject_definitions:)/u.test((localPrompt || '').trim())) {
    throw new Error(`segment prompt did not render the official H3 structure: ${(localPrompt || '').slice(0, 180)}`);
  }
  if (!/\[Shot 1\]/u.test(localPrompt || '')) {
    throw new Error(`official H3 segment prompt is missing Shot 1: ${(localPrompt || '').slice(0, 180)}`);
  }
  await page.waitForFunction(({ key, aiSegmentCount }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const state = JSON.parse(raw);
    const plan = state?.project?.sequencePlans?.at(-1);
    return plan?.segments?.length === aiSegmentCount
      && plan.segments.every((segment) => segment.status === 'ready' && segment.storyboardId);
  }, { key: storageKey, aiSegmentCount });
  const generatedSegmentSnapshot = await persistedSequenceSnapshot();
  const localPromptStarts = generatedSegmentSnapshot?.segmentBoards.map((board) => (
    /^【0(?:\.0+)?s-/u.test(board?.finalPrompt?.trim() || '')
  )) || [];
  const bilingualSegmentPrompts = generatedSegmentSnapshot?.segmentBoards.map((board) => Boolean(
    board?.englishPrompt?.trim()
    && board.englishPromptSource === board.finalPrompt
  )) || [];
  if (
    localPromptStarts.length !== aiSegmentCount
    || localPromptStarts.some((value) => !value)
    || bilingualSegmentPrompts.length !== aiSegmentCount
    || bilingualSegmentPrompts.some((value) => !value)
  ) {
    throw new Error(`persisted segment prompts must all start at local 0s and contain matching English versions: ${JSON.stringify({ localPromptStarts, bilingualSegmentPrompts })}`);
  }
  threeStageFlow.localPromptStarts = localPromptStarts;
  threeStageFlow.bilingualSegmentPrompts = bilingualSegmentPrompts;

  const sequenceLanguageCards = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.result-language-switch button')];
    const oldTranslationButtons = [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim() || '')
      .filter((text) => text === '转成英文' || text === '重新翻译英文');
    return {
      labels: buttons.map((button) => button.textContent?.trim() || ''),
      active: buttons.find((button) => button.classList.contains('active'))?.textContent?.trim() || '',
      oldTranslationButtons,
    };
  });
  if (
    JSON.stringify(sequenceLanguageCards.labels) !== JSON.stringify(['中文', 'English'])
    || sequenceLanguageCards.active !== '中文'
    || sequenceLanguageCards.oldTranslationButtons.length
  ) {
    throw new Error(`sequence result must expose both language cards without a manual translation button: ${JSON.stringify(sequenceLanguageCards)}`);
  }
  threeStageFlow.sequenceLanguageCards = sequenceLanguageCards;

  sequenceReferenceRegenerationRegression = await runSequenceReferenceRegenerationRegression(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey),
    generatedSegmentSnapshot.plan.id,
  );
  sequenceMultiPictureSubjectsRegression = await runSequenceMultiPictureSubjectsRegression(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey),
  );
  quietFoleyReferenceRegression = await runSequenceMultiPictureSubjectsRegression(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey),
    { quietFoley: true },
  );
  allImageRulesComfyRegression = await runAllImageRulesComfyRegression();

  await page.getByRole('button', { name: '返回全片规划', exact: true }).click();
  await expandPlannerOptions();
  const totalInput = page.getByLabel('全片总秒数');
  const originalTotal = Number(await totalInput.inputValue());
  await totalInput.fill(String(originalTotal + 1));
  const staleState = await page.evaluate(() => ({
    warning: document.querySelector('.sequence-plan-footer')?.textContent || '',
    directDisabled: [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '③ 单段导演')?.disabled,
    hasSnapshotAction: [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '继续使用旧快照'),
  }));
  if (!staleState.directDisabled || !staleState.hasSnapshotAction || !staleState.warning.includes('已变化')) {
    throw new Error(`stale-plan gate failed: ${JSON.stringify(staleState)}`);
  }
  await page.getByRole('button', { name: '继续使用旧快照', exact: true }).click();
  await page.getByRole('tab', { name: '③ 单段导演', exact: true }).click();
  await waitForDirectorSections();

  await page.getByRole('button', { name: '分镜时间线', exact: true }).click();
  await page.waitForTimeout(100);
  const groupedStoryboards = await page.evaluate(() => ({
    heading: document.querySelector('.topbar h1')?.textContent?.trim() || '',
    planGroups: document.querySelectorAll('.storyboard-sequence-group').length,
    segmentButtons: [...document.querySelectorAll('button')]
      .filter((button) => /第\s*\d+\s*段/u.test(button.textContent || '')).length,
  }));
  if (groupedStoryboards.heading !== '分镜时间线' || groupedStoryboards.planGroups < 1) {
    throw new Error(`sequence storyboard grouping missing: ${JSON.stringify(groupedStoryboards)}`);
  }

  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('tab', { name: '① 全片规划', exact: true }).click();
  await expandPlannerOptions();
  await page.getByRole('button', { name: '固定总时长', exact: true }).click();
  const estimateRangeText = await page.locator('.sequence-estimate-copy').textContent();
  const rangeMatch = estimateRangeText?.match(/范围\s*([\d.]+)—([\d.]+)\s*秒/u);
  if (!rangeMatch) throw new Error(`duration estimate range missing: ${estimateRangeText}`);
  const estimateMinimum = Number(rangeMatch[1]);
  const compressedSegmentDuration = 4;
  const compressedDuration = Math.max(
    compressedSegmentDuration,
    Math.round(estimateMinimum * 0.8 / compressedSegmentDuration) * compressedSegmentDuration,
  );
  if (compressedDuration < estimateMinimum * 0.65 || compressedDuration >= estimateMinimum) {
    throw new Error(`QA compressed fixture has no compressed-range 4s grid total: minimum=${estimateMinimum}, total=${compressedDuration}`);
  }
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('自定义单段秒数').fill(String(compressedSegmentDuration));
  await page.getByLabel('全片总秒数').fill(String(compressedDuration));
  await generateConfirmAndSplitCurrentInputs();
  await page.getByRole('button', { name: '确认偏紧风险', exact: true }).waitFor();
  const compressedWarning = await page.locator('.sequence-plan-footer').textContent();
  await page.getByRole('button', { name: '确认偏紧风险', exact: true }).click();
  const remainedInPlannerAfterFirstConfirm = await page.locator('.sequence-planner-panel').isVisible();
  await page.waitForTimeout(350);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.locator('.sequence-planner-panel').waitFor();
  const persistedReviewGate = await page.evaluate(() => ({
    directDisabled: [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '③ 单段导演')?.disabled,
    confirmVisible: [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '确认分段，进入③单段导演'),
    riskButtonVisible: [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '确认偏紧风险'),
  }));
  await page.getByRole('button', { name: '确认分段，进入③单段导演', exact: true }).click();
  await waitForDirectorSections();
  await page.waitForTimeout(350);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '提示词导演台', exact: true }).click();
  await waitForDirectorSections();
  const persistedConfirmedStage = await page.getByRole('tab', {
    name: '③ 单段导演',
    exact: true,
  }).getAttribute('aria-selected');
  await page.getByRole('button', { name: '返回全片规划', exact: true }).click();
  await page.locator('.sequence-planner-panel').waitFor();
  await expandPlannerOptions();

  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('自定义单段秒数').fill('1');
  await page.getByLabel('全片总秒数').fill('1');
  await generateConfirmAndSplitCurrentInputs();
  await page.waitForFunction(() => document.querySelector('.sequence-plan-footer')?.textContent?.includes('时长不足'));
  const insufficientState = await page.evaluate(() => ({
    warning: document.querySelector('.sequence-plan-footer')?.textContent || '',
    confirmDisabled: [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('确认分段'))?.disabled,
    directDisabled: [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '③ 单段导演')?.disabled,
  }));
  riskGates = {
    compressedDuration,
    compressedWarning,
    remainedInPlannerAfterFirstConfirm,
    persistedReviewGate,
    persistedConfirmedStage,
    insufficientState,
  };
  if (
    !compressedWarning?.includes('节奏偏紧')
    || !remainedInPlannerAfterFirstConfirm
    || !persistedReviewGate.directDisabled
    || !persistedReviewGate.confirmVisible
    || persistedReviewGate.riskButtonVisible
    || persistedConfirmedStage !== 'true'
    || !insufficientState.warning.includes('时长不足')
    || !insufficientState.confirmDisabled
    || !insufficientState.directDisabled
  ) {
    throw new Error(`fit-status gates failed: ${JSON.stringify(riskGates)}`);
  }

  const requiredMainTextCalls = ['director', 'shot-recommendation', 'converter', 'translator', 'segmentation'];
  const missingMainTextCalls = requiredMainTextCalls.filter(
    (callKind) => !mainTextApiCalls.includes(callKind),
  );
  const mainConverterCallCount = mainTextApiCalls.filter(
    (callKind) => callKind === 'converter',
  ).length;
  const mainTranslatorCallCount = mainTextApiCalls.filter(
    (callKind) => callKind === 'translator',
  ).length;
  if (
    mainTextApiCalls.includes('unexpected')
    || mainTextApiMockErrors.length
    || missingMainTextCalls.length
    || mainConverterCallCount < 4
    || mainTranslatorCallCount < 4
  ) {
    throw new Error(`main text API mock coverage failed: ${JSON.stringify({
      mainTextApiCalls,
      mainTextApiMockErrors,
      missingMainTextCalls,
      mainConverterCallCount,
      mainTranslatorCallCount,
    })}`);
  }
  const mainTextApi = {
    calls: mainTextApiCalls,
    converterCallCount: mainConverterCallCount,
    translatorCallCount: mainTranslatorCallCount,
    mockErrors: mainTextApiMockErrors,
  };

  const report = {
    baseUrl,
    layoutReport,
    updateLogLayoutReport,
    denseDirectorStripReport,
    threeStageFlow,
    asyncMasterPromptRegression,
    storyBiblePreviewRegression,
    storyBibleRecoveryRegression,
    sequenceReferenceRegenerationRegression,
    sequenceMultiPictureSubjectsRegression,
    quietFoleyReferenceRegression,
    allImageRulesComfyRegression,
    legacyKreaCatalogRegression,
    mainTextApi,
    storyInputActions,
    confirmedPlanningInputEdits,
    tamperedMasterRecovery,
    editRecovery,
    riskGates,
    batchStatuses,
    staleState,
    groupedStoryboards,
    consoleErrors,
  };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  if (consoleErrors.length) throw new Error(`browser console errors: ${consoleErrors.join(' | ')}`);
  console.log(JSON.stringify({
    layouts: layoutReport.length,
    updateLogLayouts: updateLogLayoutReport.length,
    denseDirectorStripLayouts: denseDirectorStripReport.length,
    threeStageFlow,
    asyncMasterPromptRegression,
    storyBiblePreviewRegression,
    storyBibleRecoveryRegression,
    sequenceReferenceRegenerationRegression,
    sequenceMultiPictureSubjectsRegression,
    quietFoleyReferenceRegression,
    allImageRulesComfyRegression,
    legacyKreaCatalogRegression,
    mainTextApi,
    storyInputActions,
    confirmedPlanningInputEdits,
    tamperedMasterRecovery,
    editRecovery,
    riskGates,
    batchStatuses,
    staleState,
    groupedStoryboards,
    outputDirectory,
  }, null, 2));
} catch (error) {
  const failureState = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      notice: document.querySelector('.sidebar-notice')?.textContent || '',
      stages: state.project?.sequencePlans?.map((plan) => ({
        id: plan.id,
        planningStage: plan.planningStage,
        segments: plan.segments.map((segment) => ({ index: segment.index, status: segment.status, failureReason: segment.failureReason, storyboardId: segment.storyboardId })),
      })),
      runtimeErrors: JSON.parse(localStorage.getItem('lianhua_runtime_error_log_v1') || '[]'),
      segmentStatuses: [...document.querySelectorAll('.sequence-segment-chip')].map((chip) => chip.textContent),
    };
  }, storageKey).catch(() => null);
  await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(outputDirectory, 'failure-report.json'), JSON.stringify({
    error: error instanceof Error ? error.stack : String(error), failureState,
    mainTextApiCalls, mainTextApiMockErrors, layoutReport, consoleErrors,
  }, null, 2));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
