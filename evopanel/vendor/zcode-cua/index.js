const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function createComputerUseRuntime(_options) {
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
