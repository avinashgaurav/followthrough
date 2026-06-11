/**
 * Minimal Chrome extension API typings for the surface this extension uses.
 * Hand-written instead of pulling @types/chrome so the build has zero
 * dependencies beyond Bun and TypeScript.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: tabs.Tab;
    }

    const id: string;
    const lastError: { message?: string } | undefined;

    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    function getURL(path: string): string;
    function getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      title?: string;
      url?: string;
      active: boolean;
      audible?: boolean;
    }
    function query(queryInfo: {
      active?: boolean;
      lastFocusedWindow?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;
  }

  namespace tabCapture {
    function getMediaStreamId(
      options: { targetTabId?: number; consumerTabId?: number },
      callback: (streamId: string) => void,
    ): void;
  }

  namespace offscreen {
    function createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }
}
