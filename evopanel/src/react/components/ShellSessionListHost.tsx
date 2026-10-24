import { memo } from 'react'
import { ShellSessionListPortal } from './ShellSessionListPortal.js'
import {
  useShellSessionListBridge,
  type UseShellSessionListBridgeOptions,
} from '../hooks/useShellSessionListBridge.js'

type ShellSessionListHostProps = UseShellSessionListBridgeOptions

function ShellSessionListHostInner(props: ShellSessionListHostProps) {
  const { shellListProps } = useShellSessionListBridge(props)
  return <ShellSessionListPortal {...shellListProps} />
}

/**
 * ChatApp 流式重绘时：props 未变则侧栏不进 reconcile，hover / 转圈不跟气泡抢主线程。
 * 齿轮起停由 bridge 内订阅 executingListEpoch（与 Composer 停止同源），不依赖本 memo 的 props。
 */
export const ShellSessionListHost = memo(ShellSessionListHostInner)
