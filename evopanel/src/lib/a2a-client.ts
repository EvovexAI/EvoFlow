/**
 * A2A Client - frontend SDK for the A2A (Agent-to-Agent) protocol.
 *
 * Provides:
 * - JSON-RPC `tasks/send` via fetch
 * - SSE subscription via EventSource for streaming task updates
 * - REST helpers for meetings API
 *
 * Usage:
 *   const client = new A2AClient()
 *   const task = await client.sendTask('project-architect', 'mt_xxx', '讨论登录页重构')
 *   const unsub = client.subscribeToTask('project-architect', task.id, {
 *     onMessage: (delta) => ...,
 *     onComplete: (finalText) => ...,
 *   })
 */

// ── Types ──────────────────────────────────────────────────

export interface A2ATaskStatus {
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed'
  timestamp: string
  message?: { role: string; parts: { type: string; text: string }[] }
}

export interface A2ATask {
  id: string
  sessionId: string
  status: A2ATaskStatus
  messages?: unknown[]
  agent_code: string
  role_name: string
  subscribeUrl: string
}

export interface AgentCard {
  name: string
  description: string
  url: string
  agent_code: string
  version: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    stateTransitionHistory: boolean
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: {
    id: string
    name: string
    description: string
    tags: string[]
    examples: string[]
  }[]
  department: string
  workspace: string
  model: string
  tools: string[]
}

export interface MeetingParticipant {
  agent_code: string
  role_name: string
  agent_card: AgentCard | null
}

export interface MeetingMessage {
  id: string
  speakerAgentCode: string | null
  speakerRoleName: string | null
  text: string
  timestamp: number
  taskId?: string
  artifacts?: { name: string; content: string }[]
  streaming?: boolean
  error?: boolean
}

export interface SubscribeCallbacks {
  onMessage: (text: string) => void
  onArtifact?: (name: string, content: string) => void
  onComplete: (finalText: string) => void
  onError: (error: string) => void
}

// ── A2A Client ─────────────────────────────────────────────

export class A2AClient {
  private baseUrl: string = ''

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || ''
  }

  /** Set or update the gateway base URL (for Tauri builds). */
  setBaseUrl(url: string): void {
    this.baseUrl = url || ''
  }

  private apiUrl(path: string): string {
    const base = this.baseUrl || ''
    return `${base}${path}`
  }

  // ── Agent Card discovery ──────────────────────────────

  /** GET /.well-known/agent.json - list all agent cards. */
  async listAgents(): Promise<AgentCard[]> {
    const resp = await fetch(this.apiUrl('/.well-known/agent.json'))
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    return Array.isArray(data?.agents) ? data.agents : []
  }

  /** GET /api/a2a/agents - list all agent cards (panel endpoint). */
  async listAgentsPanel(): Promise<AgentCard[]> {
    const resp = await fetch(this.apiUrl('/api/a2a/agents'))
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    return Array.isArray(data?.agents) ? data.agents : []
  }

  // ── JSON-RPC tasks/send ───────────────────────────────

  /**
   * Send an A2A Task to an agent via JSON-RPC `tasks/send`.
   * Returns the A2A Task object (with id + subscribeUrl).
   */
  async sendTask(
    agentCode: string,
    sessionId: string,
    text: string,
    contextSummary = '',
  ): Promise<A2ATask> {
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'tasks/send',
      params: {
        sessionId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text }],
        },
        metadata: {
          context_summary: contextSummary,
          source: 'meeting_ui',
          from_agent: 'user',
          meeting_id: sessionId,
        },
      },
      id: crypto.randomUUID(),
    }

    const resp = await fetch(this.apiUrl(`/api/a2a/${agentCode}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
    })

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const rpcResp = await resp.json()

    if (rpcResp.error) {
      throw new Error(rpcResp.error.message || 'RPC error')
    }

    return rpcResp.result?.task
  }

  // ── JSON-RPC tasks/get ────────────────────────────────

  /** Query a task's status and messages. */
  async getTask(agentCode: string, taskId: string): Promise<unknown> {
    const rpcRequest = {
      jsonrpc: '2.0',
      method: 'tasks/get',
      params: { taskId },
      id: crypto.randomUUID(),
    }

    const resp = await fetch(this.apiUrl(`/api/a2a/${agentCode}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
    })

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const rpcResp = await resp.json()
    return rpcResp.result
  }

  // ── SSE subscription ──────────────────────────────────

  /**
   * Subscribe to a Task's SSE stream for real-time updates.
   * Returns an unsubscribe function.
   */
  subscribeToTask(
    agentCode: string,
    taskId: string,
    callbacks: SubscribeCallbacks,
  ): () => void {
    const url = this.apiUrl(`/api/a2a/${agentCode}/tasks/${taskId}/stream`)
    const eventSource = new EventSource(url)

    eventSource.addEventListener('task:message', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        const parts = data?.message?.parts || []
        for (const part of parts) {
          if (part.type === 'text') {
            callbacks.onMessage(part.text)
          }
        }
      } catch {
        // ignore parse errors
      }
    })

    eventSource.addEventListener('task:artifact', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        const artifact = data?.artifact
        if (artifact && callbacks.onArtifact) {
          const content = artifact.parts?.[0]?.text || ''
          callbacks.onArtifact(artifact.name || 'unknown', content)
        }
      } catch {
        // ignore
      }
    })

    eventSource.addEventListener('task:completed', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        const finalText = data?.finalText || data?.status?.message?.parts?.[0]?.text || ''
        callbacks.onComplete(finalText)
      } catch {
        callbacks.onComplete('')
      }
      eventSource.close()
    })

    eventSource.addEventListener('task:failed', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        callbacks.onError(data?.error || 'task failed')
      } catch {
        callbacks.onError('task failed')
      }
      eventSource.close()
    })

    eventSource.onerror = () => {
      callbacks.onError('connection error')
      eventSource.close()
    }

    return () => {
      eventSource.close()
    }
  }

  // ── Meetings REST API ─────────────────────────────────

  /** Create a new meeting. */
  async createMeeting(
    title: string,
    participants: string[],
    sessionKey = '',
  ): Promise<{ meeting_id: string; participants: MeetingParticipant[] }> {
    const resp = await fetch(this.apiUrl('/api/meetings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, participants, session_key: sessionKey }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }

  /** Get meeting details. */
  async getMeeting(meetingId: string): Promise<{
    meeting_id: string
    title: string
    status: string
    participants: MeetingParticipant[]
  }> {
    const resp = await fetch(this.apiUrl(`/api/meetings/${meetingId}`))
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }

  /** Start a discussion round (serial dispatch to all participants). */
  async startDiscussion(
    meetingId: string,
    topic: string,
    speakerOrder?: string[],
  ): Promise<{
    meeting_id: string
    turn_id: string
    topic: string
    speaker_order: string[]
    status: string
  }> {
    const resp = await fetch(this.apiUrl(`/api/meetings/${meetingId}/discuss`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, speaker_order: speakerOrder }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }

  /** @mention a specific participant. */
  async mentionParticipant(
    meetingId: string,
    agentCode: string,
    text: string,
  ): Promise<{ agent_code: string; role_name: string; task: A2ATask }> {
    const resp = await fetch(this.apiUrl(`/api/meetings/${meetingId}/mention`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_code: agentCode, text }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }

  /** List all discussion turns. */
  async listTurns(meetingId: string): Promise<unknown> {
    const resp = await fetch(this.apiUrl(`/api/meetings/${meetingId}/turns`))
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }

  /** List all A2A tasks for a meeting. */
  async listMeetingTasks(meetingId: string): Promise<unknown> {
    const resp = await fetch(this.apiUrl(`/api/meetings/${meetingId}/tasks`))
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }
}
