/**
 * 共享模型预设配置
 * models.js 和 assistant.js 共用，只需维护一套数据
 */

// API 接口类型选项
export const API_TYPES = [
  { value: 'openai-completions', label: 'OpenAI 兼容 (最常用)' },
  { value: 'anthropic-messages', label: 'Anthropic 原生' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
]

// 服务商快捷预设（用于添加向导与左侧「厂商」列表）
// 每个厂商支持两种 URL：
// - baseUrl: 普通 API 端点
// - codingBaseUrl: Coding/编程场景专用端点
export const PROVIDER_PRESETS = [
  // 支持 Coding Plan 专属接口的三家排在最前：百炼 → 火山 → 智谱
  { key: 'aliyun', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', codingBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1', api: 'openai-completions', site: 'https://www.aliyun.com/product/bailian', desc: '阿里云 AI 大模型平台，支持通义千问全系列' },
  { key: 'volcengine', label: '火山引擎', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', codingBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', agentPlanBaseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', api: 'openai-completions', site: 'https://www.volcengine.com/product/ark', desc: '方舟 Agent Plan：DeepSeek-V4-flash / Kimi-K3 / Doubao-Seed-Evolving / GLM-5.3 等，全模态 + Harness。套餐请用 /api/plan/v3，勿用按量 /api/v3' },
  { key: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', codingBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions', site: 'https://www.bigmodel.cn/', desc: '国产大模型领军企业，支持 GLM-4 全系列' },
  { key: 'shengsuanyun', label: '胜算云', baseUrl: 'https://router.shengsuanyun.com/api/v1', codingBaseUrl: 'https://router.shengsuanyun.com/api/v1', api: 'openai-completions', site: 'https://www.shengsuanyun.com/', desc: '国内知名 AI 模型聚合平台，支持多种主流模型' },
  { key: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', codingBaseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', site: 'https://cloud.siliconflow.cn/', desc: '高性价比推理平台，支持 DeepSeek、Qwen 等开源模型' },
  { key: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', codingBaseUrl: 'https://api.minimax.chat/v1', api: 'openai-completions', site: 'https://platform.minimaxi.com/', desc: '国产多模态大模型，支持 MiniMax-Text 系列' },
  { key: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', codingBaseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions', site: 'https://platform.moonshot.cn', desc: '月之暗面（Moonshot AI）官方 API，支持 Kimi K2.5 / K2.6 / K3 等' },
  {
    key: 'openai',
    label: 'OpenAI / 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    codingBaseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    site: 'https://platform.openai.com/docs/api-reference',
    desc: '默认指向官方 api.openai.com；也可把接口地址改成 NewAPI / OneAPI / Azure 兼容端 / 自建网关等任意 OpenAI 兼容端点。需要的是 API Key（按量），不是 ChatGPT Plus 网页订阅。',
  },
  // Official SDK base has no /v1; ChatAnthropic appends /v1/messages itself.
  { key: 'anthropic', label: 'Anthropic 官方', baseUrl: 'https://api.anthropic.com', codingBaseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', codingBaseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { key: 'google', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', codingBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  { key: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', codingBaseUrl: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions', desc: '英伟达推理平台，支持 Llama、Mistral 等模型' },
  {
    key: 'ollama',
    label: 'Ollama (本地)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    codingBaseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    apiKeyOptional: true,
    site: 'https://ollama.com',
    desc: '本机 Ollama 服务，默认 OpenAI 兼容接口，无需 API Key',
  },
]

/** 模型配置页左侧展示的厂商（与预设一致，用于选栏） */
export const VENDOR_PRESETS = PROVIDER_PRESETS

/** 支持「通用 / Coding Plan / 自定义」接口地址切换的厂商（与面板 UI 一致） */
export const PROVIDER_URL_MODE_KEYS = ['aliyun', 'volcengine', 'zhipu']

// 胜算云推广配置
export const SHENGSUANYUN = {
  baseUrl: 'https://router.shengsuanyun.com/api/v1',
  site: 'https://www.shengsuanyun.com/',
  providerKey: 'shengsuanyun',
  brandName: '胜算云',
  api: 'openai-completions',
}

// 常用模型预设（按服务商分组）
export const MODEL_PRESETS = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
    { id: 'o3-mini', name: 'o3 Mini', contextWindow: 200000, reasoning: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
    { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', contextWindow: 200000 },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 64000 },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1', contextWindow: 64000, reasoning: true },
  ],
  moonshot: [
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5（图片理解）',
      contextWindow: 256000,
      reasoning: true,
      vision: true,
      section: 'recommended',
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      contextWindow: 256000,
      reasoning: true,
      vision: false,
      section: 'recommended',
    },
    {
      id: 'kimi-k3',
      name: 'Kimi K3',
      contextWindow: 256000,
      reasoning: true,
      vision: false,
      section: 'recommended',
    },
  ],
  google: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, reasoning: true },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
  ],
  ollama: [
    { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', contextWindow: 32768 },
    { id: 'llama3.2', name: 'Llama 3.2', contextWindow: 8192 },
    { id: 'gemma3', name: 'Gemma 3', contextWindow: 32768 },
  ],
  // 百炼快捷添加：默认 128k 上下文 + 推理；section 用于弹窗内「推荐 / 更多」分组
  aliyun: [
    {
      id: 'qwen3.6-plus',
      name: 'Qwen3.6 Plus（图片理解）',
      contextWindow: 128000,
      reasoning: true,
      vision: true,
      section: 'recommended',
    },
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5（图片理解）',
      contextWindow: 128000,
      reasoning: true,
      vision: true,
      section: 'recommended',
    },
    {
      id: 'glm-5',
      name: 'GLM-5',
      contextWindow: 128000,
      reasoning: true,
      vision: false,
      section: 'recommended',
    },
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax M2.5',
      contextWindow: 128000,
      reasoning: true,
      vision: false,
      section: 'recommended',
    },
    {
      id: 'qwen3.5-plus',
      name: 'Qwen3.5 Plus（图片理解）',
      contextWindow: 128000,
      reasoning: true,
      vision: true,
      section: 'more',
    },
  ],
}
