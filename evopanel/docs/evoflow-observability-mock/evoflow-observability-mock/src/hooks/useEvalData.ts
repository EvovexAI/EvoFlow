import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataSource } from '../types';

interface EvalDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  dataSource: DataSource | null;
  reload: () => void;
}

/**
 * 统一的评测数据加载 hook：封装 useEffect + useState 模式。
 * - fn 返回 Promise<ApiResult<T>>（来自 evalApi 的 safeGet/safePost）
 * - 组件挂载即加载，reload 可手动刷新
 * - 自动清理防止卸载后 setState
 */
export function useEvalData<T>(fn: () => Promise<{ data: T; dataSource: DataSource }>, deps: unknown[] = []) {
  const [state, setState] = useState<Omit<EvalDataState<T>, 'reload'>>({
    data: null,
    loading: true,
    error: null,
    dataSource: null
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef.current()
      .then((res) => {
        if (cancelled) return;
        setState({ data: res.data, dataSource: res.dataSource, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, dataSource: null, loading: false, error: err?.message || '加载失败' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { ...state, reload };
}
