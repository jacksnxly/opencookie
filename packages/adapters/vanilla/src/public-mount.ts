import {
  expandCategorySelection,
  resolvePolicyText,
  resolvePurposeDependencies,
  resolvePurposeSelection,
} from "@opencookie-dev/core/domain";

import {
  assertBannerLinks,
  launcherReplacement,
  mountOpenCookieHost,
  type MountedOpenCookie,
  type VanillaOpenCookieMountOptions,
} from "./mount.js";
import { projectPolicyPresentation } from "./policy-presentation.js";

export { OPENCOOKIE_CHANGE_EVENT } from "./mount.js";
export type {
  MountedOpenCookie,
  OpenCookieChangeDetail,
  VanillaOpenCookieCopy,
  VanillaOpenCookieLink,
  VanillaOpenCookieMountOptions,
} from "./mount.js";

/**
 * Mounts the no-framework OpenCookie interface. Importing this module has no
 * browser side effects, so it remains safe in SSR entry points.
 *
 * @public
 */
export function mountOpenCookie(
  options: VanillaOpenCookieMountOptions,
): MountedOpenCookie {
  assertBannerLinks(options.links);
  return mountOpenCookieHost(
    options,
    (policy, purposeId) =>
      resolvePurposeDependencies(policy, { [purposeId]: "granted" }),
    resolvePurposeSelection,
    expandCategorySelection,
    projectPolicyPresentation,
    undefined,
    undefined,
    resolvePolicyText,
    launcherReplacement(options.launcher),
  );
}
