import { importPKCS8, SignJWT } from "jose";
import { AppError } from "./errors";
import { readSecret } from "./secrets";

const ORIGIN = "https://api.appstoreconnect.apple.com";
const TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 512 * 1024;

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface Document {
  data?: Resource | Resource[];
  errors?: Array<{ code?: string; detail?: string; title?: string }>;
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
    await this.findTester(email, appId);
  }

  async ensureTester(
    email: string,
    appId: string,
    groupId: string,
    onStage: (testerId: string, stage: string) => Promise<void>,
    assertOwnership: () => Promise<void>,
  ): Promise<string> {
    await this.verifyWriteScope(appId, groupId);
    const existing = await this.findTester(email, appId);
    await assertOwnership();
    const testerId = existing?.id ?? (await this.createTester(email, groupId)).id;
    await onStage(testerId, existing ? "tester_found" : "tester_created");
    await assertOwnership();
    await this.addTesterToGroup(testerId, groupId);
    await onStage(testerId, "group_added");
    await assertOwnership();
    await this.inviteTester(testerId, appId);
    await onStage(testerId, "invited");
    return testerId;
  }

  async removeTesterFromApp(
    testerId: string,
    appId: string,
    assertOwnership: () => Promise<void>,
  ): Promise<void> {
    await this.verifyAppScope(appId);
    await assertOwnership();
    await this.request(
      `/v1/apps/${encodeURIComponent(appId)}/relationships/betaTesters`,
      {
        method: "DELETE",
        body: JSON.stringify({
          data: [{ type: "betaTesters", id: testerId }],
        }),
      },
      new Set([202, 204, 404]),
    );
  }

  async removeCurrentAppAccess(
    email: string,
    appId: string,
    assertOwnership: () => Promise<void>,
  ): Promise<void> {
    await this.verifyAppScope(appId);
    const tester = await this.findTester(email, appId);
    if (!tester) return;
    await assertOwnership();
    await this.removeTesterFromAppUnchecked(tester.id, appId);
  }

  private async verifyWriteScope(appId: string, groupId: string): Promise<void> {
    const [app, groupDocument, relationship] = await Promise.all([
      this.getApp(appId),
      this.request(`/v1/betaGroups/${encodeURIComponent(groupId)}`),
      this.request(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/app`,
      ),
    ]);
    const groupApp =
      relationship.data && !Array.isArray(relationship.data)
        ? relationship.data
        : null;
    const group =
      groupDocument.data && !Array.isArray(groupDocument.data)
        ? groupDocument.data
        : null;
    assertAscWriteScope(
      this.expectedBundleId,
      appId,
      groupId,
      app.attributes?.bundleId,
      group?.type,
      group?.id,
      group?.attributes?.isInternalGroup,
      groupApp?.type,
      groupApp?.id,
    );
  }

  private async verifyAppScope(appId: string): Promise<void> {
    const app = await this.getApp(appId);
    if (app.attributes?.bundleId !== this.expectedBundleId) {
      throw new AppError("temporarily_unavailable", "App Store Connect scope mismatch", 503);
    }
  }

  private async getApp(appId: string): Promise<Resource> {
    const document = await this.request(`/v1/apps/${encodeURIComponent(appId)}`);
    if (
      !document.data ||
      Array.isArray(document.data) ||
      document.data.type !== "apps" ||
      document.data.id !== appId
    ) {
      throw new AppError("temporarily_unavailable", "App Store Connect scope mismatch", 503);
    }
    return document.data;
  }

  private async removeTesterFromAppUnchecked(testerId: string, appId: string): Promise<void> {
    await this.request(
      `/v1/apps/${encodeURIComponent(appId)}/relationships/betaTesters`,
      {
        method: "DELETE",
        body: JSON.stringify({
          data: [{ type: "betaTesters", id: testerId }],
        }),
      },
      new Set([202, 204, 404]),
    );
  }

  private async findTester(email: string, appId: string): Promise<Resource | null> {
    const scoped = await this.queryTesters(email, appId);
    const document = scoped.length > 0 ? scoped : await this.queryTesters(email, null);
    const resources = document;
    const matches = resources.filter(
      (item) =>
        item.type === "betaTesters" &&
        typeof item.attributes?.email === "string" &&
        item.attributes.email.toLocaleLowerCase("en-US") === email,
    );
    if (matches.length > 1) {
      throw new AppError("temporarily_unavailable", "multiple tester records", 409);
    }
    return matches[0] ?? null;
  }

  private async queryTesters(email: string, appId: string | null): Promise<Resource[]> {
    const query = new URLSearchParams({ "filter[email]": email, limit: "10" });
    if (appId) query.set("filter[apps]", appId);
    const document = await this.request(`/v1/betaTesters?${query}`);
    const resources = Array.isArray(document.data) ? document.data : [];
    return resources;
  }

  private async createTester(email: string, groupId: string): Promise<Resource> {
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
    if (!document.data || Array.isArray(document.data)) {
      throw new AppError("temporarily_unavailable", "invalid App Store Connect response", 503, true);
    }
    return document.data;
  }

  private async addTesterToGroup(testerId: string, groupId: string): Promise<void> {
    await this.request(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
      {
        method: "POST",
        body: JSON.stringify({ data: [{ type: "betaTesters", id: testerId }] }),
      },
      new Set([204]),
    );
  }

  private async inviteTester(testerId: string, appId: string): Promise<void> {
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
  }

  private async request(
    path: string,
    init: RequestInit = {},
    accepted = new Set([200, 201]),
  ): Promise<Document> {
    let response: Response;
    try {
      response = await fetch(new URL(path, ORIGIN), {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new AppError("temporarily_unavailable", "App Store Connect unavailable", 503, true, { cause });
    }
    if (accepted.has(response.status)) {
      if (isEmptySuccessStatus(response.status)) {
        await response.body?.cancel();
        return {};
      }
      return readDocument(response);
    }
    const document = await readDocument(response).catch((): Document => ({}));
    const serialized = JSON.stringify(document.errors ?? []).toLocaleLowerCase("en-US");
    if (response.status === 409 && /limit|capacity|maximum/.test(serialized)) {
      throw new AppError("capacity_full", "TestFlight capacity is full", 409, true);
    }
    if (response.status === 409 && /already|exists/.test(serialized)) return document;
    if (response.status === 429 || response.status >= 500) {
      throw new AppError("temporarily_unavailable", "App Store Connect unavailable", 503, true);
    }
    throw new AppError("temporarily_unavailable", "App Store Connect rejected the operation", 409);
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
    throw new AppError("temporarily_unavailable", "App Store Connect scope mismatch", 503);
  }
}

function assertAscConfig(env: Env): void {
  if (
    !/^\d+$/.test(env.ASC_APP_ID) ||
    !/^[A-Za-z0-9-]+$/.test(env.ASC_BETA_GROUP_ID) ||
    env.ASC_APP_ID.startsWith("REPLACE_") ||
    env.ASC_BETA_GROUP_ID.startsWith("REPLACE_")
  ) {
    throw new AppError("temporarily_unavailable", "service not configured", 503, true);
  }
}

async function readDocument(response: Response): Promise<Document> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > RESPONSE_LIMIT) throw new Error("ASC response too large");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ASC response");
  return value as Document;
}
