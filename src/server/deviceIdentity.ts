import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";

export type DeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  deviceToken?: string;
  createdAtMs: number;
};

type StoredDeviceIdentity = Partial<DeviceIdentity>;

export async function loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
  const absolutePath = resolve(filePath);
  const stored = await readStoredIdentity(absolutePath);
  if (isStoredIdentity(stored)) {
    const publicKeyBytes = base64UrlDecode(stored.publicKey);
    const deviceId = fingerprintPublicKey(publicKeyBytes);
    if (deviceId === stored.deviceId) {
      return stored;
    }
    return { ...stored, deviceId };
  }

  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = await getPublicKeyAsync(privateKeyBytes);
  const identity: DeviceIdentity = {
    version: 1,
    deviceId: fingerprintPublicKey(publicKeyBytes),
    publicKey: base64UrlEncode(publicKeyBytes),
    privateKey: base64UrlEncode(privateKeyBytes),
    createdAtMs: Date.now()
  };
  await saveDeviceIdentity(absolutePath, identity);
  return identity;
}

export async function saveDeviceIdentity(filePath: string, identity: DeviceIdentity): Promise<void> {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

export async function signDevicePayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const privateKey = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const signature = await signAsync(data, privateKey);
  return base64UrlEncode(signature);
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce
  ].join("|");
}

async function readStoredIdentity(filePath: string): Promise<StoredDeviceIdentity | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredDeviceIdentity;
  } catch {
    return undefined;
  }
}

function isStoredIdentity(value: StoredDeviceIdentity | undefined): value is DeviceIdentity {
  return (
    value?.version === 1 &&
    typeof value.deviceId === "string" &&
    typeof value.publicKey === "string" &&
    typeof value.privateKey === "string" &&
    typeof value.createdAtMs === "number"
  );
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}
