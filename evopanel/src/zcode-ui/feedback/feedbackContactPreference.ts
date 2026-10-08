const FEEDBACK_CONTACT_STORAGE_KEY = "zcode.feedback.contact";

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readFeedbackContactPreference(storage: Storage | null = getStorage()): string {
  if (!storage) return "";
  try {
    return storage.getItem(FEEDBACK_CONTACT_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function clearFeedbackContactPreference(storage: Storage | null = getStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(FEEDBACK_CONTACT_STORAGE_KEY);
  } catch {
    // localStorage 在隐私模式或 WebView 限制下可能不可用；联系方式记忆失败不能阻断反馈提交。
  }
}

export function persistFeedbackContactPreference(
  contact: string,
  storage: Storage | null = getStorage(),
): void {
  const normalized = contact.trim();
  if (!normalized) {
    clearFeedbackContactPreference(storage);
    return;
  }
  if (!storage) return;
  try {
    storage.setItem(FEEDBACK_CONTACT_STORAGE_KEY, normalized);
  } catch {
    // localStorage 在隐私模式或 WebView 限制下可能不可用；联系方式记忆失败不能阻断反馈提交。
  }
}

export function rememberFeedbackContactInput(
  contact: string,
  storage: Storage | null = getStorage(),
): string {
  persistFeedbackContactPreference(contact, storage);
  return contact;
}
