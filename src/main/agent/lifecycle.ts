/** Connection, reconnect, auth refresh and browser-login launch share one process owner. */
export class SerialOperations {
  private tail: Promise<void> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(action);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
