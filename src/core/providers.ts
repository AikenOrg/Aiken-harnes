import type { ModelInfo, Provider } from "../protocol/provider.ts";

export class ProviderRegistry {
  #providers = new Map<string, Provider>();
  #modelOwner = new Map<string, string>();
  #models = new Map<string, ModelInfo>();
  #prefixOwner = new Map<string, string>();

  register(provider: Provider, moduleName: string): void {
    const models = provider.models();
    if (models.length === 0) throw new Error(`provider ${moduleName} declares no models`);
    this.#providers.set(moduleName, provider);

    for (const model of models) {
      if (!model.id.includes("/")) throw new Error(`model id must be "<prefix>/<model>": ${model.id}`);
      if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
        throw new Error(`model ${model.id} requires a positive contextWindow`);
      }
      const prefix = model.id.slice(0, model.id.indexOf("/"));
      const owner = this.#prefixOwner.get(prefix);
      if (owner !== undefined && owner !== moduleName) {
        throw new Error(`model prefix ${prefix} owned by ${owner}, not ${moduleName}`);
      }
      const existing = this.#modelOwner.get(model.id);
      if (existing !== undefined && existing !== moduleName) {
        throw new Error(`model ${model.id} already registered by ${existing}`);
      }
      this.#prefixOwner.set(prefix, moduleName);
      this.#modelOwner.set(model.id, moduleName);
      this.#models.set(model.id, model);
    }
  }

  models(): ModelInfo[] {
    return [...this.#models.values()];
  }

  getModelInfo(modelId: string): ModelInfo {
    const model = this.#models.get(modelId);
    if (!model) throw new Error(`model not found: ${modelId}`);
    return model;
  }

  resolve(modelId: string): Provider {
    const moduleName = this.#modelOwner.get(modelId);
    if (!moduleName) throw new Error(`model not found: ${modelId}`);
    const provider = this.#providers.get(moduleName);
    if (!provider) throw new Error(`provider not found: ${moduleName}`);
    return provider;
  }

  moduleOf(modelId: string): string {
    const moduleName = this.#modelOwner.get(modelId);
    if (!moduleName) throw new Error(`model not found: ${modelId}`);
    return moduleName;
  }

  get size(): number {
    return this.#providers.size;
  }
}
