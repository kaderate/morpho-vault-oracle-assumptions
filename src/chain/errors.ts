// The RPC could not answer (rate limit after retries, network, node error). The data may exist; we could not read it.
export class RpcUnavailableError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'RpcUnavailableError';
  }
}

// The block does not exist (yet) or the node does not have it.
export class BlockNotFoundError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'BlockNotFoundError';
  }
}

// A getter the vault or market must answer reverted: wrong address, or the contract did not exist at that block.
export class RevertedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevertedError';
  }
}
