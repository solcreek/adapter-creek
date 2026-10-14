export const config = { runtime: "experimental-edge" };
export async function getServerSideProps({ params, query }) { return { props: { slug: params?.slug ?? null, q: query.q ?? null } }; }
export default function Page({ slug, q }) { return <p id="edge-ssr-dyn">slug={slug} q={q}</p>; }
