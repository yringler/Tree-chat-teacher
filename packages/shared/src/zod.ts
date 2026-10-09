import { z } from 'zod';

// Neither the web app's CSP nor workerd allows eval. Skip zod's `new Function`
// JIT probe, which a strict CSP / Trusted Types reports as a violation even
// though zod catches the error. An object schema decides at creation whether
// it may JIT, so every schema here is built with this `z`: importing it runs
// the config before any schema exists, whatever order the modules load in.
z.config({ jitless: true });

export { z };
