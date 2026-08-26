import {
  StyledText,
  bg,
  fg,
  type BoxRenderable,
  type InputRenderable,
  type TextRenderable,
} from "@opentui/core";
import {
  menuRowAt,
  menuWidth,
  placeMenu,
  renderMenuLine,
  type GraphMenuItem,
} from "./graph-menu.js";
import { clipColumns } from "./runtime-presentation.js";
import { oneDarkTheme } from "./theme.js";

interface PopupPane {
  items: GraphMenuItem[];
  left: number;
  top: number;
  width: number;
  hover?: number;
}

interface Popup extends PopupPane {
  title: string;
  submenu?: PopupPane & { parent: number };
  select(item: GraphMenuItem): void;
}

export interface RuntimePopupContext {
  terminalSize(): { width: number; height: number };
  overlayCatcher: BoxRenderable;
  menuBox: BoxRenderable;
  menuText: TextRenderable;
  submenuBox: BoxRenderable;
  submenuText: TextRenderable;
  promptInput: InputRenderable;
  closed(): void;
}

/** Owns popup placement, rendering, and pointer interaction. */
export class RuntimePopupController {
  private popup?: Popup;
  private promptActive = false;

  constructor(private readonly context: RuntimePopupContext) {}

  get isOpen(): boolean {
    return !!this.popup;
  }

  open(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
    promptActive = false,
  ) {
    const width = menuWidth(items);
    const terminal = this.context.terminalSize();
    const { left, top } = placeMenu(
      x,
      y,
      width,
      items.length,
      terminal.width,
      terminal.height,
    );
    this.popup = { title, items, left, top, width, select };
    this.promptActive = promptActive;
    this.paint();
  }

  close() {
    this.popup = undefined;
    this.promptActive = false;
    this.context.promptInput.blur();
    this.context.promptInput.visible = false;
    this.context.closed();
    this.paint();
  }

  paint() {
    const {
      overlayCatcher,
      menuBox,
      menuText,
      submenuBox,
      submenuText,
      promptInput,
    } = this.context;
    const popup = this.popup;
    const visible = !!popup;
    for (const widget of [overlayCatcher, menuBox, menuText])
      widget.visible = visible;
    promptInput.visible = visible && this.promptActive;
    const submenuVisible = !!popup?.submenu;
    submenuBox.visible = submenuVisible;
    submenuText.visible = submenuVisible;
    if (!popup) return;
    menuBox.left = popup.left;
    menuBox.top = popup.top;
    menuBox.width = popup.width;
    menuBox.height = popup.items.length + 2;
    menuBox.title = ` ${clipColumns(popup.title, popup.width - 4)} `;
    menuText.left = popup.left + 1;
    menuText.top = popup.top + 1;
    menuText.width = popup.width - 2;
    menuText.height = popup.items.length;
    menuText.content = this.content(popup);
    if (this.promptActive) {
      promptInput.left = popup.left + 2;
      promptInput.top = popup.top + 1;
      promptInput.width = Math.max(8, popup.width - 4);
    }
    const submenu = popup.submenu;
    if (!submenu) return;
    submenuBox.left = submenu.left;
    submenuBox.top = submenu.top;
    submenuBox.width = submenu.width;
    submenuBox.height = submenu.items.length + 2;
    submenuBox.title = "";
    submenuText.left = submenu.left + 1;
    submenuText.top = submenu.top + 1;
    submenuText.width = submenu.width - 2;
    submenuText.height = submenu.items.length;
    submenuText.content = this.content(submenu);
  }

  hover(x: number, y: number, inSubmenu: boolean) {
    const popup = this.popup;
    if (!popup) return;
    const pane = inSubmenu ? popup.submenu : popup;
    if (!pane) return;
    const row = menuRowAt(pane, x, y);
    if (pane.hover === row) return;
    pane.hover = row;
    if (!inSubmenu && row !== undefined && popup.submenu?.parent !== row)
      popup.submenu = undefined;
    if (!inSubmenu && row !== undefined) this.openSubmenuFor(row);
    this.paint();
  }

  click(x: number, y: number, inSubmenu: boolean) {
    const popup = this.popup;
    if (!popup) return;
    const pane = inSubmenu ? popup.submenu : popup;
    if (!pane) return;
    const row = menuRowAt(pane, x, y);
    if (row === undefined) return;
    const item = pane.items[row];
    if (!item || item.disabled) return;
    if (item.submenu) {
      this.openSubmenuFor(row);
      this.paint();
      return;
    }
    const select = popup.select;
    this.close();
    select(item);
  }

  private content(pane: PopupPane): StyledText {
    const width = pane.width - 2;
    return new StyledText(
      pane.items.map((item, index) => {
        const line = renderMenuLine(item, width);
        const suffix = index === pane.items.length - 1 ? "" : "\n";
        if (item.separator) return fg(oneDarkTheme.border)(`${line}${suffix}`);
        const rowBg =
          index === pane.hover && !item.disabled
            ? oneDarkTheme.selected
            : oneDarkTheme.panelRaised;
        const color = item.disabled
          ? oneDarkTheme.muted
          : item.destructive
            ? oneDarkTheme.deleted
            : oneDarkTheme.text;
        return bg(rowBg)(fg(color)(`${line}${suffix}`));
      }),
    );
  }

  private openSubmenuFor(row: number) {
    const popup = this.popup;
    const item = popup?.items[row];
    if (!popup || !item?.submenu || popup.submenu?.parent === row) return;
    const width = menuWidth(item.submenu);
    const terminal = this.context.terminalSize();
    const { left, top } = placeMenu(
      popup.left + popup.width,
      popup.top + 1 + row,
      width,
      item.submenu.length,
      terminal.width,
      terminal.height,
    );
    popup.submenu = { parent: row, items: item.submenu, left, top, width };
  }
}
