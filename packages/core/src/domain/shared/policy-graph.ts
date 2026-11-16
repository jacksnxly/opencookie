/** Resolves one category or purpose DAG with a numeric bit fold. */
export function resolvePolicyGraph<
  Node extends Readonly<{ id: string }> &
    (
      | { readonly categoryIds: readonly string[]; readonly dependsOn?: never }
      | { readonly categoryIds?: never; readonly dependsOn: readonly string[] }
    ),
>(
  nodes: readonly Node[],
  rootIds: Iterable<string>,
  resolve: (
    node: Node,
    visit: (id: string) => number | false | undefined,
  ) => number | boolean,
  mapRoot?: (id: string) => string,
): ReadonlyMap<string, Node | number | false> {
  const graph = new Map<string, Node | number | false>(
    nodes.map((node) => [node.id, node]),
  );

  function visit(id: string): number | false | undefined {
    const node = graph.get(id);
    if (typeof node !== "object") return node;
    graph.set(id, false);
    let result = +resolve(node, visit);
    for (const childId of node.categoryIds ?? node.dependsOn) {
      result |= visit(childId) as number;
    }
    graph.set(id, result);
    return result;
  }

  for (const id of rootIds) visit(mapRoot ? mapRoot(id) : id);
  return graph;
}
