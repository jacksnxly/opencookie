// A generic custom integration: the page bundles its own OpenCookie runtime
// from the JSON that `opencookie policy install --out <file>.json` wrote beside
// it. The test copies this entry next to that file and bundles it minified.
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

import installedPolicy from "./opencookie-policy.json";

bootstrapOpenCookie({ installedPolicy });
