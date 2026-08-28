import { importPKCS8, SignJWT } from "jose";
import { AppError } from "./errors";
import { readSecret } from "./secrets";

const ORIGIN = "https://api.appstoreconnect.apple.com";
const TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 512 * 1024;
const MAX_PAGES = 10;
const MAX_RESOURCES = 1_000;
const MAX_TESTER_MATCHES = 5;
const RELATIONSHIP_WAIT_ATTEMPTS = 6;
const RELATIONSHIP_WAIT_MS = 500;

interface ResourceIdentifier {
  id: string;
  type: string;
}

interface Relationship {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
}

interface Resource extends ResourceIdentifier {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, Relationship>;
}

interface Document {
  data?: Resource | Resource[];
  links?: { next?: string | null };
  errors?: Array<{
    status?: string;
    code?: string;
    detail?: string;
    title?: string;
  }>;
}

export interface BetaTester {
  id: string;
  email: string;
  state: string | null;
  appIds: string[];
  groupIds: string[];
}

/** 仅保存可安全写入日志的 ASC 元数据，不包含 Apple detail 或邮箱。 */
export class AscErrorCause extends Error {
  constructor(
    readonly httpStatus: number | null,
    readonly ascCode: string | null,
    options?: ErrorOptions,
  ) {
    super(ascCode ?? "asc_error", options);
    this.name = "AscErrorCause";
  }
}

export class AppStoreConnectClient {
  private constructor(
    private readonly token: string,
    private readonly expectedBundleId: string,
  ) {}

  static async create(env: Env): Promise<AppStoreConnectClient> {
    assertAscConfig(env);
    const [issuerId, keyId, privateKey] = await Promise.all([
      readSecret(env.ASC_ISSUER_ID),
      readSecret(env.ASC_KEY_ID),
      readSecret(env.ASC_PRIVATE_KEY),
    ]);
    const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "ES256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT()
      .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
      .setIssuer(issuerId)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(key);
    return new AppStoreConnectClient(token, env.BUNDLE_ID);
  }

  async preflightTester(
    email: string,
    appId: string,
    groupId: string,
  ): Promise<void> {
    await this.verifyWriteScope(appId, groupId);
    await this.findTester(email, appId, groupId);
  }

  async ensureTester(
    email: string,
    appId: string,
    groupId: string,
    onStage: (testerId: string, stage: string) => Promise<void>,
    assertOwnership: () => Promise<void>,
  ): Promise<string> {
    await this.verifyWriteScope(appId, groupId);
    let tester = await this.findTester(email, appId, groupId);
    let wasExisting = tester !== null;
    const previouslyHadApp = tester?.appIds.includes(appId) ?? false;
    await assertOwnership();
    if (!tester) {
      try {
        tester = await this.createTester(email, groupId);
      } catch (error) {
        // ASC 的创建可能已成功但响应丢失，或与并发创建冲突；以实际资源为准。
        const recovered = await this.findTester(email, appId, groupId).catch(
          () => null,
        );
        if (!recovered) throw error;
        tester = recovered;
        wasExisting = true;
      }
    }
    const testerId = tester.id;
    await onStage(testerId, wasExisting ? "tester_found" : "tester_created");
    await assertOwnership();
    await this.addTesterToGroup(testerId, groupId);
    await onStage(testerId, "group_added");

    const shouldInvite =
      !previouslyHadApp ||
      tester.state === "NOT_INVITED" ||
      tester.state === "REVOKED";
    if (shouldInvite) {
      await assertOwnership();
      await this.inviteTester(testerId, appId);
    }
    await onStage(testerId, "invited");
    return testerId;
  }

  async findTester(
    email: string,
    appId: string,
    targetGroupId?: string,
  ): Promise<BetaTester | null> {
    const normalizedEmail = email.toLocaleLowerCase("en-US");
    const scoped = await this.queryTesters(email, appId);
    const scopedMatches = scoped.filter((resource) => {
      const candidate = betaTesterFromResource(resource);
      return candidate?.email.toLocaleLowerCase("en-US") === normalizedEmail;
    });
    const resources = scopedMatches.length > 0
      ? scopedMatches
      : await this.queryTesters(email, null);
    const candidates = resources
      .map(betaTesterFromResource)
      .filter(
        (tester): tester is BetaTester =>
          tester !== null &&
          tester.email.toLocaleLowerCase("en-US") === normalizedEmail,
      );
    if (candidates.length === 0) return null;
    if (candidates.length > MAX_TESTER_MATCHES) {
      throw new AppError(
        "temporarily_unavailable",
        "too many beta tester records",
        409,
      );
    }

    const results = await Promise.allSettled(
      candidates.map((tester) => this.hydrateTesterRelationships(tester)),
    );
    const hydrated: BetaTester[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        hydrated.push(result.value);
      } else if (!isNotFound(result.reason)) {
        throw result.reason;
      }
    }
    if (hydrated.length === 0) return null;

    const associated = hydrated.filter(
      (tester) =>
        tester.appIds.includes(appId) ||
        (targetGroupId !== undefined && tester.groupIds.includes(targetGroupId)),
    );
    if (associated.length === 1) return associated[0] ?? null;
    if (associated.length === 0 && hydrated.length === 1) {
      return hydrated[0] ?? null;
    }
    throw new AppError(
      "temporarily_unavailable",
      "multiple beta tester records",
      409,
    );
  }

  async getTester(testerId: string): Promise<BetaTester> {
    const document = await this.request(
      `/v1/betaTesters/${encodeURIComponent(testerId)}`,
    );
    const tester = betaTesterFromResource(singleResource(document.data));
    if (!tester) {
      throw new AppError("not_found", "beta tester not found", 404);
    }
    return this.hydrateTesterRelationships(tester);
  }

  async createTester(email: string, groupId: string): Promise<BetaTester> {
    const document = await this.request("/v1/betaTesters", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "betaTesters",
          attributes: { email },
          relationships: {
            betaGroups: { data: [{ type: "betaGroups", id: groupId }] },
          },
        },
      }),
    });
    const tester = betaTesterFromResource(singleResource(document.data));
    if (!tester) {
      throw new AppError(
        "temporarily_unavailable",
        "invalid App Store Connect response",
        503,
        true,
      );
    }
    if (!tester.groupIds.includes(groupId)) tester.groupIds.push(groupId);
    return tester;
  }

  async addTesterToGroup(testerId: string, groupId: string): Promise<void> {
    if (await this.testerHasGroup(testerId, groupId)) return;
    try {
      await this.request(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        {
          method: "POST",
          body: relationshipBody("betaTesters", [testerId]),
        },
        new Set([204]),
      );
    } catch (error) {
      if (
        await this.waitForRelationship(
          () => this.testerHasGroup(testerId, groupId),
          true,
        )
      ) return;
      throw error;
    }
    if (!(await this.waitForTesterGroupState(testerId, groupId, true))) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect group relationship is not visible",
        503,
        true,
      );
    }
  }

  async removeTesterFromGroup(
    testerId: string,
    groupId: string,
    appId: string,
    assertOwnership: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    await this.verifyWriteScope(appId, groupId);
    if (!(await this.testerHasGroup(testerId, groupId))) return;
    await assertOwnership();
    try {
      await this.request(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        {
          method: "DELETE",
          body: relationshipBody("betaTesters", [testerId]),
        },
        new Set([202, 204]),
      );
    } catch (error) {
      if (
        await this.waitForRelationship(
          () => this.testerHasGroup(testerId, groupId),
          false,
        )
      ) return;
      throw error;
    }
    if (!await this.waitForTesterGroupState(testerId, groupId, false)) {
      throw new AppError(
        "temporarily_unavailable",
        "old TestFlight group removal is not visible",
        503,
        true,
      );
    }
  }

  async inviteTester(testerId: string, appId: string): Promise<void> {
    try {
      await this.request("/v1/betaTesterInvitations", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "betaTesterInvitations",
            relationships: {
              app: { data: { type: "apps", id: appId } },
              betaTester: { data: { type: "betaTesters", id: testerId } },
            },
          },
        }),
      });
    } catch (error) {
      if (await this.waitForInvitationState(testerId)) return;
      throw error;
    }
  }

  async removeTesterFromApp(
    testerId: string,
    appId: string,
    assertOwnership: () => Promise<void>,
  ): Promise<void> {
    await this.verifyAppScope(appId);
    if (!(await this.testerHasApp(testerId, appId))) return;
    await assertOwnership();
    await this.removeTesterFromAppUnchecked(testerId, appId);
  }

  async removeCurrentAppAccess(
    email: string,
    appId: string,
    assertOwnership: () => Promise<void>,
  ): Promise<void> {
    await this.verifyAppScope(appId);
    const tester = await this.findTester(email, appId);
    if (!tester || !tester.appIds.includes(appId)) return;
    await assertOwnership();
    await this.removeTesterFromAppUnchecked(tester.id, appId);
  }

  async testerHasApp(testerId: string, appId: string): Promise<boolean> {
    try {
      return (await this.getRelationshipIds(testerId, "apps")).includes(appId);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async testerHasGroup(testerId: string, groupId: string): Promise<boolean> {
    try {
      return (await this.getRelationshipIds(testerId, "betaGroups")).includes(
        groupId,
      );
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async waitForTesterAppState(
    testerId: string,
    appId: string,
    expected: boolean,
  ): Promise<boolean> {
    return this.waitForRelationship(
      () => this.testerHasApp(testerId, appId),
      expected,
    );
  }

  async waitForTesterGroupState(
    testerId: string,
    groupId: string,
    expected: boolean,
  ): Promise<boolean> {
    return this.waitForRelationship(
      () => this.testerHasGroup(testerId, groupId),
      expected,
    );
  }

  private async verifyWriteScope(appId: string, groupId: string): Promise<void> {
    const [app, groupDocument, relationship] = await Promise.all([
      this.getApp(appId),
      this.request(`/v1/betaGroups/${encodeURIComponent(groupId)}`),
      this.request(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/app`,
      ),
    ]);
    const groupApp = singleResource(relationship.data);
    const group = singleResource(groupDocument.data);
    assertAscWriteScope(
      this.expectedBundleId,
      appId,
      groupId,
      app.attributes?.bundleId,
      group.type,
      group.id,
      group.attributes?.isInternalGroup,
      groupApp.type,
      groupApp.id,
    );
  }

  private async verifyAppScope(appId: string): Promise<void> {
    const app = await this.getApp(appId);
    if (app.attributes?.bundleId !== this.expectedBundleId) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect scope mismatch",
        503,
      );
    }
  }

  private async getApp(appId: string): Promise<Resource> {
    const document = await this.request(`/v1/apps/${encodeURIComponent(appId)}`);
    const app = singleResource(document.data);
    if (app.type !== "apps" || app.id !== appId) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect scope mismatch",
        503,
      );
    }
    return app;
  }

  private async removeTesterFromAppUnchecked(
    testerId: string,
    appId: string,
  ): Promise<void> {
    try {
      await this.request(
        `/v1/apps/${encodeURIComponent(appId)}/relationships/betaTesters`,
        {
          method: "DELETE",
          body: relationshipBody("betaTesters", [testerId]),
        },
        new Set([202, 204]),
      );
    } catch (error) {
      if (
        await this.waitForRelationship(
          () => this.testerHasApp(testerId, appId),
          false,
        )
      ) return;
      throw error;
    }
    if (!await this.waitForTesterAppState(testerId, appId, false)) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect removal is not visible",
        503,
        true,
      );
    }
  }

  private async queryTesters(
    email: string,
    appId: string | null,
  ): Promise<Resource[]> {
    const url = new URL("/v1/betaTesters", ORIGIN);
    url.searchParams.set("filter[email]", email);
    url.searchParams.set("limit", "200");
    if (appId) url.searchParams.set("filter[apps]", appId);
    return this.collectResources(url, "/v1/betaTesters");
  }

  private async hydrateTesterRelationships(
    tester: BetaTester,
  ): Promise<BetaTester> {
    const [appIds, groupIds] = await Promise.all([
      this.getRelationshipIds(tester.id, "apps"),
      this.getRelationshipIds(tester.id, "betaGroups"),
    ]);
    return { ...tester, appIds, groupIds };
  }

  private async getRelationshipIds(
    testerId: string,
    relationship: "apps" | "betaGroups",
  ): Promise<string[]> {
    const pathname = `/v1/betaTesters/${encodeURIComponent(testerId)}/relationships/${relationship}`;
    const url = new URL(pathname, ORIGIN);
    url.searchParams.set("limit", "200");
    return (await this.collectResources(url, pathname)).map((item) => item.id);
  }

  private async collectResources(
    initialUrl: URL,
    expectedPath: string,
  ): Promise<Resource[]> {
    const resources: Resource[] = [];
    let next: URL | null = initialUrl;
    for (let page = 0; page < MAX_PAGES && next; page += 1) {
      if (next.origin !== ORIGIN || next.pathname !== expectedPath) {
        throw invalidAscPagination();
      }
      const document = await this.request(next.href);
      resources.push(...resourceArray(document.data));
      if (resources.length > MAX_RESOURCES) {
        throw new AppError(
          "temporarily_unavailable",
          "App Store Connect result limit reached",
          503,
          true,
        );
      }
      next = safeNextUrl(document.links?.next);
    }
    if (next) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect pagination limit reached",
        503,
        true,
      );
    }
    return resources;
  }

  private async waitForRelationship(
    read: () => Promise<boolean>,
    expected: boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < RELATIONSHIP_WAIT_ATTEMPTS; attempt += 1) {
      try {
        if ((await read()) === expected) return true;
      } catch {
        // ASC 关系读取也可能短暂失败；在有界窗口内继续确认最终状态。
      }
      if (attempt + 1 < RELATIONSHIP_WAIT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELATIONSHIP_WAIT_MS));
      }
    }
    return false;
  }

  private async waitForInvitationState(testerId: string): Promise<boolean> {
    for (let attempt = 0; attempt < RELATIONSHIP_WAIT_ATTEMPTS; attempt += 1) {
      try {
        const state = (await this.getTester(testerId)).state;
        if (state !== null && state !== "NOT_INVITED" && state !== "REVOKED") {
          return true;
        }
      } catch {
        // 邀请写入可能最终一致；在有界窗口内以 tester 实际状态兜底。
      }
      if (attempt + 1 < RELATIONSHIP_WAIT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELATIONSHIP_WAIT_MS));
      }
    }
    return false;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    accepted = new Set([200, 201]),
  ): Promise<Document> {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) {
      throw new AppError(
        "temporarily_unavailable",
        "invalid App Store Connect origin",
        503,
      );
    }
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect unavailable",
        503,
        true,
        { cause: new AscErrorCause(null, null, { cause }) },
      );
    }
    if (accepted.has(response.status)) {
      if (isEmptySuccessStatus(response.status)) {
        await response.body?.cancel();
        return {};
      }
      try {
        return await readDocument(response);
      } catch (cause) {
        throw new AppError(
          "temporarily_unavailable",
          "invalid App Store Connect response",
          503,
          true,
          { cause },
        );
      }
    }
    const document = await readDocument(response).catch((): Document => ({}));
    const ascCode = firstAscErrorCode(document);
    const errorCause = new AscErrorCause(response.status, ascCode);
    const serialized = JSON.stringify(document.errors ?? []).toLocaleLowerCase(
      "en-US",
    );
    if (response.status === 409 && /limit|capacity|maximum/.test(serialized)) {
      throw new AppError(
        "capacity_full",
        "TestFlight capacity is full",
        409,
        false,
        { cause: errorCause },
      );
    }
    if (response.status === 404) {
      throw new AppError(
        "not_found",
        "App Store Connect resource was not found",
        404,
        false,
        { cause: errorCause },
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AppError(
        "temporarily_unavailable",
        "App Store Connect unavailable",
        503,
        true,
        { cause: errorCause },
      );
    }
    throw new AppError(
      "temporarily_unavailable",
      "App Store Connect rejected the operation",
      409,
      false,
      { cause: errorCause },
    );
  }
}

export function isEmptySuccessStatus(status: number): boolean {
  return status === 202 || status === 204 || status === 404;
}

export function assertAscWriteScope(
  expectedBundleId: string,
  expectedAppId: string,
  expectedGroupId: string,
  actualBundleId: unknown,
  groupType: unknown,
  actualGroupId: unknown,
  isInternalGroup: unknown,
  relationshipType: unknown,
  relationshipAppId: unknown,
): void {
  if (
    actualBundleId !== expectedBundleId ||
    groupType !== "betaGroups" ||
    actualGroupId !== expectedGroupId ||
    isInternalGroup !== false ||
    relationshipType !== "apps" ||
    relationshipAppId !== expectedAppId
  ) {
    throw new AppError(
      "temporarily_unavailable",
      "App Store Connect scope mismatch",
      503,
    );
  }
}

function assertAscConfig(env: Env): void {
  if (
    !/^\d+$/.test(env.ASC_APP_ID) ||
    !/^[A-Za-z0-9-]+$/.test(env.ASC_BETA_GROUP_ID) ||
    env.ASC_APP_ID.startsWith("REPLACE_") ||
    env.ASC_BETA_GROUP_ID.startsWith("REPLACE_")
  ) {
    throw new AppError(
      "temporarily_unavailable",
      "service not configured",
      503,
      true,
    );
  }
}

function betaTesterFromResource(resource: Resource): BetaTester | null {
  if (resource.type !== "betaTesters") return null;
  const email = resource.attributes?.email;
  if (typeof email !== "string" || email.length === 0) return null;
  const relationshipIds = (name: string, type: string): string[] => {
    const data = resource.relationships?.[name]?.data;
    return Array.isArray(data)
      ? data.filter((item) => item.type === type).map((item) => item.id)
      : [];
  };
  const state = resource.attributes?.state;
  return {
    id: resource.id,
    email,
    state: typeof state === "string" ? state : null,
    appIds: relationshipIds("apps", "apps"),
    groupIds: relationshipIds("betaGroups", "betaGroups"),
  };
}

function resourceArray(data: Document["data"]): Resource[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function singleResource(data: Document["data"]): Resource {
  const resources = resourceArray(data);
  if (resources.length !== 1) {
    throw new AppError(
      "temporarily_unavailable",
      "invalid App Store Connect response",
      503,
      true,
    );
  }
  return resources[0] as Resource;
}

function relationshipBody(type: string, ids: string[]): string {
  return JSON.stringify({ data: ids.map((id) => ({ type, id })) });
}

function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.code === "not_found";
}

function firstAscErrorCode(document: Document): string | null {
  const code = document.errors?.find((item) => item.code)?.code;
  return typeof code === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(code)
    ? code
    : null;
}

function safeNextUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN) throw new Error("unexpected origin");
    return url;
  } catch (cause) {
    throw new AppError(
      "temporarily_unavailable",
      "invalid App Store Connect pagination",
      503,
      true,
      { cause },
    );
  }
}

function invalidAscPagination(): AppError {
  return new AppError(
    "temporarily_unavailable",
    "invalid App Store Connect pagination",
    503,
    true,
  );
}

async function readDocument(response: Response): Promise<Document> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > RESPONSE_LIMIT) {
    throw new Error("ASC response too large");
  }
  if (!response.body) throw new Error("ASC response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("ASC response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid ASC response");
  }
  return value as Document;
}
