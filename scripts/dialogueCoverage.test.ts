import assert from 'node:assert/strict';
import { missingCanonicalDialogues, missingStoryDialogues, normalizeCanonicalDialogueQuotes } from '../src/dialogueCoverage';
import { assertRelativeSoundCueTimes, canonicalDialogueField, normalizeAbsoluteSoundCueTimes, parseMasterTimelinePrompt } from '../src/masterTimeline';

const help = '我需要您的帮助。';
const reassurance = '不必惊慌，我已经向你的方向派出了增援，他们伤不到你。';
const source = `西娅说：“${help}”母巢回答：“${reassurance}”`;
const shot = (dialogue: string, index = 0, visual = '') => `【${index * 5}s-${(index + 1) * 5}s】 主体：@西娅（紧张）[朝向：前方] 正在 [停下→握住通讯器]（推进）；空间：前景-通讯器 中景-西娅 背景-走廊${visual}；光影：自然光；镜头：中景固定；台词：${dialogue}；音效：环境层-[无] 动作层-[无] 情绪层-[无配乐]`;
const quoted = (speaker: string, text: string) => `第1s @${speaker}：“${text}”`;
const prompt = (...fields: string[]) => fields.map((field, index) => shot(field, index)).join('\n');
const complete = prompt(quoted('西娅', help), quoted('母巢', reassurance));

const firstCommand = '我们的任务是帮他们一把，不过不是去帮他们解围，而是去彻底消灭那些恶心的玩意儿！';
const secondCommand = '它们很快就会为自己的愚蠢和狂妄，付出惨重的代价！';
const commandFields = `第1s @边缘划水：“${firstCommand}”第6s @边缘划水：“${secondCommand}”第11s @边缘划水：“前进！！”`;
const commandPrompt = shot(commandFields).replace('0s-5s', '0s-15s');
assert.equal(normalizeCanonicalDialogueQuotes(commandPrompt), commandPrompt, 'adjacent quoted cues must not wrap the next timestamp into speech');
const legacyCommandFields = `第1s @边缘划水：「“${firstCommand}”第6s」 @边缘划水：「“${secondCommand}”第11s」 @边缘划水：“前进！！”`;
const legacyCommandPrompt = shot(legacyCommandFields).replace('0s-5s', '0s-15s');
assert.equal(normalizeCanonicalDialogueQuotes(legacyCommandPrompt), commandPrompt, 'recover only the known extra-wrapper plus next-speaker-time defect');
assert.deepEqual(missingCanonicalDialogues(legacyCommandPrompt, commandPrompt), [], 'old erroneous time wrappers must not become required dialogue words');
assert.deepEqual(missingCanonicalDialogues(legacyCommandPrompt, commandPrompt.replace(firstCommand, '我们的任务是帮他们一把！')), [firstCommand], 'actual omitted original wording stays protected after compatibility repair');
assert.equal(normalizeCanonicalDialogueQuotes(commandPrompt), normalizeCanonicalDialogueQuotes(normalizeCanonicalDialogueQuotes(commandPrompt)), 'normalization is idempotent');
const literalNested = shot('第1s @西娅：「她说“第6s开始！”」 第3s @母巢：“明白。”');
assert.equal(normalizeCanonicalDialogueQuotes(literalNested), literalNested, 'real nested quotations and spoken timestamp text must remain unchanged');
const isolatedTimeQuote = shot('第1s @西娅：「“开始”第6s」');
assert.equal(normalizeCanonicalDialogueQuotes(isolatedTimeQuote), isolatedTimeQuote, 'without a following speaker the timestamp-like literal is not moved');

assert.deepEqual(missingStoryDialogues(source, complete), []);
const bareConfirmed = prompt(`第1s @西娅：${help}`, `第1s @母巢：${reassurance}`);
assert.deepEqual(missingCanonicalDialogues(bareConfirmed, prompt(quoted('母巢', reassurance), quoted('西娅', help))), [], 'confirmed bare source speech may move across shots without a mechanical order mismatch');
assert.deepEqual(missingCanonicalDialogues(bareConfirmed, prompt(quoted('西娅', help), '无')), [reassurance], 'confirmed timed bare dialogue cannot disappear when the raw novel is unavailable');
assert.deepEqual(missingCanonicalDialogues(prompt(quoted('母巢', reassurance)), prompt('第4s @母巢：不必惊慌。', '第0.3s @母巢：我已经向你的方向派出了增援，他们伤不到你。')), [], 'confirmed content can split at a natural pause with newly arranged timing');
assert.deepEqual(missingStoryDialogues(source, prompt(`第1s @西娅：${help}`, `第1s @母巢：${reassurance}`)), [], 'timed bare speech is already complete, not two missing lines');
assert.deepEqual(missingStoryDialogues(source, shot(`${quoted('西娅', help)}；第2s @母巢：${reassurance}`)), [], 'a quoted utterance cannot hide another bare utterance in the same field');
assert.deepEqual(missingStoryDialogues(source, shot(`${quoted('西娅', help)}｜第2s @母巢：“不必惊慌。”｜第3s @母巢：“我已经向你的方向派出了增援，他们伤不到你。”`)), [], 'pipe-separated cue headers must not inject time numbers into a split utterance');
assert.deepEqual(missingStoryDialogues(source, shot(`${quoted('西娅', help)}|第2s @母巢：${reassurance}`)), [], 'ASCII pipe is a cue separator, not dialogue text');
assert.deepEqual(missingStoryDialogues(source, prompt(quoted('母巢', reassurance), quoted('西娅', help))), [], 'content coverage does not call a global order difference a missing line');
assert.deepEqual(missingStoryDialogues(source, prompt(`${quoted('西娅', help)} 第2s @母巢：“不必惊慌。”`, '第1s @母巢（以“安抚”语气）：“我已经向你的方向派出了增援，他们伤不到你。”')), [], 'speaker annotations do not inject fake words between split speech');
assert.deepEqual(missingStoryDialogues(source, prompt(`${quoted('西娅', help)} 第2s @母巢：不必惊慌。`, '第1s @母巢：我已经向你的方向派出了增援，他们伤不到你。')), [], 'bare split speech may continue naturally across adjacent shots');
assert.deepEqual(missingStoryDialogues('母巢说：“不必惊慌，我已经派出增援。”', prompt('第1s：“不必惊慌。”', '第1s：“我已经派出增援。”')), [], 'a typography-only absent speaker prefix does not insert timestamp words into quoted speech');
assert.deepEqual(missingStoryDialogues(source, prompt(`第1s：${help}`, `第1s：${reassurance}`)), [], 'timing prefixes do not turn bare spoken content into omissions');
assert.deepEqual(missingStoryDialogues(source, prompt(quoted('西娅', '我，需要 您的帮助！'), quoted('母巢', reassurance.replaceAll('，', ' ')))), [], 'punctuation and whitespace are not content omissions');
assert.deepEqual(missingStoryDialogues(source, prompt(quoted('西娅', help), '无')), [reassurance], 'an actually absent source utterance remains missing');
assert.deepEqual(missingStoryDialogues(source, prompt(quoted('西娅', '我需要你的帮助。'), quoted('母巢', reassurance))), [help], 'do not silently paraphrase an authored pronoun');
assert.deepEqual(missingStoryDialogues(source, `${shot(quoted('西娅', help))}\n${shot('无', 1, `；墙上写着“${reassurance}”`)}`), [reassurance], 'putting words on a sign is not spoken dialogue');

const prepared = `对白：西娅：母亲……他们发现我了。\n西娅：${help}\n母巢：${reassurance}`;
assert.deepEqual(missingStoryDialogues(prepared, prompt('第0.2s @西娅：母亲……他们发现我了。', `第1s @西娅：${help}`, `第1s @母巢：${reassurance}`)), [], 'first speaker after a preparation-section label remains ordinary speech');
assert.deepEqual(missingStoryDialogues(prepared, prompt(`第1s @西娅：${help}`, `第1s @母巢：${reassurance}`)), ['母亲……他们发现我了。'], 'the preparation label must not cause the first real line to disappear');
assert.deepEqual(missingStoryDialogues('西娅：“母巢：不必惊慌。”', shot('第1s @西娅：“母巢：不必惊慌。”')), [], 'a name and colon within quoted speech are literal authored text');

const repeatedSource = `西娅：“${help}”母巢：“${help}”`;
assert.deepEqual(missingStoryDialogues(repeatedSource, shot(quoted('西娅', help))), [help], 'one occurrence cannot satisfy two spoken events');
assert.deepEqual(missingStoryDialogues(repeatedSource, prompt(quoted('母巢', help), quoted('西娅', help))), [], 'both identical lines survive even if their globally rendered order changes');
const containingSource = `母巢：“不必惊慌。”母巢：“${reassurance}”`;
assert.deepEqual(missingStoryDialogues(containingSource, shot(quoted('母巢', reassurance))), ['不必惊慌。'], 'a short utterance may not reuse the beginning of an already allocated long utterance');
assert.deepEqual(missingStoryDialogues(containingSource, prompt(quoted('母巢', reassurance), quoted('母巢', '不必惊慌。'))), [], 'long-first nonoverlapping allocation keeps a separate short occurrence');

const englishSource = `母巢用英语说：“欢迎回来。”西娅说：“${help}”`;
assert.deepEqual(missingStoryDialogues(englishSource, prompt('第1s @母巢：Welcome back.', quoted('西娅', help))), [], 'only the explicitly English line gets a language exception');
assert.deepEqual(missingStoryDialogues(englishSource, prompt(quoted('母巢', 'Welcome back.'), quoted('西娅', 'I need your help.'))), [help], 'one English instruction cannot authorize translating other Chinese dialogue');
const sameEnglishAndChinese = `母巢用英语说：“${help}”西娅说：“${help}”`;
assert.deepEqual(missingStoryDialogues(sameEnglishAndChinese, prompt(quoted('西娅', help), quoted('母巢', 'I need your help.'))), [], 'the language exception must not consume the only ordinary Chinese duplicate');
assert.deepEqual(missingStoryDialogues(`母巢用英语说：“欢迎。”西娅用英语说：“回来。”`, shot(quoted('母巢', 'Welcome back.'))), ['回来。'], 'one English utterance cannot fill two source speech occurrences');
assert.deepEqual(missingStoryDialogues(source, prompt(quoted('西娅', 'I need your help.'), quoted('母巢', 'Do not worry. Reinforcements are coming.'))), [help, reassurance]);

const literalFieldWords = '我需要您的帮助；音效：请听清。';
const singleQuote = shot(`第1s @西娅：'${literalFieldWords}'`);
assert.equal(canonicalDialogueField(singleQuote), `第1s @西娅：'${literalFieldWords}'`);
assert.deepEqual(missingStoryDialogues(`西娅：“${literalFieldWords}”`, singleQuote), [], 'ASCII single quotes protect literal field delimiters');
assert.equal(parseMasterTimelinePrompt(singleQuote, 5).length, 1);
const contraction = shot("第1s @西娅：don't panic.");
assert.equal(canonicalDialogueField(contraction), "第1s @西娅：don't panic.");
assert.equal(parseMasterTimelinePrompt(contraction, 5).length, 1, 'apostrophes do not swallow following fields');
assert.deepEqual(missingStoryDialogues('西娅说：“Don\'t panic.”', shot("第1s @西娅：'Don't panic.'")), []);

assert.doesNotThrow(() => assertRelativeSoundCueTimes('第0.2s人物说：“第99s才开始。”', 2.2));
assert.doesNotThrow(() => assertRelativeSoundCueTimes("第0.2s人物说：'请说第99秒。'", 2.2));
assert.throws(() => assertRelativeSoundCueTimes('第3.2s轻微脚步', 2.2), /第3\.2s.*0-2\.2s/u);
assert.throws(() => assertRelativeSoundCueTimes("don't stop；第3.2s脚步", 2.2), /第3\.2s/u);
assert.equal(normalizeAbsoluteSoundCueTimes('第7s脚步，人物说：“第7s才开始。”', 5, 10), '第2s脚步，人物说：“第7s才开始。”', 'legacy rebasing must not rewrite quoted authored numbers');
console.log('dialogueCoverage: timed bare/mixed speech, annotations, order-independent nonoverlap coverage, repeats, single-line English opt-in and quoted time/field literals passed');
