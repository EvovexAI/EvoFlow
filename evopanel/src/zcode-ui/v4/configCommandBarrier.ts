interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

/**
 * 配置命令与发送命令之间的顺序屏障。
 *
 * 模式/模型选择先乐观更新 UI，再异步提交 CAS；用户紧接着发送时，
 * sendText 可能先于 CAS 重试完成，导致界面显示新配置而 runtime 仍使用旧配置。
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}
