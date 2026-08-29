import { describe, expect, it, vi } from 'vitest';

import {
  parseRecruitmentTranscriptResult,
  transcribeRecruitmentInterview,
} from './recruitment-transcription.js';

describe('recruitment WhisperX transcription', () => {
  it('parses timestamped diarized segments without voice-trait classifications', () => {
    const result = parseRecruitmentTranscriptResult(JSON.stringify({
      backend: 'whisperx', model: 'large-v3', language: 'zh', diarized: true,
      segments: [
        { speaker: 'SPEAKER_00', startSeconds: 1.2, endSeconds: 4.8, text: '请介绍项目。' },
        { speaker: 'SPEAKER_01', startSeconds: 5, endSeconds: 10, text: '我负责交付。' },
      ],
    }));
    expect(result).toMatchObject({
      backend: 'whisperx', model: 'large-v3', diarized: true, language: 'zh',
    });
    expect(result.segments[1]).toMatchObject({ speaker: 'SPEAKER_01', startSeconds: 5 });
    expect(result).not.toHaveProperty('emotion');
    expect(result).not.toHaveProperty('personality');
  });

  it('invokes Python with an argument array and fails closed on unsupported files', async () => {
    const runner = vi.fn(async (_executable: string, _args: string[]) => ({
      stdout: JSON.stringify({
        backend: 'whisperx', model: 'small', language: 'zh', diarized: false,
        warning: '说话人需要人工确认',
        segments: [{ speaker: '说话人待确认', startSeconds: 0, endSeconds: 3, text: '测试' }],
      }),
    }));
    const result = await transcribeRecruitmentInterview('D:\\audio\\interview.wav', { runner });
    expect(result.warning).toContain('人工确认');
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[1][1]).toContain(
      'from whisperx.diarize import DiarizationPipeline, assign_word_speakers',
    );
    expect(runner.mock.calls[0]?.[1][1]).toContain('DiarizationPipeline(token=token');
    expect(runner.mock.calls[0]?.[1].at(-1)).toBe('D:\\audio\\interview.wav');
    await expect(transcribeRecruitmentInterview('D:\\audio\\resume.pdf', { runner }))
      .rejects.toThrow('请选择');
  });

  it('surfaces missing WhisperX honestly', async () => {
    await expect(transcribeRecruitmentInterview('D:\\audio\\interview.mp3', {
      runner: vi.fn(async () => ({ stdout: JSON.stringify({ error: 'WhisperX 未安装' }) })),
    })).rejects.toThrow('WhisperX 未安装');
  });
});
