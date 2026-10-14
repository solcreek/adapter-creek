import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { useRouter } from "next/router";

// The page imports Next's router context directly, and next/router reads the
// pages runtime's copy: they must be the same context.
function Pathname() {
  return <p id="pathname">pathname {useRouter().pathname}</p>;
}

export default function SharedRuntime() {
  return (
    <RouterContext.Provider value={{ pathname: "/from-provider", query: {}, asPath: "/from-provider" }}>
      <Pathname />
    </RouterContext.Provider>
  );
}

export async function getServerSideProps() {
  return { props: {} };
}
