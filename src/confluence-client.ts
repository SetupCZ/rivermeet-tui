import type {
  ConfluenceSpace,
  ConfluencePage,
  ConfluencePageRef,
  ADFDocument,
  Config,
} from "./types";
import { logger } from "./logger";

export class ConfluenceClient {
  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private authHeader: string;

  constructor(config: Config["confluence"]) {
    // Clean and normalize the baseUrl
    let url = config.baseUrl.trim();
    logger.debug("ConfluenceClient constructor", { 
      originalBaseUrl: config.baseUrl,
      email: config.email,
      hasApiToken: !!config.apiToken 
    });
    
    // Fix common URL mistakes
    // Remove any malformed protocol prefixes like "hhttps://" or "htttps://"
    url = url.replace(/^h+ttps?:\/\//i, "");
    url = url.replace(/^https?:\/\//i, ""); // Remove valid protocol too, we'll add it back
    
    // Now add https:// prefix
    if (url) {
      url = `https://${url}`;
    }
    
    this.baseUrl = url.replace(/\/$/, "");
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.authHeader = `Basic ${Buffer.from(
      `${this.email}:${this.apiToken}`
    ).toString("base64")}`;
    
    logger.info("ConfluenceClient initialized", { baseUrl: this.baseUrl, email: this.email });
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    if (!this.baseUrl) {
      const error = "Confluence base URL is not configured";
      logger.error(error);
      throw new Error(error);
    }
    
    const url = `${this.baseUrl}${endpoint}`;
    logger.debug("Making request", { 
      url, 
      method: options.method || "GET",
      bodyPreview: options.body ? String(options.body).substring(0, 500) : undefined
    });
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });

      logger.debug("Response received", { 
        url, 
        status: response.status, 
        statusText: response.statusText 
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error("API error response", { url, status: response.status, error });
        throw new Error(
          `Confluence API error (${response.status}): ${error}`
        );
      }

      const data = await response.json() as T;
      logger.debug("Response parsed successfully", { url });
      return data;
    } catch (error) {
      logger.error("Request failed", { 
        url, 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      
      if (error instanceof Error) {
        if (error.message.includes("ERR_INVALID_ARG_VALUE")) {
          throw new Error(`Invalid URL: ${url}. Please check your ATLASSIAN_BASE_URL configuration.`);
        }
        throw error;
      }
      throw new Error(`Request failed: ${error}`);
    }
  }

  async getSpaces(): Promise<ConfluenceSpace[]> {
    interface SpacesResponse {
      results: Array<{
        id: string;
        key: string;
        name: string;
        type: string;
        status: string;
        description?: { plain?: { value: string } };
        homepageId?: string;
      }>;
      _links?: { next?: string };
    }

    const spaces: ConfluenceSpace[] = [];
    let cursor: string | undefined;

    do {
      const endpoint = cursor
        ? `/wiki/api/v2/spaces?cursor=${cursor}&limit=50`
        : "/wiki/api/v2/spaces?limit=50";

      const response = await this.request<SpacesResponse>(endpoint);

      for (const space of response.results) {
        spaces.push({
          id: space.id,
          key: space.key,
          name: space.name,
          type: space.type as "global" | "personal",
          status: space.status as "current" | "archived",
          description: space.description?.plain?.value,
        });
      }

      // Extract cursor from next link if present
      if (response._links?.next) {
        const match = response._links.next.match(/cursor=([^&]+)/);
        cursor = match ? match[1] : undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    return spaces;
  }

  async getSpacePages(spaceId: string): Promise<ConfluencePageRef[]> {
    interface PagesResponse {
      results: Array<{
        id: string;
        title: string;
      }>;
      _links?: { next?: string };
    }

    const pages: ConfluencePageRef[] = [];
    let cursor: string | undefined;

    do {
      const endpoint = cursor
        ? `/wiki/api/v2/spaces/${spaceId}/pages?cursor=${cursor}&limit=50`
        : `/wiki/api/v2/spaces/${spaceId}/pages?limit=50`;

      const response = await this.request<PagesResponse>(endpoint);

      for (const page of response.results) {
        pages.push({
          id: page.id,
          title: page.title,
        });
      }

      if (response._links?.next) {
        const match = response._links.next.match(/cursor=([^&]+)/);
        cursor = match ? match[1] : undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    return pages;
  }

  async getPage(
    pageId: string,
    bodyFormat: "storage" | "atlas_doc_format" = "atlas_doc_format"
  ): Promise<ConfluencePage> {
    interface PageResponse {
      id: string;
      title: string;
      spaceId: string;
      parentId?: string;
      status: string;
      body?: {
        storage?: { value: string };
        atlas_doc_format?: { value: string };
      };
      version: {
        number: number;
        message?: string;
        createdAt: string;
      };
    }

    const endpoint = `/wiki/api/v2/pages/${pageId}?body-format=${bodyFormat}`;
    const response = await this.request<PageResponse>(endpoint);

    return {
      id: response.id,
      title: response.title,
      spaceId: response.spaceId,
      parentId: response.parentId,
      status: response.status as "current" | "draft" | "archived",
      body: {
        ...(response.body?.storage && {
          storage: {
            value: response.body.storage.value,
            representation: "storage" as const,
          },
        }),
        ...(response.body?.atlas_doc_format && {
          atlas_doc_format: {
            value: response.body.atlas_doc_format.value,
            representation: "atlas_doc_format" as const,
          },
        }),
      },
      version: response.version,
    };
  }

  async getPageChildren(pageId: string): Promise<ConfluencePageRef[]> {
    interface ChildrenResponse {
      results: Array<{
        id: string;
        title: string;
      }>;
      _links?: { next?: string };
    }

    const children: ConfluencePageRef[] = [];
    let cursor: string | undefined;

    do {
      const endpoint = cursor
        ? `/wiki/api/v2/pages/${pageId}/children?cursor=${cursor}&limit=50`
        : `/wiki/api/v2/pages/${pageId}/children?limit=50`;

      const response = await this.request<ChildrenResponse>(endpoint);

      for (const child of response.results) {
        children.push({
          id: child.id,
          title: child.title,
        });
      }

      if (response._links?.next) {
        const match = response._links.next.match(/cursor=([^&]+)/);
        cursor = match ? match[1] : undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    return children;
  }

  async updatePage(
    pageId: string,
    title: string,
    body: string,
    version: number,
    bodyFormat: "storage" | "atlas_doc_format" = "atlas_doc_format",
    spaceKey?: string
  ): Promise<ConfluencePage> {
    // Use REST API v1 for updating pages
    const endpoint = `/wiki/rest/api/content/${pageId}`;

    // If no spaceKey provided, fetch it from the page metadata
    let resolvedSpaceKey = spaceKey;
    if (!resolvedSpaceKey) {
      const metadata = await this.getPageMetadata(pageId);
      resolvedSpaceKey = metadata.spaceKey;
    }

    const payload = {
      id: pageId,
      type: "page",
      title,
      space: {
        key: resolvedSpaceKey,
      },
      version: {
        number: version + 1,
        message: "Updated via confluence-tui",
      },
      body: {
        atlas_doc_format: {
          value: body,
          representation: bodyFormat,
        },
      },
    };

    logger.info("updatePage request (v1 API)", { 
      endpoint, 
      fullUrl: `${this.baseUrl}${endpoint}`,
      pageId, 
      title, 
      spaceKey: resolvedSpaceKey,
      currentVersion: version,
      newVersion: version + 1,
      bodyFormat,
    });

    const response = await this.request<any>(endpoint, {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    // Convert v1 response to our ConfluencePage type
    return {
      id: response.id,
      title: response.title,
      spaceId: response.space?.key || "",
      status: response.status as "current" | "draft" | "archived",
      body: {
        ...(response.body?.storage && {
          storage: {
            value: response.body.storage.value,
            representation: "storage" as const,
          },
        }),
        ...(response.body?.atlas_doc_format && {
          atlas_doc_format: {
            value: response.body.atlas_doc_format.value,
            representation: "atlas_doc_format" as const,
          },
        }),
      },
      version: response.version,
    };
  }

  /**
   * Get page metadata (title, space key, version)
   */
  async getPageMetadata(pageId: string): Promise<{ title: string; spaceKey: string; currentVersion: number }> {
    const endpoint = `/wiki/rest/api/content/${pageId}?expand=space,version`;
    const response = await this.request<any>(endpoint);
    
    return {
      title: response.title,
      spaceKey: response.space.key,
      currentVersion: response.version.number,
    };
  }

  parseADF(page: ConfluencePage): ADFDocument | null {
    if (page.body.atlas_doc_format?.value) {
      try {
        return JSON.parse(page.body.atlas_doc_format.value);
      } catch {
        return null;
      }
    }
    return null;
  }
}
