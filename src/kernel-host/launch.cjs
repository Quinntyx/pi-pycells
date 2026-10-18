// Git installs contain TypeScript sources, not dist/ or the development compiler.
// Declare our own loader: the detached host cannot depend on Pi's module aliases.
const { createJiti } = require("jiti");
const jiti = createJiti(__filename);

jiti.import("./main.ts")
  .then(({ main }) => main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
