/**
 * Static export: API routes and middleware are incompatible with `output: "export"`.
 * Temporarily stash them outside `src/app` (folders under app/ become routes), then restore.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const apiFrom = path.join(root, "src", "app", "api");
/** Must not live under src/app — Next would treat it as routes */
const apiHold = path.join(root, ".static-export-stash-api");
const mwFrom = path.join(root, "src", "middleware.ts");
const mwHold = path.join(root, ".static-export-stash-middleware.ts");
const loginActionsFrom = path.join(root, "src", "app", "admin", "login", "actions.ts");
const loginActionsHold = path.join(root, ".static-export-stash-login-actions.ts");

/** No "use server" — static export rejects Server Actions */
const LOGIN_ACTIONS_STATIC_STUB = `// Temporary stub for \`output: export\` build (restored after build)
export async function loginAction(
  _prev: { error?: string } | null,
  _formData: FormData,
): Promise<{ error?: string }> {
  return { error: "静态导出版不支持后台登录" };
}

export async function logoutAction(): Promise<void> {
  void 0;
}
`;

let hadApi = false;
let hadMw = false;
let hadLoginActions = false;

function stashApi() {
  if (!fs.existsSync(apiFrom)) return;
  if (fs.existsSync(apiHold)) fs.rmSync(apiHold, { recursive: true, force: true });
  fs.cpSync(apiFrom, apiHold, { recursive: true });
  fs.rmSync(apiFrom, { recursive: true, force: true });
  hadApi = true;
}

function restoreApi() {
  if (!hadApi) return;
  if (fs.existsSync(apiFrom)) fs.rmSync(apiFrom, { recursive: true, force: true });
  fs.cpSync(apiHold, apiFrom, { recursive: true });
  fs.rmSync(apiHold, { recursive: true, force: true });
  hadApi = false;
}

function stashMiddleware() {
  if (!fs.existsSync(mwFrom)) return;
  fs.copyFileSync(mwFrom, mwHold);
  fs.unlinkSync(mwFrom);
  hadMw = true;
}

function restoreMiddleware() {
  if (!hadMw) return;
  if (fs.existsSync(mwFrom)) fs.unlinkSync(mwFrom);
  fs.copyFileSync(mwHold, mwFrom);
  fs.unlinkSync(mwHold);
  hadMw = false;
}

function stashLoginActions() {
  if (!fs.existsSync(loginActionsFrom)) return;
  fs.copyFileSync(loginActionsFrom, loginActionsHold);
  fs.writeFileSync(loginActionsFrom, LOGIN_ACTIONS_STATIC_STUB, "utf8");
  hadLoginActions = true;
}

function restoreLoginActions() {
  if (!hadLoginActions) return;
  fs.copyFileSync(loginActionsHold, loginActionsFrom);
  fs.unlinkSync(loginActionsHold);
  hadLoginActions = false;
}

stashApi();
stashMiddleware();
stashLoginActions();

let exitCode = 1;
try {
  const r = spawnSync("npx", ["next", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, EVOFLOW_STATIC_EXPORT: "1" },
  });
  exitCode = r.status ?? 1;
} finally {
  restoreLoginActions();
  restoreApi();
  restoreMiddleware();
}
process.exit(exitCode);
