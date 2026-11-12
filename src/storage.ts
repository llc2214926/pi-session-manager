import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  getAgentDir, SessionManager,
  type FileEntry, type SessionHeader,
} from "@earendil-works/pi-coding-agent";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

interface ArchiveData {
  version: 1;
  archivedAt: string;
  originalPath: string;
  session: string;
}

export interface Archive {
  path: string;
  archivedAt: string;
  originalPath: string;
  header: SessionHeader;
  name: string;
}

export function archiveDir(): string {
  return join(getAgentDir(), "session-archives");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function readRegular(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error(`不是普通文件（不操作符号链接）：${path}`);
  return readFileSync(path);
}

// 严格读取，不能像 Pi 的容错读取那样静默跳过损坏行后再删除原文件。
export function parseSession(text: string): { header: SessionHeader; entries: FileEntry[] } {
  let entries: FileEntry[];
  try {
    entries = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`会话含损坏的 JSON 行：${errorText(error)}`);
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id ||
      typeof header.cwd !== "string" || !isAbsolute(header.cwd) ||
      !Number.isFinite(Date.parse(header.timestamp)) ||
      (header.version !== undefined && ![1, 2, 3].includes(header.version))) {
    throw new Error("无效或不支持的 Pi 会话头");
  }
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (!entry || entry.type === "session" || typeof entry.type !== "string") {
      throw new Error("会话含无效条目");
    }
    if ((header.version ?? 1) >= 2) {
      if (typeof entry.id !== "string" || ids.has(entry.id) ||
          (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new Error("会话树存在重复 ID、断链或循环");
      }
      ids.add(entry.id);
    }
  }
  return { header, entries };
}

// 完整写入并刷盘后才发布文件；硬链接提供原子、不覆盖已有文件的创建语义。
function createFile(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, data, { flag: "wx", mode: 0o600, flush: true });
  try {
    linkSync(temporary, path);
    if (process.platform !== "win32") {
      const fd = openSync(dirname(path), "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } finally {
    unlinkSync(temporary);
  }
}

function decodeArchive(path: string): ArchiveData {
  let data: ArchiveData;
  try {
    data = JSON.parse(gunzipSync(readRegular(path), {
      maxOutputLength: MAX_ARCHIVE_BYTES,
    }).toString("utf8"));
  } catch (error) {
    throw new Error(`无法解压或读取归档 ${path}：${errorText(error)}`);
  }
  if (!data || data.version !== 1 || typeof data.session !== "string" ||
      typeof data.originalPath !== "string" || !isAbsolute(data.originalPath) ||
      resolve(data.originalPath) !== data.originalPath || !data.originalPath.endsWith(".jsonl") ||
      typeof data.archivedAt !== "string" || !Number.isFinite(Date.parse(data.archivedAt))) {
    throw new Error(`无效归档：${path}`);
  }
  parseSession(data.session);
  return data;
}

export function storeSession(originalPath: string): string {
  const original = readRegular(originalPath);
  const session = original.toString("utf8");
  if (!Buffer.from(session).equals(original)) throw new Error("会话不是有效 UTF-8，已保留原文件");
  parseSession(session);
  const data: ArchiveData = {
    version: 1, archivedAt: new Date().toISOString(), originalPath: resolve(originalPath), session,
  };
  const packed = Buffer.from(JSON.stringify(data));
  if (packed.length > MAX_ARCHIVE_BYTES) throw new Error("归档超过 256 MiB 安全上限，已保留原会话");
  const path = join(archiveDir(), `${randomUUID()}.json.gz`);
  createFile(path, gzipSync(packed));
  if (decodeArchive(path).session !== session) throw new Error(`归档校验失败，原会话未删除：${path}`);
  if (!readRegular(originalPath).equals(original)) {
    throw new Error(`会话被其他进程修改，原会话和归档均已保留：${path}`);
  }
  unlinkSync(originalPath);
  return path;
}

export function listArchives(cwd?: string): { archives: Archive[]; errors: string[] } {
  let files: string[];
  try { files = readdirSync(archiveDir()); }
  catch (error) {
    if (isMissing(error)) return { archives: [], errors: [] };
    throw error;
  }
  const archives: Archive[] = [];
  const errors: string[] = [];
  for (const file of files.filter((name) => name.endsWith(".json.gz"))) {
    const path = join(archiveDir(), file);
    try {
      const data = decodeArchive(path);
      const { header, entries } = parseSession(data.session);
      if (cwd && resolve(header.cwd) !== resolve(cwd)) continue;
      const manager = SessionManager.inMemory(header.cwd, undefined, entries);
      archives.push({
        path, archivedAt: data.archivedAt, originalPath: data.originalPath, header,
        name: manager.getSessionName() || header.id,
      });
    } catch (error) {
      errors.push(`${file}: ${errorText(error)}`);
    }
  }
  archives.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return { archives, errors };
}

export interface RestoreTransaction {
  path: string;
  commit(): void;
  rollback(): void;
  release(): void;
}

export function prepareRestore(archivePath: string): RestoreTransaction {
  const lockPath = `${archivePath}.lock`;
  const fd = openSync(lockPath, "wx", 0o600);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
    unlinkSync(lockPath);
  };
  try {
    const packed = readRegular(archivePath);
    const data = decodeArchive(archivePath);
    const { header } = parseSession(data.session);
    if (!lstatSync(header.cwd).isDirectory()) throw new Error(`工作区目录不存在：${header.cwd}`);
    const bytes = Buffer.from(data.session);
    let created = false;
    try {
      if (!readRegular(data.originalPath).equals(bytes)) {
        throw new Error(`恢复位置已有不同内容，拒绝覆盖：${data.originalPath}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      createFile(data.originalPath, bytes);
      created = true;
    }
    return {
      path: data.originalPath,
      commit() {
        // 只有新运行时已成功载入，且归档未被并发替换，才清除归档。
        if (!readRegular(archivePath).equals(packed)) throw new Error("归档已改变，未清除归档");
        readRegular(data.originalPath);
        unlinkSync(archivePath);
      },
      rollback() {
        if (created && readRegular(data.originalPath).equals(bytes)) unlinkSync(data.originalPath);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
