// The negative control: the same integration imports only the policy from the
// installed JSON, so the bundler drops the recorded digests and nothing in the
// bundle says which publication it was built from.
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

import { policy } from "./opencookie-policy.json";

bootstrapOpenCookie({
  catalogueRevision: "catalogue-1",
  policyDefinition: policy,
  policyVersion: "1.0.0",
});
