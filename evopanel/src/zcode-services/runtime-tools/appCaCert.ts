import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "../paths.js";

// app 场景的自签 CA（区别于 debug 抓包代理那套，仅 debug 环境用）。
// 程序首次启动时生成一份自签根 CA，公钥证书供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任，
// 私钥供出口代理做 TLS 重签。已存在则原样复用，保证证书指纹稳定、被信任后不漂移。

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

function getAppCaCertPaths(): AppCaCertPaths {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, APP_CA_CERT_FILE),
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * 确保 app 自签 CA 存在；缺失时生成一份。返回证书（公钥）路径。
 * 幂等：证书与私钥都已存在时直接返回，不重新生成。
 */
export function ensureAppCaCert(): string {
  const { certPath, keyPath } = getAppCaCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // 私钥含敏感材料，权限收紧到 0600；公钥证书可读。
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return certPath;
}

function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(CA_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // 用密码学随机数做序列号，首字节清零避免被解析成负数。
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Network CA" },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // 自签：issuer == subject
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
