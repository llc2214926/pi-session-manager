import { unlinkSync } from "node:fs";
import {
  type ExtensionAPI, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { continueSession } from "./handoff.ts";
import {
  errorText, isMissing, listArchives, prepareRestore, readRegular, storeSession,
} from "./storage.ts";

// 名称和路径来自会话文件，不能把控制字符直接送进终端。
function label(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

async function leaveAndRemove(ctx: ExtensionCommandContext, archive: boolean): Promise<void> {
  const path = ctx.sessionManager.getSessionFile();
  let persisted = false;
  if (path) {
    try { readRegular(path); persisted = true; }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  if (archive && !persisted) {
    ctx.ui.notify("当前会话尚未落盘（空会话或 --no-session），没有可归档的文件。", "info");
    return;
  }
  const action = archive ? "归档" : "永久删除";
  if (!await ctx.ui.confirm(`${action}当前会话？`,
    `${label(ctx.sessionManager.getSessionName() || ctx.sessionManager.getSessionId())}\n${label(path || "内存会话")}\n` +
    `操作后进入空白新会话。${archive ? "原会话将只在归档列表中出现。" : "删除不可撤销，不影响项目文件。"}\n请确认其他 Pi 进程没有同时打开此会话。`)) return;
  const result = await ctx.newSession({
    withSession: async (fresh) => {
      try {
        if (archive && path) {
          // 在旧运行时 shutdown 完成后读取，包含其他扩展最后追加的条目。
          const stored = storeSession(path);
          fresh.ui.notify(`会话已归档：${stored}`, "info");
        } else {
          if (path) {
            try { readRegular(path); unlinkSync(path); }
            catch (error) { if (!isMissing(error)) throw error; }
          }
          fresh.ui.notify("原会话已删除，当前为空白新会话。", "info");
        }
      } catch (error) {
        fresh.ui.notify(`${action}失败；已进入新会话，原文件/已写入的归档未主动清理。可通过 /resume 找回原会话：${errorText(error)}`, "error");
      }
    },
  });
  if (result.cancelled) ctx.ui.notify("切换被取消，原会话未删除或归档。", "info");
}

async function restoreSession(ctx: ExtensionCommandContext, all: boolean): Promise<void> {
  const { archives, errors } = listArchives(all ? undefined : ctx.cwd);
  if (errors.length) ctx.ui.notify(`以下归档读取失败，已保留原包：\n${errors.map(label).join("\n")}`, "warning");
  if (!archives.length) {
    ctx.ui.notify(all ? "没有可恢复的归档。" : "当前工作区没有可恢复的归档。", "info");
    return;
  }
  const options = archives.map((entry, index) =>
    `${index + 1}. ${entry.archivedAt} | ${label(entry.name)} | ${label(entry.header.id.slice(0, 8))}` +
    (all ? ` | 工作区：${label(entry.header.cwd)}` : ""));
  const selected = await ctx.ui.select(all ? "全部工作区归档（选择后恢复并切换）" : "当前工作区归档（选择后恢复并切换）", options);
  if (selected === undefined) return;
  const archive = archives[options.indexOf(selected)];
  if (!archive) return;
  if (!await ctx.ui.confirm("恢复并切换到此会话？",
    `工作区：${label(archive.header.cwd)}\n恢复位置：${label(archive.originalPath)}\n当前会话会保留。恢复成功后删除归档包。`)) return;
  const transaction = prepareRestore(archive.path);
  try {
    const result = await ctx.switchSession(transaction.path, {
      withSession: async (fresh) => {
        try {
          transaction.commit();
          fresh.ui.notify("会话已恢复，归档包已移除。", "info");
        } catch (error) {
          fresh.ui.notify(`已切换到恢复的会话，但归档清理失败，归档仍保留：${errorText(error)}`, "warning");
        }
      },
    });
    if (result.cancelled) {
      transaction.rollback();
      ctx.ui.notify("恢复切换被取消，归档仍保留。", "info");
    }
    // 切换抛错时无法判断旧运行时是否已失效，保留已恢复文件和归档，不冒险回滚。
  } finally {
    transaction.release();
  }
}

export default function sessionManagerExtension(pi: ExtensionAPI): void {
  let running = false;
  const register = (name: string, description: string, run: (ctx: ExtensionCommandContext) => Promise<void>) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        if (args.trim()) { ctx.ui.notify(`用法：/${name}（不接受参数）`, "warning"); return; }
        if (!ctx.hasUI) throw new Error(`/${name} 需要交互界面`);
        if (running || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("请等待当前任务和消息队列结束，或先按 Esc 停止，再执行会话命令。", "warning");
          return;
        }
        running = true;
        try { await run(ctx); }
        finally { running = false; }
        // 错误交由 Pi 命令调度器显示；切换后不能再用失效的旧 ctx 报错。
      },
    });
  };
  register("s-delete", "确认后删除当前会话，并进入空白新会话", (ctx) => leaveAndRemove(ctx, false));
  register("s-new-continue", "新建会话并接手未完成任务，空会话自动回溯", continueSession);
  register("s-store", "无损压缩归档当前会话，并从普通会话列表移除", (ctx) => leaveAndRemove(ctx, true));
  register("s-restore", "选择并恢复当前工作区的归档会话", (ctx) => restoreSession(ctx, false));
  register("s-restore-all", "选择并恢复全部工作区的归档会话", (ctx) => restoreSession(ctx, true));
}
