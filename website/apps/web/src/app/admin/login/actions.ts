// Temporary stub for `output: export` build (restored after build)
export async function loginAction(
  _prev: { error?: string } | null,
  _formData: FormData,
): Promise<{ error?: string }> {
  return { error: "静态导出版不支持后台登录" };
}

export async function logoutAction(): Promise<void> {
  void 0;
}
