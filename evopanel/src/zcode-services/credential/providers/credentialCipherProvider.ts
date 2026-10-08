import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultCredentialSecret(env: NodeJS.ProcessEnv): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
  const key = deriveCipherKey(defaultCredentialSecret(env));

  return {
    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        bufferToBase64url(iv),
        ".",
        bufferToBase64url(authTag),
        ".",
        bufferToBase64url(encrypted),
      ].join("");
    },

    decrypt(value: string): string {
      if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }

      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw createCredentialDecryptError("密文格式非法");
      }

      const iv = base64urlToBuffer(ivRaw);
      const authTag = base64urlToBuffer(authTagRaw);
      const cipherText = base64urlToBuffer(cipherRaw);

      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw createCredentialDecryptError("IV 长度非法");
      }

      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw createCredentialDecryptError("AuthTag 长度非法");
      }

      const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      try {
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch {
        throw createCredentialDecryptError("密钥不匹配或密文已损坏");
      }
    },
  };
}
