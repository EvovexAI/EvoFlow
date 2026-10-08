const REMOTE_CONNECTION_LOG_BOTTOM_THRESHOLD_PX = 2;

type RemoteConnectionLogViewport = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

export function isRemoteConnectionLogScrolledToLatest(
  viewport: RemoteConnectionLogViewport,
  thresholdPx = REMOTE_CONNECTION_LOG_BOTTOM_THRESHOLD_PX,
): boolean {
  const bottomScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return bottomScrollTop - viewport.scrollTop <= thresholdPx;
}

export function scrollRemoteConnectionLogsToLatestIfFollowing(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
  shouldFollowLatestLog: boolean,
): boolean {
  if (!shouldFollowLatestLog) {
    return false;
  }

  viewport.scrollTop = viewport.scrollHeight;
  return true;
}
