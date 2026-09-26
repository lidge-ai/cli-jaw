/**
 * The Claude Agent SDK version this build is pinned to. Must equal the exact
 * `optionalDependencies` entry in package.json; tests/unit/claude-sdk-version-pin.test.ts
 * asserts it against package.json, package-lock.json and the installed package.
 * Kept out of claude-sdk-loader.ts because tests mock that module wholesale.
 */
export const CLAUDE_AGENT_SDK_PINNED_VERSION = '0.3.282';
