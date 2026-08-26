jest.mock("expo-screen-capture", () => ({ usePreventScreenCapture: jest.fn(), enableAppSwitcherProtectionAsync: jest.fn(async () => undefined),
  disableAppSwitcherProtectionAsync: jest.fn(async () => undefined) }));
