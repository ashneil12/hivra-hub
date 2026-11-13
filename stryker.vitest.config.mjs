// The vitest config StrykerJS uses (stryker.config.mjs): the repo's own config, with the test list cut to the
// folders of the modules being mutated, so the first (dry) run takes seconds instead of the whole suite.
import base from "./vitest.config.ts";

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "src/features/firstmate/model/**/*.test.ts",
      "src/features/autopilot/model/**/*.test.ts",
      "src/features/monos/model/**/*.test.ts",
    ],
  },
};
