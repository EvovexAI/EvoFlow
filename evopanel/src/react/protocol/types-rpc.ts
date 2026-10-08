/**
 * Stub for ``@zcode/rpc`` — minimal placeholder.
 *
 * ZCode RPC layer: protocol transport over MessagePort / WebSocket.
 */

export interface ZCodeRpcEnvelope<T = unknown> {
  method: string
  payload: T
  requestId: string
}

export interface ZCodeRpcClient {
  call<TReq, TResp>(method: string, payload: TReq): Promise<TResp>
  subscribe?(method: string, listener: (payload: unknown) => void): () => void
}

export const zcodeRpc: ZCodeRpcClient = {
  async call<TReq, TResp>(_method: string, _payload: TReq): Promise<TResp> {
    return undefined as unknown as TResp
  },
}