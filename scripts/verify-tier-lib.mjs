function step(id, args) {
  return Object.freeze({
    args: Object.freeze(args),
    command: "pnpm",
    id,
  });
}

const FAST_STEPS = Object.freeze([
  step("typecheck", ["typecheck"]),
  step("lint", ["lint"]),
  step("format", ["format:check"]),
  step("codegen", ["verify:codegen"]),
  step("build", ["build:packages"]),
  step("unit", ["test"]),
]);

const CHANGE_STEPS = Object.freeze([
  ...FAST_STEPS,
  step("coverage", ["test:coverage"]),
  step("architecture", ["verify:arch"]),
  step("scripts", ["test:scripts"]),
  step("pain-points", ["verify:pain-points"]),
  step("docs", ["--filter", "@opencookie-dev/docs", "verify"]),
  step("mutation", ["test:mutation"]),
  step("packages", ["verify:packages"]),
  step("cdn-sri", ["verify:sri"]),
  step("packed-dx", ["e2e:dx"]),
  step("browser", ["e2e", "--tier=change", "--skip-build"]),
  step("clean-tree", ["verify:clean"]),
]);

const RELEASE_STEPS = Object.freeze([
  ...CHANGE_STEPS.slice(0, -1).map((item) => {
    if (item.id === "mutation") return step("mutation", ["test:mutation:full"]);
    if (item.id === "browser") {
      return step("browser", ["e2e", "--tier=release", "--skip-build"]);
    }
    return item;
  }),
  step("cdn-performance", ["verify:performance"]),
  step("candidate", ["verify:candidate"]),
  CHANGE_STEPS.at(-1),
]);

export const VERIFY_TIERS = Object.freeze({
  change: CHANGE_STEPS,
  fast: FAST_STEPS,
  release: RELEASE_STEPS,
});

/**
 * @param {string} tier
 * @param {{ only?: readonly string[], skip?: readonly string[] }} [selection]
 */
export function selectTierSteps(tier, { only = [], skip = [] } = {}) {
  const steps = VERIFY_TIERS[tier];
  if (steps === undefined) {
    throw new Error(`Unknown verify tier ${tier}.`);
  }
  if (only.length > 0 && skip.length > 0) {
    throw new Error("Verify selection accepts --only or --skip, not both.");
  }

  const known = new Set(steps.map(({ id }) => id));
  for (const id of [...only, ...skip]) {
    if (!known.has(id)) throw new Error(`Unknown verify step ${id}.`);
  }

  const chosen =
    only.length > 0 ? new Set(only) : new Set(steps.map(({ id }) => id));
  for (const id of skip) chosen.delete(id);

  return {
    skipped: steps.filter(({ id }) => !chosen.has(id)).map(({ id }) => id),
    steps: steps.filter(({ id }) => chosen.has(id)),
  };
}
