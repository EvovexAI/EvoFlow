/**
 * Paste-ready OpenAPI call examples for a published App workflow.
 * Mirrors backend ``build_example_chat_request`` sampling rules.
 */

const MESSAGE_ALIASES = new Set(['query', 'input', 'prompt'])

/**
 * @param {object} param
 * @returns {string}
 */
export function sampleParameterValue(param) {
  if (!param || typeof param !== 'object') return ''
  const def = param.default
  if (def != null && String(def).trim() !== '') return String(def)
  const opts = Array.isArray(param.options) ? param.options : []
  for (const opt of opts) {
    const text = String(opt || '').trim()
    if (text) return text
  }
  const ptype = String(param.type || 'text').trim().toLowerCase()
  const name = String(param.name || '').trim()
  const label = String(param.label || name || '示例').trim()
  if (ptype === 'number') return '1'
  if (ptype === 'textarea') return `示例内容：${label}`
  if (MESSAGE_ALIASES.has(name.toLowerCase())) return `请执行本工作流（${label}）`
  return `示例${label}`
}

/**
 * @param {object} app
 * @returns {Record<string, string>}
 */
export function buildExampleVariables(app) {
  const rows = Array.isArray(app?.parameters) ? app.parameters : []
  /** @type {Record<string, string>} */
  const out = {}
  for (const p of rows) {
    const name = String(p?.name || '').trim()
    if (!name) continue
    out[name] = sampleParameterValue(p)
  }
  return out
}

/**
 * @param {object} app
 * @param {Record<string, string>} [variables]
 */
export function buildExampleUserMessage(app, variables = {}) {
  for (const alias of MESSAGE_ALIASES) {
    const text = String(variables?.[alias] || '').trim()
    if (text) return text
  }
  const goal = String(app?.goal_template || app?.description || '').trim()
  const name = String(app?.name || '').trim()
  if (goal) {
    let clipped = goal.replace(/\n/g, ' ').trim()
    if (clipped.length > 120) clipped = `${clipped.slice(0, 117)}…`
    return `请按 variables 执行「${name || '工作流'}」：${clipped}`
  }
  if (name) return `请按 variables 执行工作流「${name}」`
  return '请按 variables 执行本工作流'
}

/**
 * @param {object} opts
 * @param {string} opts.appId
 * @param {object} opts.app
 * @param {Record<string, string>} [opts.variables]
 * @param {boolean} [opts.detail]
 * @param {boolean} [opts.stream]
 * @param {boolean} [opts.asyncMode]
 */
export function buildExampleChatRequest({
  appId,
  app,
  variables,
  detail = true,
  stream = false,
  asyncMode = false,
}) {
  const vars = variables && typeof variables === 'object' ? { ...variables } : buildExampleVariables(app)
  /** @type {Record<string, unknown>} */
  const body = {
    model: String(appId || '').trim(),
    stream: !!stream,
    detail: !!detail,
    messages: [{ role: 'user', content: buildExampleUserMessage(app, vars) }],
    variables: vars,
  }
  if (asyncMode) {
    body.async = true
    body.stream = false
  }
  return body
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  e.g. http://host:8012/v1
 * @param {string} opts.apiKey
 * @param {object} opts.body
 */
export function buildCurlSync({ baseUrl, apiKey, body }) {
  const root = String(baseUrl || '').replace(/\/+$/, '')
  const key = String(apiKey || 'ef-YOUR_API_KEY')
  const json = JSON.stringify(body, null, 2).replace(/'/g, `'\\''`)
  return `curl -X POST '${root}/chat/completions' \\
  -H 'Authorization: Bearer ${key}' \\
  -H 'Content-Type: application/json' \\
  -d '${json}'`
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {object} opts.body  sync-shaped; async flag forced
 */
export function buildCurlAsync({ baseUrl, apiKey, body }) {
  const root = String(baseUrl || '').replace(/\/+$/, '')
  const key = String(apiKey || 'ef-YOUR_API_KEY')
  const asyncBody = { ...body, async: true, stream: false }
  const json = JSON.stringify(asyncBody, null, 2).replace(/'/g, `'\\''`)
  return `# 1) 异步启动
curl -X POST '${root}/chat/completions' \\
  -H 'Authorization: Bearer ${key}' \\
  -H 'Content-Type: application/json' \\
  -d '${json}'
# 2) 轮询（detail=true 拿分步 / agent）
curl -H 'Authorization: Bearer ${key}' '${root}/runs/{run_id}?detail=true'`
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.appId
 * @param {Record<string, string>} opts.variables
 * @param {string} opts.userMessage
 */
export function buildPythonSdk({ baseUrl, apiKey, appId, variables, userMessage }) {
  const root = String(baseUrl || '').replace(/\/+$/, '')
  const key = String(apiKey || 'ef-YOUR_API_KEY')
  const varsJson = JSON.stringify(variables || {}, null, 4)
  const msg = JSON.stringify(String(userMessage || '请按 variables 执行本工作流'))
  return `from openai import OpenAI

client = OpenAI(api_key="${key}", base_url="${root}")
# 契约 + 可直接跑通的示例请求体
model = client.models.retrieve("${appId}")
print(getattr(model, "example_request", None) or getattr(model, "evoflow", {}))

resp = client.chat.completions.create(
    model="${appId}",
    messages=[{"role": "user", "content": ${msg}}],
    extra_body={"variables": ${varsJson}, "detail": True},
)
print(resp.choices[0].message.content)
raw = resp.model_dump() if hasattr(resp, "model_dump") else {}
print(raw.get("responseData") or (raw.get("evoflow") or {}).get("flowResponses"))`
}

/**
 * @param {object} opts
 * @param {string} opts.appId
 * @param {object} opts.app
 * @param {boolean} [opts.detail]
 */
export function buildExampleChatResponse({ appId, app, detail = true }) {
  const steps = Array.isArray(app?.steps)
    ? app.steps
    : Array.isArray(app?.plan?.steps)
      ? app.plan.steps
      : []
  const rows = steps
    .filter((s) => s && typeof s === 'object')
    .map((step, idx) => {
      const ref = String(step.ref || idx + 1).trim() || String(idx + 1)
      const name = String(step.name || '').trim() || `步骤${ref}`
      const agent = String(
        step.assigned_agent || step.assigned_to || step.agent_id || '',
      ).trim()
      return {
        moduleName: name,
        moduleType: 'agentStep',
        ref,
        assigned_agent: agent,
        agent,
        name,
        status: 'completed',
        result_summary: `（示例）${name} 的输出摘要`,
        error_text: '',
        subtask_id: `Sub_example_${ref}`,
        progress: 100,
      }
    })

  const answerRef = String(app?.answer_from_ref || app?.plan?.answer_from_ref || '').trim()
  let content = ''
  if (answerRef) {
    const hit = rows.find((r) => r.ref === answerRef)
    content = hit?.result_summary || `（示例）步骤 ${answerRef} 答案`
  } else if (rows.length) {
    content = rows[rows.length - 1].result_summary
  } else {
    content = `（示例）${String(app?.name || '工作流').trim() || '工作流'} 已完成`
  }

  /** @type {Record<string, unknown>} */
  const evoflow = {
    run_id: 'Run_example',
    app_id: String(appId || '').trim(),
  }
  if (app?.version != null) evoflow.app_version = app.version

  /** @type {Record<string, unknown>} */
  const resp = {
    id: 'chatcmpl-example',
    object: 'chat.completion',
    created: 0,
    model: String(appId || '').trim(),
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    evoflow,
  }
  if (detail) {
    resp.responseData = rows
    evoflow.flowResponses = rows
    evoflow.steps = rows
  }
  return resp
}

export function buildResponseContractSummary() {
  return {
    'choices[0].message.content': '对外答案（单字符串）',
    'responseData[].assigned_agent': '该步 Agent 标识（detail=true）',
    'responseData[].ref': '步骤编号',
    'responseData[].result_summary': '该步输出摘要',
    'evoflow.run_id': '异步轮询 / 排障用',
    'evoflow.flowResponses': '同 responseData',
    note: 'usage 恒为 0；非完整 OpenAI 语义',
  }
}
