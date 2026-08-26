import materialExtension from "../../assets/icons/material-icons.json";

export interface ResolvedIcon {
  glyph: string;
  color?: string;
}

interface MaterialIconData {
  file: ResolvedIcon;
  folder: ResolvedIcon;
  folderOpen: ResolvedIcon;
  definitions: Record<string, ResolvedIcon>;
  names: Record<string, string>;
  extensions: Record<string, string>;
}

const material = materialExtension.icons[0] as MaterialIconData;

function definition(
  id: string | undefined,
  fallback: ResolvedIcon,
): ResolvedIcon {
  return (id && material.definitions[id]) || fallback;
}

export function resolveMaterialIcon(
  name: string,
  directory: boolean,
  open = false,
): ResolvedIcon {
  const lower = name.toLowerCase();
  // Folders always use the generic folder glyph: name-specific folder icons
  // (git, src, tests, ...) read as file-type icons in a dense tree.
  if (directory) return open ? material.folderOpen : material.folder;

  const named = material.names[lower];
  if (named) return definition(named, material.file);
  const parts = lower.split(".");
  for (let index = 1; index < parts.length; index++) {
    const id = material.extensions[parts.slice(index).join(".")];
    if (id) return definition(id, material.file);
  }
  return material.file;
}
