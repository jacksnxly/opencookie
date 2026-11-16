import type { GetServerSideProps, InferGetServerSidePropsType } from "next";

export const getServerSideProps = ((context) => {
  const id = Array.isArray(context.params?.id)
    ? context.params.id[0]
    : context.params?.id;
  return Promise.resolve({ props: { id: id ?? "unknown" } });
}) satisfies GetServerSideProps<{ id: string }>;

export default function DynamicRoute({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <section className="route-card" aria-label="Rendered route">
      Dynamic route {id}
    </section>
  );
}
