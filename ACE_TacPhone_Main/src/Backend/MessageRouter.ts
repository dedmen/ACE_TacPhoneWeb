// This is a helper that can be used by other apps
// Because there is only one OnMessageFromGame() handler per App, there needs to be a way to route messages to the panels that want it
//
// Apps construct one through `window.TacPhone.utils.CommandRegistry`.

import type { CommandHandler } from "./Types";

export type { CommandHandler } from "./Types";

export class CommandRegistry {
  // Internal map tracking a Set of callbacks for each action string
  private registry: Map<string, Set<CommandHandler>> = new Map();
  // Commands already reported as unsubscribed, so a high-rate push (GPS.Update
  // runs at 10 Hz) warns once instead of on every message. Registering a
  // subscriber for the command arms the report again.
  private reportedUnsubscribed: Set<string> = new Set();

  /**
   * Registers a callback for a specific action.
   * @returns A cleanup function to unregister this specific listener.
   */
  public register(action: string, handler: CommandHandler): () => void {
    const existing = this.registry.get(action);
    const wasEmpty = !existing || existing.size === 0;
    if (!existing) {
      this.registry.set(action, new Set());
    }

    this.registry.get(action)!.add(handler);

    // The first subscriber makes a previous "no subscribers" report stale.
    if (wasEmpty) {
      this.reportedUnsubscribed.delete(action);
    }

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
      } else if (!this.reportedUnsubscribed.has(packet.c)) {
        this.reportedUnsubscribed.add(packet.c);
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
    this.reportedUnsubscribed.clear();
  }
}
