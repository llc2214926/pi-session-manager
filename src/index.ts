import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager, type ExtensionAPI, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { continueSession } from "./handoff.ts";
import { selectSession } from "./session-picker.ts";
import {
  errorText, isMissing, label, listArchives, parseSession, prepareRestore, readRegular, storeSession,
} from "./storage.ts";

function sessionPathKey(path: string): string {
  try {
    // 解析目录别名；文件本身的符号链接保留原路径，交给 readRegular 拒绝。
    return lstatSync(path).isSymbolicLink() ? resolve(path) : realpathSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return resolve(path); // 列表刷新期间文件可能已消失，后续读取会安全报错。
  }
}

async function leaveAndRemove(ctx: ExtensionCommandContext, archive: boolean): Promise<ExtensionCommandContext> {
  const path = ctx.sessionManager.getSessionFile();
  let persisted = false;
  if (path) {
    try { readRegular(path); persisted = true; }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  if (archive && !persisted) {
    ctx.ui.notify("当前会话尚未落盘（空会话或 --no-session），没有可归档的文件。", "info");
    return ctx;
  }
  const action = archive ? "归档" : "永久删除";
  if (!await ctx.ui.confirm(`${action}当前会话？`,
    `${label(ctx.sessionManager.getSessionName() || ctx.sessionManager.getSessionId())}\n工作区：${label(ctx.cwd)}\n${label(path || "内存会话")}\n` +
    `操作后进入空白新会话。${archive ? "原会话将只在归档列表中出现。" : "删除不可撤销，不影响项目文件。"}\n请确认其他 Pi 进程没有同时打开此会话。`)) return ctx;
  let active = ctx;
  const result = await ctx.newSession({
    withSession: async (fresh) => {
      active = fresh;
      try {
        if (archive && path) {
          // 在旧运行时 shutdown 完成后读取，包含其他扩展最后追加的条目。
          const stored = storeSession(path);
          fresh.ui.notify(`会话已归档：${label(stored)}`, "info");
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
  return active;
}

async function removeFromList(ctx: ExtensionCommandContext, archive: boolean, all: boolean): Promise<void> {
  const action = archive ? "归档" : "删除";
  let selectedIndex = 0;
  let selectedPath: string | undefined;
  while (true) {
    const dir = ctx.sessionManager.getSessionDir();
    let sessions = all ? await SessionManager.listAll(dir) : await SessionManager.list(ctx.cwd, dir);
    if (all) {
      sessions = [...new Map([...await SessionManager.listAll(), ...sessions]
        .map((session) => [sessionPathKey(session.path), session])).values()];
    } else {
      sessions = sessions.filter((session) => resolve(session.cwd) === resolve(ctx.cwd));
    }
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    // 原会话还在时按路径定位；已移除时沿用原序号，末项回退，空列表选退出。
    const previousIndex = sessions.findIndex((session) => sessionPathKey(session.path) === selectedPath);
    selectedIndex = previousIndex >= 0 ? previousIndex : Math.min(selectedIndex, Math.max(0, sessions.length - 1));
    const currentPath = ctx.sessionManager.getSessionFile();
    const currentKey = currentPath && sessionPathKey(currentPath);
    const options = sessions.map((session, index) =>
      `${index + 1}. ` + (all ? `工作区：${label(session.cwd || "未知工作区")} | ` : "") +
      (currentKey && sessionPathKey(session.path) === currentKey ? "[当前会话] " : "") +
      `${label(session.name || session.firstMessage || session.id)} | ${session.modified.toISOString()} | ${label(session.id.slice(0, 8))}`);
    const selected = await selectSession(ctx,
      `${all ? "全部工作区" : "当前工作区"}会话（${sessions.length} 个，${sessions.length ? `回车选择${action}` : `暂无可${action}会话`}，Esc 退出）`,
      [...options, "退出列表"], selectedIndex);
    if (selected === undefined) return;
    selectedIndex = options.indexOf(selected);
    const session = sessions[selectedIndex];
    if (!session) return;
    selectedPath = sessionPathKey(session.path);
    if (currentKey && selectedPath === currentKey) {
      // 操作当前会话会替换运行时；继续列表必须使用新上下文。
      ctx = await leaveAndRemove(ctx, archive);
      continue;
    }
    try {
      const original = readRegular(session.path);
      const { header } = parseSession(original.toString("utf8"));
      if (header.id !== session.id || resolve(header.cwd) !== resolve(session.cwd)) {
        throw new Error("会话已被替换，请从刷新后的列表重新选择");
      }
      if (!await ctx.ui.confirm(`${archive ? "归档" : "永久删除"}此会话？`,
        `${label(session.name || session.firstMessage || session.id)}\n工作区：${label(session.cwd)}\n${label(session.path)}\n` +
        (archive ? "原会话将只在归档列表中出现，可通过 /s-restore 恢复。" : "删除不可撤销。") +
        "不影响项目文件，当前会话保持不变。\n请确认其他 Pi 进程没有同时打开此会话。")) continue;
      if (!readRegular(session.path).equals(original)) throw new Error(`会话已被其他进程修改，未${action}，请重新确认`);
      if (archive) {
        const stored = storeSession(session.path);
        ctx.ui.notify(`会话已归档：${label(stored)}`, "info");
      } else {
        unlinkSync(session.path);
        ctx.ui.notify("会话已删除。", "info");
      }
    } catch (error) {
      ctx.ui.notify(`${action}未完成，返回列表：${label(errorText(error))}`, "error");
    }
  }
}

async function removeSession(ctx: ExtensionCommandContext, args: string, archive: boolean): Promise<void> {
  const command = archive ? "s-store" : "s-delete";
  const flags = args.trim().split(/\s+/).filter(Boolean)
    .map((flag) => flag === "-l" ? "-ls" : flag.replace(/^--/, "-"));
  if (flags.some((flag) => flag !== "-ls" && flag !== "-all") || (flags.length > 0 && !flags.includes("-ls"))) {
    ctx.ui.notify(`用法：/${command} 或 /${command} -ls [-all]（-l、--ls 等价于 -ls；也支持 --all）`, "warning");
    return;
  }
  if (flags.includes("-ls")) await removeFromList(ctx, archive, flags.includes("-all"));
  else await leaveAndRemove(ctx, archive);
}

async function restoreSession(ctx: ExtensionCommandContext, all: boolean): Promise<void> {
  const { archives, errors } = await listArchives(all ? undefined : ctx.cwd);
  if (errors.length) ctx.ui.notify(`以下归档读取失败，已保留原包：\n${errors.map(label).join("\n")}`, "warning");
  if (!archives.length) {
    ctx.ui.notify(all ? "没有可恢复的归档。" : "当前工作区没有可恢复的归档。", "info");
    return;
  }
  const options = archives.map((entry, index) =>
    `${index + 1}. ${label(entry.archivedAt)} | ${label(entry.name)} | ${label(entry.header.id.slice(0, 8))}` +
    (all ? ` | 工作区：${label(entry.header.cwd)}` : ""));
  const selected = await selectSession(ctx, all ? "全部工作区归档（选择后恢复并切换）" : "当前工作区归档（选择后恢复并切换）", options);
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
  const register = (name: string, description: string, run: (ctx: ExtensionCommandContext, args: string) => Promise<void>) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        if (args.trim() && name === "s-new-continue") {
          ctx.ui.notify(`用法：/${name}（不接受参数）`, "warning");
          return;
        }
        if (!ctx.hasUI) throw new Error(`/${name} 需要交互界面`);
        if (running || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("请等待当前任务和消息队列结束，或先按 Esc 停止，再执行会话命令。", "warning");
          return;
        }
        running = true;
        try { await run(ctx, args); }
        catch (error) { throw new Error(errorText(error)); }
        finally { running = false; }
        // 错误交由 Pi 命令调度器显示；切换后不能再用失效的旧 ctx 报错。
      },
    });
  };
  register("s-delete", "确认删除当前会话；-ls 列表删除，-ls -all 显示全部工作区", (ctx, args) => removeSession(ctx, args, false));
  register("s-new-continue", "新建会话并接手未完成任务，空会话自动回溯", continueSession);
  register("s-store", "无损归档当前会话；-ls 列表归档，-ls -all 显示全部工作区", (ctx, args) => removeSession(ctx, args, true));
  register("s-restore", "选择恢复当前工作区归档；-all 显示全部工作区", async (ctx, args) => {
    const flag = args.trim();
    if (flag && flag !== "-all" && flag !== "--all") {
      ctx.ui.notify("用法：/s-restore [-all]（也支持 --all）", "warning");
      return;
    }
    await restoreSession(ctx, flag !== "");
  });
}
