import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const serialized = JSON.stringify(config);
const failures = [];
const alistD1Id = "d10d3411-16e3-4e2d-950e-da185a6c0e40";
const forbiddenTvboxResourceIds = new Set([
  "f975b8a7-07ca-4d01-bb99-ed2559e0ecfa",
]);
if (serialized.includes("REPLACE_WITH_")) failures.push("仍有 REPLACE_WITH_ 占位符");
if (serialized.includes("00000000-0000-0000-0000-000000000000")) {
  failures.push("D1 database_id 仍为全零哨兵");
}
if (serialized.includes('"store_id":"00000000000000000000000000000000"')) {
  failures.push("AList 自有 Secrets Store ID 仍为全零哨兵");
}
if (config.name !== "alistserver-tf-automation") failures.push("Worker 名称不是 AList 专用名称");
if (
  config.vars?.PUBLIC_ORIGIN !== "https://alistserver.99999987.xyz" ||
  config.routes?.length !== 1 ||
  config.routes[0]?.pattern !== "alistserver.99999987.xyz" ||
  config.routes[0]?.custom_domain !== true
) {
  failures.push("公开域名或 Worker route 不是 AListServer 专用域名");
}
if (config.vars?.BUNDLE_ID !== "com.gendago.alist") {
  failures.push("Bundle ID 不是 AListServer");
}
const databases = config.d1_databases ?? [];
if (
  databases.length !== 1 ||
  databases[0]?.binding !== "DB" ||
  databases[0]?.database_name !== "alistserver-tf-automation" ||
  databases[0]?.database_id !== alistD1Id ||
  databases[0]?.migrations_dir !== "./migrations"
) {
  failures.push("D1 必须唯一且精确绑定 AList 专属 DB 名称、ID 和 migration 目录");
}
for (const database of databases) {
  if (forbiddenTvboxResourceIds.has(database.database_id)) {
    failures.push("D1 database_id 错误指向 tvbox 资源");
  }
}
const sharedStore = "ea5dd611ede94e1fbad424b9d21d9e9f";
const allowedSharedBindings = new Set([
  "APPLE_ISSUER_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "ASC_ISSUER_ID",
  "ASC_KEY_ID",
  "ASC_PRIVATE_KEY",
  "TURNSTILE_SECRET",
  "TRANSACTION_HASH_SECRET",
  "EMAIL_DATA_SECRET",
  "IP_HASH_SECRET",
]);
const requiredAListCoreSecretNames = new Map([
  ["TURNSTILE_SECRET", "ALIST_TF_TURNSTILE_SECRET"],
  ["TRANSACTION_HASH_SECRET", "ALIST_TF_TRANSACTION_HASH_SECRET"],
  ["EMAIL_DATA_SECRET", "ALIST_TF_EMAIL_DATA_SECRET"],
  ["IP_HASH_SECRET", "ALIST_TF_IP_HASH_SECRET"],
]);
const requiredAListSecretNames = new Map([
  ...requiredAListCoreSecretNames,
]);
const requiredAppleSecretNames = new Map([
  ["APPLE_ISSUER_ID", "IAP_ISSUER_ID"],
  ["APPLE_KEY_ID", "IAP_KEY_ID"],
  ["APPLE_PRIVATE_KEY", "IAP_PRIVATE_KEY"],
  ["ASC_ISSUER_ID", "ASC_ISSUER_ID"],
  ["ASC_KEY_ID", "ASC_KEY_ID"],
  ["ASC_PRIVATE_KEY", "ASC_PRIVATE_KEY"],
]);
for (const [bindingName, requiredSecretName] of requiredAppleSecretNames) {
  const matches = (config.secrets_store_secrets ?? []).filter(
    (binding) => binding.binding === bindingName,
  );
  if (matches.length !== 1) {
    failures.push(`缺少或重复定义 Apple/ASC secret binding ${bindingName}`);
  } else if (
    matches[0].secret_name !== requiredSecretName ||
    matches[0].store_id !== sharedStore
  ) {
    failures.push(`Apple/ASC binding ${bindingName} 未绑定到预期 secret`);
  }
}
for (const [bindingName, requiredSecretName] of requiredAListSecretNames) {
  const matches = (config.secrets_store_secrets ?? []).filter(
    (binding) => binding.binding === bindingName,
  );
  if (matches.length !== 1) {
    failures.push(`缺少或重复定义必需 secret binding ${bindingName}`);
  } else if (
    matches[0].secret_name !== requiredSecretName ||
    matches[0].store_id !== sharedStore
  ) {
    failures.push(`secret binding ${bindingName} 未绑定到正确的 AList 专属 secret`);
  }
}
for (const binding of config.secrets_store_secrets ?? []) {
  if (binding.store_id === sharedStore && !allowedSharedBindings.has(binding.binding)) {
    failures.push(`AList 业务 secret ${binding.binding} 错误指向共享验证密钥 Store`);
  }
  const requiredName = requiredAListSecretNames.get(binding.binding);
  if (requiredName && binding.secret_name !== requiredName) {
    failures.push(`AList 业务 secret ${binding.binding} 未使用专用名称 ${requiredName}`);
  }
}
if (
  config.vars?.CF_ACCESS_TEAM_DOMAIN !== undefined ||
  (config.secrets_store_secrets ?? []).some(
    (binding) => binding.binding === "CF_ACCESS_AUD" || binding.binding === "ADMIN_API_SECRET",
  )
) {
  failures.push("仍残留 Cloudflare Access 或常驻管理 API 密钥配置");
}
if (
  !Array.isArray(config.triggers?.crons) ||
  config.triggers.crons.length !== 2 ||
  !config.triggers.crons.includes("*/5 * * * *") ||
  !config.triggers.crons.includes("17 3 * * *")
) {
  failures.push("未正确配置 AList Worker 的 5 分钟恢复 Cron 和每日 retention Cron");
}
if (serialized.includes("FEISHU_")) {
  failures.push("生产配置不得保留飞书变量或 secret binding");
}
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("AListServer 生产资源隔离配置检查通过。");
}
