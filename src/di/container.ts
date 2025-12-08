/**
 * Simple Dependency Injection Container
 * 
 * Provides a lightweight DI system for managing component dependencies.
 * Components can be registered and resolved by token (string or symbol).
 */

export type Token<T = unknown> = string | symbol;

export interface Provider<T> {
  useFactory: () => T;
}

export class Container {
  private instances = new Map<Token, unknown>();
  private factories = new Map<Token, () => unknown>();

  /**
   * Register a factory function for a token
   */
  register<T>(token: Token<T>, provider: Provider<T>): this {
    this.factories.set(token, provider.useFactory);
    return this;
  }

  /**
   * Register an existing instance for a token
   */
  registerInstance<T>(token: Token<T>, instance: T): this {
    this.instances.set(token, instance);
    return this;
  }

  /**
   * Resolve a dependency by token
   * Creates instance on first access (lazy singleton)
   */
  resolve<T>(token: Token<T>): T {
    // Check if instance already exists
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Check if factory exists
    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`No provider registered for token: ${String(token)}`);
    }

    // Create instance and cache it
    const instance = factory() as T;
    this.instances.set(token, instance);
    return instance;
  }

  /**
   * Check if a token is registered
   */
  has(token: Token): boolean {
    return this.instances.has(token) || this.factories.has(token);
  }

  /**
   * Clear all instances (useful for testing)
   */
  clear(): void {
    this.instances.clear();
    this.factories.clear();
  }
}

// Global container instance
export const container = new Container();

// Token definitions for the application
export const TOKENS = {
  // Core services
  Renderer: Symbol("Renderer"),
  Config: Symbol("Config"),
  Client: Symbol("Client"),
  Cache: Symbol("Cache"),
  KeyBindings: Symbol("KeyBindings"),
  
  // Components
  TreeView: Symbol("TreeView"),
  PageView: Symbol("PageView"),
  LandingView: Symbol("LandingView"),
  DebugPanel: Symbol("DebugPanel"),
  NavigationHelp: Symbol("NavigationHelp"),
  StatusBar: Symbol("StatusBar"),
  
  // State
  AppState: Symbol("AppState"),
} as const;

/**
 * Decorator-like helper for injecting dependencies
 * Usage: const treeView = inject(TOKENS.TreeView);
 */
export function inject<T>(token: Token<T>): T {
  return container.resolve<T>(token);
}
