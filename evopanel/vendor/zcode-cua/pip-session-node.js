export function createPipSessionClient(_options) {
  return {
    enabled: false,
    async connect() {},
    async send() {
      return { applied: false };
    },
    close() {},
  };
}
