export type MenuAction =
  | "checkout"
  | "copy-sha"
  | "create-branch"
  | "delete"
  | "refresh";
export interface MenuItem {
  label: string;
  action: MenuAction;
  destructive?: boolean;
}
export interface ContextMenu {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
}
export function contextMenu(
  kind: "commit" | "branch" | "file",
  x = 0,
  y = 0,
): ContextMenu {
  const items: MenuItem[] =
    kind === "commit"
      ? [
          { label: "Create branch here", action: "create-branch" },
          { label: "Copy commit SHA", action: "copy-sha" },
        ]
      : kind === "branch"
        ? [
            { label: "Checkout", action: "checkout" },
            { label: "Delete branch", action: "delete", destructive: true },
          ]
        : [{ label: "Refresh", action: "refresh" }];
  return { x, y, title: kind.charAt(0).toUpperCase() + kind.slice(1), items };
}
