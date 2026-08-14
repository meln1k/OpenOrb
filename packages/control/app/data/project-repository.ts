import { type Database, DataTableAdapterError } from "remix/data-table";

import { type ProjectRow, projects } from "./schema.ts";

export const DEFAULT_PROJECT_REF = "main";
export const DEFAULT_PROJECT_BRANCH_PATTERN = "openorb/{session-name}-{short-session-id}";

export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultRef: string;
  defaultBranchPattern: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveProjectInput {
  id?: string;
  name: string;
  repositoryUrl: string;
}

export type SaveProjectResult =
  | { status: "saved"; project: Project }
  | { status: "not-found" }
  | { status: "name-conflict" };

export type DeleteProjectResult = "deleted" | "not-found" | "in-use";

export interface ProjectRepository {
  listProjects(userId: number): Promise<Project[]>;
  getProject(userId: number, id: string): Promise<Project | null>;
  saveProject(userId: number, input: SaveProjectInput): Promise<SaveProjectResult>;
  deleteProject(userId: number, id: string): Promise<DeleteProjectResult>;
}

export function createProjectRepository(database: Database): ProjectRepository {
  return {
    async listProjects(userId) {
      const rows = await database.findMany(projects, {
        where: { user_id: userId },
        orderBy: ["name", "asc"],
      });
      return rows.map(mapProject);
    },

    async getProject(userId, id) {
      const row = await database.findOne(projects, { where: { id, user_id: userId } });
      return row ? mapProject(row) : null;
    },

    saveProject(userId, input) {
      return database.transaction(async (transaction) => {
        const existing = input.id
          ? await transaction.findOne(projects, { where: { id: input.id, user_id: userId } })
          : null;
        if (input.id && !existing) return { status: "not-found" } as const;

        const duplicate = await transaction.findOne(projects, {
          where: { user_id: userId, name: input.name },
        });
        if (duplicate && duplicate.id !== input.id) return { status: "name-conflict" } as const;

        const now = new Date().toISOString();
        if (existing) {
          const updated = await transaction.update(projects, existing.id, {
            name: input.name,
            repository_url: input.repositoryUrl,
            default_ref: DEFAULT_PROJECT_REF,
            default_branch_pattern: DEFAULT_PROJECT_BRANCH_PATTERN,
            updated_at: now,
          });
          return { status: "saved", project: mapProject(updated) } as const;
        }

        const row: ProjectRow = {
          id: crypto.randomUUID(),
          user_id: userId,
          name: input.name,
          repository_url: input.repositoryUrl,
          default_ref: DEFAULT_PROJECT_REF,
          default_branch_pattern: DEFAULT_PROJECT_BRANCH_PATTERN,
          created_at: now,
          updated_at: now,
        };
        await transaction.create(projects, row);
        return { status: "saved", project: mapProject(row) } as const;
      });
    },

    async deleteProject(userId, id) {
      try {
        const row = await database.findOne(projects, { where: { id, user_id: userId } });
        if (!row) return "not-found";
        return (await database.delete(projects, row.id)) ? "deleted" : "not-found";
      } catch (error) {
        if (isPostgresForeignKeyViolation(error)) return "in-use";
        throw error;
      }
    },
  };
}

function isPostgresForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof DataTableAdapterError)) return false;
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23503";
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryUrl: row.repository_url,
    defaultRef: row.default_ref,
    defaultBranchPattern: row.default_branch_pattern,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
