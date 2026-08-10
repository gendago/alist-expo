const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const response = await fetch(
    "https://alistserver.99999987.xyz/health",
    { signal: controller.signal, redirect: "error" },
  );
  const body = await response.json();
  if (
    !response.ok ||
    body?.ok !== true ||
    body?.app !== "AListServer" ||
    body?.configured !== true
  ) {
    throw new Error("生产健康检查返回了非预期状态");
  }
  console.log("AListServer Worker 生产健康检查通过。");
} finally {
  clearTimeout(timeout);
}
