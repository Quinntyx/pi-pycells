/** Human-facing naming adapter; PythonSessionManager owns kernel identities. */
import { normalizeKernelName, type PythonSessionManager } from "../python-session-manager";
export { normalizeKernelName } from "../python-session-manager";

export interface KernelRef {
  id: string;
  name: string;
  notebookPath?: string;
}

export class KernelNameError extends Error {}

export class KernelDirectory {
  // Bindings also support structural manager doubles. Runtime names remain authoritative.
  private names = new Map<string, string>();
  constructor(private readonly manager: PythonSessionManager) {}

  private liveKernels() {
    return this.manager.list().map((kernel) => ({
      id: kernel.id,
      name: kernel.name,
      notebookPath: kernel.notebookPath,
    }));
  }

  nameOf(id: string): string | undefined {
    return this.liveKernels().find((kernel) => kernel.id === id)?.name
      ?? [...this.names].find(([, sessionId]) => sessionId === id)?.[0];
  }

  assertAvailable(rawName: unknown): string {
    const name = normalizeKernelName(rawName);
    if (this.liveKernels().some((kernel) => kernel.name === name || this.names.get(name) === kernel.id)) {
      throw new KernelNameError(`Kernel name "${name}" is already in use by a live kernel. Choose a unique name.`);
    }
    return name;
  }

  register(rawName: unknown, id: string, notebookPath?: string): KernelRef {
    const name = normalizeKernelName(rawName);
    const live = this.liveKernels();
    if (live.some((kernel) => kernel.id !== id && (kernel.name === name || this.names.get(name) === kernel.id))) {
      throw new KernelNameError(`Kernel name "${name}" is already in use by a live kernel. Choose a unique name.`);
    }
    this.names.set(name, id);
    return { id, name, notebookPath };
  }

  resolveKernel(rawName: unknown): KernelRef {
    const name = normalizeKernelName(rawName);
    const live = this.liveKernels();
    const kernel = live.find((candidate) => candidate.name === name || this.names.get(name) === candidate.id);
    if (kernel) return { id: kernel.id, name: kernel.name ?? name, notebookPath: kernel.notebookPath };
    this.names.delete(name);
    const names = this.list().map((entry) => entry.name);
    throw new KernelNameError(`Unknown kernel "${name}". Live kernels: ${names.join(", ") || "(none)"}.`);
  }

  list(): KernelRef[] {
    return this.liveKernels().flatMap((kernel) => {
      const name = kernel.name ?? this.nameOf(kernel.id);
      return name ? [{ id: kernel.id, name, notebookPath: kernel.notebookPath }] : [];
    });
  }

  forget(id: string): void {
    for (const [name, sessionId] of this.names) if (sessionId === id) this.names.delete(name);
  }
}
