import * as fs from "fs";
import * as path from "path";
import type { CachedPage, ADFDocument, Config } from "./types";
import {
  createComponentRegistry,
  createRenderContext,
} from "./markdown-components";

export class PageCache {
  private cacheDir: string;

  constructor(config: Config) {
    this.cacheDir = config.cacheDir;
    this.ensureCacheDir();
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(spaceKey: string, pageId: string): string {
    const spaceDir = path.join(this.cacheDir, spaceKey);
    if (!fs.existsSync(spaceDir)) {
      fs.mkdirSync(spaceDir, { recursive: true });
    }
    return path.join(spaceDir, `${pageId}.json`);
  }

  private getMarkdownPath(spaceKey: string, pageId: string): string {
    const spaceDir = path.join(this.cacheDir, spaceKey);
    if (!fs.existsSync(spaceDir)) {
      fs.mkdirSync(spaceDir, { recursive: true });
    }
    return path.join(spaceDir, `${pageId}.md`);
  }

  getCachedPage(spaceKey: string, pageId: string): CachedPage | null {
    const cachePath = this.getCachePath(spaceKey, pageId);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(cachePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  savePage(
    spaceKey: string,
    pageId: string,
    title: string,
    adf: ADFDocument,
    version: number
  ): CachedPage {
    const markdown = this.adfToMarkdown(adf);
    const cached: CachedPage = {
      pageId,
      spaceKey,
      title,
      markdown,
      adf,
      fetchedAt: Date.now(),
      version,
    };

    // Save JSON cache
    const cachePath = this.getCachePath(spaceKey, pageId);
    fs.writeFileSync(cachePath, JSON.stringify(cached, null, 2));

    // Save markdown file
    const markdownPath = this.getMarkdownPath(spaceKey, pageId);
    fs.writeFileSync(markdownPath, markdown);

    return cached;
  }

  getMarkdownPath_public(spaceKey: string, pageId: string): string {
    return this.getMarkdownPath(spaceKey, pageId);
  }

  readMarkdownFile(spaceKey: string, pageId: string): string | null {
    const markdownPath = this.getMarkdownPath(spaceKey, pageId);
    if (!fs.existsSync(markdownPath)) {
      return null;
    }
    return fs.readFileSync(markdownPath, "utf-8");
  }

  private adfToMarkdown(adf: ADFDocument): string {
    const components = createComponentRegistry();
    const context = createRenderContext(components);

    const docComponent = components.get("doc");
    if (!docComponent) {
      throw new Error("Document component not found");
    }

    return docComponent.toMarkdown(adf, context);
  }

  isStale(cached: CachedPage, maxAgeMs: number = 1000 * 60 * 5): boolean {
    return Date.now() - cached.fetchedAt > maxAgeMs;
  }

  clearCache(): void {
    if (fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true });
      this.ensureCacheDir();
    }
  }

  clearPageCache(spaceKey: string, pageId: string): void {
    const cachePath = this.getCachePath(spaceKey, pageId);
    const markdownPath = this.getMarkdownPath(spaceKey, pageId);

    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
    if (fs.existsSync(markdownPath)) {
      fs.unlinkSync(markdownPath);
    }
  }
}
