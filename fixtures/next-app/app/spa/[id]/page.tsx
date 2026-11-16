export default async function DynamicRoute({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return (
    <section className="route-card" aria-label="Rendered route">
      Dynamic route {id}
    </section>
  );
}
