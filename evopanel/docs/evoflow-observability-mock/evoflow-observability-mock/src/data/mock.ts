import type {
  AgentRecord,
  AgentRankingItem,
  AlertItem,
  EvalHistoryItem,
  EvalSummary,
  GatewayRoute,
  Metric,
  ModelRecord,
  ProviderRecord,
  RequestRecord,
  TaskQualityStats,
  TimePoint,
  ToolCallRecord,
  ToolRecord,
  ToolReliabilityStats,
  TraceRecord
} from '../types';

export const metrics: Metric[] = [
  { title: '请求总数', value: '128,430', delta: '+12.4% vs 7d 前', trend: 'up', icon: '〽', accent: 'blue', data: [24, 28, 26, 33, 31, 37, 42, 39, 35, 46, 44, 41] },
  { title: '成功率', value: '98.24%', delta: '-0.6pp vs 7d 前', trend: 'bad', icon: '✓', accent: 'green', data: [91, 92, 92, 94, 91, 90, 93, 92, 94, 95, 94, 93] },
  { title: '平均耗时', value: '842ms', delta: '+18ms vs 7d 前', trend: 'bad', icon: '◷', accent: 'purple', data: [42, 44, 48, 46, 50, 49, 47, 52, 51, 54, 53, 55] },
  { title: 'Token 消耗', value: '42.8M', delta: '+21.7% vs 7d 前', trend: 'up', icon: '◉', accent: 'orange', data: [32, 36, 39, 43, 41, 45, 48, 50, 46, 52, 55, 58] },
  { title: '预估成本', value: '$186.42', delta: '+16.3% vs 7d 前', trend: 'up', icon: '$', accent: 'cyan', data: [21, 23, 27, 25, 28, 31, 30, 34, 33, 36, 39, 41] }
];

export const requestTrend: TimePoint[] = [
  { label: '5/13', total: 19800, success: 14200, failed: 2100, warning: 3500, prompt: 3.2, completion: 4.1, cost: 14.8 },
  { label: '5/14', total: 17800, success: 12450, failed: 1900, warning: 3450, prompt: 2.4, completion: 5.8, cost: 15.2 },
  { label: '5/15', total: 21800, success: 15380, failed: 2600, warning: 3820, prompt: 3.6, completion: 4.2, cost: 16.9 },
  { label: '5/16', total: 17000, success: 11600, failed: 1800, warning: 3600, prompt: 2.8, completion: 6.1, cost: 15.7 },
  { label: '5/17', total: 20400, success: 14120, failed: 2300, warning: 3980, prompt: 4.2, completion: 5.3, cost: 18.1 },
  { label: '5/18', total: 22600, success: 15600, failed: 2200, warning: 4800, prompt: 3.9, completion: 7.6, cost: 20.4 },
  { label: '5/19', total: 18430, success: 12870, failed: 2450, warning: 3110, prompt: 4.4, completion: 5.9, cost: 17.3 }
];

export const recentRequests: RequestRecord[] = [
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A', status: 'failed', time: '2025-05-19 14:35:21', relativeTime: '8 分钟前', agent: 'SummarizeAgent', model: 'GPT-4o mini', provider: 'OpenAI', latency: '5.21s', latencyMs: 5210, promptTokens: 812, completionTokens: 433, tokens: 1245, cost: 0.0056, threadId: 'thr_8H3QK92', runId: 'run_7VJ1P3', stage: 'model_call', error: 'Rate limit exceeded', region: 'us-east-1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7B', status: 'success', time: '2025-05-19 14:41:21', relativeTime: '2 分钟前', agent: 'ResearchAgent', model: 'GPT-4.1', provider: 'OpenAI', latency: '812ms', latencyMs: 812, promptTokens: 1220, completionTokens: 1131, tokens: 2351, cost: 0.0182, threadId: 'thr_2LPO990', runId: 'run_090KLM', stage: 'final', region: 'us-east-1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7C', status: 'warning', time: '2025-05-19 14:38:12', relativeTime: '5 分钟前', agent: 'CodeAgent', model: 'Claude 3.5 Sonnet', provider: 'Anthropic', latency: '1.24s', latencyMs: 1240, promptTokens: 3334, completionTokens: 1538, tokens: 4872, cost: 0.0321, threadId: 'thr_AQK0091', runId: 'run_PLK123', stage: 'tool_call', error: 'Tool retry once', region: 'us-west-2' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7D', status: 'success', time: '2025-05-19 14:36:42', relativeTime: '7 分钟前', agent: 'DataAnalyst', model: 'Gemini 1.5 Pro', provider: 'Google', latency: '1.03s', latencyMs: 1030, promptTokens: 2070, completionTokens: 1837, tokens: 3907, cost: 0.0198, threadId: 'thr_GEM223', runId: 'run_GG401', stage: 'final', region: 'asia-east1' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7E', status: 'success', time: '2025-05-19 14:32:01', relativeTime: '11 分钟前', agent: 'TranslateAgent', model: 'DeepSeek', provider: 'DeepSeek', latency: '932ms', latencyMs: 932, promptTokens: 1515, completionTokens: 1361, tokens: 2876, cost: 0.0112, threadId: 'thr_DSK009', runId: 'run_DSK782', stage: 'final', region: 'cn-east' },
  { id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7F', status: 'warning', time: '2025-05-19 14:21:45', relativeTime: '22 分钟前', agent: 'PlanningAgent', model: 'Local Llama', provider: 'Local', latency: '2.18s', latencyMs: 2180, promptTokens: 982, completionTokens: 702, tokens: 1684, cost: 0.0000, threadId: 'thr_LOC111', runId: 'run_LOC019', stage: 'planning', error: 'Slow local inference', region: 'local' }
];

export const agents: AgentRecord[] = [
  { name: 'ResearchAgent', status: 'normal', requests: 28430, successRate: 98.9, avgLatency: '812ms', tokens: '8.2M', mainModel: 'GPT-4.1', tools: 12420, owner: 'Knowledge Team' },
  { name: 'CodeAgent', status: 'warning', requests: 18321, successRate: 96.4, avgLatency: '1.24s', tokens: '6.8M', mainModel: 'Claude 3.5 Sonnet', tools: 18220, owner: 'DevTools Team' },
  { name: 'DataAnalyst', status: 'normal', requests: 22104, successRate: 98.1, avgLatency: '1.03s', tokens: '7.4M', mainModel: 'Gemini 1.5 Pro', tools: 9730, owner: 'Data Team' },
  { name: 'SummarizeAgent', status: 'error', requests: 16781, successRate: 91.2, avgLatency: '5.21s', tokens: '3.9M', mainModel: 'GPT-4o mini', tools: 4220, owner: 'Docs Team' },
  { name: 'TranslateAgent', status: 'normal', requests: 10922, successRate: 99.1, avgLatency: '932ms', tokens: '3.1M', mainModel: 'DeepSeek', tools: 1290, owner: 'Localization' }
];

export const providers: ProviderRecord[] = [
  { name: 'OpenAI', status: 'warning', requests: 84200, successRate: 98.1, avgLatency: '920ms', tokens: '31.2M', cost: 142.8, errors: 'rate_limit 42, timeout 18' },
  { name: 'Anthropic', status: 'normal', requests: 24312, successRate: 99.0, avgLatency: '1.12s', tokens: '9.8M', cost: 42.37, errors: 'timeout 7' },
  { name: 'Google', status: 'normal', requests: 18760, successRate: 98.4, avgLatency: '1.03s', tokens: '7.1M', cost: 31.24, errors: 'quota 5' },
  { name: 'DeepSeek', status: 'normal', requests: 10234, successRate: 97.8, avgLatency: '932ms', tokens: '3.2M', cost: 12.08, errors: 'network 3' },
  { name: 'Local', status: 'warning', requests: 6127, successRate: 94.2, avgLatency: '2.46s', tokens: '1.5M', cost: 0, errors: 'gpu_busy 21' }
];

export const models: ModelRecord[] = [
  { model: 'GPT-4.1', provider: 'OpenAI', requests: 32145, successRate: 99.1, avgLatency: '812ms', p95Latency: '1.92s', promptTokens: '7.8M', completionTokens: '4.8M', tokens: '12.6M', cost: 58.21, errorRate: 0.9, mainAgents: ['ResearchAgent', 'PlanningAgent'] },
  { model: 'Claude 3.5 Sonnet', provider: 'Anthropic', requests: 24312, successRate: 98.7, avgLatency: '1.24s', p95Latency: '2.81s', promptTokens: '6.2M', completionTokens: '3.6M', tokens: '9.8M', cost: 42.37, errorRate: 1.3, mainAgents: ['CodeAgent'] },
  { model: 'Gemini 1.5 Pro', provider: 'Google', requests: 18760, successRate: 98.4, avgLatency: '1.03s', p95Latency: '2.11s', promptTokens: '4.5M', completionTokens: '2.6M', tokens: '7.1M', cost: 31.24, errorRate: 1.6, mainAgents: ['DataAnalyst'] },
  { model: 'GPT-4o mini', provider: 'OpenAI', requests: 16852, successRate: 94.2, avgLatency: '1.86s', p95Latency: '5.21s', promptTokens: '3.4M', completionTokens: '2.2M', tokens: '5.6M', cost: 21.15, errorRate: 5.8, mainAgents: ['SummarizeAgent'] },
  { model: 'DeepSeek', provider: 'DeepSeek', requests: 10234, successRate: 97.9, avgLatency: '932ms', p95Latency: '1.87s', promptTokens: '1.9M', completionTokens: '1.3M', tokens: '3.2M', cost: 12.08, errorRate: 2.1, mainAgents: ['TranslateAgent'] },
  { model: 'Local Llama', provider: 'Local', requests: 6127, successRate: 94.2, avgLatency: '2.46s', p95Latency: '6.4s', promptTokens: '1.0M', completionTokens: '0.5M', tokens: '1.5M', cost: 0, errorRate: 5.8, mainAgents: ['PlanningAgent'] }
];

export const tools: ToolRecord[] = [
  { name: 'web_search', category: 'Retrieval', requests: 18320, successRate: 98.4, avgLatency: '642ms', p95Latency: '1.2s', failureRate: 1.6, mainAgent: 'ResearchAgent' },
  { name: 'code_interpreter', category: 'Compute', requests: 9220, successRate: 96.2, avgLatency: '2.8s', p95Latency: '7.1s', failureRate: 3.8, mainAgent: 'CodeAgent' },
  { name: 'sql_query', category: 'Database', requests: 7420, successRate: 97.1, avgLatency: '412ms', p95Latency: '1.0s', failureRate: 2.9, mainAgent: 'DataAnalyst' },
  { name: 'file_reader', category: 'IO', requests: 5210, successRate: 99.2, avgLatency: '223ms', p95Latency: '610ms', failureRate: 0.8, mainAgent: 'SummarizeAgent' },
  { name: 'vector_search', category: 'Retrieval', requests: 4821, successRate: 98.8, avgLatency: '384ms', p95Latency: '902ms', failureRate: 1.2, mainAgent: 'ResearchAgent' }
];

export const toolCalls: ToolCallRecord[] = [
  { id: 'tool_001', time: '2025-05-19 14:40:10', toolName: 'web_search', agent: 'ResearchAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7B', traceId: 'trace_1001', status: 'success', latency: '642ms', input: '{"query":"agent observability"}', output: '{"results":8}' },
  { id: 'tool_002', time: '2025-05-19 14:38:03', toolName: 'code_interpreter', agent: 'CodeAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7C', traceId: 'trace_1002', status: 'warning', latency: '2.8s', input: '{"language":"python"}', output: '{"stdout":"ok"}', error: 'retry once' },
  { id: 'tool_003', time: '2025-05-19 14:36:28', toolName: 'sql_query', agent: 'DataAnalyst', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7D', traceId: 'trace_1003', status: 'success', latency: '412ms', input: '{"sql":"select count(*)"}', output: '{"rows":1}' },
  { id: 'tool_004', time: '2025-05-19 14:35:18', toolName: 'file_reader', agent: 'SummarizeAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A', traceId: 'trace_1004', status: 'failed', latency: '5.21s', input: '{"file":"report.pdf"}', output: '{}', error: 'rate limit exceeded' },
  { id: 'tool_005', time: '2025-05-19 14:32:02', toolName: 'vector_search', agent: 'ResearchAgent', requestId: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7E', traceId: 'trace_1005', status: 'success', latency: '384ms', input: '{"top_k":5}', output: '{"matches":5}' }
];

export const gatewayRoutes: GatewayRoute[] = [
  { route: '/v1/chat/completions', method: 'POST', requests: 54820, avgLatency: '912ms', p95Latency: '2.6s', status2xx: 53120, status4xx: 912, status5xx: 248, rateLimited: 540, upstream: 'OpenAI / Anthropic' },
  { route: '/v1/agents/run', method: 'POST', requests: 22340, avgLatency: '1.34s', p95Latency: '3.1s', status2xx: 21670, status4xx: 311, status5xx: 102, rateLimited: 257, upstream: 'Agent Runtime' },
  { route: '/v1/tools/call', method: 'POST', requests: 18392, avgLatency: '682ms', p95Latency: '2.4s', status2xx: 17800, status4xx: 302, status5xx: 91, rateLimited: 199, upstream: 'Tool Router' },
  { route: '/v1/traces/:id', method: 'GET', requests: 9042, avgLatency: '124ms', p95Latency: '342ms', status2xx: 8974, status4xx: 48, status5xx: 5, rateLimited: 15, upstream: 'SQLite' },
  { route: '/v1/dashboard', method: 'GET', requests: 7120, avgLatency: '88ms', p95Latency: '214ms', status2xx: 7088, status4xx: 21, status5xx: 3, rateLimited: 8, upstream: 'SQLite' }
];

export const traces: TraceRecord[] = [
  {
    id: 'trace_1004',
    threadId: 'thr_8H3QK92',
    agent: 'SummarizeAgent',
    duration: '5.21s',
    steps: 7,
    status: 'failed',
    startedAt: '2025-05-19 14:35:21',
    summary: '文档摘要请求在模型调用阶段被限流。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '输入 812 tokens' },
      { id: 's2', type: 'agent', title: 'Agent Planning', duration: '86ms', status: 'success', meta: '生成摘要计划' },
      { id: 's3', type: 'tool', title: 'Tool Call: file_reader', duration: '223ms', status: 'success', meta: '读取 report.pdf' },
      { id: 's4', type: 'model', title: 'Model Call: GPT-4o mini', duration: '5.21s', status: 'failed', meta: 'Rate limit exceeded' },
      { id: 's5', type: 'error', title: 'Error Handler', duration: '32ms', status: 'failed', meta: '没有可用 fallback model' }
    ]
  },
  {
    id: 'trace_1001',
    threadId: 'thr_2LPO990',
    agent: 'ResearchAgent',
    duration: '1.42s',
    steps: 8,
    status: 'success',
    startedAt: '2025-05-19 14:41:21',
    summary: '完成检索、推理和最终答复。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '研究主题' },
      { id: 's2', type: 'tool', title: 'Tool Call: web_search', duration: '642ms', status: 'success', meta: '返回 8 条结果' },
      { id: 's3', type: 'model', title: 'Model Call: GPT-4.1', duration: '812ms', status: 'success', meta: '生成最终答案' }
    ]
  },
  {
    id: 'trace_1002',
    threadId: 'thr_AQK0091',
    agent: 'CodeAgent',
    duration: '3.18s',
    steps: 6,
    status: 'warning',
    startedAt: '2025-05-19 14:38:12',
    summary: '代码解释器首次超时，重试成功。',
    items: [
      { id: 's1', type: 'message', title: 'User Message', duration: '0ms', status: 'success', meta: '代码分析请求' },
      { id: 's2', type: 'tool', title: 'Tool Call: code_interpreter', duration: '2.8s', status: 'warning', meta: 'retry once' },
      { id: 's3', type: 'model', title: 'Model Call: Claude 3.5 Sonnet', duration: '1.24s', status: 'success', meta: '补全分析' }
    ]
  }
];

export const health = [
  { label: 'Normal', value: 132, percent: 82, color: 'success' },
  { label: 'Warning', value: 18, percent: 11, color: 'warning' },
  { label: 'Error', value: 7, percent: 6, color: 'failed' }
];

export const jsonPreview = {
  request_id: 'req_01HX2F8Z7V7J1P3Q6N8K5M2L7A',
  agent: 'SummarizeAgent',
  model: 'gpt-4o-mini',
  provider: 'openai',
  status: 'failed',
  latency_ms: 5210,
  tokens: {
    prompt: 812,
    completion: 433,
    total: 1245
  },
  cost_usd: 0.0056,
  error: 'Rate limit exceeded'
};

/* ---------- 评测中心 Evaluation Center ---------- */

export const evalSummary: EvalSummary = {
  healthScore: 86,
  taskCompletionRate: 85.3,
  securityScore: 72,
  avgLatency: '2.8s',
  toolSuccessRate: 96.7,
  activeAgents: 12
};

export const taskQualityStats: TaskQualityStats = {
  totalTasks: 8421,
  completionRate: 85.3,
  failureRate: 9.6,
  humanInterventionRate: 5.1
};

export const toolReliabilityStats: ToolReliabilityStats[] = [
  { name: 'web_search', category: 'Retrieval', calls: 18320, successRate: 98.4, avgLatency: '642ms', p95Latency: '1.2s', failureRate: 1.6 },
  { name: 'code_interpreter', category: 'Compute', calls: 9220, successRate: 96.2, avgLatency: '2.8s', p95Latency: '7.1s', failureRate: 3.8 },
  { name: 'sql_query', category: 'Database', calls: 7420, successRate: 97.1, avgLatency: '412ms', p95Latency: '1.0s', failureRate: 2.9 },
  { name: 'file_reader', category: 'IO', calls: 5210, successRate: 99.2, avgLatency: '223ms', p95Latency: '610ms', failureRate: 0.8 },
  { name: 'vector_search', category: 'Retrieval', calls: 4821, successRate: 98.8, avgLatency: '384ms', p95Latency: '902ms', failureRate: 1.2 }
];

export const agentRanking: AgentRankingItem[] = [
  { rank: 1, name: 'ResearchAgent', score: 92.4, tasks: 28430, successRate: 98.9, status: 'normal' },
  { rank: 2, name: 'TranslateAgent', score: 90.8, tasks: 10922, successRate: 99.1, status: 'normal' },
  { rank: 3, name: 'DataAnalyst', score: 88.2, tasks: 22104, successRate: 98.1, status: 'normal' },
  { rank: 4, name: 'CodeAgent', score: 82.6, tasks: 18321, successRate: 96.4, status: 'warning' },
  { rank: 5, name: 'SummarizeAgent', score: 74.1, tasks: 16781, successRate: 91.2, status: 'error' }
];

export const alerts: AlertItem[] = [
  { id: 'alert_001', level: 'high', title: 'SummarizeAgent 成功率跌破 92%，接近服务降级阈值', type: 'Agent 健康', time: '10 分钟前' },
  { id: 'alert_002', level: 'medium', title: 'code_interpreter P95 延迟 7.1s，超出 SLO 2.5 倍', type: '性能', time: '35 分钟前' },
  { id: 'alert_003', level: 'low', title: '本地 Llama 节点 GPU 繁忙，平均推理耗时上升 18%', type: '资源', time: '1 小时前' }
];

export const evalHistory: EvalHistoryItem[] = [
  { id: 'eval_240601', name: '6 月回归评测', scope: '全部 Agent', score: 86, status: 'success', startedAt: '2025-06-01 02:00', duration: '42m' },
  { id: 'eval_240525', name: '知识库检索专项', scope: 'ResearchAgent', score: 91, status: 'success', startedAt: '2025-05-25 09:30', duration: '18m' },
  { id: 'eval_240518', name: '代码生成基准', scope: 'CodeAgent', score: 74, status: 'warning', startedAt: '2025-05-18 15:00', duration: '1h 05m' },
  { id: 'eval_240511', name: '多轮对话稳定性', scope: '对话型 Agent', score: 83, status: 'success', startedAt: '2025-05-11 11:20', duration: '26m' },
  { id: 'eval_240504', name: '5 月回归评测', scope: '全部 Agent', score: 81, status: 'warning', startedAt: '2025-05-04 02:00', duration: '39m' }
];

export const taskTrend = [
  { label: '6/1', completed: 620, failed: 74, intervened: 42 },
  { label: '6/2', completed: 688, failed: 61, intervened: 39 },
  { label: '6/3', completed: 715, failed: 68, intervened: 45 },
  { label: '6/4', completed: 742, failed: 55, intervened: 36 },
  { label: '6/5', completed: 769, failed: 82, intervened: 51 },
  { label: '6/6', completed: 781, failed: 70, intervened: 40 },
  { label: '6/7', completed: 804, failed: 77, intervened: 43 }
];

export const toolTrend = [
  { label: '6/1', web_search: 2420, code_interpreter: 1210, sql_query: 980, file_reader: 640 },
  { label: '6/2', web_search: 2580, code_interpreter: 1280, sql_query: 1030, file_reader: 682 },
  { label: '6/3', web_search: 2710, code_interpreter: 1340, sql_query: 1090, file_reader: 706 },
  { label: '6/4', web_search: 2890, code_interpreter: 1420, sql_query: 1150, file_reader: 731 },
  { label: '6/5', web_search: 3040, code_interpreter: 1500, sql_query: 1210, file_reader: 764 },
  { label: '6/6', web_search: 3180, code_interpreter: 1560, sql_query: 1270, file_reader: 782 },
  { label: '6/7', web_search: 3320, code_interpreter: 1620, sql_query: 1330, file_reader: 803 }
];

export const failureReasons = [
  { label: '模型输出格式不符', value: 214, sub: '23.4%' },
  { label: '工具调用超时', value: 168, sub: '18.4%' },
  { label: '上下文长度超限', value: 121, sub: '13.2%' },
  { label: '外部 API 限流', value: 96, sub: '10.5%' },
  { label: '知识库检索无结果', value: 82, sub: '9.0%' },
  { label: '权限 / 认证失败', value: 64, sub: '7.0%' },
  { label: 'Prompt 注入被拦截', value: 47, sub: '5.1%' },
  { label: '输入参数非法', value: 39, sub: '4.3%' },
  { label: '网络抖动重试失败', value: 31, sub: '3.4%' },
  { label: '其他', value: 26, sub: '2.8%' }
];

export const taskDurationStats = [
  { label: 'P50', value: '1.8s' },
  { label: 'P95', value: '6.4s' },
  { label: 'P99', value: '11.2s' },
  { label: 'Max', value: '24.6s' }
];

export const taskRoleDetail = [
  { role: '内容创作', tasks: 1862, completed: 1612, successRate: 86.6, humanIntervention: 4.8 },
  { role: '数据分析', tasks: 1521, completed: 1289, successRate: 84.7, humanIntervention: 5.6 },
  { role: '代码开发', tasks: 1438, completed: 1194, successRate: 83.0, humanIntervention: 6.2 },
  { role: '客户支持', tasks: 1226, completed: 1087, successRate: 88.7, humanIntervention: 3.4 },
  { role: '文档处理', tasks: 1068, completed: 926, successRate: 86.7, humanIntervention: 4.2 },
  { role: '知识检索', tasks: 896, completed: 802, successRate: 89.5, humanIntervention: 3.1 }
];

/* ---------- 评测中心 Phase 2：安全中心 mock ---------- */

export const securitySummary = {
  score: 72,
  highVulns: 2,
  pendingFixes: 15,
  highNew: 1,
  pendingNew: 3,
  lastScan: '2 小时前'
};

export const vulnerabilities: Array<{
  id: string;
  level: 'high' | 'medium' | 'low';
  name: string;
  scope: string;
  foundAt: string;
  status: 'pending' | 'processing' | 'resolved' | 'ignored';
  category: string;
}> = [
  { id: 'vul_001', level: 'high', name: '知识库横向越权漏洞', scope: '所有用户知识库', foundAt: '2 小时前', status: 'pending', category: '越权检测' },
  { id: 'vul_002', level: 'high', name: 'MCP terminal 沙箱逃逸尝试', scope: 'MCP 工具', foundAt: '昨天', status: 'processing', category: '沙箱安全' },
  { id: 'vul_003', level: 'medium', name: '任务详情越权访问', scope: '协作任务', foundAt: '昨天', status: 'pending', category: '越权检测' },
  { id: 'vul_004', level: 'medium', name: 'Prompt 注入绕过系统指令', scope: '对话 Agent', foundAt: '3 天前', status: 'processing', category: '注入防护' },
  { id: 'vul_005', level: 'medium', name: '对话回复疑似泄露 API Key', scope: '对话日志', foundAt: '3 天前', status: 'pending', category: '数据泄露' },
  { id: 'vul_006', level: 'low', name: '会话 Token 过期时间过长', scope: '登录用户', foundAt: '3 天前', status: 'resolved', category: '会话安全' },
  { id: 'vul_007', level: 'low', name: '子 Agent 权限边界过宽', scope: '子 Agent', foundAt: '5 天前', status: 'resolved', category: '沙箱安全' },
  { id: 'vul_008', level: 'low', name: '配置文件中存在弱密钥占位', scope: '配置文件', foundAt: '5 天前', status: 'ignored', category: '密钥扫描' }
];

export const permissionMatrix = {
  roles: ['管理员', '普通用户', '访客', '子 Agent'],
  actions: ['读', '写', '删', '管理'],
  matrix: {
    管理员: { 读: 'allow', 写: 'allow', 删: 'allow', 管理: 'allow' },
    普通用户: { 读: 'allow', 写: 'allow', 删: 'deny', 管理: 'deny' },
    访客: { 读: 'allow', 写: 'deny', 删: 'deny', 管理: 'deny' },
    子Agent: { 读: 'warn', 写: 'warn', 删: 'deny', 管理: 'deny' }
  }
};

export const dataLeaks: Array<{
  id: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  source: string;
  description: string;
  foundAt: string;
  status: 'pending' | 'processing' | 'resolved' | 'ignored';
}> = [
  { id: 'leak_001', type: 'API Key', severity: 'high', source: '对话回复', description: '对话中检测到疑似 OpenAI API Key', foundAt: '3 天前', status: 'pending' },
  { id: 'leak_002', type: '邮箱地址', severity: 'medium', source: '日志', description: '日志中写入用户邮箱明文', foundAt: '4 天前', status: 'processing' },
  { id: 'leak_003', type: '密码', severity: 'high', source: '配置文件', description: '配置文件中存在明文数据库密码', foundAt: '1 周前', status: 'resolved' },
  { id: 'leak_004', type: '手机号', severity: 'low', source: '对话内容', description: '对话内容包含完整手机号', foundAt: '1 周前', status: 'ignored' }
];

export const securityAuditEvents: Array<{
  id: string;
  level: 'high' | 'medium' | 'low' | 'info';
  message: string;
  time: string;
}> = [
  { id: 'evt_001', level: 'high', message: '发现知识库横向越权漏洞', time: '14:30' },
  { id: 'evt_002', level: 'medium', message: 'Prompt 注入防护触发告警', time: '10:15' },
  { id: 'evt_003', level: 'info', message: '日度安全扫描完成', time: '09:00' },
  { id: 'evt_004', level: 'high', message: '检测到沙箱逃逸尝试', time: '昨天' },
  { id: 'evt_005', level: 'low', message: '会话 Token 过期策略已更新', time: '昨天' }
];

/* ---------- 评测中心 Phase 2：性能基准 mock ---------- */

export const performanceSummary = {
  p50: 1.2,
  p95: 3.8,
  p99: 8.5,
  peakQps: 45,
  p50Delta: -0.3,
  p95Delta: -0.5,
  p99Delta: -1.2,
  qpsDelta: 8,
  lastTest: '昨天'
};

export const latencyDistribution: Array<{ label: string; count: number }> = [
  { label: '<0.5s', count: 120 },
  { label: '0.5-1s', count: 260 },
  { label: '1-2s', count: 420 },
  { label: '2-3s', count: 310 },
  { label: '3-5s', count: 180 },
  { label: '5-8s', count: 80 },
  { label: '>8s', count: 24 }
];

export const latencyTrend: Array<{ label: string; p50: number; p95: number; p99: number }> = [
  { label: '周一', p50: 1.4, p95: 4.2, p99: 9.1 },
  { label: '周二', p50: 1.3, p95: 4.0, p99: 8.8 },
  { label: '周三', p50: 1.2, p95: 3.9, p99: 8.6 },
  { label: '周四', p50: 1.3, p95: 4.1, p99: 9.0 },
  { label: '周五', p50: 1.2, p95: 3.8, p99: 8.5 },
  { label: '周六', p50: 1.1, p95: 3.6, p99: 8.0 },
  { label: '周日', p50: 1.2, p95: 3.8, p99: 8.5 }
];

export const moduleLatency: Array<{ module: string; latency: number; p95: number }> = [
  { module: '对话生成', latency: 1.5, p95: 3.2 },
  { module: '工具调用', latency: 0.8, p95: 2.1 },
  { module: '知识库检索', latency: 0.3, p95: 0.9 },
  { module: '消息推送', latency: 0.1, p95: 0.3 }
];

export const versionCompare: Array<{ version: string; p95: number; delta: number }> = [
  { version: 'v0.3.9', p95: 4.3, delta: 0 },
  { version: 'v0.4.0', p95: 3.8, delta: -0.5 },
  { version: 'v0.4.1', p95: 3.5, delta: -0.3 }
];

export const errorStats = {
  total: 42,
  errorRate: 1.8,
  byType: [
    { type: '超时', count: 18 },
    { type: '限流', count: 12 },
    { type: '解析错误', count: 7 },
    { type: '服务异常', count: 5 }
  ]
};

/* ---------- 评测中心 Phase 2：评测管理 mock ---------- */

export const evalRuns: Array<{
  id: string;
  name: string;
  type: 'smoke' | 'full' | 'security' | 'performance' | 'custom';
  status: 'pending' | 'running' | 'completed' | 'failed';
  passRate: number;
  duration: string;
  executedAt: string;
  progress?: number;
}> = [
  { id: 'eval_240601', name: '6 月回归评测', type: 'full', status: 'completed', passRate: 86, duration: '42m', executedAt: '2025-06-01 02:00' },
  { id: 'eval_240530', name: 'v0.4.1 冒烟测试', type: 'smoke', status: 'completed', passRate: 100, duration: '32s', executedAt: '2025-05-30 10:00' },
  { id: 'eval_240528', name: '安全周度审计', type: 'security', status: 'completed', passRate: 78, duration: '8m', executedAt: '2025-05-28 09:30' },
  { id: 'eval_240526', name: '性能基准测试', type: 'performance', status: 'completed', passRate: 95, duration: '15m', executedAt: '2025-05-26 14:00' },
  { id: 'eval_240525', name: '知识库检索专项', type: 'custom', status: 'completed', passRate: 91, duration: '18m', executedAt: '2025-05-25 09:30' },
  { id: 'eval_240522', name: '全量回归测试', type: 'full', status: 'failed', passRate: 72, duration: '25m', executedAt: '2025-05-22 16:00' },
  { id: 'eval_240520', name: '正在进行中的评测', type: 'smoke', status: 'running', passRate: 0, duration: '—', executedAt: '2025-05-20 11:00', progress: 62 },
  { id: 'eval_240518', name: '代码生成基准', type: 'performance', status: 'completed', passRate: 74, duration: '1h 05m', executedAt: '2025-05-18 15:00' }
];

export const evalRunDetail = {
  id: 'eval_240601',
  name: '6 月回归评测',
  type: 'full' as const,
  status: 'completed' as const,
  passRate: 86,
  duration: '42m',
  startedAt: '2025-06-01 02:00',
  triggeredBy: '手动',
  dimensions: [
    { name: '业务质量', score: 88, status: 'success' as const },
    { name: '性能', score: 92, status: 'success' as const },
    { name: '安全', score: 78, status: 'warning' as const },
    { name: '稳定性', score: 85, status: 'success' as const }
  ],
  cases: [
    { id: 'B001', name: '任务完成率统计', category: '业务', status: 'success' as const },
    { id: 'B002', name: '任务平均耗时', category: '业务', status: 'success' as const },
    { id: 'B003', name: '工具调用成功率', category: '业务', status: 'warning' as const, message: 'code_interpreter 成功率 96.2%，略低于目标' },
    { id: 'S001', name: '横向越权-知识库', category: '安全', status: 'failed' as const, message: '检测到横向越权漏洞，待修复' },
    { id: 'P001', name: '对话响应 P50/P95', category: '性能', status: 'success' as const },
    { id: 'T001', name: '错误率统计', category: '稳定', status: 'success' as const }
  ]
};

export const evalCases: Array<{
  id: string;
  name: string;
  category: string;
  level: string;
  description: string;
  severity: string;
  enabled: boolean;
}> = [
  { id: 'B001', name: '任务完成率统计', category: 'business', level: 'smoke', description: '统计周期内任务完成率', severity: 'medium', enabled: true },
  { id: 'B002', name: '任务平均耗时', category: 'business', level: 'smoke', description: 'P50/P95/P99 耗时', severity: 'medium', enabled: true },
  { id: 'B003', name: '工具调用成功率', category: 'business', level: 'smoke', description: '各工具成功率排行', severity: 'medium', enabled: true },
  { id: 'S001', name: '横向越权-知识库', category: 'security', level: 'smoke', description: '用户A能否访问用户B的知识库', severity: 'high', enabled: true },
  { id: 'S004', name: '垂直越权-管理接口', category: 'security', level: 'full', description: '普通用户能否调用管理员API', severity: 'high', enabled: true },
  { id: 'P001', name: '对话响应 P50/P95', category: 'performance', level: 'smoke', description: '对话响应延迟分布', severity: 'medium', enabled: true }
];

/* ---------- 评测中心 Phase 2：评测计划 & 告警 mock ---------- */

export const evalSchedules: Array<{
  id: string;
  name: string;
  type: 'smoke' | 'full' | 'security' | 'performance' | 'custom';
  frequency: string;
  nextRun: string;
  enabled: boolean;
  lastRun?: string;
}> = [
  { id: 'sch_001', name: '每日冒烟测试', type: 'smoke', frequency: '每天 9:00', nextRun: '明天 9:00', enabled: true, lastRun: '今天 9:00' },
  { id: 'sch_002', name: '周度安全审计', type: 'security', frequency: '每周一 10:00', nextRun: '下周一 10:00', enabled: true, lastRun: '本周一 10:00' },
  { id: 'sch_003', name: '月度性能基准测试', type: 'performance', frequency: '每月 1 号 02:00', nextRun: '下月 1 号 02:00', enabled: false, lastRun: '上月 1 号 02:00' }
];

export const alertRules: Array<{
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: string;
  severity: 'critical' | 'warning' | 'info';
  channels: string;
  enabled: boolean;
}> = [
  { id: 'rule_001', name: '任务完成率骤降告警', metric: '任务完成率', condition: '日环比', threshold: '< 80%', severity: 'critical', channels: '飞书+邮件', enabled: true },
  { id: 'rule_002', name: '高危漏洞告警', metric: '安全高危漏洞数', condition: '>', threshold: '0', severity: 'critical', channels: '电话+飞书', enabled: true },
  { id: 'rule_003', name: 'P95 延迟超标告警', metric: '对话 P95 延迟', condition: '>', threshold: '5s', severity: 'warning', channels: '飞书', enabled: true },
  { id: 'rule_004', name: '工具成功率下降告警', metric: '工具成功率', condition: '<', threshold: '90%', severity: 'warning', channels: '邮件', enabled: false }
];
