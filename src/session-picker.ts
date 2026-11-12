import { getSelectListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

export function selectSession(ctx: ExtensionCommandContext, title: string, options: string[], initialIndex = 0): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const items = options.map((label, index) => ({ label, value: String(index) }));
    let selectedIndex = Math.max(0, Math.min(initialIndex, options.length - 1));
    let visible = 1;
    const createList = () => {
      const list = new SelectList(items, visible, getSelectListTheme());
      list.setSelectedIndex(selectedIndex);
      list.onSelectionChange = (item) => { selectedIndex = Number(item.value); };
      list.onSelect = (item) => done(options[Number(item.value)]);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = createList();
    return {
      render(width: number) {
        const rows = Math.max(1, tui.terminal.rows);
        const chrome = rows >= 4;
        // 为标题、帮助和列表自带的滚动计数留行；极矮终端优先显示选中项。
        const nextVisible = Math.max(1, Math.min(12, rows - (chrome ? 3 : 1)));
        if (nextVisible !== visible) {
          visible = nextVisible;
          list = createList();
        }
        return [
          ...(chrome ? [theme.fg("accent", title)] : []),
          ...list.render(width),
          ...(chrome ? [theme.fg("dim", "↑↓ / j k 选择 · Enter 确认 · Esc 退出")] : []),
        ].slice(0, rows).map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (data === "j" || data === "k") {
          selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + (data === "j" ? 1 : -1)));
          list.setSelectedIndex(selectedIndex);
        } else {
          list.handleInput(data === "\n" ? "\r" : data);
        }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        const result = list.handleMouse({ ...event, y: event.y - (tui.terminal.rows >= 4 ? 1 : 0) });
        if (result?.handled) tui.requestRender();
        return result;
      },
      invalidate() { list.invalidate(); },
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}
