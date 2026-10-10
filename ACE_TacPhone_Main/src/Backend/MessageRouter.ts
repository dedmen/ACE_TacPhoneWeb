// This is a helper that can be used by other apps
// Because there is only one OnMessageFromGame() handler per App, there needs to be a way to route messages to the panels that want it


export type CommandHandler = (payload: object) => void;

export class CommandRegistry {
  // Internal map tracking a Set of callbacks for each action string
  private registry: Map<string, Set<CommandHandler>> = new Map();

  /**
   * Registers a callback for a specific action.
   * @returns A cleanup function to unregister this specific listener.
   */
  public register(action: string, handler: CommandHandler): () => void {
    if (!this.registry.has(action)) {
      this.registry.set(action, new Set());
    }

    this.registry.get(action)!.add(handler);

    // Return a self-contained unregister closure
    return () => {
      const handlers = this.registry.get(action);
      if (handlers) {
        handlers.delete(handler);
        // Clean up empty sets to free up map memory
        if (handlers.size === 0) {
          this.registry.delete(action);
        }
      }
    };
  }

  /**
   * Parses a raw WebSocket message string and routes it to all matching subscribers.
   */
  public routeMessage(packet: {c: string}): void {
    try {
      const handlers = this.registry.get(packet.c);

      if (handlers && handlers.size > 0) {
        handlers.forEach((executeCommand) => {
          try {
            executeCommand(packet);
          } catch (err) {
            console.error(`Error in subscriber for command "${packet.c}":`, err);
          }
        });
      } else {
        console.warn(`No active subscribers for command: ${packet.c}`);
      }
    } catch (err) {
      console.error('Failed to parse global network packet:', err);
    }
  }

  /**
   * Purges all subscribers across all commands.
   */
  public clear(): void {
    this.registry.clear();
  }
}


// The apps don't have access to our code itself, we need to store the prototype globally so they can access it

declare global {
    interface Window { TacPhoneUtils: { CommandRegistry: typeof CommandRegistry }; }
}
window.TacPhoneUtils = {...window.TacPhoneUtils, CommandRegistry};