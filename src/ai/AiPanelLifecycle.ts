export type AiPanelLifecycle = {
  generation: number;
  userId: string;
};

type AiPanelRequestKind = "load" | "upload" | "download" | "account";

export class AiPanelLifecycleGuard {
  private generation = 0;
  private userId: string | null = null;
  private controllers = new Map<AiPanelRequestKind, AbortController>();

  activate(userId: string): AiPanelLifecycle {
    this.abortRequests();
    this.generation += 1;
    this.userId = userId;
    return { generation: this.generation, userId };
  }

  deactivate() {
    this.abortRequests();
    this.generation += 1;
    this.userId = null;
  }

  current(userId: string): AiPanelLifecycle | null {
    if (this.userId !== userId) return null;
    return { generation: this.generation, userId };
  }

  isCurrent(lifecycle: AiPanelLifecycle) {
    return (
      this.userId === lifecycle.userId &&
      this.generation === lifecycle.generation
    );
  }

  beginRequest(
    kind: AiPanelRequestKind,
    lifecycle: AiPanelLifecycle
  ) {
    this.controllers.get(kind)?.abort();
    const controller = new AbortController();
    if (!this.isCurrent(lifecycle)) {
      controller.abort();
      return controller;
    }
    this.controllers.set(kind, controller);
    return controller;
  }

  finishRequest(kind: AiPanelRequestKind, controller: AbortController) {
    if (this.controllers.get(kind) === controller) {
      this.controllers.delete(kind);
    }
  }

  private abortRequests() {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }
}
