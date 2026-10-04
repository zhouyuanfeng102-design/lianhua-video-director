const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const VIDEO_FORMATS = { '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska', '.mkv': 'matroska' };
const AUDIO_FORMATS = { '.mp3': 'mp3', '.wav': 'wav', '.m4a': 'mov', '.aac': 'aac', '.ogg': 'ogg', '.flac': 'flac' };
const MAX_DURATION_SEC = 24 * 60 * 60;
const MAX_FRAME_SCAN = 2_000_000;
const DEFAULT_BGM_VOLUME = 0.16;

const abortError = () => Object.assign(new Error('视频处理已取消，未保存半成品'), { name: 'AbortError' });
const assertActive = (job) => { if (job?.cancelled) throw abortError(); };
const finite = (value, min, max, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}必须在 ${min}–${max} 之间`);
  return value;
};
const validId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) throw new Error(`${label}无效`);
  return value;
};
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const ratio = (value) => {
  const [numerator, denominator = '1'] = String(value ?? '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : 0;
};
const seconds = (value) => Number(value.toFixed(9)).toString();
const safeOutputName = (value, fallback, extension) => {
  const stem = String(value || fallback).replace(/\.[^.]+$/u, '').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 100);
  return `${stem || fallback}.${extension}`;
};

const resolveManagedSource = async (assetRoot, source, kind = 'video', job) => {
  validId(source?.assetId, '素材 ID');
  const relative = source?.relativePath;
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[:\u0000-\u001f]/u.test(relative) || path.isAbsolute(relative)) throw new Error('只允许读取资产库中的媒体文件');
  const segments = relative.replace(/\\/gu, '/').split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new Error('资产路径越界');
  const format = (kind === 'video' ? VIDEO_FORMATS : { ...VIDEO_FORMATS, ...AUDIO_FORMATS })[path.extname(relative).toLowerCase()];
  if (!format) throw new Error(kind === 'video' ? '不支持的视频格式，请使用 MP4、MOV、WebM 或 MKV' : '不支持的背景音乐格式');
  const root = await fs.promises.realpath(assetRoot);
  let actual;
  try { actual = await fs.promises.realpath(path.resolve(root, ...segments)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('视频或音频素材已丢失，请在资产库重新定位'); throw error; }
  if (!inside(root, actual)) throw new Error('资产路径越界（不允许链接到资产库外部）');
  const stat = await fs.promises.stat(actual);
  if (!stat.isFile() || !stat.size) throw new Error('媒体素材为空或不是普通文件');
  if (source.expectedChecksum !== undefined && source.expectedChecksum !== '') {
    if (!/^[a-f\d]{64}$/iu.test(source.expectedChecksum)) throw new Error('素材校验码无效');
    const checksum = await fileHash(actual, job);
    if (checksum.toLowerCase() !== source.expectedChecksum.toLowerCase()) throw new Error('素材校验失败：文件内容已改变，请重新导入或定位素材');
  }
  assertActive(job);
  return { path: actual, format, stat };
};

const fileHash = async (filePath, job) => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) { assertActive(job); hash.update(chunk); }
  assertActive(job);
  return hash.digest('hex');
};

const parseProbe = (json, audioOnly = false) => {
  const video = json.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = json.streams?.find((stream) => stream.codec_type === 'audio');
  if (audioOnly && !audio) throw new Error('选择的背景音乐素材没有可用音轨');
  if (!audioOnly && !video) throw new Error('素材没有可解码的视频画面');
  const stream = audioOnly ? audio : video;
  const durationSec = Number(stream?.duration) || Number(json.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) throw new Error('媒体时长无效或超过 24 小时，无法安全处理');
  const rotation = Number(video?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation || video?.tags?.rotate || 0);
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const width = Number(rotated ? video?.height : video?.width) || 0;
  const height = Number(rotated ? video?.width : video?.height) || 0;
  if (!audioOnly && (!width || !height || width * height > 16384 * 16384)) throw new Error('视频画面尺寸无效');
  const avgFps = ratio(video?.avg_frame_rate);
  const rawFps = ratio(video?.r_frame_rate);
  const fps = avgFps || rawFps || 25;
  const frameCount = Number(video?.nb_frames);
  return {
    probe: {
      durationSec, width, height, fps,
      ...(Number.isSafeInteger(frameCount) && frameCount > 0 ? { frameCount } : {}),
      hasAudio: Boolean(audio), videoCodec: video?.codec_name || '',
      ...(audio ? { audioCodec: audio.codec_name || '', audioSampleRate: Number(audio.sample_rate) || undefined, audioChannels: Number(audio.channels) || undefined } : {}),
      variableFrameRate: Boolean(avgFps && rawFps && Math.abs(avgFps - rawFps) > 0.01),
    },
    startTimeSec: Number(stream?.start_time) || 0,
  };
};

const chooseFrames = (request, probe, frameTimes) => {
  const begin = request.inSec === undefined ? 0 : finite(request.inSec, 0, probe.durationSec, '入点');
  const end = request.outSec === undefined ? probe.durationSec : finite(request.outSec, 0, probe.durationSec + 0.001, '出点');
  if (end <= begin) throw new Error('抽帧范围为空：出点必须晚于入点');
  const eligible = frameTimes.filter((frame) => frame.timeSec >= begin - 0.000001 && frame.timeSec < end - 0.000001);
  if (!eligible.length) throw new Error('选定范围内没有可用视频帧，请调整入点和出点');
  const atTime = (time) => eligible.find((frame) => frame.timeSec >= time - 0.000001) || eligible[eligible.length - 1];
  const wrap = (frame, role) => ({ ...frame, role });
  switch (request.mode) {
    case 'first': return [wrap(eligible[0], 'first-frame')];
    case 'last': return [wrap(eligible[eligible.length - 1], 'last-frame')];
    case 'boundaries': return [wrap(eligible[0], 'first-frame'), wrap(eligible[eligible.length - 1], 'last-frame')];
    case 'time': {
      const time = finite(request.timeSec, begin, end, '指定时间');
      if (time >= end) throw new Error('指定时间必须早于出点；提取末帧请使用“尾帧”');
      return [wrap(atTime(time), 'custom-frame')];
    }
    case 'frame': {
      if (!Number.isSafeInteger(request.frameIndex) || request.frameIndex < 0) throw new Error('指定帧号必须是从 0 开始的整数');
      const frame = eligible.find((item) => item.frameIndex === request.frameIndex);
      if (!frame) throw new Error('指定帧号超出视频或当前裁剪范围');
      return [wrap(frame, 'custom-frame')];
    }
    case 'uniform': {
      if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 120) throw new Error('均匀抽帧数量必须在 1–120 之间');
      const last = eligible[eligible.length - 1].timeSec;
      const first = eligible[0].timeSec;
      const picked = Array.from({ length: request.count }, (_, index) => wrap(atTime(first + (last - first) * (request.count === 1 ? 0 : index / (request.count - 1))), 'custom-frame'));
      return picked.filter((item, index) => picked.findIndex((other) => other.frameIndex === item.frameIndex) === index);
    }
    default: throw new Error('未知的抽帧方式');
  }
};

/** Quantize edits to output frames, so very short clips and overlapping dissolves cannot corrupt the timeline. */
const buildRenderPlan = (request, sources) => {
  if (!Array.isArray(request.clips) || request.clips.length < 1 || request.clips.length > 200) throw new Error('时间线必须包含 1–200 个视频片段');
  const first = sources[0]?.probe;
  const fps = request.output?.fps === undefined ? Math.min(60, Math.max(1, first?.fps || 25)) : finite(request.output.fps, 1, 120, '输出帧率');
  const maxScale = Math.min(1, 3840 / first.width, 2160 / first.height);
  const defaultWidth = Math.max(2, Math.floor(first.width * maxScale / 2) * 2);
  const defaultHeight = Math.max(2, Math.floor(first.height * maxScale / 2) * 2);
  const width = request.output?.width === undefined ? defaultWidth : finite(request.output.width, 2, 3840, '输出宽度');
  const height = request.output?.height === undefined ? defaultHeight : finite(request.output.height, 2, 3840, '输出高度');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 2 || height % 2 || width * height > 3840 * 2160) throw new Error('输出尺寸须为偶数且总像素不超过 4K');
  const quantize = (value) => Math.floor(value * fps + 0.00001) / fps;
  const clips = request.clips.map((clip, index) => {
    const input = sources[index];
    const start = finite(clip.inSec, 0, input.probe.durationSec, `第 ${index + 1} 段入点`);
    const end = finite(clip.outSec, 0, input.probe.durationSec + 0.001, `第 ${index + 1} 段出点`);
    const duration = quantize(end - start);
    if (duration < 1 / fps - 0.000001) throw new Error(`第 ${index + 1} 段裁剪后不足一帧`);
    const volume = clip.volume === undefined ? 1 : finite(clip.volume, 0, 2, '片段音量');
    const transition = clip.transitionAfter;
    if (transition && !['cut', 'crossfade'].includes(transition.type)) throw new Error('不支持的转场类型');
    const outgoing = index < request.clips.length - 1 && transition?.type === 'crossfade'
      ? quantize(finite(transition.durationSec, 1 / fps, 10, '转场时长')) : 0;
    return { ...input, start, end: start + duration, duration, volume, outgoing };
  });
  clips.forEach((clip, index) => {
    if (clip.outgoing && (clip.outgoing > clip.duration / 2 + 0.000001 || clip.outgoing > clips[index + 1].duration / 2 + 0.000001)) throw new Error(`第 ${index + 1} 段转场过长，不能超过相邻较短片段的一半`);
  });
  const pieces = [];
  clips.forEach((clip, index) => {
    const incoming = clips[index - 1]?.outgoing || 0;
    const bodyDuration = quantize(clip.duration - incoming - clip.outgoing);
    if (bodyDuration >= 1 / fps - 0.000001) pieces.push({ type: 'body', duration: bodyDuration, inputs: [{ ...clip, seek: clip.start + incoming }] });
    if (clip.outgoing) pieces.push({ type: 'crossfade', duration: clip.outgoing, inputs: [{ ...clip, seek: clip.end - clip.outgoing }, { ...clips[index + 1], seek: clips[index + 1].start }] });
  });
  const durationSec = pieces.reduce((sum, piece) => sum + piece.duration, 0);
  if (!durationSec || durationSec > MAX_DURATION_SEC) throw new Error('成片时长必须大于零且不超过 24 小时');
  const maxFade = Math.min(30, durationSec / 2);
  const videoFadeIn = request.output?.fadeInSec === undefined ? 0 : finite(request.output.fadeInSec, 0, maxFade, '画面淡入时长');
  const videoFadeOut = request.output?.fadeOutSec === undefined ? 0 : finite(request.output.fadeOutSec, 0, maxFade, '画面淡出时长');
  const audioFadeIn = request.audio?.fadeInSec === undefined ? 0 : finite(request.audio.fadeInSec, 0, maxFade, '音频淡入时长');
  const audioFadeOut = request.audio?.fadeOutSec === undefined ? 0 : finite(request.audio.fadeOutSec, 0, maxFade, '音频淡出时长');
  const bgmVolume = request.audio?.bgmVolume === undefined ? DEFAULT_BGM_VOLUME : finite(request.audio.bgmVolume, 0, 0.5, '背景音乐音量');
  return { width, height, fps, pieces, durationSec, videoFadeIn, videoFadeOut, audioFadeIn, audioFadeOut, bgmVolume, ducking: request.audio?.ducking !== false };
};

// Shared with the lightweight thumbnail worker; both use the same bundled tools.
const resolveMediaBinary = (name, options = {}) => {
  const environment = options.env || process.env;
  const configured = options[`${name}Path`] || environment[`LIANHUA_${name.toUpperCase()}_PATH`];
  if (configured) return fs.existsSync(configured) && path.isAbsolute(configured) ? { path: configured, source: 'configured' } : null;
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const directories = [
    options.binaryDirectory,
    options.resourcesPath && path.join(options.resourcesPath, 'media-tools', `${process.platform}-${process.arch}`),
    options.resourcesPath && path.join(options.resourcesPath, 'media-tools'),
    options.projectRoot && path.join(options.projectRoot, 'build', 'media-tools', `${process.platform}-${process.arch}`),
  ].filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, source: 'bundled' };
  }
  for (const directory of String(environment.PATH || environment.Path || '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory.replace(/^"|"$/gu, ''))) continue;
    const candidate = path.join(directory.replace(/^"|"$/gu, ''), executable);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate, source: 'system' };
  }
  return null;
};

const createVideoWorkbench = (options) => {
  const jobs = new Map();
  const spawnProcess = options.spawn || spawn;
  const assetRoot = path.resolve(options.assetRoot);
  const tempRoot = path.resolve(options.tempRoot);
  let binaryResolution;
  let commitTail = Promise.resolve();
  const binaryFor = (name) => resolveMediaBinary(name, options);

  const runProcess = (binary, args, job, runOptions = {}) => new Promise((resolve, reject) => {
    assertActive(job);
    let child;
    try { child = spawnProcess(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: runOptions.cwd || tempRoot }); }
    catch (error) { reject(error); return; }
    if (job) job.child = child;
    let stdout = '';
    let stderr = '';
    let error;
    let killTimer;
    const stop = () => {
      try { child.kill(); } catch { /* already stopped */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already stopped */ } }, 1000);
      killTimer.unref?.();
    };
    if (job) job.stop = stop;
    const timeout = setTimeout(() => { error = new Error('本地视频处理超时，请缩短素材后重试'); stop(); }, runOptions.timeoutMs || 120000);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      try {
        if (runOptions.onStdout) runOptions.onStdout(text);
        if (runOptions.captureStdout !== false) {
          stdout += text;
          if (stdout.length > 8 * 1024 * 1024) throw new Error('媒体探测返回内容过大');
        }
      } catch (caught) { error = caught; stop(); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16000); });
    child.once('error', (caught) => { error = caught; });
    child.once('close', (code) => {
      clearTimeout(timeout); clearTimeout(killTimer);
      if (job?.child === child) { job.child = null; job.stop = null; }
      if (job?.cancelled) reject(abortError());
      else if (error) reject(error);
      else if (code !== 0) reject(new Error(`本地视频处理失败：${stderr.trim().slice(-2200) || `进程退出码 ${code}`}`));
      else resolve({ stdout, stderr });
    });
  });

  const resolveBinaries = async () => {
    if (!binaryResolution) binaryResolution = (async () => {
      await fs.promises.mkdir(tempRoot, { recursive: true });
      const ffmpeg = binaryFor('ffmpeg');
      const ffprobe = binaryFor('ffprobe');
      if (!ffmpeg || !ffprobe) return { ffmpeg, ffprobe, available: false, message: '未找到完整的 FFmpeg / FFprobe。请使用含媒体工具的新版便携包，或在系统 PATH 安装这两个程序后重新启动。' };
      try {
        await Promise.all([runProcess(ffmpeg.path, ['-version'], null, { timeoutMs: 10000 }), runProcess(ffprobe.path, ['-version'], null, { timeoutMs: 10000 })]);
        return { ffmpeg, ffprobe, available: true, message: '本地视频处理工具已就绪；原素材不会被修改。' };
      } catch { return { ffmpeg, ffprobe, available: false, message: 'FFmpeg / FFprobe 无法运行，请检查便携包是否完整、是否被安全软件隔离。' }; }
    })();
    return binaryResolution;
  };

  const requireBinaries = async () => {
    const binaries = await resolveBinaries();
    if (!binaries.available) throw new Error(binaries.message);
    return binaries;
  };
  const emit = (job, stage, percent, message) => {
    job.percent = Math.max(job.percent || 0, Math.min(100, Math.max(0, percent)));
    try { job.notify?.({ jobId: job.id, projectId: job.projectId, kind: job.kind, stage, percent: job.percent, message }); } catch { /* disposed renderer */ }
  };
  const probeFile = async (source, binaries, job, audioOnly = false) => {
    const result = await runProcess(binaries.ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', source.format, '-show_streams', '-show_format', '-of', 'json', source.path], job);
    let details;
    try { details = parseProbe(JSON.parse(result.stdout), audioOnly); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('无法读取媒体信息，素材可能已损坏'); throw error; }
    if (!audioOnly) {
      // MP4 stream.duration can undercount the tail of variable/reordered frames; container duration can include an audio tail.
      // Packet PTS (not DTS) gives the real video interval without decoding every picture or retaining the packet list.
      let pending = '';
      let maxEnd = 0;
      let packetCount = 0;
      const parseLine = (line) => {
        const fields = Object.fromEntries(line.trim().split('|').map((entry) => entry.split('=')));
        const timestamp = Number(fields.pts_time);
        if (!Number.isFinite(timestamp)) return;
        const duration = Number(fields.duration_time) || 1 / Math.max(details.probe.fps, 1);
        maxEnd = Math.max(maxEnd, timestamp - details.startTimeSec + duration);
        packetCount += 1;
        if (packetCount > MAX_FRAME_SCAN) throw new Error('视频超过两百万帧，请分段导入后处理');
      };
      await runProcess(binaries.ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', source.format, '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'compact=p=0:nk=0', source.path], job, {
        captureStdout: false,
        onStdout: (chunk) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/u); pending = lines.pop() || '';
          for (const line of lines) parseLine(line);
          if (pending.length > 16384) throw new Error('媒体时间戳信息异常');
        },
      });
      if (pending) parseLine(pending);
      if (maxEnd > 0 && maxEnd <= MAX_DURATION_SEC) details.probe.durationSec = maxEnd;
    }
    return details;
  };
  const ffmpeg = async (args, job, binaries, duration, startPercent, endPercent, message) => {
    let pending = '';
    emit(job, 'processing', startPercent, message);
    return runProcess(binaries.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1', '-progress', 'pipe:1', '-nostats', ...args], job, {
      timeoutMs: Math.min(6 * 3600 * 1000, Math.max(120000, duration * 20000)), captureStdout: false,
      onStdout: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/u); pending = lines.pop() || '';
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const elapsed = Number(line.slice(12)) / 1000000;
          if (Number.isFinite(elapsed)) emit(job, 'processing', startPercent + Math.min(1, elapsed / Math.max(duration, 0.001)) * (endPercent - startPercent), message);
        }
      },
    });
  };

  const saveOutput = async (job, filePath, extension, fileName, metadata = {}) => {
    assertActive(job);
    const checksum = await fileHash(filePath, job);
    const kind = extension === '.png' ? 'image' : 'video';
    const directory = path.join(assetRoot, kind);
    await fs.promises.mkdir(directory, { recursive: true });
    const actualRoot = await fs.promises.realpath(assetRoot);
    const actualDirectory = await fs.promises.realpath(directory);
    if (!inside(actualRoot, actualDirectory)) throw new Error('输出资产目录越界');
    const destination = path.join(actualDirectory, `${checksum}${extension}`);
    job.outputs.push({ filePath, destination, checksum });
    const stat = await fs.promises.stat(filePath);
    const relativePath = `${kind}/${checksum}${extension}`;
    return { fileName, relativePath, checksum, sizeBytes: stat.size, mediaType: kind, mimeType: extension === '.png' ? 'image/png' : 'video/mp4', managed: true, missing: false, url: `lianhua-asset://local/${relativePath}`, ...metadata };
  };

  const commitOutputs = async (job) => {
    // Serialize commits: cancellation must never delete an identical frame another completed job has just reused.
    const previous = commitTail;
    let unlock;
    commitTail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    try {
      assertActive(job);
      for (const output of job.outputs) {
        assertActive(job);
        try { await fs.promises.copyFile(output.filePath, output.destination, fs.constants.COPYFILE_EXCL); job.createdFiles.push(output.destination); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await fs.promises.lstat(output.destination);
          if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('输出资产路径无效，不能覆盖链接或目录');
          if (await fileHash(output.destination, job) !== output.checksum) throw new Error('输出资产校验冲突');
        }
      }
      assertActive(job);
      job.committed = true;
    } catch (error) {
      for (const filePath of job.createdFiles) { try { await fs.promises.unlink(filePath); } catch { /* already absent */ } }
      throw error;
    } finally { unlock(); }
  };

  const withJob = async (request, kind, ownerId, notify, action) => {
    const id = validId(request?.jobId, '处理任务 ID');
    validId(request?.projectId, '项目 ID');
    if (jobs.has(id)) throw new Error('同一视频处理任务已经在运行，请勿重复提交');
    if (jobs.size >= 2) throw new Error('同时最多处理 2 个本地视频任务，请等待当前任务结束');
    const job = { id, projectId: request.projectId, kind, ownerId, notify, cancelled: false, committed: false, child: null, stop: null, outputs: [], createdFiles: [], percent: 0, directory: null };
    jobs.set(id, job);
    emit(job, 'preparing', 0, kind === 'render' ? '检查剪辑素材与时间线…' : '检查视频并定位真实帧…');
    try {
      await fs.promises.mkdir(tempRoot, { recursive: true });
      job.directory = await fs.promises.mkdtemp(path.join(tempRoot, 'video-workbench-'));
      const binaries = await requireBinaries();
      assertActive(job);
      const result = await action(job, binaries);
      assertActive(job);
      await commitOutputs(job);
      emit(job, 'completed', 100, kind === 'render' ? '成片已保存到资产库' : '抽帧图片已保存到资产库');
      return result;
    } catch (error) {
      emit(job, job.cancelled ? 'cancelled' : 'failed', job.percent, job.cancelled ? '已取消，半成品已清理' : String(error?.message || error));
      throw job.cancelled ? abortError() : error;
    } finally {
      jobs.delete(id);
      if (job.directory && inside(tempRoot, job.directory) && path.basename(job.directory).startsWith('video-workbench-')) {
        await fs.promises.rm(job.directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
      }
    }
  };

  const readFrameTimes = async (source, details, binaries, job) => {
    const frameTimes = [];
    let pending = '';
    let index = 0;
    const readLine = (line) => {
      const value = Number.parseFloat(line.trim());
      if (!Number.isFinite(value)) return;
      const timeSec = value - details.startTimeSec;
      if (timeSec >= -0.000001) frameTimes.push({ frameIndex: index, timeSec: Math.max(0, timeSec) });
      index += 1;
      if (index > MAX_FRAME_SCAN) throw new Error('视频超过两百万帧，请先裁剪需要的片段后再抽帧');
    };
    await runProcess(binaries.ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', source.format, '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', source.path], job, {
      timeoutMs: Math.min(3600000, Math.max(120000, details.probe.durationSec * 5000)), captureStdout: false,
      onStdout: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/u); pending = lines.pop() || '';
        for (const line of lines) readLine(line);
        if (pending.length > 4096) throw new Error('视频帧信息异常');
        const last = frameTimes[frameTimes.length - 1];
        if (last) emit(job, 'preparing', Math.min(20, last.timeSec / details.probe.durationSec * 20), '正在定位视频真实帧（支持可变帧率）…');
      },
    });
    if (pending) readLine(pending);
    if (!frameTimes.length) throw new Error('视频中没有可提取的画面帧');
    return frameTimes;
  };

  const extractFrames = (request, ownerId, notify) => withJob(request, 'extract', ownerId, notify, async (job, binaries) => {
    const source = await resolveManagedSource(assetRoot, request.source, 'video', job);
    const details = await probeFile(source, binaries, job);
    const times = await readFrameTimes(source, details, binaries, job);
    const selected = chooseFrames(request, details.probe, times);
    const indices = [...new Set(selected.map((frame) => frame.frameIndex))].sort((a, b) => a - b);
    const selection = indices.map((index) => `eq(n\\,${index})`).join('+');
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-f', source.format, '-threads', '2', '-i', source.path, '-map', '0:v:0', '-an', '-sn', '-vf', `select=${selection}`, '-fps_mode', 'vfr', '-frames:v', String(indices.length), '-threads', '1', '-start_number', '0', path.join(job.directory, 'frame-%03d.png')], job, binaries, selected[selected.length - 1].timeSec || 1, 20, 90, `正在提取 ${indices.length} 张原尺寸画面…`);
    emit(job, 'saving', 92, '校验并保存抽帧图片…');
    const frames = [];
    for (const frame of selected) {
      const filePath = path.join(job.directory, `frame-${String(indices.indexOf(frame.frameIndex)).padStart(3, '0')}.png`);
      const file = await fs.promises.open(filePath, 'r');
      const header = Buffer.alloc(24);
      try { await file.read(header, 0, 24, 0); } finally { await file.close(); }
      if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('抽帧图片不完整，请重试');
      const baseName = safeOutputName(request.fileName, '视频抽帧', 'png').slice(0, -4);
      const roleName = frame.role === 'first-frame' ? '首帧' : frame.role === 'last-frame' ? '尾帧' : '自定义帧';
      const fileName = `${baseName}·${roleName}·${String(frame.frameIndex + 1).padStart(6, '0')}(${frame.timeSec.toFixed(3)}s).png`;
      frames.push(await saveOutput(job, filePath, '.png', fileName, { ...frame, width: header.readUInt32BE(16), height: header.readUInt32BE(20) }));
    }
    return { probe: { ...details.probe, frameCount: times.length }, frames };
  });

  const renderPiece = async (piece, plan, output, job, binaries, startPercent, endPercent) => {
    const args = [];
    const filters = [];
    piece.inputs.forEach((input, index) => {
      args.push('-protocol_whitelist', 'file,pipe', '-ss', seconds(input.seek), '-t', seconds(piece.duration), '-f', input.format, '-threads', '2', '-i', input.path);
      filters.push(`[${index}:v:0]trim=duration=${seconds(piece.duration)},setpts=PTS-STARTPTS,scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${seconds(plan.fps)},format=yuv420p,settb=AVTB[v${index}]`);
      filters.push(input.probe.hasAudio
        ? `[${index}:a:0]atrim=duration=${seconds(piece.duration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${seconds(input.volume)},apad,atrim=duration=${seconds(piece.duration)}[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(piece.duration)},asetpts=PTS-STARTPTS[a${index}]`);
    });
    if (piece.type === 'crossfade') {
      filters.push(`[v0][v1]xfade=transition=fade:duration=${seconds(piece.duration)}:offset=0[vout]`);
      filters.push(`[a0][a1]acrossfade=d=${seconds(piece.duration)}:c1=tri:c2=tri[aout]`);
    }
    const videoLabel = piece.type === 'crossfade' ? '[vout]' : '[v0]';
    const audioLabel = piece.type === 'crossfade' ? '[aout]' : '[a0]';
    // No reordered frames in intermediates: negative DTS otherwise shifts each concat boundary and accumulates A/V drift.
    args.push('-filter_complex', filters.join(';'), '-map', videoLabel, '-map', audioLabel, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '0', '-pix_fmt', 'yuv420p', '-threads', '2', '-r', seconds(plan.fps), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', seconds(piece.duration), '-f', 'nut', output);
    await ffmpeg(args, job, binaries, piece.duration, startPercent, endPercent, piece.type === 'crossfade' ? '正在合成交叉溶解与音频转场…' : '正在裁剪并统一画面、帧率与音轨…');
  };

  const renderTimeline = (request, ownerId, notify) => withJob(request, 'render', ownerId, notify, async (job, binaries) => {
    if (!Array.isArray(request.clips) || request.clips.length < 1 || request.clips.length > 200) throw new Error('时间线必须包含 1–200 个视频片段');
    const sources = [];
    const sourceCache = new Map();
    for (const clip of request.clips) {
      assertActive(job);
      const key = JSON.stringify(clip.source);
      let entry = sourceCache.get(key);
      if (!entry) {
        const source = await resolveManagedSource(assetRoot, clip.source, 'video', job);
        const details = await probeFile(source, binaries, job);
        entry = { ...source, ...details };
        sourceCache.set(key, entry);
      }
      sources.push(entry);
    }
    const plan = buildRenderPlan(request, sources);
    let bgm;
    if (request.audio?.bgm) {
      bgm = await resolveManagedSource(assetRoot, request.audio.bgm, 'audio', job);
      await probeFile(bgm, binaries, job, true);
    }
    const piecePaths = [];
    let elapsed = 0;
    for (const [index, piece] of plan.pieces.entries()) {
      const fileName = `part-${String(index).padStart(4, '0')}.nut`;
      const output = path.join(job.directory, fileName);
      await renderPiece(piece, plan, output, job, binaries, 2 + elapsed / plan.durationSec * 83, 2 + (elapsed + piece.duration) / plan.durationSec * 83);
      elapsed += piece.duration;
      piecePaths.push(fileName);
    }
    assertActive(job);
    const concatPath = path.join(job.directory, 'segments.txt');
    await fs.promises.writeFile(concatPath, piecePaths.map((name, index) => `file '${name}'\nduration ${seconds(plan.pieces[index].duration)}`).join('\n'), 'utf8');
    const outputPath = path.join(job.directory, 'rendered.mp4');
    const args = ['-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', concatPath];
    const filters = [];
    if (bgm) {
      args.push('-protocol_whitelist', 'file,pipe', '-stream_loop', '-1', '-f', bgm.format, '-i', bgm.path);
      filters.push(`[1:a:0]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${seconds(plan.durationSec)},asetpts=PTS-STARTPTS,volume=${seconds(plan.bgmVolume)}[bgm]`);
      if (plan.ducking) {
        filters.push('[0:a:0]asplit=2[original][sidechain]');
        filters.push('[bgm][sidechain]sidechaincompress=threshold=0.025:ratio=8:attack=15:release=300[quietbgm]');
        filters.push('[original][quietbgm]amix=inputs=2:duration=first:normalize=0[mixed]');
      } else filters.push('[0:a:0][bgm]amix=inputs=2:duration=first:normalize=0[mixed]');
    }
    const audioFilters = ['alimiter=limit=0.98:level=0:latency=1'];
    if (plan.audioFadeIn) audioFilters.push(`afade=t=in:st=0:d=${seconds(plan.audioFadeIn)}`);
    if (plan.audioFadeOut) audioFilters.push(`afade=t=out:st=${seconds(plan.durationSec - plan.audioFadeOut)}:d=${seconds(plan.audioFadeOut)}`);
    filters.push(`${bgm ? '[mixed]' : '[0:a:0]'}${audioFilters.join(',')}[audioout]`);
    const videoFilters = [];
    if (plan.videoFadeIn) videoFilters.push(`fade=t=in:st=0:d=${seconds(plan.videoFadeIn)}`);
    if (plan.videoFadeOut) videoFilters.push(`fade=t=out:st=${seconds(plan.durationSec - plan.videoFadeOut)}:d=${seconds(plan.videoFadeOut)}`);
    if (videoFilters.length) filters.push(`[0:v:0]${videoFilters.join(',')}[videoout]`);
    args.push('-filter_complex', filters.join(';'), '-map', videoFilters.length ? '[videoout]' : '0:v:0', '-map', '[audioout]');
    if (videoFilters.length) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '2');
    else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', seconds(plan.durationSec), '-movflags', '+faststart', outputPath);
    await ffmpeg(args, job, binaries, plan.durationSec, 85, 96, '正在输出 MP4 并混合音频（对白优先）…');
    emit(job, 'saving', 97, '校验成片画面、音轨与时长…');
    const result = await probeFile({ path: outputPath, format: 'mov' }, binaries, job);
    if (!result.probe.hasAudio || result.probe.videoCodec !== 'h264' || result.probe.width !== plan.width || result.probe.height !== plan.height || Math.abs(result.probe.durationSec - plan.durationSec) > Math.max(0.3, 2 / plan.fps)) throw new Error('成片校验失败：画面、音轨或时长与时间线不一致，未保存结果');
    return saveOutput(job, outputPath, '.mp4', safeOutputName(request.output?.fileName, '视频工作台成片', 'mp4'), { probe: result.probe, renderMode: 'transcode' });
  });

  return {
    async status() {
      const result = await resolveBinaries();
      return { available: result.available, ffmpeg: Boolean(result.ffmpeg), ffprobe: Boolean(result.ffprobe), source: result.ffmpeg?.source, message: result.message };
    },
    async probe(source) {
      const binaries = await requireBinaries();
      const resolved = await resolveManagedSource(assetRoot, source);
      return (await probeFile(resolved, binaries)).probe;
    },
    extractFrames,
    renderTimeline,
    cancel(jobId, ownerId) {
      const job = jobs.get(jobId);
      if (!job || job.ownerId !== ownerId || job.committed) return false;
      job.cancelled = true;
      job.stop?.();
      return true;
    },
    cancelOwner(ownerId) { for (const job of jobs.values()) if (job.ownerId === ownerId && !job.committed) { job.cancelled = true; job.stop?.(); } },
    close() { for (const job of jobs.values()) if (!job.committed) { job.cancelled = true; job.stop?.(); } },
  };
};

module.exports = { createVideoWorkbench, resolveManagedSource, resolveMediaBinary, parseProbe, chooseFrames, buildRenderPlan, DEFAULT_BGM_VOLUME };
