/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildBundledPythonEnvironment,
  resolveDocumentRuntime,
} from 'otto-core';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_SEGMENTS = 10_000;
const MAX_TRANSCRIPT_TEXT = 2_000_000;
const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4', '.mov',
]);

export interface RecruitmentTranscriptSegment {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface RecruitmentTranscriptResult {
  backend: 'whisperx';
  model: string;
  language: string | null;
  diarized: boolean;
  segments: RecruitmentTranscriptSegment[];
  warning?: string;
}

interface CommandResult { stdout: string; stderr?: string }
type CommandRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<CommandResult>;

const WHISPERX_SCRIPT = String.raw`
import json
import os
import sys

try:
    import torch
    import whisperx
    from whisperx.diarize import DiarizationPipeline, assign_word_speakers
except Exception as exc:
    print(json.dumps({"error": "Otto 智能招聘运行时缺少 WhisperX 3.8.6 或依赖无法加载: " + str(exc)}, ensure_ascii=False))
    sys.exit(2)

audio_path = sys.argv[1]
device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "float16" if device == "cuda" else "int8"
model_name = os.environ.get("OTTO_RECRUITMENT_WHISPERX_MODEL", "small")
language = os.environ.get("OTTO_WHISPER_LANGUAGE") or None
model = whisperx.load_model(model_name, device, compute_type=compute_type, language=language)
audio = whisperx.load_audio(audio_path)
result = model.transcribe(audio, batch_size=8)

try:
    align_model, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    result = whisperx.align(result["segments"], align_model, metadata, audio, device, return_char_alignments=False)
except Exception:
    pass

diarized = False
warning = None
token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
if token:
    try:
        pipeline = DiarizationPipeline(token=token, device=device)
        diarization = pipeline(audio)
        result = assign_word_speakers(diarization, result)
        diarized = True
    except Exception as exc:
        warning = "WhisperX 已完成转写，但说话人区分失败: " + str(exc)
else:
    warning = "WhisperX 已完成转写；未配置 HF_TOKEN，当前说话人需要人工确认。"

segments = []
for index, segment in enumerate(result.get("segments", [])):
    text = str(segment.get("text", "")).strip()
    if not text:
        continue
    speaker = segment.get("speaker") or ("说话人待确认" if not diarized else "SPEAKER_UNKNOWN")
    segments.append({
        "speaker": str(speaker),
        "startSeconds": float(segment.get("start", 0)),
        "endSeconds": float(segment.get("end", segment.get("start", 0))),
        "text": text,
    })

print(json.dumps({
    "backend": "whisperx",
    "model": model_name,
    "language": result.get("language"),
    "diarized": diarized,
    "segments": segments,
    "warning": warning,
}, ensure_ascii=False))
`;

export function parseRecruitmentTranscriptResult(stdout: string): RecruitmentTranscriptResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error('WhisperX 返回了无法解析的结果');
  }
  if (!value || typeof value !== 'object') throw new Error('WhisperX 返回结果为空');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.error === 'string' && candidate.error.trim()) {
    throw new Error(candidate.error.trim());
  }
  if (candidate.backend !== 'whisperx'
    || typeof candidate.model !== 'string'
    || !candidate.model.trim()
    || !Array.isArray(candidate.segments)) {
    throw new Error('WhisperX 返回结构不完整');
  }
  if (candidate.segments.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new Error('面试录音分段数量超过安全上限');
  }
  let totalText = 0;
  const segments = candidate.segments.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`WhisperX 第 ${index + 1} 段格式无效`);
    const segment = raw as Record<string, unknown>;
    if (typeof segment.text !== 'string' || !segment.text.trim()
      || typeof segment.speaker !== 'string'
      || typeof segment.startSeconds !== 'number'
      || typeof segment.endSeconds !== 'number'
      || !Number.isFinite(segment.startSeconds)
      || !Number.isFinite(segment.endSeconds)) {
      throw new Error(`WhisperX 第 ${index + 1} 段字段不完整`);
    }
    totalText += segment.text.length;
    return {
      speaker: segment.speaker.trim() || '说话人待确认',
      startSeconds: Math.max(0, segment.startSeconds),
      endSeconds: Math.max(segment.startSeconds, segment.endSeconds),
      text: segment.text.trim(),
    };
  });
  if (totalText > MAX_TRANSCRIPT_TEXT) throw new Error('面试转写文本超过安全上限');
  if (segments.length === 0) throw new Error('WhisperX 没有识别到可用语音');
  return {
    backend: 'whisperx',
    model: candidate.model.trim(),
    language: typeof candidate.language === 'string' ? candidate.language : null,
    diarized: candidate.diarized === true,
    segments,
    ...(typeof candidate.warning === 'string' && candidate.warning.trim()
      ? { warning: candidate.warning.trim() } : {}),
  };
}

export async function transcribeRecruitmentInterview(
  filePath: string,
  options: { runner?: CommandRunner; timeoutMs?: number } = {},
): Promise<RecruitmentTranscriptResult> {
  if (!SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('请选择 WAV、MP3、M4A、AAC、FLAC、OGG、OPUS、WEBM、MP4 或 MOV 面试录音');
  }
  const runtime = resolveDocumentRuntime('python');
  const runner = options.runner ?? (async (executable, args, runOptions) => {
    const result = await execFileAsync(executable, args, runOptions);
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  });
  try {
    const result = await runner(
      runtime.executable,
      ['-c', WHISPERX_SCRIPT, filePath],
      {
        env: buildBundledPythonEnvironment(runtime),
        timeout: options.timeoutMs ?? 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return parseRecruitmentTranscriptResult(result.stdout);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/WhisperX|whisperx|HF_TOKEN/u.test(message)) throw cause;
    throw new Error(`WhisperX 面试转写失败：${message}`);
  }
}
