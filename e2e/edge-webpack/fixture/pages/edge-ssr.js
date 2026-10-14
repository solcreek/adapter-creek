export const config = { runtime: "experimental-edge" };
export async function getServerSideProps({ query }) { return { props: { q: query.q ?? null } }; }
export default function Page({ q }) { return <p id="edge-pages-ssr">edge pages ssr q={q}</p>; }
