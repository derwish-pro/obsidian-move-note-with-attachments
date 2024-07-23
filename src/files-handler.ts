import {
  App,
  type CachedMetadata,
  type ListedFiles,
  TFile
} from "obsidian";
import {
  LinksHandler,
  type PathChangeInfo
} from "./links-handler.ts";
import { Utils } from "./utils.ts";
import {
  getAllLinks,
  getCacheSafe
} from "./MetadataCache.ts";
import {
  basename,
  dirname,
  extname,
  join
} from "node:path/posix";
import { showError } from "./Error.ts";

export interface MovedAttachmentResult {
  movedAttachments: PathChangeInfo[]
  renamedFiles: PathChangeInfo[],
}

export class FilesHandler {
  public constructor(
    private app: App,
    private lh: LinksHandler,
    private consoleLogPrefix: string = "",
    private ignoreFolders: string[] = [],
    private ignoreFilesRegex: RegExp[] = [],
  ) { }

  public isPathIgnored(path: string): boolean {
    if (path.startsWith("./")) {
      path = path.substring(2);
    }

    for (const folder of this.ignoreFolders) {
      if (path.startsWith(folder)) {
        return true;
      }
    }

    for (const fileRegex of this.ignoreFilesRegex) {
      const testResult = fileRegex.test(path);
      // console.log(path,fileRegex,testResult)
      if (testResult) {
        return true;
      }
    }

    return false;
  }

  public async createFolderForAttachmentFromLink(link: string, owningNotePath: string): Promise<void> {
    const newFullPath = this.lh.getFullPathForLink(link, owningNotePath);
    return await this.createFolderForAttachmentFromPath(newFullPath);
  }

  public async createFolderForAttachmentFromPath(filePath: string): Promise<void> {
    const newParentFolder = filePath.substring(0, filePath.lastIndexOf("/"));
    try {
      //todo check folder exist
      await this.app.vault.createFolder(newParentFolder);
    } catch { }
  }

  public generateFileCopyName(originalName: string): string {
    const ext = extname(originalName);
    const baseName = basename(originalName, ext);
    const dir = dirname(originalName);
    for (let i = 1; i < 100000; i++) {
      const newName = dir + "/" + baseName + " " + i + ext;
      const existFile = this.app.vault.getFileByPath(newName);
      if (!existFile) {
        return newName;
      }
    }
    return "";
  }

  public async moveCachedNoteAttachments(oldNotePath: string, newNotePath: string,
    deleteExistFiles: boolean, attachmentsSubfolder: string, deleteEmptyFolders: boolean): Promise<MovedAttachmentResult> {

    if (this.isPathIgnored(oldNotePath) || this.isPathIgnored(newNotePath)) {
      return { movedAttachments: [], renamedFiles: [] };
    }

    const cache = await getCacheSafe(this.app, oldNotePath);
    const links = getAllLinks(cache);

    const result: MovedAttachmentResult = {
      movedAttachments: [],
      renamedFiles: []
    };

    for (const link of links) {
      const [linkPath] = this.lh.splitSubpath(link.link);
      const oldLinkPath = this.lh.getFullPathForLink(linkPath, oldNotePath);

      if (result.movedAttachments.findIndex(x => x.oldPath == oldLinkPath) != -1) {
        //already moved
        continue;
      }

      let file = this.lh.getFileByLink(linkPath, oldNotePath);
      if (!file) {
        file = this.lh.getFileByLink(linkPath, newNotePath);
        if (!file) {
          showError(this.consoleLogPrefix + oldNotePath + " has bad embed (file does not exist): " + linkPath);
          continue;
        }
      }

      //if attachment not in the note folder, skip it
      // = "." means that note was at root path, so do not skip it
      if (dirname(oldNotePath) != "." && !dirname(oldLinkPath).startsWith(dirname(oldNotePath))) {
        continue;
      }

      if (!this.isAttachment(file)) {
        continue;
      }

      const newLinkPath = this.getNewAttachmentPath(file.path, newNotePath, attachmentsSubfolder);

      if (newLinkPath == file.path) {
        //nothing to move
        continue;
      }

      const res = await this.moveAttachment(file, newLinkPath, [oldNotePath, newNotePath], deleteExistFiles, deleteEmptyFolders);
      result.movedAttachments = result.movedAttachments.concat(res.movedAttachments);
      result.renamedFiles = result.renamedFiles.concat(res.renamedFiles);
    }

    return result;
  }

  public getNewAttachmentPath(oldAttachmentPath: string, notePath: string, subfolderName: string): string {
    const resolvedSubFolderName = subfolderName.replace(/\${filename}/g, basename(notePath, ".md"));
    let newPath = (resolvedSubFolderName == "") ? dirname(notePath) : join(dirname(notePath), resolvedSubFolderName);
    newPath = Utils.normalizePathForFile(join(newPath, basename(oldAttachmentPath)));
    return newPath;
  }

  public async collectAttachmentsForCachedNote(notePath: string, subfolderName: string,
    deleteExistFiles: boolean, deleteEmptyFolders: boolean): Promise<MovedAttachmentResult> {

    if (this.isPathIgnored(notePath)) {
      return { movedAttachments: [], renamedFiles: [] };
    }

    const result: MovedAttachmentResult = {
      movedAttachments: [],
      renamedFiles: []
    };

    const cache = await getCacheSafe(this.app, notePath);

    for (const link of getAllLinks(cache)) {
      const [linkPath] = this.lh.splitSubpath(link.link);

      if (!linkPath) {
        continue;
      }

      const fullPathLink = this.lh.getFullPathForLink(linkPath, notePath);
      if (result.movedAttachments.findIndex(x => x.oldPath == fullPathLink) != -1) {
        // already moved
        continue;
      }

      const file = this.lh.getFileByLink(linkPath, notePath);
      if (!file) {
        const type = link.original.startsWith("!") ? "embed" : "link";
        showError(`${this.consoleLogPrefix}${notePath} has bad ${type} (file does not exist): ${linkPath}`);
        continue;
      }

      if (!this.isAttachment(file)) {
        continue;
      }

      const newPath = this.getNewAttachmentPath(file.path, notePath, subfolderName);

      if (newPath == file.path) {
        // nothing to move
        continue;
      }

      const res = await this.moveAttachment(file, newPath, [notePath], deleteExistFiles, deleteEmptyFolders);

      result.movedAttachments = result.movedAttachments.concat(res.movedAttachments);
      result.renamedFiles = result.renamedFiles.concat(res.renamedFiles);
    }

    return result;
  }

  public async moveAttachment(file: TFile, newLinkPath: string, parentNotePaths: string[], deleteExistFiles: boolean, deleteEmptyFolders: boolean): Promise<MovedAttachmentResult> {
    const path = file.path;

    const result: MovedAttachmentResult = {
      movedAttachments: [],
      renamedFiles: []
    };

    if (this.isPathIgnored(path)) {
      return result;
    }

    if (!this.isAttachment(file)) {
      return result;
    }

    if (path == newLinkPath) {
      console.warn(this.consoleLogPrefix + "Can't move file. Source and destination path the same.");
      return result;
    }

    await this.createFolderForAttachmentFromPath(newLinkPath);

    const linkedNotes = this.lh.getCachedNotesThatHaveLinkToFile(path);
    if (parentNotePaths) {
      for (const notePath of parentNotePaths) {
        linkedNotes.remove(notePath);
      }
    }

    if (path !== file.path) {
      console.warn(this.consoleLogPrefix + "File was moved already");
      return await this.moveAttachment(file, newLinkPath, parentNotePaths, deleteExistFiles, deleteEmptyFolders);
    }

    //if no other file has link to this file - try to move file
    //if file already exist at new location - delete or move with new name
    if (linkedNotes.length == 0) {
      const existFile = this.app.vault.getFileByPath(newLinkPath);
      if (!existFile) {
        //move
        console.log(this.consoleLogPrefix + "move file [from, to]: \n   " + path + "\n   " + newLinkPath);
        result.movedAttachments.push({ oldPath: path, newPath: newLinkPath });
        await this.app.vault.rename(file, newLinkPath);
      } else {
        if (deleteExistFiles) {
          //delete
          console.log(this.consoleLogPrefix + "delete file: \n   " + path);
          result.movedAttachments.push({ oldPath: path, newPath: newLinkPath });
          await this.deleteFile(file, deleteEmptyFolders);
        } else {
          //move with new name
          const newFileCopyName = this.generateFileCopyName(newLinkPath);
          console.log(this.consoleLogPrefix + "copy file with new name [from, to]: \n   " + path + "\n   " + newFileCopyName);
          result.movedAttachments.push({ oldPath: path, newPath: newFileCopyName });
          await this.app.vault.rename(file, newFileCopyName);
          result.renamedFiles.push({ oldPath: newLinkPath, newPath: newFileCopyName });
        }
      }
    } else {
      //if some other file has link to this file - try to copy file
      //if file already exist at new location - copy file with new name or do nothing
      const existFile = this.app.vault.getFileByPath(newLinkPath);
      if (!existFile) {
        //copy
        console.log(this.consoleLogPrefix + "copy file [from, to]: \n   " + path + "\n   " + newLinkPath);
        result.movedAttachments.push({ oldPath: path, newPath: newLinkPath });
        await this.app.vault.copy(file, newLinkPath);
      } else {
        if (deleteExistFiles) {
          //do nothing
        } else {
          //copy with new name
          const newFileCopyName = this.generateFileCopyName(newLinkPath);
          console.log(this.consoleLogPrefix + "copy file with new name [from, to]: \n   " + path + "\n   " + newFileCopyName);
          result.movedAttachments.push({ oldPath: file.path, newPath: newFileCopyName });
          await this.app.vault.copy(file, newFileCopyName);
          result.renamedFiles.push({ oldPath: newLinkPath, newPath: newFileCopyName });
        }
      }
    }
    return result;
  }

  public async deleteEmptyFolders(dirName: string): Promise<void> {
    if (this.isPathIgnored(dirName)) {
      return;
    }

    if (dirName.startsWith("./")) {
      dirName = dirName.substring(2);
    }

    let list = await this.safeList(dirName);
    for (const folder of list.folders) {
      await this.deleteEmptyFolders(folder);
    }

    list = await this.safeList(dirName);
    if (list.files.length == 0 && list.folders.length == 0) {
      console.log(this.consoleLogPrefix + "delete empty folder: \n   " + dirName);
      if (await this.app.vault.adapter.exists(dirName)) {
        try {
          await this.app.vault.adapter.rmdir(dirName, false);
        } catch(e) {
          if (await this.app.vault.adapter.exists(dirName)) {
            throw e;
          }
        }
      }
    }
  }

  public async deleteUnusedAttachmentsForCachedNote(notePath: string, cache: CachedMetadata, deleteEmptyFolders: boolean): Promise<void> {
    if (this.isPathIgnored(notePath)) {
      return;
    }

    for (const link of getAllLinks(cache)) {
      const [linkPath] = this.lh.splitSubpath(link.link);
      const file = this.lh.getFileByLink(linkPath, notePath, false);

      if (!file || !this.isAttachment(file)) {
        continue;
      }

      const linkedNotes = this.lh.getCachedNotesThatHaveLinkToFile(file.path);
      if (linkedNotes.length == 0) {
        try {
          await this.deleteFile(file, deleteEmptyFolders);
        } catch { }
      }
    }
  }

  public async deleteFile(file: TFile, deleteEmptyFolders: boolean): Promise<void> {
    await this.app.vault.trash(file, true);
    if (deleteEmptyFolders) {
      let dir = file.parent!;
      while (dir.children.length === 0) {
        await this.app.vault.trash(dir, true);
        dir = dir.parent!;
      }
    }
  }

  private isAttachment(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    return extension !== "md" && extension !== "canvas";
  }

  public async safeList(path: string): Promise<ListedFiles> {
    const EMPTY = { files: [], folders: [] };
    if (!(await this.app.vault.adapter.exists(path))) {
      return EMPTY;
    }

    try {
      return await this.app.vault.adapter.list(path);
    } catch(e) {
      if (await this.app.vault.adapter.exists(path)) {
        throw e;
      }
      return EMPTY;
    }
  }
}
