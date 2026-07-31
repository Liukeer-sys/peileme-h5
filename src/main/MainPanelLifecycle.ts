export type MainPanelPrivateState = {
  invite: string;
  message: string;
  displayName: string;
  busy: boolean;
};

export const createMainPanelPrivateState = (
  displayName = ""
): MainPanelPrivateState => ({
  invite: "",
  message: "",
  displayName,
  busy: false
});

export type MainPanelMutation = {
  generation: number;
  mutationGeneration: number;
  userId: string;
};

export class MainPanelLifecycleGuard {
  private generation = 0;
  private mutationGeneration = 0;
  private userId: string | null = null;

  activate(userId: string) {
    this.generation += 1;
    this.mutationGeneration += 1;
    this.userId = userId;
  }

  deactivate() {
    this.generation += 1;
    this.mutationGeneration += 1;
    this.userId = null;
  }

  beginMutation(userId: string): MainPanelMutation | null {
    if (this.userId !== userId) return null;
    this.mutationGeneration += 1;
    return {
      generation: this.generation,
      mutationGeneration: this.mutationGeneration,
      userId
    };
  }

  isCurrent(
    mutation: MainPanelMutation,
    visibleUserId: string | null
  ) {
    return (
      visibleUserId === mutation.userId &&
      this.userId === mutation.userId &&
      this.generation === mutation.generation &&
      this.mutationGeneration === mutation.mutationGeneration
    );
  }
}
