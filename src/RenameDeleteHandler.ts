import {
  App,
  TFile,
  Vault,
  type ReferenceCache,
  type TAbstractFile
} from "obsidian";
import type ConsistentAttachmentsAndLinksPlugin from "./ConsistentAttachmentsAndLinksPlugin.ts";
import {
  relative,
  join,
  dirname
} from "obsidian-dev-utils/Path";
import {
  removeFolderSafe,
  applyFileChanges,
  processWithRetry,
  createFolderSafe,
  removeEmptyFolderHierarchy
} from "obsidian-dev-utils/obsidian/Vault";
import { isNote } from "obsidian-dev-utils/obsidian/TAbstractFile";
import type { CanvasData } from "obsidian/canvas.js";
import { toJson } from "obsidian-dev-utils/JSON";
import { getAttachmentFolderPath } from "obsidian-dev-utils/obsidian/AttachmentPath";
import {
  extractLinkFile,
  updateLink,
  updateLinksInFile
} from "obsidian-dev-utils/obsidian/Link";
import {
  getAllLinks,
  getBacklinksForFileSafe,
  getCacheSafe
} from "obsidian-dev-utils/obsidian/MetadataCache";

const renamingPaths = new Set<string>();

export async function handleRename(plugin: ConsistentAttachmentsAndLinksPlugin, file: TAbstractFile, oldPath: string): Promise<void> {
  if (renamingPaths.has(oldPath)) {
    return;
  }

  console.debug("Handle Rename");

  if (!(file instanceof TFile)) {
    return;
  }

  const app = plugin.app;

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const updateAllLinks = app.fileManager.updateAllLinks;
  try {
    plugin.app.fileManager.updateAllLinks = async (): Promise<void> => { };

    const renameMap = new Map<string, string>();
    await fillRenameMap(app, file, oldPath, renameMap);

    for (const [oldPath2, newPath2] of renameMap.entries()) {
      await processRename(plugin, oldPath2, newPath2, renameMap);
    }
  } finally {
    renamingPaths.delete(oldPath);
    plugin.app.fileManager.updateAllLinks = updateAllLinks;
  }
}

export async function handleDelete(plugin: ConsistentAttachmentsAndLinksPlugin, file: TAbstractFile): Promise<void> {
  console.debug("Handle Delete");
  if (!isNote(file)) {
    return;
  }

  if (renamingPaths.has(file.path)) {
    return;
  }

  const attachmentFolder = await getAttachmentFolderPath(plugin.app, file.path);
  await removeFolderSafe(plugin.app, attachmentFolder, file.path);
}

async function fillRenameMap(app: App, file: TFile, oldPath: string, renameMap: Map<string, string>): Promise<void> {
  renameMap.set(oldPath, file.path);

  if (!isNote(file)) {
    return;
  }

  const oldAttachmentFolderPath = await getAttachmentFolderPath(app, oldPath);
  const newAttachmentFolderPath = await getAttachmentFolderPath(app, file.path);
  const dummyOldAttachmentFolderPath = await getAttachmentFolderPath(app, join(dirname(oldPath), "DUMMY_FILE.md"));

  const oldAttachmentFolder = app.vault.getFolderByPath(oldAttachmentFolderPath);

  if (!oldAttachmentFolder) {
    return;
  }

  if (oldAttachmentFolderPath === newAttachmentFolderPath) {
    return;
  }

  const children: TFile[] = [];

  if (oldAttachmentFolderPath === dummyOldAttachmentFolderPath) {
    const cache = await getCacheSafe(app, file);
    if (!cache) {
      return;
    }
    for (const link of getAllLinks(cache)) {
      const attachmentFile = extractLinkFile(app, link, oldPath);
      if (!attachmentFile) {
        continue;
      }

      if (attachmentFile.path.startsWith(oldAttachmentFolderPath)) {
        const backlinks = await getBacklinksForFileSafe(app, attachmentFile);
        if (backlinks.keys().length === 1) {
          children.push(attachmentFile);
        }
      }
    }
  } else {
    Vault.recurseChildren(oldAttachmentFolder, (child) => {
      if (child instanceof TFile) {
        children.push(child);
      }
    });
  }

  for (let child of children) {
    if (isNote(child)) {
      continue;
    }
    child = child as TFile;
    const relativePath = relative(oldAttachmentFolderPath, child.path);
    const newDir = join(newAttachmentFolderPath, dirname(relativePath));
    let newChildPath = join(newDir, child.name);
    if (child.path !== newChildPath) {
      newChildPath = app.vault.getAvailablePath(join(newDir, child.basename), child.extension);
      renameMap.set(child.path, newChildPath);
    }
  }
}

async function processRename(plugin: ConsistentAttachmentsAndLinksPlugin, oldPath: string, newPath: string, renameMap: Map<string, string>): Promise<void> {
  const app = plugin.app;
  let oldFile: TFile | null = null;
  let fakeOldFileCreated = false;

  try {
    oldFile = app.vault.getFileByPath(oldPath);
    const newFile = app.vault.getFileByPath(newPath);
    const file = oldFile ?? newFile;
    if (!file) {
      return;
    }

    if (!oldFile) {
      fakeOldFileCreated = true;
      oldFile = await app.vault.create(oldPath, "");
    }

    const backlinks = await getBacklinks(plugin.app, oldFile, newFile);

    for (const parentNotePath of backlinks.keys()) {
      let parentNote = app.vault.getFileByPath(parentNotePath);
      if (!parentNote) {
        const newParentNotePath = renameMap.get(parentNotePath);
        if (newParentNotePath) {
          parentNote = app.vault.getFileByPath(newParentNotePath);
        }
      }

      if (!parentNote) {
        console.warn(`Parent note not found: ${parentNotePath}`);
        continue;
      }

      await applyFileChanges(app, parentNote, async () => {
        const links =
          (await getBacklinks(plugin.app, oldFile!, newFile)).get(parentNotePath) ?? [];
        const changes = [];

        for (const link of links) {
          changes.push({
            startIndex: link.position.start.offset,
            endIndex: link.position.end.offset,
            oldContent: link.original,
            newContent: updateLink({
              app,
              link,
              pathOrFile: file,
              oldPathOrFile: oldPath,
              sourcePathOrFile: parentNote,
              renameMap
            }),
          });
        }

        return changes;
      });
    }

    if (file.extension.toLowerCase() === "canvas") {
      await processWithRetry(app, file, (content) => {
        const canvasData = JSON.parse(content) as CanvasData;
        for (const node of canvasData.nodes) {
          if (node.type !== "file") {
            continue;
          }
          const newPath = renameMap.get(node.file);
          if (!newPath) {
            continue;
          }
          node.file = newPath;
        }
        return toJson(canvasData);
      });
    } else if (file.extension.toLowerCase() === "md") {
      await updateLinksInFile({
        app,
        pathOrFile: file,
        oldPathOrFile: oldPath,
        renameMap
      });
    }

    if (!fakeOldFileCreated) {
      await createFolderSafe(app, dirname(newPath));
      const oldFolder = oldFile.parent;
      if (newFile) {
        await app.vault.delete(newFile);
      }
      await app.vault.rename(oldFile, newPath);
      if (plugin.settingsCopy.deleteEmptyFolders) {
        await removeEmptyFolderHierarchy(app, oldFolder);
      }
    }
  } finally {
    if (fakeOldFileCreated && oldFile) {
      await app.vault.delete(oldFile);
    }
    renameMap.delete(oldPath);
  }
}

async function getBacklinks(app: App, oldFile: TFile, newFile: TFile | null): Promise<Map<string, ReferenceCache[]>> {
  const backlinks = new Map<string, ReferenceCache[]>();
  const oldLinks = await getBacklinksForFileSafe(app, oldFile);
  for (const path of oldLinks.keys()) {
    backlinks.set(path, oldLinks.get(path)!);
  }

  if (!newFile) {
    return backlinks;
  }

  const newLinks = await getBacklinksForFileSafe(app, newFile);

  for (const path of newLinks.keys()) {
    const links = backlinks.get(path) ?? [];
    links.push(...newLinks.get(path)!);
    backlinks.set(path, links);
  }

  return backlinks;
}
