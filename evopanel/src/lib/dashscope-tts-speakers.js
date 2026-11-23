/** 阿里云语音音色：Token Plan（sk-sp-）用 Qwen-Audio；按量 sk- 才用 CosyVoice */
export const DASHSCOPE_TTS_SPEAKER_DOC_URL =
  'https://help.aliyun.com/zh/model-studio/token-plan-speech-synthesis'

export const DASHSCOPE_TTS_SPEAKER_PRESETS = [
  // Token Plan（sk-sp- / qwen-audio-3.0-tts-plus）— 套餐用户请只用这组
  { value: 'longanlingxin', label: '龙安灵心（推荐 · Token Plan · 女声）' },
  { value: 'longanlufeng', label: '龙安鲁风（Token Plan · 男声）' },
  { value: 'longanhuan_v3.6', label: '龙安欢 v3.6（Token Plan）' },
  // 按量 CosyVoice（仅 sk- + dashscope.aliyuncs.com；Token Plan 会自动落到上面音色）
  { value: 'longanyang', label: '龙安洋（仅按量 CosyVoice · 男声）' },
  { value: 'longanhuan', label: '龙安欢（仅按量 CosyVoice · 女声）' },
  { value: 'longxiaochun_v3', label: '龙小淳 v3（仅按量 CosyVoice）' },
  { value: 'longxiaoxia_v3', label: '龙小夏 v3（仅按量 CosyVoice）' },
  { value: 'longcheng_v3', label: '龙橙 v3（仅按量 CosyVoice）' },
  { value: 'longze_v3', label: '龙泽 v3（仅按量 CosyVoice）' },
  { value: 'longmiao_v3', label: '龙妙 v3（仅按量 CosyVoice）' },
  { value: 'longsanshu_v3', label: '龙三叔 v3（仅按量 CosyVoice）' },
  { value: 'longanrou_v3', label: '龙安柔 v3（仅按量 CosyVoice）' },
  { value: 'longyingjing_v3', label: '龙应静 v3（仅按量 CosyVoice）' },
  { value: 'longhua_v3', label: '龙华 v3（仅按量 CosyVoice）' },
]

export const OPENAI_TTS_SPEAKER_PRESETS = [
  { value: 'nova', label: 'Nova（女声，自然）' },
  { value: 'shimmer', label: 'Shimmer（女声，轻柔）' },
  { value: 'alloy', label: 'Alloy（中性）' },
  { value: 'echo', label: 'Echo（男声）' },
  { value: 'fable', label: 'Fable（男声，叙事）' },
  { value: 'onyx', label: 'Onyx（男声，低沉）' },
]

export const ELEVENLABS_TTS_SPEAKER_PRESETS = [
  { value: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel（女声，自然）' },
  { value: 'pNInz6obpgDQGcFmaJgB', label: 'Adam（男声）' },
  { value: 'ErXwobaYiN019PkySvjV', label: 'Antoni（男声，温和）' },
  { value: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli（女声，年轻）' },
  { value: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi（女声，有力）' },
  { value: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh（男声，深沉）' },
]

export const MINIMAX_TTS_SPEAKER_PRESETS = [
  { value: 'male-qn-qingse', label: '青涩男声' },
  { value: 'male-qn-jingying', label: '精英男声' },
  { value: 'male-qn-badao', label: '霸道男声' },
  { value: 'female-shaonv', label: '少女' },
  { value: 'female-yujie', label: '御姐' },
  { value: 'female-chengshu', label: '成熟女声' },
  { value: 'presenter_male', label: '男主播' },
  { value: 'presenter_female', label: '女主播' },
]
