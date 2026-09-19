import type { Database } from "remix/data-table";
import { Schema } from "effect";
import { err, ok, type Result, trySync } from "@openorb/result";
import type { WorkspaceId } from "@openorb/protocol/runner-api";

import type { MasterKey } from "@/app/utils/master-key.ts";
import { decryptSecret, encryptSecret, type SecretMetadata } from "@/app/utils/secret-cipher.ts";
import {
  encryptedSecretPurposes,
  type EncryptedSecretRow,
  encryptedSecrets,
  type ModelProviderCredentialRow,
  modelProviderCredentials,
} from "@/app/data/schema.ts";

export interface ModelProviderCredential {
  id: string;
  providerId: string;
  credentialType: ModelProviderCredentialValue["type"];
  createdAt: string;
  updatedAt: string;
}

type ModelProviderCredentialValue =
  | { readonly type: "api_key"; readonly value: string }
  | ModelProviderOAuthCredential;

export interface ModelProviderOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export class ModelProviderCredentialReadError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved model provider credential could not be read.", { cause });
    this.name = "ModelProviderCredentialReadError";
  }
}

export type DeleteModelProviderCredentialResult =
  | { status: "deleted" }
  | { status: "not-found" };

export interface ModelProviderRepository {
  listModelProviderCredentials(workspaceId: WorkspaceId): Promise<ModelProviderCredential[]>;
  getModelProviderCredential(
    workspaceId: WorkspaceId,
    providerId: string,
  ): Promise<ModelProviderCredential | null>;
  getModelProviderApiKey(
    workspaceId: WorkspaceId,
    providerId: string,
  ): Promise<Result<string | null, ModelProviderCredentialReadError>>;
  saveModelProviderCredential(
    workspaceId: WorkspaceId,
    providerId: string,
    apiKey: string,
  ): Promise<ModelProviderCredential>;
  saveModelProviderOAuthCredential(
    workspaceId: WorkspaceId,
    providerId: string,
    credential: ModelProviderOAuthCredential,
  ): Promise<ModelProviderCredential>;
  modifyModelProviderOAuthCredential(
    workspaceId: WorkspaceId,
    providerId: string,
    update: (
      credential: ModelProviderOAuthCredential,
    ) => Promise<ModelProviderOAuthCredential>,
  ): Promise<Result<ModelProviderOAuthCredential | null, ModelProviderCredentialReadError>>;
  deleteModelProviderCredential(
    workspaceId: WorkspaceId,
    providerId: string,
  ): Promise<DeleteModelProviderCredentialResult>;
  deleteModelProviderOAuthCredential(
    workspaceId: WorkspaceId,
    providerId: string,
    beforeDelete: (credential: ModelProviderOAuthCredential) => Promise<void>,
  ): Promise<DeleteModelProviderCredentialResult>;
}

export function createModelProviderRepository(
  database: Database,
  masterKey: MasterKey,
): ModelProviderRepository {
  const modificationChains = new Map<string, Promise<unknown>>();

  const readCredential = async (
    workspaceId: WorkspaceId,
    providerId: string,
  ): Promise<Result<ModelProviderCredentialValue | null, ModelProviderCredentialReadError>> => {
    const credential = await database.findOne(modelProviderCredentials, {
      where: { workspace_id: workspaceId, provider_id: providerId },
    });
    if (!credential) return ok(null);
    const purpose = credentialPurpose(credential.credential_type);
    if (purpose === undefined) return err(new ModelProviderCredentialReadError());
    const secret = await database.findOne(encryptedSecrets, {
      where: {
        id: credential.encrypted_secret_id,
        workspace_id: workspaceId,
        purpose,
      },
    });
    if (!secret) return err(new ModelProviderCredentialReadError());
    const [ciphertext, decodeError] = trySync(
      () => Uint8Array.fromBase64(secret.ciphertext),
      (cause) => new ModelProviderCredentialReadError(cause),
    );
    if (decodeError !== undefined) return err(decodeError);
    const [plaintext, decryptionError] = await decryptSecret(
      masterKey,
      { keyVersion: secret.key_version, ciphertext },
      { workspaceId, key: secret.key },
    );
    if (decryptionError !== undefined) {
      return err(new ModelProviderCredentialReadError(decryptionError));
    }
    if (credential.credential_type === "api_key") {
      return ok({ type: "api_key", value: plaintext });
    }
    const oauth = parseOAuthCredential(plaintext);
    return oauth === null ? err(new ModelProviderCredentialReadError()) : ok(oauth);
  };

  const saveCredential = (
    workspaceId: WorkspaceId,
    providerId: string,
    value: ModelProviderCredentialValue,
  ): Promise<ModelProviderCredential> => {
    const now = new Date().toISOString();
    const plaintext = value.type === "api_key" ? value.value : JSON.stringify(value);
    const purpose = value.type === "api_key"
      ? encryptedSecretPurposes.providerApiKey
      : encryptedSecretPurposes.providerOAuth;
    return database.transaction(async (transaction) => {
      const existing = await transaction.findOne(modelProviderCredentials, {
        where: { workspace_id: workspaceId, provider_id: providerId },
      });
      if (existing) {
        const secret = await transaction.find(encryptedSecrets, existing.encrypted_secret_id);
        assertCredentialSecret(secret, workspaceId, existing.credential_type);
        const encrypted = await encryptSecret(masterKey, plaintext, {
          workspaceId,
          key: secret.key,
        });
        await transaction.update(encryptedSecrets, secret.id, {
          purpose,
          key_version: encrypted.keyVersion,
          ciphertext: encrypted.ciphertext.toBase64(),
          updated_at: now,
        });
        const updated = await transaction.update(modelProviderCredentials, existing.id, {
          credential_type: value.type,
          updated_at: now,
        });
        return mapCredential(updated);
      }

      const credentialId = crypto.randomUUID();
      const secretKey = crypto.randomUUID();
      const metadata: SecretMetadata = { workspaceId, key: secretKey };
      const encrypted = await encryptSecret(masterKey, plaintext, metadata);
      const secret: EncryptedSecretRow = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        key: secretKey,
        purpose,
        key_version: encrypted.keyVersion,
        ciphertext: encrypted.ciphertext.toBase64(),
        allowed_hosts: null,
        created_at: now,
        updated_at: now,
      };
      const credential: ModelProviderCredentialRow = {
        id: credentialId,
        workspace_id: workspaceId,
        provider_id: providerId,
        credential_type: value.type,
        encrypted_secret_id: secret.id,
        created_at: now,
        updated_at: now,
      };
      await transaction.create(encryptedSecrets, secret);
      await transaction.create(modelProviderCredentials, credential);
      return mapCredential(credential);
    });
  };

  const enqueueModification = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = modificationChains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.catch(() => {});
    modificationChains.set(key, tail);
    void tail.then(() => {
      if (modificationChains.get(key) === tail) modificationChains.delete(key);
    });
    return current;
  };

  const deleteCredential = async (
    workspaceId: WorkspaceId,
    providerId: string,
  ): Promise<DeleteModelProviderCredentialResult> => {
    return await database.transaction(async (transaction) => {
      const credential = await transaction.findOne(modelProviderCredentials, {
        where: { workspace_id: workspaceId, provider_id: providerId },
      });
      if (!credential) return { status: "not-found" } as const;
      await transaction.delete(modelProviderCredentials, credential.id);
      await transaction.delete(encryptedSecrets, credential.encrypted_secret_id);
      return { status: "deleted" } as const;
    });
  };

  return {
    async listModelProviderCredentials(workspaceId) {
      const rows = await database.findMany(modelProviderCredentials, {
        where: { workspace_id: workspaceId },
        orderBy: ["provider_id", "asc"],
      });
      return rows.map(mapCredential);
    },

    async getModelProviderCredential(workspaceId, providerId) {
      const row = await database.findOne(modelProviderCredentials, {
        where: { workspace_id: workspaceId, provider_id: providerId },
      });
      return row ? mapCredential(row) : null;
    },

    async getModelProviderApiKey(workspaceId, providerId) {
      const [credential, readError] = await readCredential(workspaceId, providerId);
      if (readError !== undefined) return err(readError);
      return ok(credential?.type === "api_key" ? credential.value : null);
    },

    saveModelProviderCredential(workspaceId, providerId, apiKey) {
      return enqueueModification(
        `${workspaceId}:${providerId}`,
        () => saveCredential(workspaceId, providerId, { type: "api_key", value: apiKey }),
      );
    },

    saveModelProviderOAuthCredential(workspaceId, providerId, credential) {
      return enqueueModification(
        `${workspaceId}:${providerId}`,
        () => saveCredential(workspaceId, providerId, credential),
      );
    },

    modifyModelProviderOAuthCredential(workspaceId, providerId, update) {
      return enqueueModification(`${workspaceId}:${providerId}`, async () => {
        const [credential, readError] = await readCredential(workspaceId, providerId);
        if (readError !== undefined) return err(readError);
        if (credential?.type !== "oauth") return ok(null);
        const updated = await update(credential);
        if (updated === credential) return ok(credential);
        await saveCredential(workspaceId, providerId, updated);
        return ok(updated);
      });
    },

    deleteModelProviderCredential(workspaceId, providerId) {
      return enqueueModification(
        `${workspaceId}:${providerId}`,
        () => deleteCredential(workspaceId, providerId),
      );
    },

    deleteModelProviderOAuthCredential(workspaceId, providerId, beforeDelete) {
      return enqueueModification(`${workspaceId}:${providerId}`, async () => {
        const [credential, readError] = await readCredential(workspaceId, providerId);
        if (readError !== undefined) return await deleteCredential(workspaceId, providerId);
        if (credential?.type === "oauth") {
          await beforeDelete(credential).catch(() => {});
        }
        return await deleteCredential(workspaceId, providerId);
      });
    },
  };
}

function assertCredentialSecret(
  secret: EncryptedSecretRow | null,
  workspaceId: WorkspaceId,
  credentialType: string,
): asserts secret is EncryptedSecretRow {
  if (!secret) {
    throw new ModelProviderCredentialIntegrityError("The provider credential secret is missing.");
  }
  if (secret.workspace_id !== workspaceId) {
    throw new ModelProviderCredentialIntegrityError(
      "The provider credential secret has an invalid owner.",
    );
  }
  if (secret.purpose !== credentialPurpose(credentialType)) {
    throw new ModelProviderCredentialIntegrityError(
      "The provider credential secret has an invalid purpose.",
    );
  }
}

class ModelProviderCredentialIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderCredentialIntegrityError";
  }
}

function mapCredential(row: ModelProviderCredentialRow): ModelProviderCredential {
  if (row.credential_type !== "api_key" && row.credential_type !== "oauth") {
    throw new ModelProviderCredentialIntegrityError(
      "The provider credential has an invalid type.",
    );
  }
  return {
    id: row.id,
    providerId: row.provider_id,
    credentialType: row.credential_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialPurpose(credentialType: string): string | undefined {
  switch (credentialType) {
    case "api_key":
      return encryptedSecretPurposes.providerApiKey;
    case "oauth":
      return encryptedSecretPurposes.providerOAuth;
    default:
      return undefined;
  }
}

function parseOAuthCredential(value: string): ModelProviderOAuthCredential | null {
  const [credential, parseError] = trySync(
    () => Schema.decodeUnknownSync(StoredOAuthCredential)(JSON.parse(value)),
    () => true,
  );
  if (parseError !== undefined) return null;
  return credential;
}

const StoredOAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  refresh: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  expires: Schema.Finite,
});
